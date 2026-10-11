/* ============================================================
   BMBPlayer — Worker "bmbplayer" (một Worker cho cả hệ thống, deploy MỘT lần bằng wrangler)
   BMBPlayer = chọn bài hát + gọi phục vụ (trước đây là 2 app BMBPlayer và BMB Order)
   ============================================================
   TRANG (GitHub Pages, https://bmbplayer.boommusicbox.vn):
     index.html  — TV: phát bài; chưa gán phòng thì hiện mã 6 số + QR để quầy gán; phòng mở thì hiện
                   QR khách ở góc trái (QR này mở remote.html: chọn bài + gọi phục vụ). Mỗi lượt mở là QR mới.
     remote.html — Khách / máy tính bảng trong phòng: tab Chọn bài + tab Gọi phục vụ.
     quay.html   — Quầy: hàng đợi đơn, mở/đóng phòng, lịch sử, menu, tài khoản, và tab TV & phòng
                   (gán TV, xem/đổi QR khách, gỡ máy tính bảng, admin thêm/xoá phòng, in thẻ đánh giá).
     kho.html, nhac.html — kho karaoke và nhạc TV (Worker kho-karaoke / nhac-playlist riêng, không đổi).

   ĐƯỜNG DẪN CỦA WORKER:
     POST /api               — API quầy + gọi phục vụ (body JSON {action,...}), giữ đúng tên action cũ của Order.
     GET  /ws                — WebSocket kênh phòng (TV / máy tính bảng / điện thoại khách).
     POST /api/tv/pair/*     — TV chưa gán phòng xin mã 6 số, chờ quầy gán.
     POST /api/tablet/claim  — máy tính bảng đổi QR trên TV lấy mã máy tính bảng của phòng.
     POST /api/tokcheck      — TV / máy tính bảng hỏi mã còn dùng được không.
     /nhac/ws, /api/nhac/*   — kênh tức thì của nhac.html (nghe nhạc trên TV).

   DỮ LIỆU: D1 `bmb_data` dùng chung với app quản lý BMB (chi_nhanh, tai_khoan, nhat_ky, luu_luong_truy_cap)
   + bảng riêng order_phong, order_mon_mau, order_menu, order_don, order_chan_tb, order_gioi_han
   (giữ nguyên tên bảng cũ để không phải chuyển dữ liệu). Kênh phòng + mã TV/QR nằm trong Durable Object.

   PHÂN QUYỀN (vai_tro trong tai_khoan):
     admin   — mọi chi nhánh (chọn chi nhánh trên quay.html, gửi kèm branchId); thêm/xoá phòng
     manager — chi nhánh của mình: xử lý đơn, sửa menu, tài khoản QUẦY, gỡ máy tính bảng
     quay    — chi nhánh của mình: xử lý đơn, mở/đóng phòng, gán TV, đổi QR khách, chặn thiết bị;
               sửa menu chỉ khi order_sua_menu = 1
     kythuat / kythuat_mang — không vào được quầy

   KHÁCH GỌI PHỤC VỤ: không còn QR dán bàn / mã 4 số. Khách quét QR trên TV (chỉ đúng lượt đang mở);
   máy tính bảng dùng mã máy tính bảng (theo phòng qua mọi lượt; phòng đóng vẫn gửi được nhưng bị đánh dấu nghi ngờ).
   Nguồn đơn (QR / TABLET) lấy theo loại mã, không tin client.

   PHIÊN QUẦY: token riêng (ký bằng SESSION_SECRET), mỗi request đọc lại tai_khoan: khoá / đổi vai trò /
   đổi mật khẩu có hiệu lực ngay. MẬT KHẨU: chuẩn BMB (PBKDF2 của SHA256(username::matkhau::boom)).

   NGÀY KINH DOANH: 06:00 → 06:00 sáng hôm sau (GIO_CHOT_NGAY).

   CẤU HÌNH (xem README-BMBPlayer.md):
     Secret : SESSION_SECRET (GIỐNG HỆT bmb-order-worker cũ → phiên quầy đang mở không bị đá ra),
              SECRET (chuỗi ngẫu nhiên dài, ký mã TV/QR), GUEST_SECRET (GIỐNG HỆT kho-karaoke),
              APP_PASS (mật khẩu nhac.html) · tuỳ chọn: LEGACY_SECRET, NHAC_PASS
     Biến   : ALLOWED_ORIGINS (mặc định https://bmbplayer.boommusicbox.vn), NET_CHECK (off|warn|on), TB_NET (on|off)
     Binding: D1 DB → bmb_data ; Durable Object ROOM → Room, REG → Registry, NHAC → NhacRoom
   CHƯA CÓ: escalation SLA qua Telegram; học IP chi nhánh
   ============================================================ */
import { DurableObject } from 'cloudflare:workers';

const enc = new TextEncoder();
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;                                  // mã phòng = order_phong.id của Order (vd P1A2B3C4D5E6)
const TOKEN_RE = /^([A-Za-z0-9_-]{1,40})\.(\d{1,6})\.([\w-]{22})$/;
const ACTIONS = new Set(['add', 'play', 'next', 'replay', 'mute', 'vol', 'prio', 'up', 'remove', 'hello']);
const MAX_MSG = 4096, MAX_STATE = 32768, MAX_REMOTES = 2, RATE_PER_SEC = 15;

/* ---------- Mã ---------- */
const b64uB = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, text){
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64uB(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)))).slice(0, 22);
}
/* Vé khách cho kho-karaoke: <mã phòng>.<hết hạn ms>.<chữ ký> — Worker kho kiểm bằng cùng GUEST_SECRET */
async function guestTicket(env, id){
  if(!env.GUEST_SECRET) return '';
  const payload = id + '.' + (Date.now() + 8 * 3600 * 1000);
  return payload + '.' + await hmac(env.GUEST_SECRET, 'guest|' + payload);
}
const same = (a, b) => { a = String(a); b = String(b); let d = a.length ^ b.length; for(let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };
async function mkToken(env, id, kind, gen){ return id + '.' + gen + '.' + await hmac(env.SECRET, id + '|' + kind + '|' + gen); }
function parseToken(t){ const m = TOKEN_RE.exec(String(t || '')); return m ? { id: m[1], gen: +m[2], sig: m[3] } : null; }

/* ---------- Tiện ích ---------- */
const origins = env => String(env.ALLOWED_ORIGINS || 'https://bmbplayer.boommusicbox.vn').split(',').map(s => s.trim()).filter(Boolean);
function cors(req, env){
  const o = req.headers.get('Origin');
  const h = { 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'content-type, x-pass', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  if(o && origins(env).includes(o)) h['Access-Control-Allow-Origin'] = o;
  return h;
}
const jres = (data, status, extra) => new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || {}) });
function netKey(ip){                                   // IPv6: so theo 4 nhóm đầu (cùng /64), IPv4: cả địa chỉ
  ip = String(ip || '');
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
}



// ---------------- Ngưỡng giới hạn ----------------
const MAX_BODY_BYTES = 8 * 1024;
const MAX_ITEMS = 20;
const MAX_QTY = 50;
const MAX_NOTE = 200;
const MO_MAX_DON_CHO = 4;
const MO_GIAN_CACH_MS = 5 * 1000;
const DONG_MAX_DON_CHO = 1;
const DONG_GIAN_CACH_MS = 60 * 1000;
const MAX_DON_10_PHUT = 12;
const MAX_DON_CHO_CHI_NHANH = 100;

const LOGIN_KHOA_MS = 15 * 60 * 1000;   // giống BMB: 5 lần sai / 15 phút theo username
const LOGIN_MAX_SAI_USER = 5;
const LOGIN_MAX_SAI_IP = 30;            // thêm lớp theo IP (nhiều nhân viên chung mạng quán)
const MA4_WINDOW_MS = 10 * 60 * 1000;
const MA4_MAX_IP = 30;
const FEED_MAX_DON = 400;
const MAX_PHONG_MOI_LAN = 50;
const CHAN_TB_MS = 24 * 3600 * 1000;

const VAI_TRO_ORDER = ['admin', 'manager', 'quay'];

// Nhóm món — thứ tự này cũng là thứ tự hiện cho khách. 'dv' = dịch vụ/báo sự cố (bật/tắt, không số lượng)
const NHOM = ['bia', 'nuoc', 'an', 'khac', 'dv'];
const loaiTheoNhom = nhom => nhom === 'dv' ? 'SV' : 'DR';
const nhomHopLe = v => NHOM.includes(v) ? v : '';
// Icon là emoji chọn từ thư viện — chặn ký tự HTML phòng khi bị gửi bậy
const iconHopLe = v => { const x = s(v, 16); return /[<>&"'`]/.test(x) ? '' : x; };
const tenHopLe = (v, max = 60) => s(v, max).replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ');
// Sắp món: theo nhóm, rồi theo thứ tự chi nhánh tự xếp
const sapMon = (a, b) => (NHOM.indexOf(a.nhom) - NHOM.indexOf(b.nhom)) || (a.thu_tu - b.thu_tu) || (a.id - b.id);
const maNgauNhien = (tienTo, dai) => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return tienTo + [...crypto.getRandomValues(new Uint8Array(dai))].map(x => A[x % A.length]).join('');
};
const PBKDF2_ITER = 100000;
const SESSION_TTL_SEC = 12 * 3600;

// ---------------- Trả lời ----------------
function ok(data) { return json({ ok: true, ...data }); }
function fail(error, status = 400, msg, extra) { return json({ ok: false, error, ...(msg ? { msg } : {}), ...(extra || {}) }, status); }
function failSession() { return json({ ok: false, error: 'unauthorized', msg: 'HET_PHIEN' }, 401); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function withCors(res, origin, env) {
  const h = new Headers(res.headers);
  if (origin && origins(env).includes(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Content-Type');
    h.set('Access-Control-Max-Age', '86400');
    h.append('Vary', 'Origin');
  }
  h.set('Cache-Control', 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  return new Response(res.body, { status: res.status, headers: h });
}

function s(v, max = 100) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function cleanNote(v) { return typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, MAX_NOTE) : ''; }
function maMoi() { return crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase(); }
const ghiNhatKy = (env, loai, nd) =>
  env.DB.prepare('INSERT INTO nhat_ky (luc, loai, noi_dung) VALUES (?,?,?)').bind(Date.now(), loai, String(nd).slice(0, 800));

// ============================================================
// Mật khẩu — ĐÚNG chuẩn bmb-quanly-worker
// ============================================================
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));
async function sha256Hex(str) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))); }
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function pbkdf2(dauVao, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(dauVao), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, k, 256));
}
async function bamMatKhau(dauVao) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return hex(salt) + ':' + await pbkdf2(dauVao, salt);
}
// Chuỗi đầu vào chuẩn BMB từ mật khẩu thường
const dauVaoBMB = (username, matKhau) => sha256Hex(username + '::' + matKhau + '::boom');
// Lấy đầu vào từ body: ưu tiên `hash` 64 hex có sẵn, không thì tự tính từ mật khẩu thường
async function dauVaoTuBody(username, body, tenField) {
  const h = s(body.hash, 80).toLowerCase();
  if (/^[0-9a-f]{64}$/.test(h)) return h;
  const p = typeof body[tenField] === 'string' ? body[tenField] : '';
  if (!p || p.length > 256) return '';
  return dauVaoBMB(username, p);
}
/** → 'ok' | 'ok_can_nang_cap' | 'can_legacy' | 'sai'. daLuu rỗng vẫn chạy PBKDF2 giả để không lộ username. */
async function kiemTraMatKhau(env, dauVao, daLuu) {
  daLuu = String(daLuu || '');
  if (daLuu.startsWith('legacy_sha256$')) {
    if (!env.LEGACY_SECRET) return 'can_legacy';
    const cu = await sha256Hex(dauVao + env.LEGACY_SECRET);
    return timingSafeEqual(cu, daLuu.slice(14)) ? 'ok_can_nang_cap' : 'sai';
  }
  const [saltHex, h] = daLuu.split(':');
  if (!saltHex || !h) { await pbkdf2(dauVao || 'x', new Uint8Array(16)); return 'sai'; }
  return timingSafeEqual(await pbkdf2(dauVao, unhex(saltHex)), h) ? 'ok' : 'sai';
}

// ============================================================
// Phiên Order
// ============================================================
function b64u(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return decodeURIComponent(escape(atob(str)));
}
// "Vân tay" mật khẩu trong token: HMAC của mat_khau_hash (không để lộ chính hash). Đổi mật khẩu → vân tay đổi → phiên cũ chết.
async function vanTay(env, matKhauHash) { return (await hmacHex(env.SESSION_SECRET, 'vt|' + matKhauHash)).slice(0, 24); }
async function makeToken(env, payload) {
  const body = b64u(JSON.stringify(payload));
  return body + '.' + (await hmacHex(env.SESSION_SECRET, body)).slice(0, 40);
}
async function verifyToken(env, token) {
  if (!token || typeof token !== 'string' || token.length > 1000) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  if (!timingSafeEqual(parts[1], (await hmacHex(env.SESSION_SECRET, parts[0])).slice(0, 40))) return null;
  try {
    const p = JSON.parse(unb64u(parts[0]));
    if (!p.exp || Date.now() / 1000 > p.exp || typeof p.u !== 'string' || typeof p.vt !== 'string') return null;
    return p;
  } catch (e) { return null; }
}

/** Đọc phiên + nạp lại quyền từ tai_khoan. Trả null nếu phiên hết hạn/tài khoản bị khoá/đổi mật khẩu/đổi vai trò. */
async function getSession(env, body) {
  if (!env.SESSION_SECRET) throw new Error('missing_SESSION_SECRET_binding');
  const p = await verifyToken(env, body.session);
  if (!p) return null;
  const tk = await env.DB.prepare(
    'SELECT username, vai_tro, chi_nhanh_id, hoat_dong, mat_khau_hash, order_sua_menu FROM tai_khoan WHERE username = ?'
  ).bind(p.u).first();
  if (!tk || !tk.hoat_dong || !VAI_TRO_ORDER.includes(tk.vai_tro)) return null;
  if (!timingSafeEqual(await vanTay(env, tk.mat_khau_hash), p.vt)) return null;

  let b = tk.chi_nhanh_id || '';
  if (tk.vai_tro === 'admin') {
    // admin không gắn cố định chi nhánh — lấy theo chi nhánh đang chọn trên quay.html
    b = s(body.branchId, 40);
    if (b && !(await env.DB.prepare('SELECT 1 FROM chi_nhanh WHERE id = ?').bind(b).first())) b = '';
  }
  const quanLy = tk.vai_tro === 'admin' || tk.vai_tro === 'manager';
  return { u: tk.username, r: tk.vai_tro, b, quanLy, suaMenu: quanLy || tk.order_sua_menu === 1 };
}
/** Gói chung: kiểm phiên + chi nhánh + quyền. Trả [phiên, null] hoặc [null, Response lỗi]. */
async function canPhien(env, body, yeuCau = '') {
  const ss = await getSession(env, body);
  if (!ss) return [null, failSession()];
  if (!ss.b) return [null, fail('chua_chon_chi_nhanh', 400, 'Chọn chi nhánh trước.')];
  if (yeuCau === 'quanLy' && !ss.quanLy) return [null, fail('forbidden', 403, 'Chỉ quản lý chi nhánh mới làm được việc này.')];
  if (yeuCau === 'admin' && ss.r !== 'admin') return [null, fail('forbidden', 403, 'Chỉ admin mới thêm/xoá phòng được.')];
  if (yeuCau === 'suaMenu' && !ss.suaMenu) return [null, fail('forbidden', 403, 'Tài khoản chưa được cấp quyền sửa menu.')];
  return [ss, null];
}

// Sắp tên phòng theo số tự nhiên: P1, P2, … P9, P10 (không phải P1, P10, P11, P2 kiểu so chữ)
const SAP_PHONG = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
const sapPhong = (a, b) => SAP_PHONG.compare(a.ten_phong, b.ten_phong);

// ---------- Ngày kinh doanh (xem giải thích đầu file) ----------
const GIO_CHOT_NGAY = 6;
const VN_MS = 7 * 3600 * 1000;
// 'YYYY-MM-DD' của ngày kinh doanh đang diễn ra
const ngayKinhDoanh = (ms = Date.now()) => new Date(ms + VN_MS - GIO_CHOT_NGAY * 3600 * 1000).toISOString().slice(0, 10);
// Mốc bắt đầu (epoch ms) của 1 ngày kinh doanh = 06:00 giờ VN ngày đó
const mocNgay = ngay => Date.parse(ngay + 'T00:00:00Z') - VN_MS + GIO_CHOT_NGAY * 3600 * 1000;

// Định dạng 1 đơn trả về cho quay.html — dùng chung cho hàng đợi và lịch sử
const donRaClient = o => ({
  id: o.id, roomName: o.ten_phong, items: JSON.parse(o.items), note: o.ghi_chu,
  time: o.tao_luc, source: o.nguon, status: o.trang_thai,
  nghiNgo: !!o.nghi_ngo, lyDo: o.ly_do_nghi_ngo, pos: !!o.da_nhap_pos,
  devId: o.dev_id || '', nguoiXuLy: o.nguoi_xu_ly || '',
  nhanSau: o.nhan_luc ? Math.round((o.nhan_luc - o.tao_luc) / 1000) : null
});

// ============================================================
// Bộ đếm giới hạn tốc độ (order_gioi_han)
// ============================================================
function rlTangStmt(env, khoa, windowMs) {
  const now = Date.now();
  return env.DB.prepare(
    `INSERT INTO order_gioi_han (khoa, dem, het_han) VALUES (?1, 1, ?2)
     ON CONFLICT(khoa) DO UPDATE SET
       dem = CASE WHEN het_han <= ?3 THEN 1 ELSE dem + 1 END,
       het_han = CASE WHEN het_han <= ?3 THEN ?2 ELSE het_han END
     RETURNING dem, het_han`
  ).bind(khoa, now + windowMs, now);
}
async function rlTang(env, khoa, windowMs) {
  const { results } = await rlTangStmt(env, khoa, windowMs).all();
  return results[0] || { dem: 1, het_han: Date.now() + windowMs };
}
// Dọn rác ~2% số lần: khoá giới hạn hết hạn + lệnh chặn thiết bị đã hết 24h
async function rlDonRac(env) {
  if (Math.random() < 0.02) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM order_gioi_han WHERE het_han < ?').bind(now),
      env.DB.prepare('DELETE FROM order_chan_tb WHERE den_luc < ?').bind(now)
    ]);
  }
}

// ============================================================
// Router
// ============================================================
async function handleApi(request, env) {
    const origin = request.headers.get('Origin');
    const originOk = !origin || origins(env).includes(origin);

    if (request.method === 'OPTIONS') {
      if (!originOk) return withCors(new Response(null, { status: 403 }), null, env);
      return withCors(new Response(null, { status: 204 }), origin, env);
    }
    if (!originOk) return withCors(fail('origin_not_allowed', 403), null, env);
    if (request.method !== 'POST') return withCors(fail('method_not_allowed', 405), origin, env);

    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) return withCors(fail('body_too_large', 413), origin, env);
    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return withCors(fail('body_too_large', 413), origin, env);
      body = JSON.parse(raw);
    } catch (e) {
      return withCors(fail('bad_json', 400), origin, env);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return withCors(fail('bad_json', 400), origin, env);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const action = typeof body.action === 'string' ? body.action.slice(0, 40) : '';
    let res;
    try {
      switch (action) {
        case 'menu.get':                 res = await menuGet(env, body); break;
        case 'don.tao':                  res = await donTao(env, body); break;   // khách / máy tính bảng: mã kênh phòng (body.r, body.role)
        case 'don.trangThai':            res = await donTrangThai(env, body); break;
        case 'don.cuaPhong':             res = await donCuaPhong(env, body); break;
        case 'auth.dangNhap':
        case 'auth.login':               res = await authDangNhap(env, body, ip); break;
        case 'quay.feed':                res = await quayFeed(env, body); break;
        case 'quay.don':                 res = await quayDon(env, body); break;
        case 'quay.phong':               res = await quayPhong(env, body); break;
        case 'quay.tv':                  res = await quayTv(env, body); break;
        case 'quay.ganTv':               res = await quayGanTv(env, body, ip); break;
        case 'quay.tvCheck':             res = await quayTvCheck(env, body, ip); break;
        case 'quay.doiQr':               res = await quayDoiQr(env, body); break;
        case 'quay.goMtb':               res = await quayGoMtb(env, body); break;
        case 'quay.goTv':                res = await quayGoTv(env, body); break;
        case 'quay.pos':                 res = await quayPos(env, body); break;
        case 'quay.chan':                res = await quayChan(env, body); break;
        case 'quay.lichSu':              res = await quayLichSu(env, body); break;
        case 'admin.menuList':           res = await adminMenuList(env, body); break;
        case 'admin.menuHetHang':        res = await adminMenuHetHang(env, body); break;
        case 'admin.menuThemMau':        res = await adminMenuThemMau(env, body); break;
        case 'admin.menuSave':           res = await adminMenuSave(env, body); break;
        case 'admin.menuAn':             res = await adminMenuAn(env, body); break;
        case 'admin.menuXoa':            res = await adminMenuXoa(env, body); break;
        case 'admin.menuThuTu':          res = await adminMenuThuTu(env, body); break;
        case 'admin.mauList':            res = await adminMauList(env, body); break;
        case 'admin.mauSave':            res = await adminMauSave(env, body); break;
        case 'admin.mauAn':              res = await adminMauAn(env, body); break;
        case 'admin.phongThem':          res = await adminPhongThem(env, body); break;
        case 'admin.phongXoa':           res = await adminPhongXoa(env, body); break;
        case 'admin.taiKhoan.danhSach':  res = await tkDanhSach(env, body); break;
        case 'admin.taiKhoan.tao':       res = await tkTao(env, body); break;
        case 'admin.taiKhoan.khoa':      res = await tkKhoa(env, body); break;
        case 'admin.taiKhoan.datLaiMk':  res = await tkDatLaiMk(env, body); break;
        case 'admin.taiKhoan.quyenMenu': res = await tkQuyenMenu(env, body); break;
        default:                         res = fail('unknown_action: ' + action, 400);
      }
    } catch (e) {
      console.error('BMB order error [' + action + ']:', e);
      res = fail('server_error', 500);
    }
    return withCors(res, origin, env);
}

// ============================================================
// Khách (index.html)
// ============================================================
async function menuGet(env, body) {
  const branchId = s(body.branchId, 40);
  if (!branchId) return fail('missing_branchId');
  const { results } = await env.DB.prepare(
    `SELECT id, code, label, loai, icon, nhom, thu_tu FROM order_menu WHERE chi_nhanh_id = ? AND an = 0 AND het_hang = 0`
  ).bind(branchId).all();
  return ok({ items: results.sort(sapMon).map(m => ({ code: m.code, label: m.label, type: m.loai, icon: m.icon, nhom: m.nhom })) });
}

async function donTao(env, body) {
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length) return fail('empty_items');
  if (rawItems.length > MAX_ITEMS) return fail('too_many_items', 400, 'Đơn có quá nhiều món.');

  const [kenh, loiKenh] = await kenhKhach(env, body);
  if (loiKenh) return loiKenh;
  const phong = await env.DB.prepare('SELECT * FROM order_phong WHERE id = ?').bind(kenh.id).first();
  if (!phong) return fail('room_not_found');

  const now = Date.now();
  const dongPhong = !phong.dang_mo;

  // Thiết bị đang bị chặn → từ chối ngay, trước mọi truy vấn khác
  const devId = s(body.dev, 128);
  if (devId) {
    const chan = await env.DB.prepare(
      'SELECT 1 FROM order_chan_tb WHERE dev_id = ? AND chi_nhanh_id = ? AND den_luc > ?'
    ).bind(devId, phong.chi_nhanh_id, now).first();
    if (chan) return fail('device_blocked', 403, 'Thiết bị này đang bị chặn tạm thời.');
  }

  const [menuRs, phongRs, cnRs] = await env.DB.batch([
    env.DB.prepare('SELECT code, label, loai, icon, het_hang FROM order_menu WHERE chi_nhanh_id = ? AND an = 0').bind(phong.chi_nhanh_id),
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN trang_thai = 'MOI' THEN 1 ELSE 0 END), 0) AS moi,
         COALESCE(SUM(CASE WHEN tao_luc > ?2 THEN 1 ELSE 0 END), 0) AS gan,
         COALESCE(MAX(tao_luc), 0) AS cuoi
       FROM order_don WHERE phong_id = ?1 AND tao_luc > ?3`
    ).bind(phong.id, now - 10 * 60 * 1000, now - 3600 * 1000),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM order_don WHERE chi_nhanh_id = ? AND trang_thai = 'MOI' AND tao_luc > ?`
    ).bind(phong.chi_nhanh_id, now - 6 * 3600 * 1000)
  ]);

  const st = phongRs.results[0] || { moi: 0, gan: 0, cuoi: 0 };
  const maxCho = dongPhong ? DONG_MAX_DON_CHO : MO_MAX_DON_CHO;
  const giaCach = dongPhong ? DONG_GIAN_CACH_MS : MO_GIAN_CACH_MS;
  if (st.moi >= maxCho || (st.cuoi && now - st.cuoi < giaCach) || st.gan >= MAX_DON_10_PHUT) {
    return fail('gui_qua_nhanh', 429, 'Yêu cầu trước đang được xử lý. Vui lòng đợi một chút rồi gửi tiếp.');
  }
  if ((cnRs.results[0] || { n: 0 }).n >= MAX_DON_CHO_CHI_NHANH) {
    return fail('qua_tai', 429, 'Quầy đang rất bận. Vui lòng gọi trực tiếp nhân viên.');
  }

  // Dựng lại món từ menu trong DB — không tin label/type client gửi
  const menuMap = new Map(menuRs.results.map(m => [m.code, m]));
  const gop = new Map();
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') return fail('bad_item');
    const code = s(it.code, 40);
    const m = menuMap.get(code);
    if (!m) return fail('bad_item', 400, 'Có món không còn trong menu. Menu đã được cập nhật, vui lòng chọn lại.');
    if (m.het_hang) return fail('het_hang', 409, m.label + ' vừa hết hàng. Menu đã được cập nhật, vui lòng chọn món khác.');
    const qty = (it.qty === undefined || it.qty === null) ? 1 : Math.floor(Number(it.qty));
    if (!Number.isFinite(qty) || qty < 1) return fail('bad_item');
    const cu = gop.get(code);
    if (cu) cu.qty += qty;
    else gop.set(code, { code: m.code, label: m.label, type: m.loai, icon: m.icon, qty });
  }
  const items = [...gop.values()];
  for (const it of items) {
    if (it.type === 'SV') it.qty = 1;
    else if (it.qty > MAX_QTY) return fail('bad_qty', 400, 'Số lượng mỗi món tối đa ' + MAX_QTY + '.');
  }

  const lyDo = dongPhong ? 'Phòng đang ở trạng thái đóng lúc khách gửi yêu cầu' : '';
  const nguon = kenh.role === 'tablet' ? 'TABLET' : 'QR';     // lấy theo loại mã, không tin client
  const ghiChu = cleanNote(body.note);

  let id;
  for (let lan = 0; lan < 3; lan++) {
    id = maMoi();
    try {
      await env.DB.prepare(
        `INSERT INTO order_don (id, chi_nhanh_id, phong_id, ten_phong, items, ghi_chu, nguon, nghi_ngo, ly_do_nghi_ngo, trang_thai, tao_luc, cap_nhat_luc, dev_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(id, phong.chi_nhanh_id, phong.id, phong.ten_phong, JSON.stringify(items), ghiChu, nguon, dongPhong ? 1 : 0, lyDo, 'MOI', now, now, devId).run();
      break;
    } catch (e) {
      if (lan === 2 || !/UNIQUE|constraint/i.test(String(e && e.message || e))) throw e;
    }
  }
  return ok({ orderId: id });
}

async function donTrangThai(env, body) {
  const orderId = s(body.orderId, 40);
  if (!orderId) return fail('missing_orderId');
  const row = await env.DB.prepare('SELECT trang_thai FROM order_don WHERE id = ?').bind(orderId).first();
  if (!row) return fail('not_found');
  return ok({ status: row.trang_thai });
}

// Khách xem lại các đơn đã gọi của phòng mình (mã kênh phòng — QR trên TV của lượt đang mở, hoặc mã máy tính bảng).
// Chỉ trả món + trạng thái + giờ — KHÔNG trả cờ nghi ngờ/lý do/thiết bị/người xử lý.
async function donCuaPhong(env, body) {
  const [kenh, loiKenh] = await kenhKhach(env, body);
  if (loiKenh) return loiKenh;
  const phong = await env.DB.prepare('SELECT id, dang_mo, mo_luc FROM order_phong WHERE id = ?').bind(kenh.id).first();
  if (!phong) return fail('not_found');
  const now = Date.now();
  // "Phiên" = từ lúc phòng được mở; phòng chưa mở/đã đóng thì xem 6 giờ gần nhất. Tối đa 12 giờ.
  const tu = Math.max(now - 12 * 3600000, (phong.dang_mo && phong.mo_luc) ? phong.mo_luc : now - 6 * 3600000);
  const { results } = await env.DB.prepare(
    'SELECT id, items, ghi_chu, trang_thai, tao_luc FROM order_don WHERE phong_id = ? AND tao_luc >= ? ORDER BY tao_luc DESC LIMIT 30'
  ).bind(phong.id, tu).all();
  return ok({
    orders: results.map(o => {
      let items = [];
      try { items = JSON.parse(o.items).map(i => ({ label: i.label, type: i.type, icon: i.icon || '', qty: i.qty })); } catch (e) {}
      return { orderId: o.id, status: o.trang_thai, at: o.tao_luc, note: o.ghi_chu, items };
    })
  });
}

// ============================================================
// Đăng nhập quầy — bảng tai_khoan của BMB
// ============================================================
async function authDangNhap(env, body, ip) {
  const username = s(body.username || body.user, 40).toLowerCase();
  if (!username) return fail('missing_username_or_password', 400, 'Nhập đủ tài khoản và mật khẩu.');
  const dauVao = await dauVaoTuBody(username, body, typeof body.password === 'string' ? 'password' : 'pass');
  if (!dauVao) return fail('missing_username_or_password', 400, 'Nhập đủ tài khoản và mật khẩu.');

  const now = Date.now();
  const kIp = 'login:ip:' + ip;
  const rIp = await env.DB.prepare('SELECT dem, het_han FROM order_gioi_han WHERE khoa = ? AND het_han > ?').bind(kIp, now).first();
  if (rIp && rIp.dem >= LOGIN_MAX_SAI_IP) {
    const phut = Math.max(1, Math.ceil((rIp.het_han - now) / 60000));
    return fail('thu_qua_nhieu', 429, 'Đăng nhập sai quá nhiều lần từ mạng này. Thử lại sau khoảng ' + phut + ' phút.');
  }

  const tk = await env.DB.prepare(
    `SELECT t.*, COALESCE(NULLIF(c.ten_ngan,''), c.ten, '') AS ten_cn
     FROM tai_khoan t LEFT JOIN chi_nhanh c ON c.id = t.chi_nhanh_id WHERE t.username = ?`
  ).bind(username).first();

  // Khoá CHUNG với app quản lý BMB: đếm BAD_LOGIN kể từ lần đăng nhập đúng gần nhất
  const tu = Math.max(now - LOGIN_KHOA_MS, (tk && tk.dang_nhap_cuoi) || 0);
  const sai = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM nhat_ky WHERE loai = 'BAD_LOGIN' AND noi_dung = ? AND luc > ?`
  ).bind(username, tu).first();
  if (sai.n >= LOGIN_MAX_SAI_USER) return fail('thu_qua_nhieu', 429, 'Tài khoản tạm khoá 15 phút do nhập sai nhiều lần.');

  const kq = await kiemTraMatKhau(env, dauVao, (tk && tk.hoat_dong) ? tk.mat_khau_hash : '');
  if (kq === 'can_legacy') {
    return fail('mat_khau_cu', 401, 'Tài khoản này cần đăng nhập app quản lý BMB một lần để hệ thống nâng cấp mật khẩu, sau đó dùng được ở quầy.');
  }
  if (kq === 'sai') {
    await env.DB.batch([ghiNhatKy(env, 'BAD_LOGIN', username), rlTangStmt(env, kIp, LOGIN_KHOA_MS)]);
    await rlDonRac(env);
    return fail('sai_tai_khoan_hoac_mat_khau', 401, 'Sai tài khoản hoặc mật khẩu.');
  }
  if (!VAI_TRO_ORDER.includes(tk.vai_tro)) return fail('khong_co_quyen', 403, 'Tài khoản kỹ thuật không dùng màn hình quầy.');
  if (tk.vai_tro !== 'admin' && !tk.chi_nhanh_id) return fail('chua_gan_chi_nhanh', 403, 'Tài khoản chưa được gán chi nhánh. Nhờ admin gán trong app quản lý.');

  let matKhauHash = tk.mat_khau_hash;
  const lenh = [
    env.DB.prepare('UPDATE tai_khoan SET dang_nhap_cuoi = ? WHERE username = ?').bind(now, username),
    env.DB.prepare('INSERT INTO luu_luong_truy_cap (luc, username, vai_tro, chi_nhanh_id, ung_dung) VALUES (?,?,?,?,?)')
      .bind(now, username, tk.vai_tro, tk.chi_nhanh_id || '', 'order'),
    ghiNhatKy(env, 'LOGIN', username + ' (Order)')
  ];
  if (kq === 'ok_can_nang_cap') {
    matKhauHash = await bamMatKhau(dauVao);
    lenh.push(env.DB.prepare('UPDATE tai_khoan SET mat_khau_hash = ? WHERE username = ?').bind(matKhauHash, username));
  }
  await env.DB.batch(lenh);

  const exp = Math.floor(now / 1000) + SESSION_TTL_SEC;
  const token = await makeToken(env, { u: username, vt: await vanTay(env, matKhauHash), exp });
  const quanLy = tk.vai_tro === 'admin' || tk.vai_tro === 'manager';

  let branches = [];
  if (tk.vai_tro === 'admin') {
    branches = (await env.DB.prepare(
      `SELECT id, COALESCE(NULLIF(ten_ngan,''), ten) AS ten FROM chi_nhanh WHERE trang_thai = 'hoat_dong' ORDER BY thu_tu, id`
    ).all()).results;
  }
  return ok({
    session: token, tok: token,
    username, hoTen: tk.ho_ten || '', vaiTro: tk.vai_tro,
    quanLy, suaMenu: quanLy || tk.order_sua_menu === 1,
    branchId: tk.chi_nhanh_id || '', branchName: tk.ten_cn || '',
    branches, expiresAt: exp * 1000
  });
}

// ============================================================
// Quầy
// ============================================================
async function quayFeed(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const now = Date.now();
  const [phongRs, donRs] = await env.DB.batch([
    env.DB.prepare('SELECT id, ten_phong, dang_mo, mo_luc FROM order_phong WHERE chi_nhanh_id = ? ORDER BY ten_phong ASC').bind(ss.b),
    env.DB.prepare('SELECT * FROM order_don WHERE chi_nhanh_id = ? AND tao_luc >= ? ORDER BY tao_luc DESC LIMIT ?').bind(ss.b, mocNgay(ngayKinhDoanh()), FEED_MAX_DON)
  ]);
  const rooms = phongRs.results.sort(sapPhong).map(r => ({
    roomId: r.id, roomName: r.ten_phong, open: !!r.dang_mo,
    hours: (r.dang_mo && r.mo_luc) ? Math.floor((now - r.mo_luc) / 3600000) : 0
  }));
  const orders = donRs.results.reverse().map(donRaClient);
  return ok({ rooms, orders, ips: [], ngay: ngayKinhDoanh() });
}

// ---------- quay.lichSu: {ngay:'YYYY-MM-DD'} — toàn bộ đơn của 1 ngày kinh doanh (06:00 → 06:00) ----------
const LICH_SU_MAX = 1000;
async function quayLichSu(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const homNay = ngayKinhDoanh();
  const ngay = s(body.ngay, 10) || homNay;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ngay) || isNaN(Date.parse(ngay + 'T00:00:00Z'))) return fail('bad_ngay', 400, 'Ngày không hợp lệ.');
  if (ngay > homNay) return fail('ngay_tuong_lai', 400, 'Chưa tới ngày này.');
  const tu = mocNgay(ngay);
  const { results } = await env.DB.prepare(
    'SELECT * FROM order_don WHERE chi_nhanh_id = ? AND tao_luc >= ? AND tao_luc < ? ORDER BY tao_luc ASC LIMIT ?'
  ).bind(ss.b, tu, tu + 24 * 3600 * 1000, LICH_SU_MAX).all();
  return ok({ ngay, homNay, orders: results.map(donRaClient), duGioiHan: results.length === LICH_SU_MAX });
}

// Lấy đơn và bắt buộc thuộc đúng chi nhánh đang thao tác (admin cũng phải đang chọn đúng chi nhánh đó)
async function donCuaChiNhanh(env, ss, orderId, cot) {
  const don = await env.DB.prepare('SELECT ' + cot + ' FROM order_don WHERE id = ?').bind(orderId).first();
  if (!don) return [null, fail('not_found')];
  if (don.chi_nhanh_id !== ss.b) return [null, fail('forbidden', 403)];
  return [don, null];
}

async function quayDon(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const orderId = s(body.orderId, 40);
  const act = s(body.act, 10);
  if (!orderId || !['nhan', 'huy', 'xong'].includes(act)) return fail('missing_or_bad_params');
  const [don, loi2] = await donCuaChiNhanh(env, ss, orderId, 'chi_nhanh_id, trang_thai, dev_id');
  if (loi2) return loi2;

  const now = Date.now();
  let sql, params;
  if (act === 'nhan') {
    if (don.dev_id) {
      const chan = await env.DB.prepare(
        'SELECT 1 FROM order_chan_tb WHERE dev_id = ? AND chi_nhanh_id = ? AND den_luc > ?'
      ).bind(don.dev_id, don.chi_nhanh_id, now).first();
      if (chan) return fail('device_blocked', 403, 'Thiết bị gửi đơn này đang bị chặn — hãy huỷ đơn.');
    }
    sql = `UPDATE order_don SET trang_thai='NHAN', cap_nhat_luc=?, nhan_luc=?, nguoi_xu_ly=? WHERE id=? AND trang_thai='MOI'`;
    params = [now, now, ss.u, orderId];
  } else if (act === 'xong') {
    sql = `UPDATE order_don SET trang_thai='XONG', cap_nhat_luc=?, xong_luc=? WHERE id=? AND trang_thai='NHAN'`;
    params = [now, now, orderId];
  } else {
    sql = `UPDATE order_don SET trang_thai='HUY', cap_nhat_luc=?, nguoi_xu_ly=? WHERE id=? AND trang_thai IN ('MOI','NHAN')`;
    params = [now, ss.u, orderId];
  }
  const r = await env.DB.prepare(sql).bind(...params).run();
  if (!r.meta.changes) return fail('khong_doi_duoc_trang_thai', 400, 'Đơn đã được người khác xử lý. Màn hình sẽ tự cập nhật.');
  return ok({});
}

async function quayPhong(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const roomId = s(body.roomId, 60);
  if (!roomId) return fail('missing_roomId');
  const open = !!body.open;
  const r = await env.DB.prepare(
    'UPDATE order_phong SET dang_mo = ?, mo_luc = ? WHERE id = ? AND chi_nhanh_id = ?'
  ).bind(open ? 1 : 0, open ? Date.now() : null, roomId, ss.b).run();
  if (!r.meta.changes) return fail('not_found');
  await baoKenhPhong(env, roomId);
  return ok({});
}

async function quayPos(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const orderId = s(body.orderId, 40);
  if (!orderId) return fail('missing_orderId');
  const [, loi2] = await donCuaChiNhanh(env, ss, orderId, 'chi_nhanh_id');
  if (loi2) return loi2;
  await env.DB.prepare('UPDATE order_don SET da_nhap_pos = 1 WHERE id = ?').bind(orderId).run();
  return ok({});
}

async function quayChan(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const orderId = s(body.orderId, 40);
  if (!orderId) return fail('missing_orderId');
  const [don, loi2] = await donCuaChiNhanh(env, ss, orderId, 'chi_nhanh_id, dev_id');
  if (loi2) return loi2;
  if (!don.dev_id) return fail('no_device_id', 400, 'Đơn này không có mã thiết bị, không chặn được.');
  await env.DB.prepare(
    'INSERT OR REPLACE INTO order_chan_tb (dev_id, chi_nhanh_id, den_luc, ly_do, chan_boi) VALUES (?,?,?,?,?)'
  ).bind(don.dev_id, don.chi_nhanh_id, Date.now() + CHAN_TB_MS, cleanNote(body.lyDo), ss.u).run();
  return ok({});
}

// ============================================================
// Menu
// ============================================================
// Menu của chi nhánh — mọi tài khoản quầy xem được (để bật/tắt còn hàng)
async function adminMenuList(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const { results } = await env.DB.prepare(
    'SELECT id, code, label, loai, icon, nhom, thu_tu, an, het_hang, mau_id FROM order_menu WHERE chi_nhanh_id = ?'
  ).bind(ss.b).all();
  return ok({
    items: results.sort(sapMon).map(r => ({
      id: r.id, code: r.code, label: r.label, type: r.loai, icon: r.icon, nhom: r.nhom,
      an: !!r.an, hetHang: !!r.het_hang, mauId: r.mau_id
    })),
    suaMenu: ss.suaMenu, laAdmin: ss.r === 'admin'
  });
}

// Lấy 1 dòng menu, bắt buộc thuộc chi nhánh đang thao tác
async function monCuaChiNhanh(env, ss, id) {
  const n = Math.floor(Number(id));
  if (!Number.isFinite(n) || n < 1) return [null, fail('missing_id')];
  const m = await env.DB.prepare('SELECT * FROM order_menu WHERE id = ? AND chi_nhanh_id = ?').bind(n, ss.b).first();
  if (!m) return [null, fail('not_found')];
  return [m, null];
}

// Còn hàng / hết hàng — nhân viên quầy nào cũng bấm được (họ là người biết hàng hết)
async function adminMenuHetHang(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const [m, loi2] = await monCuaChiNhanh(env, ss, body.id);
  if (loi2) return loi2;
  const het = body.het ? 1 : 0;
  await env.DB.batch([
    env.DB.prepare('UPDATE order_menu SET het_hang = ? WHERE id = ?').bind(het, m.id),
    ghiNhatKy(env, het ? 'ORDER_HET_HANG' : 'ORDER_CON_HANG', ss.u + ' @' + ss.b + ': ' + m.label)
  ]);
  return ok({});
}

// Chọn món từ menu mẫu về chi nhánh {mauIds:[...]} — món đã có thì bỏ qua
async function adminMenuThemMau(env, body) {
  const [ss, loi] = await canPhien(env, body, 'suaMenu');
  if (loi) return loi;
  const ids = [...new Set((Array.isArray(body.mauIds) ? body.mauIds : []).map(x => Math.floor(Number(x))).filter(x => x > 0))].slice(0, 200);
  if (!ids.length) return fail('missing_mauIds', 400, 'Chưa chọn món nào.');
  const [mauRs, coRs, maxRs] = await env.DB.batch([
    env.DB.prepare(`SELECT id, ma, ten, nhom, icon, thu_tu FROM order_mon_mau WHERE an = 0 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids),
    env.DB.prepare('SELECT mau_id, code FROM order_menu WHERE chi_nhanh_id = ?').bind(ss.b),
    env.DB.prepare('SELECT COALESCE(MAX(thu_tu), 0) AS m FROM order_menu WHERE chi_nhanh_id = ?').bind(ss.b)
  ]);
  const daCoMau = new Set(coRs.results.map(r => r.mau_id));
  const daCoMa = new Set(coRs.results.map(r => r.code));
  let tt = maxRs.results[0].m || 0;
  const lenh = [];
  for (const m of mauRs.results.sort((a, b) => a.thu_tu - b.thu_tu || a.id - b.id)) {
    if (daCoMau.has(m.id) || daCoMa.has(m.ma)) continue;
    lenh.push(env.DB.prepare(
      'INSERT INTO order_menu (chi_nhanh_id, mau_id, code, label, loai, icon, nhom, thu_tu, an, het_hang) VALUES (?,?,?,?,?,?,?,?,0,0)'
    ).bind(ss.b, m.id, m.ma, m.ten, loaiTheoNhom(m.nhom), m.icon, m.nhom, ++tt));
  }
  if (lenh.length) await env.DB.batch(lenh);
  return ok({ them: lenh.length, boQua: ids.length - lenh.length });
}

// Tạo / sửa MÓN RIÊNG của chi nhánh {id?, label, icon, nhom}. Món thuộc mẫu thì không sửa tên/icon ở đây.
async function adminMenuSave(env, body) {
  const [ss, loi] = await canPhien(env, body, 'suaMenu');
  if (loi) return loi;
  const label = tenHopLe(body.label);
  const icon = iconHopLe(body.icon);
  const nhom = nhomHopLe(body.nhom);
  if (!label) return fail('missing_label', 400, 'Nhập tên món.');
  if (!nhom) return fail('bad_nhom', 400, 'Chọn nhóm món.');

  const trung = await env.DB.prepare(
    'SELECT id FROM order_menu WHERE chi_nhanh_id = ? AND lower(label) = lower(?)'
  ).bind(ss.b, label).first();

  if (body.id) {
    const [m, loi2] = await monCuaChiNhanh(env, ss, body.id);
    if (loi2) return loi2;
    if (m.mau_id) return fail('mon_mau', 400, 'Món này thuộc menu mẫu chung — tên và icon do admin sửa ở menu mẫu.');
    if (trung && trung.id !== m.id) return fail('trung_ten', 400, 'Chi nhánh đã có món trùng tên.');
    await env.DB.prepare('UPDATE order_menu SET label = ?, icon = ?, nhom = ?, loai = ? WHERE id = ?')
      .bind(label, icon, nhom, loaiTheoNhom(nhom), m.id).run();
    return ok({});
  }
  if (trung) return fail('trung_ten', 400, 'Chi nhánh đã có món trùng tên.');
  // Có sẵn trong menu mẫu thì nhắc chọn từ mẫu thay vì tạo trùng
  const coMau = await env.DB.prepare('SELECT ten FROM order_mon_mau WHERE an = 0 AND lower(ten) = lower(?)').bind(label).first();
  if (coMau && !body.vanTao) return fail('co_trong_mau', 409, '"' + coMau.ten + '" đã có trong menu mẫu — hãy chọn từ menu mẫu.');

  const maxRow = await env.DB.prepare('SELECT COALESCE(MAX(thu_tu), 0) AS m FROM order_menu WHERE chi_nhanh_id = ?').bind(ss.b).first();
  for (let lan = 0; lan < 3; lan++) {
    try {
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO order_menu (chi_nhanh_id, mau_id, code, label, loai, icon, nhom, thu_tu, an, het_hang) VALUES (?,NULL,?,?,?,?,?,?,0,0)'
        ).bind(ss.b, maNgauNhien('R', 6), label, loaiTheoNhom(nhom), icon, nhom, (maxRow.m || 0) + 1),
        ghiNhatKy(env, 'ORDER_MON_RIENG', ss.u + ' @' + ss.b + ': ' + label)
      ]);
      return ok({});
    } catch (e) {
      if (lan === 2 || !/UNIQUE|constraint/i.test(String(e && e.message || e))) throw e;
    }
  }
}

// Ẩn / hiện món với khách {id, an}
async function adminMenuAn(env, body) {
  const [ss, loi] = await canPhien(env, body, 'suaMenu');
  if (loi) return loi;
  const [m, loi2] = await monCuaChiNhanh(env, ss, body.id);
  if (loi2) return loi2;
  await env.DB.prepare('UPDATE order_menu SET an = ? WHERE id = ?').bind(body.an ? 1 : 0, m.id).run();
  return ok({});
}

// Bỏ món khỏi menu chi nhánh {id}. Đơn cũ không ảnh hưởng (đơn đã lưu sẵn tên món).
async function adminMenuXoa(env, body) {
  const [ss, loi] = await canPhien(env, body, 'suaMenu');
  if (loi) return loi;
  const [m, loi2] = await monCuaChiNhanh(env, ss, body.id);
  if (loi2) return loi2;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM order_menu WHERE id = ?').bind(m.id),
    ghiNhatKy(env, 'ORDER_BO_MON', ss.u + ' @' + ss.b + ': ' + m.label)
  ]);
  return ok({});
}

// Xếp lại thứ tự {ids:[...]} theo đúng thứ tự gửi lên — chỉ nhận id của chi nhánh mình
async function adminMenuThuTu(env, body) {
  const [ss, loi] = await canPhien(env, body, 'suaMenu');
  if (loi) return loi;
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(x => Math.floor(Number(x))).filter(x => x > 0).slice(0, 300);
  if (!ids.length) return fail('missing_ids');
  await env.DB.batch(ids.map((id, i) =>
    env.DB.prepare('UPDATE order_menu SET thu_tu = ? WHERE id = ? AND chi_nhanh_id = ?').bind(i + 1, id, ss.b)
  ));
  return ok({});
}

// ---------- Menu mẫu toàn chuỗi ----------
async function adminMauList(env, body) {
  const [ss, loi] = await canPhien(env, body, 'suaMenu');
  if (loi) return loi;
  const laAdmin = ss.r === 'admin';
  const [mauRs, coRs] = await env.DB.batch([
    env.DB.prepare('SELECT id, ma, ten, nhom, icon, thu_tu, an FROM order_mon_mau' + (laAdmin ? '' : ' WHERE an = 0')),
    env.DB.prepare('SELECT mau_id FROM order_menu WHERE chi_nhanh_id = ? AND mau_id IS NOT NULL').bind(ss.b)
  ]);
  const daChon = new Set(coRs.results.map(r => r.mau_id));
  return ok({
    items: mauRs.results.sort(sapMon).map(m => ({
      id: m.id, ma: m.ma, ten: m.ten, nhom: m.nhom, icon: m.icon, an: !!m.an, daChon: daChon.has(m.id)
    }))
  });
}

// Admin thêm / sửa món mẫu {id?, ten, icon, nhom}. Sửa → đồng bộ tên/icon/nhóm xuống mọi chi nhánh đang dùng.
async function adminMauSave(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  if (ss.r !== 'admin') return fail('forbidden', 403, 'Chỉ admin sửa được menu mẫu chung.');
  const ten = tenHopLe(body.ten);
  const icon = iconHopLe(body.icon);
  const nhom = nhomHopLe(body.nhom);
  if (!ten) return fail('missing_ten', 400, 'Nhập tên món.');
  if (!nhom) return fail('bad_nhom', 400, 'Chọn nhóm món.');
  const trung = await env.DB.prepare('SELECT id FROM order_mon_mau WHERE lower(ten) = lower(?)').bind(ten).first();
  const now = Date.now();

  if (body.id) {
    const id = Math.floor(Number(body.id));
    const m = await env.DB.prepare('SELECT id FROM order_mon_mau WHERE id = ?').bind(id).first();
    if (!m) return fail('not_found');
    if (trung && trung.id !== id) return fail('trung_ten', 400, 'Menu mẫu đã có món trùng tên.');
    await env.DB.batch([
      env.DB.prepare('UPDATE order_mon_mau SET ten = ?, icon = ?, nhom = ?, cap_nhat_luc = ?, cap_nhat_boi = ? WHERE id = ?')
        .bind(ten, icon, nhom, now, ss.u, id),
      env.DB.prepare('UPDATE order_menu SET label = ?, icon = ?, nhom = ?, loai = ? WHERE mau_id = ?')
        .bind(ten, icon, nhom, loaiTheoNhom(nhom), id),
      ghiNhatKy(env, 'ORDER_SUA_MAU', ss.u + ': ' + ten)
    ]);
    return ok({});
  }
  if (trung) return fail('trung_ten', 400, 'Menu mẫu đã có món trùng tên.');
  const maxRow = await env.DB.prepare('SELECT COALESCE(MAX(thu_tu), 0) AS m FROM order_mon_mau').first();
  for (let lan = 0; lan < 3; lan++) {
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO order_mon_mau (ma, ten, nhom, icon, thu_tu, an, cap_nhat_luc, cap_nhat_boi) VALUES (?,?,?,?,?,0,?,?)')
          .bind(maNgauNhien('M', 6), ten, nhom, icon, (maxRow.m || 0) + 1, now, ss.u),
        ghiNhatKy(env, 'ORDER_THEM_MAU', ss.u + ': ' + ten)
      ]);
      return ok({});
    } catch (e) {
      if (lan === 2 || !/UNIQUE|constraint/i.test(String(e && e.message || e))) throw e;
    }
  }
}

// Admin ngừng / dùng lại 1 món mẫu {id, an}: chỉ ẩn khỏi danh sách để chọn, chi nhánh đã chọn vẫn giữ
async function adminMauAn(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  if (ss.r !== 'admin') return fail('forbidden', 403, 'Chỉ admin sửa được menu mẫu chung.');
  const r = await env.DB.prepare('UPDATE order_mon_mau SET an = ? WHERE id = ?').bind(body.an ? 1 : 0, Math.floor(Number(body.id))).run();
  if (!r.meta.changes) return fail('not_found');
  return ok({});
}

// ============================================================
// Phòng (CHỈ admin — phòng là cố định). Cột token/ma4 vẫn sinh để giữ đúng cấu trúc bảng cũ, nhưng không còn dùng
// (khách vào bằng QR trên TV). Phòng mới tạo ở trạng thái ĐÓNG — quầy bấm mở khi có khách.
// ============================================================
async function adminPhongThem(env, body) {
  const [ss, loi] = await canPhien(env, body, 'admin');
  if (loi) return loi;
  // Lọc trùng KHÔNG phân biệt hoa/thường ("P1" và "p1" là cùng 1 phòng), giữ cách viết gặp đầu tiên
  const daThay = new Set(), ds = [];
  for (const x of s(body.ten, 2000).split(/[,;\n]+/)) {
    const ten = x.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (ten && !daThay.has(ten.toLowerCase())) { daThay.add(ten.toLowerCase()); ds.push(ten); }
  }
  if (!ds.length) return fail('missing_ten', 400, 'Nhập tên phòng, nhiều phòng cách nhau dấu phẩy.');
  if (ds.length > MAX_PHONG_MOI_LAN) return fail('qua_nhieu', 400, 'Tối đa ' + MAX_PHONG_MOI_LAN + ' phòng mỗi lần.');

  const [dsCu, ma4Rs] = await env.DB.batch([
    env.DB.prepare('SELECT ten_phong FROM order_phong WHERE chi_nhanh_id = ?').bind(ss.b),
    env.DB.prepare('SELECT ma4 FROM order_phong')
  ]);
  const tenCu = new Set(dsCu.results.map(r => r.ten_phong.toLowerCase()));
  const daDung = new Set(ma4Rs.results.map(r => r.ma4));
  const trung = ds.filter(t => tenCu.has(t.toLowerCase()));
  const moi = ds.filter(t => !tenCu.has(t.toLowerCase()));
  if (daDung.size + moi.length > 9000) return fail('het_ma4', 400, 'Sắp hết mã 4 số dự phòng — báo kỹ thuật.');

  const now = Date.now();
  const lenh = [];
  for (const ten of moi) {
    let ma4;
    do {
      ma4 = String(crypto.getRandomValues(new Uint16Array(1))[0] % 10000).padStart(4, '0');
    } while (daDung.has(ma4));
    daDung.add(ma4);
    const id = 'P' + crypto.randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase();
    const token = hex(crypto.getRandomValues(new Uint8Array(16)));
    lenh.push(env.DB.prepare(
      'INSERT INTO order_phong (id, chi_nhanh_id, ten_phong, token, ma4, dang_mo, mo_luc, tao_luc) VALUES (?,?,?,?,?,0,NULL,?)'
    ).bind(id, ss.b, ten, token, ma4, now));
  }
  if (lenh.length) {
    lenh.push(ghiNhatKy(env, 'ORDER_THEM_PHONG', ss.u + ' @' + ss.b + ': ' + moi.join(', ')));
    await env.DB.batch(lenh);
  }
  return ok({ them: moi, trung });
}

async function adminPhongXoa(env, body) {
  const [ss, loi] = await canPhien(env, body, 'admin');
  if (loi) return loi;
  const roomId = s(body.roomId, 60);
  if (!roomId) return fail('missing_roomId');
  const phong = await env.DB.prepare('SELECT ten_phong FROM order_phong WHERE id = ? AND chi_nhanh_id = ?').bind(roomId, ss.b).first();
  if (!phong) return fail('not_found');
  const coDon = await env.DB.prepare('SELECT 1 FROM order_don WHERE phong_id = ? LIMIT 1').bind(roomId).first();
  if (coDon) return fail('phong_co_don', 400, 'Phòng đã có đơn lịch sử nên không xoá được (giữ để đối soát).');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM order_phong WHERE id = ?').bind(roomId),
    ghiNhatKy(env, 'ORDER_XOA_PHONG', ss.u + ' @' + ss.b + ': ' + phong.ten_phong)
  ]);
  await baoKenhPhong(env, roomId);
  return ok({});
}

// ============================================================
// Tài khoản QUẦY (quản lý) — ghi thẳng vào tai_khoan của BMB
// ============================================================
// Chỉ đụng được tài khoản vai trò 'quay' thuộc đúng chi nhánh đang thao tác
async function tkQuayCuaChiNhanh(env, ss, username) {
  if (!username) return [null, fail('missing_username')];
  const tk = await env.DB.prepare('SELECT username, vai_tro, chi_nhanh_id FROM tai_khoan WHERE username = ?').bind(username).first();
  if (!tk) return [null, fail('not_found')];
  if (tk.vai_tro !== 'quay' || tk.chi_nhanh_id !== ss.b) {
    return [null, fail('forbidden', 403, 'Chỉ quản lý được tài khoản QUẦY của chi nhánh này. Tài khoản khác sửa ở app quản lý BMB.')];
  }
  return [tk, null];
}

async function tkDanhSach(env, body) {
  const [ss, loi] = await canPhien(env, body, 'quanLy');
  if (loi) return loi;
  const { results } = await env.DB.prepare(
    `SELECT username, ho_ten, hoat_dong, order_sua_menu, dang_nhap_cuoi FROM tai_khoan
     WHERE chi_nhanh_id = ? AND vai_tro = 'quay' ORDER BY username ASC`
  ).bind(ss.b).all();
  return ok({
    accounts: results.map(r => ({
      username: r.username, hoTen: r.ho_ten || '', hoatDong: !!r.hoat_dong,
      suaMenu: r.order_sua_menu === 1, dangNhapCuoi: r.dang_nhap_cuoi || null
    }))
  });
}

async function tkTao(env, body) {
  const [ss, loi] = await canPhien(env, body, 'quanLy');
  if (loi) return loi;
  const username = s(body.username, 40).toLowerCase();
  if (!/^[a-z0-9_.]{3,40}$/.test(username)) return fail('bad_username', 400, 'Tên đăng nhập 3–40 ký tự, chỉ chữ thường không dấu, số, dấu chấm, gạch dưới.');
  const matKhau = typeof body.matKhau === 'string' ? body.matKhau : '';
  if (matKhau.length < 6 || matKhau.length > 60) return fail('bad_password', 400, 'Mật khẩu từ 6 đến 60 ký tự.');
  if (await env.DB.prepare('SELECT 1 FROM tai_khoan WHERE username = ?').bind(username).first()) {
    return fail('username_exists', 400, 'Tên đăng nhập đã có trong hệ thống BMB, chọn tên khác.');
  }
  const matKhauHash = await bamMatKhau(await dauVaoBMB(username, matKhau));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tai_khoan (username, mat_khau_hash, ho_ten, vai_tro, chi_nhanh_id, hoat_dong, sieu_admin, doi_mk_bat, order_sua_menu, tao_luc)
       VALUES (?,?,?,'quay',?,1,0,0,?,?)`
    ).bind(username, matKhauHash, s(body.hoTen, 60), ss.b, body.suaMenu ? 1 : 0, Date.now()),
    ghiNhatKy(env, 'ORDER_TAO_TK', ss.u + ' tạo ' + username + ' @' + ss.b)
  ]);
  return ok({});
}

async function tkKhoa(env, body) {
  const [ss, loi] = await canPhien(env, body, 'quanLy');
  if (loi) return loi;
  const [tk, loi2] = await tkQuayCuaChiNhanh(env, ss, s(body.username, 40).toLowerCase());
  if (loi2) return loi2;
  const khoa = !!body.khoa;
  const lenh = [
    env.DB.prepare('UPDATE tai_khoan SET hoat_dong = ? WHERE username = ?').bind(khoa ? 0 : 1, tk.username),
    ghiNhatKy(env, khoa ? 'ORDER_KHOA_TK' : 'ORDER_MO_TK', ss.u + ' → ' + tk.username)
  ];
  if (khoa) lenh.push(env.DB.prepare('DELETE FROM phien_dang_nhap WHERE username = ?').bind(tk.username));
  await env.DB.batch(lenh);
  return ok({});
}

async function tkDatLaiMk(env, body) {
  const [ss, loi] = await canPhien(env, body, 'quanLy');
  if (loi) return loi;
  const [tk, loi2] = await tkQuayCuaChiNhanh(env, ss, s(body.username, 40).toLowerCase());
  if (loi2) return loi2;
  const matKhau = typeof body.matKhau === 'string' ? body.matKhau : '';
  if (matKhau.length < 6 || matKhau.length > 60) return fail('bad_password', 400, 'Mật khẩu từ 6 đến 60 ký tự.');
  const matKhauHash = await bamMatKhau(await dauVaoBMB(tk.username, matKhau));
  await env.DB.batch([
    env.DB.prepare('UPDATE tai_khoan SET mat_khau_hash = ? WHERE username = ?').bind(matKhauHash, tk.username),
    env.DB.prepare('DELETE FROM phien_dang_nhap WHERE username = ?').bind(tk.username),
    ghiNhatKy(env, 'ORDER_DAT_LAI_MK', ss.u + ' → ' + tk.username)
  ]);
  return ok({});
}

async function tkQuyenMenu(env, body) {
  const [ss, loi] = await canPhien(env, body, 'quanLy');
  if (loi) return loi;
  const [tk, loi2] = await tkQuayCuaChiNhanh(env, ss, s(body.username, 40).toLowerCase());
  if (loi2) return loi2;
  await env.DB.prepare('UPDATE tai_khoan SET order_sua_menu = ? WHERE username = ?').bind(body.bat ? 1 : 0, tk.username).run();
  return ok({});
}

// ============================================================
// Kênh phòng ↔ API quầy / gọi phục vụ
// ============================================================
// Khách (QR trên TV, chỉ lượt đang mở) hoặc máy tính bảng (mã máy tính bảng) → phòng nào, vai trò gì
async function kenhKhach(env, body) {
  const r = s(body.r, 120), role = body.role === 'tablet' ? 'tablet' : 'remote';
  const t = parseToken(r);
  if (!t) return [null, fail('missing_token', 400, 'Chưa vào phòng. Vui lòng quét mã QR trên TV của phòng.')];
  const k = await call(roomStub(env, t.id), '/check', { r, role });
  if (!k.valid) return [null, fail('het_luot', 403, role === 'tablet'
    ? 'Máy tính bảng này đã được gỡ khỏi phòng. Nhờ nhân viên gán lại.'
    : 'Mã QR này đã hết lượt. Vui lòng quét mã QR mới trên TV.')];
  if (role === 'remote' && !k.open) return [null, fail('phong_dong', 409, 'Phòng chưa mở. Vui lòng nhờ nhân viên.')];
  return [{ id: t.id, role }, null];
}
// Báo kênh phòng đọc lại D1 (mở/đóng/xoá phòng) — lỗi thì bỏ qua, phòng tự đọc lại khi có máy nối vào
async function baoKenhPhong(env, roomId) {
  try { await call(roomStub(env, roomId), '/sync', { id: roomId }); }
  catch (e) { console.error('baoKenhPhong:', e); }
}
async function phongCuaChiNhanh(env, ss, roomId) {
  if (!roomId) return [null, fail('missing_roomId')];
  const p = await env.DB.prepare('SELECT id, ten_phong, chi_nhanh_id FROM order_phong WHERE id = ?').bind(roomId).first();
  if (!p || p.chi_nhanh_id !== ss.b) return [null, fail('not_found', 404, 'Không có phòng này ở chi nhánh đang chọn.')];
  return [p, null];
}

// ---------- quay.tv: phòng + TV / máy tính bảng / điện thoại đang nối + QR khách của lượt đang mở ----------
async function quayTv(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const [phongRs, cn] = await Promise.all([
    env.DB.prepare('SELECT id, ten_phong, dang_mo, mo_luc FROM order_phong WHERE chi_nhanh_id = ?').bind(ss.b).all(),
    env.DB.prepare('SELECT link_maps FROM chi_nhanh WHERE id = ?').bind(ss.b).first()
  ]);
  const rows = phongRs.results.sort(sapPhong);
  const rooms = await Promise.all(rows.map(async r => {
    const st = await call(roomStub(env, r.id), '/status', { id: r.id });   // đồng thời bắt phòng đọc lại D1
    const x = { roomId: r.id, roomName: r.ten_phong, open: !!r.dang_mo, since: r.mo_luc || 0,
      tv: !!st.tv, tablets: st.tablets || 0, remotes: st.remotes || 0, offNet: st.offNet || 0 };
    if (st.open) x.tokQr = await mkToken(env, r.id, 'qr', st.genQ);
    if (ss.r === 'admin') x.tokTv = await mkToken(env, r.id, 'tv', st.genT);
    return x;
  }));
  const lm = String((cn && cn.link_maps) || '').trim();
  return ok({ rooms, reviewUrl: /^https?:\/\//i.test(lm) ? lm : '', net: env.NET_CHECK || 'off' });
}
// ---------- Mạng của chi nhánh ----------
// Chi nhánh có thể có 2 đường mạng (router cân bằng tải) và IP công cộng đổi khi modem tắt, nên KHÔNG so cứng với 1 IP.
// Worker tự học các IP của chi nhánh (TV đã gán nối vào, hoặc nhân viên xác nhận gán), mỗi IP nhớ 45 ngày.
const mangHoc = (env, branch, ip) => branch && ip ? callR(regStub(env), '/net/learn', { branch, ip: netKey(ip) }).catch(() => null) : null;
async function mangCo(env, branch, ip) {
  if (!branch || !ip) return { has: false, known: 0 };
  const r = await callR(regStub(env), '/net/has', { branch, ip: netKey(ip) }).catch(() => null);
  return r && r.data ? r.data : { has: false, known: 0 };
}
// TV chờ gán có cùng mạng chi nhánh không: cùng IP với quầy đang dùng, hoặc IP đã học của chi nhánh
async function tvCungMang(env, ss, code, ip) {
  const pk = await callR(regStub(env), '/tvpair/peek', { code, ip });
  if (pk.status !== 200) return { err: fail('bad_code', pk.status, pk.data.error) };
  const tvIp = String(pk.data.ip || '');
  if ((env.TV_NET || 'on') === 'off' || !tvIp) return { same: true, tvIp };      // tắt kiểm / mã cũ chưa ghi IP: không chặn
  if (tvIp === netKey(ip)) return { same: true, tvIp };
  const m = await mangCo(env, ss.b, tvIp);
  return { same: m.has, tvIp };
}
const MSG_KHAC_MANG = 'TV này đang ở mạng chưa từng thấy của chi nhánh. Có thể do chi nhánh có 2 đường mạng hoặc nhà mạng vừa đổi IP — hoặc đây là TV của chi nhánh khác. Chỉ gán nếu chắc chắn TV đang ở chi nhánh này.';
async function quayTvCheck(env, body, ip) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const code = String(body.code || '').replace(/\D/g, '');
  if (code.length !== 6) return fail('bad_code', 400, 'Mã trên TV gồm 6 chữ số.');
  const r = await tvCungMang(env, ss, code, ip);
  if (r.err) return r.err;
  return ok({ same: r.same, canForce: true });
}
// ---------- quay.ganTv {roomId, code}: gán TV đang hiện mã 6 số vào phòng (TV cũ của phòng bị đẩy về màn gán) ----------
async function quayGanTv(env, body, ip) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const [p, loi2] = await phongCuaChiNhanh(env, ss, s(body.roomId, 60));
  if (loi2) return loi2;
  const code = String(body.code || '').replace(/\D/g, '');
  if (code.length !== 6) return fail('bad_code', 400, 'Mã trên TV gồm 6 chữ số.');
  const net = await tvCungMang(env, ss, code, ip);
  if (net.err) return net.err;
  if (!net.same && body.force !== true) return fail('khac_mang', 403, MSG_KHAC_MANG, { canForce: true });
  const { gen } = await call(roomStub(env, p.id), '/rotate', { id: p.id, kind: 'tv' });
  const tok = await mkToken(env, p.id, 'tv', gen);
  const st = await callR(regStub(env), '/tvpair/set', { code, tok, id: p.id, name: p.ten_phong });
  if (st.status !== 200) return fail('bad_code', st.status, st.data.error);
  await mangHoc(env, ss.b, net.tvIp);                                  // TV đã gán: nhớ IP này là của chi nhánh
  await env.DB.prepare('INSERT INTO nhat_ky (luc, loai, noi_dung) VALUES (?,?,?)').bind(Date.now(), 'TV_GAN', ss.u + ' @' + ss.b + ': ' + p.ten_phong + (net.same ? '' : ' (xác nhận dù khác mạng)')).run();
  return ok({ roomName: p.ten_phong });
}
// ---------- quay.doiQr {roomId}: QR khách mới ngay giữa lượt (điện thoại đang nối bị ngắt) ----------
async function quayDoiQr(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const [p, loi2] = await phongCuaChiNhanh(env, ss, s(body.roomId, 60));
  if (loi2) return loi2;
  await call(roomStub(env, p.id), '/rotate', { id: p.id, kind: 'qr' });
  return ok({});
}
// ---------- quay.goTv {roomId}: gỡ TV khỏi phòng (đổi TV sang phòng khác). Mã TV cũ hết hiệu lực → TV tự quay về màn hình mã 6 số ----------
async function quayGoTv(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const [p, loi2] = await phongCuaChiNhanh(env, ss, s(body.roomId, 60));
  if (loi2) return loi2;
  await call(roomStub(env, p.id), '/rotate', { id: p.id, kind: 'tv' });
  await env.DB.prepare('INSERT INTO nhat_ky (luc, loai, noi_dung) VALUES (?,?,?)').bind(Date.now(), 'TV_GO', ss.u + ' @' + ss.b + ': ' + p.ten_phong).run();
  return ok({});
}
// ---------- quay.goMtb {roomId}: gỡ máy tính bảng của phòng (quản lý / admin) ----------
async function quayGoMtb(env, body) {
  const [ss, loi] = await canPhien(env, body, 'quanLy');
  if (loi) return loi;
  const [p, loi2] = await phongCuaChiNhanh(env, ss, s(body.roomId, 60));
  if (loi2) return loi2;
  await call(roomStub(env, p.id), '/rotate', { id: p.id, kind: 'tb' });
  return ok({});
}


const PHONG_SQL = `SELECT p.id, p.chi_nhanh_id, p.ten_phong, p.dang_mo, p.mo_luc, COALESCE(NULLIF(c.ten_ngan,''), c.ten, '') AS ten_cn
  FROM order_phong p LEFT JOIN chi_nhanh c ON c.id = p.chi_nhanh_id`;

/* ============================================================
   Registry — mã ghép 6 số (1 bản duy nhất). Danh sách phòng nay nằm ở D1 của Order.
   ============================================================ */
const TVPAIR_MS = 10 * 60 * 1000;                     // mã 6 số trên TV chưa gán phòng sống 10 phút (TV tự xin mã mới)
const rndCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
const rndKey = () => b64uB(crypto.getRandomValues(new Uint8Array(16)));

export class Registry extends DurableObject {
  async limited(prefix, ip, max){                      // giới hạn số lần theo địa chỉ mạng, cửa sổ 10 phút
    const now = Date.now(), rk = prefix + String(ip || '?');
    const rl = (await this.ctx.storage.get(rk)) || { n: 0, t: now };
    if(now - rl.t > 600000){ rl.n = 0; rl.t = now; }
    rl.n++; await this.ctx.storage.put(rk, rl);
    return rl.n > max;
  }
  async fetch(req){
    const u = new URL(req.url);
    const body = await req.json().catch(() => ({}));

    /* Gán TV bằng mã 6 số: TV xin mã (kèm khoá bí mật chỉ TV biết) → nhân viên nhập/quét mã → TV hỏi lại bằng khoá và nhận mã TV */
    if(u.pathname === '/tvpair/new'){
      if(await this.limited('rt:', body.ip, 40)) return jres({ error: 'Xin mã quá nhiều lần, đợi 10 phút.' }, 429);
      const now = Date.now(), old = await this.ctx.storage.list({ prefix: 't:' });
      for(const [k, v] of old) if(v.exp < now) await this.ctx.storage.delete(k);
      let code;
      do{ code = rndCode(); }while(old.has('t:' + code) && old.get('t:' + code).exp >= now);
      const key = rndKey(), exp = now + TVPAIR_MS;
      await this.ctx.storage.put('t:' + code, { key, exp, tok: '', ip: netKey(body.ip) });
      return jres({ code, key, exp });
    }
    if(u.pathname === '/tvpair/poll'){
      const k = 't:' + String(body.code || ''), v = await this.ctx.storage.get(k);
      if(!v || v.exp < Date.now()) return jres({ error: 'expired' }, 404);
      if(!same(String(body.key || ''), v.key)) return jres({ error: 'key' }, 403);
      if(!v.tok) return jres({ wait: true });
      await this.ctx.storage.delete(k);
      return jres({ tok: v.tok, id: v.id, name: v.name || '' });
    }
    if(u.pathname === '/tvpair/peek'){
      if(await this.limited('rp:', body.ip, 30)) return jres({ error: 'Nhập sai quá nhiều lần, đợi 10 phút.' }, 429);
      const v = await this.ctx.storage.get('t:' + String(body.code || ''));
      if(!v || v.exp < Date.now()) return jres({ error: 'Mã trên TV không đúng hoặc đã hết hạn. Xem lại mã đang hiện trên TV.' }, 404);
      if(v.tok) return jres({ error: 'Mã này vừa được dùng. Đợi TV hiện mã mới.' }, 409);
      return jres({ ok: true, ip: v.ip || '' });
    }
    if(u.pathname === '/tvpair/set'){
      const k = 't:' + String(body.code || ''), v = await this.ctx.storage.get(k);
      if(!v || v.exp < Date.now()) return jres({ error: 'Mã trên TV đã hết hạn.' }, 404);
      v.tok = String(body.tok || ''); v.id = String(body.id || ''); v.name = String(body.name || '').slice(0, 60);
      v.exp = Date.now() + 60000;                       // TV hỏi lại 2–3 giây/lần nên 1 phút là thừa
      await this.ctx.storage.put(k, v);
      return jres({ ok: true });
    }

    /* IP công cộng của từng chi nhánh (tự học, nhớ 45 ngày, tối đa 10 IP) */
    if(u.pathname === '/net/learn' || u.pathname === '/net/has'){
      const k = 'n:' + String(body.branch || ''), ips = (await this.ctx.storage.get(k)) || {}, now = Date.now(), ip = String(body.ip || '');
      for(const x of Object.keys(ips)) if(now - ips[x] > 45 * 86400000) delete ips[x];
      if(u.pathname === '/net/has') return jres({ has: !!ips[ip], known: Object.keys(ips).length });
      if(ip){
        ips[ip] = now;
        const ks = Object.keys(ips).sort((x, y) => ips[y] - ips[x]);
        for(const x of ks.slice(10)) delete ips[x];
      }
      await this.ctx.storage.put(k, ips);
      return jres({ ok: true });
    }

    /* Mã ghép 6 số cho nhac.html: TV xin (có mật khẩu), điện thoại đổi lấy vé của đúng phòng đó */
    if(u.pathname === '/pair/new'){
      const now = Date.now(), old = await this.ctx.storage.list({ prefix: 'p:' });
      for(const [k, v] of old) if(v.exp < now) await this.ctx.storage.delete(k);
      let code;
      do{ code = rndCode(); }while(old.has('p:' + code) && old.get('p:' + code).exp >= now);
      const exp = now + PAIR_MS;
      await this.ctx.storage.put('p:' + code, { room: String(body.room || ''), exp });
      return jres({ code, exp });
    }
    if(u.pathname === '/pair/claim'){
      if(await this.limited('rl:', body.ip, 20)) return jres({ error: 'Thử quá nhiều lần, đợi 10 phút rồi quét lại mã trên TV.' }, 429);
      const v = await this.ctx.storage.get('p:' + String(body.code || ''));
      if(!v || v.exp < Date.now()) return jres({ error: 'Mã không đúng hoặc đã hết hạn. Bấm “Ghép điện thoại” trên TV để lấy mã mới.' }, 404);
      return jres({ room: v.room });
    }
    return jres({ error: 'not found' }, 404);
  }
}

/* ============================================================
   Room — kênh riêng của 1 phòng Order
   Vai trò kết nối: 'tv' (mã TV), 'tablet' (mã máy tính bảng), 'remote' (QR khách của lượt đang mở)
   Tình trạng mở/đóng lấy từ order_phong (dang_mo, mo_luc): mo_luc đổi = lượt mới.
   ============================================================ */
const KIND = { tv: 'tv', tablet: 'tb', remote: 'qr' };
const GEN = { tv: 'genT', tablet: 'genB', remote: 'genQ' };
const RESYNC_MS = 5 * 60 * 1000;

export class Room extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async cfg(){
    const m = await this.ctx.storage.get(['open', 'since', 'session', 'genQ', 'genT', 'genB', 'tvIp', 'rid', 'moLuc', 'name', 'bname', 'branch', 'gone']);
    return { open: !!m.get('open'), since: m.get('since') || 0, session: m.get('session') || 0, genQ: m.get('genQ') || 1, genT: m.get('genT') || 1, genB: m.get('genB') || 1,
      tvIp: m.get('tvIp') || '', rid: m.get('rid') || '', moLuc: m.get('moLuc') || 0, name: m.get('name') || '', bname: m.get('bname') || '', branch: m.get('branch') || '', gone: !!m.get('gone') };
  }
  async mangOk(ip, c){ return netKey(ip) === c.tvIp || (!!c.branch && (await mangCo(this.env, c.branch, ip)).has); }
  async remember(id){ if(ID_RE.test(id || '') && (await this.ctx.storage.get('rid')) !== id) await this.ctx.storage.put('rid', id); }
  sockets(role){
    const l = this.ctx.getWebSockets(role);
    return role === 'remote' ? l.filter(w => (w.deserializeAttachment() || {}).ok) : l;   // điện thoại khách chỉ tính sau khi qua kiểm tra lúc 'sync'
  }
  listeners(){ return this.sockets('remote').concat(this.sockets('tablet')); }        // máy nhận trạng thái TV
  async roomMsg(c, extra){
    c = c || await this.cfg();
    return Object.assign({ type: 'room', open: c.open, since: c.since, session: c.session, name: c.name, bname: c.bname, branch: c.branch, tv: this.sockets('tv').length > 0,
      remotes: this.sockets('remote').length, tablets: this.sockets('tablet').length }, extra || {});
  }
  /* Phần riêng từng vai trò: TV nhận mã QR khách để vẽ ở góc màn hình, máy tính bảng nhận vé tìm bài */
  async roleExtra(c, role){
    if(!c.open || !c.rid) return {};
    if(role === 'tv') return { qr: await mkToken(this.env, c.rid, 'qr', c.genQ) };
    if(role === 'tablet') return { gt: await guestTicket(this.env, c.rid) };
    return {};
  }
  async broadcastRoom(extra){
    const c = await this.cfg(), base = await this.roomMsg(c, extra);
    for(const role of ['tv', 'tablet', 'remote']){
      const list = this.ctx.getWebSockets(role); if(!list.length) continue;
      const msg = JSON.stringify(Object.assign({}, base, await this.roleExtra(c, role)));
      for(const ws of list){ try{ ws.send(msg); }catch(e){} }
    }
  }
  async endGuests(){                                   // hết lượt: ngắt điện thoại khách (kể cả máy đang chờ phòng mở)
    const msg = JSON.stringify(await this.roomMsg(null, { open: false, reason: 'closed' }));
    for(const ws of this.ctx.getWebSockets('remote')){ try{ if((ws.deserializeAttachment() || {}).ok) ws.send(msg); ws.close(4001, 'closed'); }catch(e){} }
  }
  async applyOpen(c, mo){                              // lượt mới: phiên mới + QR khách mới (QR lượt trước chết luôn)
    await this.endGuests();
    await this.ctx.storage.put({ open: true, since: mo || Date.now(), moLuc: mo, session: c.session + 1, genQ: c.genQ + 1 });
    await this.ctx.storage.delete('last');
    await this.broadcastRoom();
  }
  async applyClose(c){
    await this.ctx.storage.put({ open: false, since: 0, moLuc: 0, session: c.session + 1 });
    await this.ctx.storage.delete('last');
    await this.endGuests();
    await this.broadcastRoom({ reason: 'closed' });     // TV và máy tính bảng vẫn nối, chỉ chuyển sang "phòng chưa mở"
  }
  /* Đọc lại phòng trong D1 của Order và áp thay đổi (mở/đóng/lượt mới/đổi tên/phòng bị xoá) */
  async syncDb(){
    let c = await this.cfg();
    if(!c.rid || !this.env.DB) return c;
    let row;
    try{ row = await this.env.DB.prepare(PHONG_SQL + ' WHERE p.id = ?').bind(c.rid).first(); }catch(e){ return c; }   // D1 lỗi tạm: giữ nguyên
    if(!row){                                           // phòng đã bị admin xoá bên Order: đóng, đẩy TV/máy tính bảng về màn gán
      if(c.gone) return c;
      if(c.open) await this.applyClose(c);
      c = await this.cfg();
      await this.ctx.storage.put({ gone: true, genT: c.genT + 1, genB: c.genB + 1 });
      for(const ws of this.ctx.getWebSockets()){ try{ ws.close(4002, 'rotated'); }catch(e){} }
      return await this.cfg();
    }
    const meta = { name: String(row.ten_phong || ''), bname: String(row.ten_cn || ''), branch: String(row.chi_nhanh_id || ''), gone: false };
    const changedMeta = meta.name !== c.name || meta.bname !== c.bname || meta.branch !== c.branch || c.gone;
    if(changedMeta){ await this.ctx.storage.put(meta); c = Object.assign(c, meta); }
    const open = !!row.dang_mo, mo = +row.mo_luc || 0;
    if(open && (!c.open || mo !== c.moLuc)) await this.applyOpen(c, mo);
    else if(!open && c.open) await this.applyClose(c);
    else if(changedMeta) await this.broadcastRoom();
    return await this.cfg();
  }
  async alarm(){                                       // TV đang bật: 5 phút/lần tự đọc lại D1 (lưới an toàn nếu Order chưa báo sang)
    if(!this.ctx.getWebSockets('tv').length) return;
    await this.syncDb();
    await this.ctx.storage.setAlarm(Date.now() + RESYNC_MS);
  }
  async status(){
    const c = await this.syncDb(), net = this.env.NET_CHECK || 'off';
    let off = 0;
    for(const ws of this.sockets('remote')){ const a = ws.deserializeAttachment() || {}; if(a.off) off++; }
    return { remotes: this.sockets('remote').length, tablets: this.sockets('tablet').length, tv: this.sockets('tv').length > 0, net, offNet: off,
      open: c.open, since: c.since, genQ: c.genQ, genT: c.genT, tvIp: (await this.ctx.storage.get('tvIp')) || '' };
  }

  async fetch(req){
    const u = new URL(req.url);
    if(u.pathname === '/ws') return this.connect(req, u);
    const body = await req.json().catch(() => ({}));
    if(u.pathname === '/check'){                         // mã còn dùng được không: TV/máy tính bảng tự quên mã chết; gọi phục vụ kiểm mã khách
      const role = body.role === 'tv' ? 'tv' : body.role === 'remote' ? 'remote' : 'tablet', t = parseToken(body.r);
      if(t) await this.remember(t.id);
      const c = await this.syncDb(), gen = c[GEN[role]];
      const valid = !!(t && !c.gone && t.gen === gen && same(t.sig, await hmac(this.env.SECRET, t.id + '|' + KIND[role] + '|' + gen)));
      return jres({ valid, open: c.open, role, id: t ? t.id : '' });
    }
    await this.remember(String(body.id || ''));
    if(u.pathname === '/status') return jres(await this.status());
    if(u.pathname === '/sync'){ const c = await this.syncDb(); return jres({ ok: true, open: c.open }); }
    if(u.pathname === '/rotate'){
      const role = body.kind === 'tv' ? 'tv' : body.kind === 'tb' ? 'tablet' : 'remote', c = await this.cfg();
      const g = c[GEN[role]] + 1;
      await this.ctx.storage.put(GEN[role], g);
      for(const ws of this.ctx.getWebSockets(role)){ try{ ws.close(4002, 'rotated'); }catch(e){} }
      if(role === 'remote') await this.broadcastRoom();   // TV vẽ lại QR mới
      return jres({ ok: true, gen: g });
    }
    if(u.pathname === '/tbclaim'){                       // máy tính bảng đổi QR khách (đang hiện trên TV) lấy mã máy tính bảng
      const t = parseToken(body.r);
      if(t) await this.remember(t.id);
      const c = await this.syncDb();
      const ok = t && t.gen === c.genQ && same(t.sig, await hmac(this.env.SECRET, t.id + '|qr|' + c.genQ));
      if(!ok) return jres({ error: 'Mã QR này đã cũ. Quét mã đang hiện ở góc trái TV.' }, 403);
      if(!c.open) return jres({ error: 'Phòng chưa mở. Mở phòng rồi quét QR trên TV.' }, 409);
      if((this.env.TB_NET || 'on') !== 'off'){
        if(!c.tvIp) return jres({ error: 'TV của phòng chưa nối. Bật TV rồi thử lại.' }, 409);
        if(!(await this.mangOk(body.ip, c))) return jres({ error: 'Máy tính bảng phải dùng wifi của quán (cùng mạng với TV).' }, 403);
      }
      const g = c.genB + 1;
      await this.ctx.storage.put('genB', g);
      for(const ws of this.ctx.getWebSockets('tablet')){ try{ ws.close(4002, 'rotated'); }catch(e){} }   // mỗi phòng 1 máy tính bảng
      return jres({ id: t.id, name: c.name, tok: await mkToken(this.env, t.id, 'tb', g) });
    }
    return jres({ error: 'not found' }, 404);
  }

  async connect(req, u){
    if(req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const q = u.searchParams.get('role'), role = q === 'tv' ? 'tv' : q === 'tablet' ? 'tablet' : 'remote';
    const t = parseToken(u.searchParams.get('r'));
    if(!t) return new Response('bad token', { status: 403 });
    await this.remember(t.id);
    const c = await this.syncDb(), gen = c[GEN[role]];
    const ok = !c.gone && t.gen === gen && same(t.sig, await hmac(this.env.SECRET, t.id + '|' + KIND[role] + '|' + gen));
    if(!ok) return new Response('bad token', { status: 403 });
    const ip = req.headers.get('CF-Connecting-IP') || '';
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);

    if(role === 'remote'){
      this.ctx.acceptWebSocket(server, ['remote']);
      server.serializeAttachment({ role, ip, id: t.id, n: 0, t: 0, ok: false });   // chưa cho vào: chờ 'sync' mới kiểm phòng mở / mạng / số máy
      return new Response(null, { status: 101, webSocket: client });
    }
    if(role === 'tv'){
      for(const old of this.sockets('tv')){ try{ old.send(JSON.stringify({ type: 'room', open: c.open, replaced: true })); old.close(4000, 'replaced'); }catch(e){} }
      await this.ctx.storage.put('tvIp', netKey(ip));
      if(c.branch) await mangHoc(this.env, c.branch, ip);   // TV của chi nhánh nối vào: nhớ IP (kể cả đường mạng thứ 2)
      if(!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + RESYNC_MS);
    }
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, ip, id: t.id, n: 0, t: 0, ok: true });
    await this.broadcastRoom();                          // báo số máy đang nối cho mọi bên
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data){
    if(typeof data !== 'string' || data.length > MAX_STATE) return;
    if(data === 'sync'){                                 // máy vừa nối xong xin: tình trạng phòng (+ mã/vé theo vai trò) và trạng thái gần nhất của TV
      const a0 = ws.deserializeAttachment() || {};
      const c = a0.role === 'remote' && !a0.ok ? await this.syncDb() : await this.cfg();
      if(a0.role === 'remote' && !a0.ok){
        const net = this.env.NET_CHECK || 'off', off = net !== 'off' && c.tvIp && !(await this.mangOk(a0.ip, c));
        const deny = !c.open ? [4003, 'notopen'] : (off && net === 'on') ? [4004, 'network'] : this.sockets('remote').length >= MAX_REMOTES ? [4005, 'full'] : null;
        if(deny){ try{ ws.send(JSON.stringify(await this.roomMsg(c, { id: a0.id, reason: deny[1] }))); ws.close(deny[0], deny[1]); }catch(e){} return; }
        a0.ok = true; a0.off = !!off; ws.serializeAttachment(a0);
        await this.broadcastRoom();
      }
      const extra = a0.role === 'remote' ? { gt: c.open ? await guestTicket(this.env, a0.id) : '' } : await this.roleExtra(c, a0.role);
      ws.send(JSON.stringify(await this.roomMsg(c, Object.assign({ id: a0.id, you: a0.role }, extra))));
      if(a0.role !== 'tv' && c.open){ const last = await this.ctx.storage.get('last'); if(last) ws.send(last); }
      return;
    }
    const a = ws.deserializeAttachment() || {}, now = Date.now();
    if(now - (a.t || 0) < 1000){ a.n = (a.n || 0) + 1; } else { a.n = 1; a.t = now; }
    ws.serializeAttachment(a);
    if(a.n > RATE_PER_SEC) return;
    let m; try{ m = JSON.parse(data); }catch(e){ return; }
    if(!m || typeof m !== 'object') return;

    if(a.role === 'remote' || a.role === 'tablet'){
      if(!a.ok || data.length > MAX_MSG || m.type !== 'cmd') return;
      const c = await this.cfg(); if(!c.open) return;
      const p = m.payload || {}; if(!ACTIONS.has(p.action)) return;
      const out = { action: p.action };
      if(p.action === 'add'){
        if(!/^[\w-]{11}$/.test(p.id || '')) return;
        out.id = p.id; out.title = String(p.title || 'Bài không tên').slice(0, 200);
        if(p.prio === true) out.prio = true;
      }else if(p.action === 'vol'){ out.value = Math.max(0, Math.min(100, +p.value || 0));
      }else if(p.action === 'prio' || p.action === 'up' || p.action === 'remove'){ out.index = Math.max(0, Math.min(500, +p.index | 0)); }
      const msg = JSON.stringify({ type: 'cmd', payload: out });
      for(const tv of this.sockets('tv')){ try{ tv.send(msg); }catch(e){} }
      return;
    }
    /* từ TV */
    if(m.type === 'state'){
      const c = await this.cfg(); if(!c.open) return;
      await this.ctx.storage.put('last', data);
      for(const r of this.listeners()){ try{ r.send(data); }catch(e){} }
    }else if(m.type === 'dead'){
      for(const r of this.listeners()){ try{ r.send(data); }catch(e){} }
    }
  }
  async webSocketClose(ws, code, reason){ try{ ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); }catch(e){} await this.broadcastRoom(); }
  async webSocketError(ws){ try{ ws.close(1011, 'error'); }catch(e){} await this.broadcastRoom(); }
}

/* ============================================================
   NhacRoom — kênh tức thì cho nhac.html (TV nghe nhạc + điện thoại điều khiển)
   - Trình duyệt không gắn được header vào WebSocket ⇒ tin nhắn ĐẦU TIÊN phải là
       {type:'auth', role:'tv'|'remote', pass}  (mật khẩu NHAC_PASS, không đặt thì dùng APP_PASS)
     hoặc {type:'auth', tok}                    (vé ghép mã, chỉ làm điều khiển, chỉ đúng phòng này)
     Sai/không gửi trong 15 giây ⇒ đóng kết nối.
   - Điện thoại {type:'cmd', action, payload} → mọi TV trong phòng.
   - TV {type:'state', state} và {type:'list', …} → mọi điện thoại; giữ bản mới nhất để gửi ngay cho máy vừa vào.
   ============================================================ */
const NHAC_ACTIONS = new Set(['toggle', 'next', 'prev', 'vol', 'shuffle', 'repeat', 'playid', 'reload', 'playlist', 'hello']);
const NHAC_ROOM_RE = /^[\w-]{1,20}$/;
const PAIR_MS = 5 * 60 * 1000, PAIR_TOKEN_MS = 24 * 3600 * 1000, MAX_LIST = 400000;
const nhacPass = env => env.NHAC_PASS || env.APP_PASS;
async function nhacToken(env, room, exp){ return room + '.' + exp + '.' + await hmac(env.SECRET, 'nhac|' + room + '|' + exp); }
async function nhacTokenOk(env, room, tok){
  const m = /^([\w-]{1,20})\.(\d{13})\.([\w-]{22})$/.exec(String(tok || ''));
  if(!m || m[1] !== room || +m[2] < Date.now()) return false;
  return same(m[3], await hmac(env.SECRET, 'nhac|' + room + '|' + m[2]));
}

export class NhacRoom extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  peers(role){ return this.ctx.getWebSockets().filter(w => { const a = w.deserializeAttachment() || {}; return a.auth && (!role || a.role === role); }); }
  sendAll(list, msg){ for(const w of list){ try{ w.send(msg); }catch(e){} } }
  peersMsg(){ return JSON.stringify({ type: 'peers', tv: this.peers('tv').length > 0, remotes: this.peers('remote').length }); }

  async fetch(req){
    const u = new URL(req.url);
    if(req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const room = u.searchParams.get('room') || '';
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ auth: false, room, at: Date.now(), n: 0, t: 0 });
    if(!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 15000);
    return new Response(null, { status: 101, webSocket: client });
  }
  async alarm(){                                      // đóng các kết nối không xác thực trong 15 giây
    const now = Date.now(); let next = 0;
    for(const w of this.ctx.getWebSockets()){
      const a = w.deserializeAttachment() || {};
      if(!a.auth){ if(now - a.at >= 14000){ try{ w.send(JSON.stringify({ type: 'denied', reason: 'timeout' })); w.close(4001, 'auth'); }catch(e){} } else if(!next || a.at < next) next = a.at; }
    }
    if(next) await this.ctx.storage.setAlarm(next + 15000);
  }
  async webSocketMessage(ws, data){
    if(typeof data !== 'string' || data.length > MAX_LIST) return;
    const a = ws.deserializeAttachment() || {}, now = Date.now();
    if(now - (a.t || 0) < 1000) a.n = (a.n || 0) + 1; else { a.n = 1; a.t = now; }
    let m; try{ m = JSON.parse(data); }catch(e){ m = null; }
    if(!a.auth){
      if(!m || m.type !== 'auth'){ try{ ws.close(4001, 'auth'); }catch(e){} return; }
      let role = null, full = false;
      if(m.pass && same(m.pass, nhacPass(this.env))){ role = m.role === 'tv' ? 'tv' : 'remote'; full = true; }
      else if(m.tok && await nhacTokenOk(this.env, a.room, m.tok)) role = 'remote';
      if(!role){ try{ ws.send(JSON.stringify({ type: 'denied', reason: m.tok ? 'token' : 'pass' })); ws.close(4001, 'auth'); }catch(e){} return; }
      a.auth = true; a.role = role; a.full = full; ws.serializeAttachment(a);
      ws.send(JSON.stringify({ type: 'hello', role, full, room: a.room }));
      if(role === 'remote'){
        const [last, list] = await Promise.all([this.ctx.storage.get('last'), this.ctx.storage.get('list')]);
        if(list) ws.send(list);
        if(last) ws.send(last);
      }
      const pm = this.peersMsg(); this.sendAll(this.peers(), pm);
      return;
    }
    ws.serializeAttachment(a);
    if(a.n > 20 || !m) return;
    if(a.role === 'remote'){
      if(m.type !== 'cmd' || data.length > 4096 || !NHAC_ACTIONS.has(m.action)) return;
      const p = m.payload && typeof m.payload === 'object' ? m.payload : {};
      const out = {};
      if(m.action === 'vol') out.value = Math.max(0, Math.min(100, +p.value || 0));
      if(m.action === 'playid'){ if(!/^[\w-]{11}$/.test(p.id || '')) return; out.id = p.id; }
      if(m.action === 'playlist') out.name = String(p.name || '').slice(0, 60);
      this.sendAll(this.peers('tv'), JSON.stringify({ type: 'cmd', action: m.action, payload: out, at: now }));
      return;
    }
    if(m.type === 'state'){
      if(data.length > 32768) return;
      const msg = JSON.stringify({ type: 'state', state: m.state || null, at: now });
      await this.ctx.storage.put('last', msg);
      this.sendAll(this.peers('remote'), msg);
    }else if(m.type === 'list'){
      const msg = JSON.stringify({ type: 'list', playlists: Array.isArray(m.playlists) ? m.playlists.slice(0, 200) : [], name: m.name || null, items: Array.isArray(m.items) ? m.items.slice(0, 2000) : [] });
      if(msg.length > MAX_LIST) return;
      await this.ctx.storage.put('list', msg);
      this.sendAll(this.peers('remote'), msg);
    }
  }
  async webSocketClose(ws, code, reason){ try{ ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); }catch(e){} this.sendAll(this.peers().filter(w => w !== ws), this.peersMsg()); }
  async webSocketError(ws){ try{ ws.close(1011, 'error'); }catch(e){} }
}

/* ============================================================
   Cổng vào
   ============================================================ */
const roomStub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));
const regStub = env => env.REG.get(env.REG.idFromName('registry'));
const call = (stub, path, body) => stub.fetch('https://do' + path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const callR = (stub, path, body) => stub.fetch('https://do' + path, { method: 'POST', body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));

export default {
  async fetch(req, env){
    const u = new URL(req.url);
    if(!env.SECRET) return jres({ error: 'Worker chưa đặt secret SECRET' }, 500);

    /* API quầy + gọi phục vụ (giữ nguyên cách gọi của quay.html cũ: POST JSON {action,...}) */
    if(u.pathname === '/api' || u.pathname === '/api/') return handleApi(req, env);

    const ch = cors(req, env);
    if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });
    const origin = req.headers.get('Origin'), originOk = !!origin && origins(env).includes(origin);
    const ip = req.headers.get('CF-Connecting-IP') || '';
    // Trang gốc: mở trang TV (index.html) giống GitHub Pages trước đây; chưa có file tĩnh thì trả chữ như cũ
    if(u.pathname === '/' && req.method === 'GET'){
      if(env.ASSETS) return env.ASSETS.fetch(new Request(new URL('/index.html', u), req));
      return new Response('BMBPlayer API', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    // Phiên bản đang chạy (cùng lúc cho cả trang HTML và API vì deploy chung một lần)
    if(u.pathname === '/api/ver' && req.method === 'GET'){
      const v = env.CF_VERSION_METADATA || {};
      return jres({ id: v.id || '', tag: v.tag || '', at: v.timestamp || '' }, 200, originOk ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {});
    }

    /* Kết nối WebSocket của TV / máy tính bảng / điện thoại */
    if(u.pathname === '/ws'){
      if(!originOk) return new Response('origin', { status: 403 });
      const t = parseToken(u.searchParams.get('r'));
      if(!t) return new Response('bad token', { status: 403 });
      return roomStub(env, t.id).fetch(req);
    }

    /* TV chưa gán phòng: xin mã 6 số, rồi hỏi lại tới khi quầy gán (không cần mật khẩu, chỉ đúng tên miền) */
    if(u.pathname === '/api/tv/pair/new' && req.method === 'POST'){
      if(!originOk) return jres({ error: 'origin' }, 403, ch);
      const r = await callR(regStub(env), '/tvpair/new', { ip });
      return jres(r.data, r.status, ch);
    }
    if(u.pathname === '/api/tv/pair/poll' && req.method === 'POST'){
      if(!originOk) return jres({ error: 'origin' }, 403, ch);
      const body = await req.json().catch(() => ({}));
      const r = await callR(regStub(env), '/tvpair/poll', { code: String(body.code || '').replace(/\D/g, ''), key: String(body.key || '') });
      return jres(r.data, r.status, ch);
    }
    /* Máy tính bảng: đổi QR khách đang hiện trên TV lấy mã máy tính bảng của phòng */
    if(u.pathname === '/api/tablet/claim' && req.method === 'POST'){
      if(!originOk) return jres({ error: 'origin' }, 403, ch);
      const body = await req.json().catch(() => ({})), t = parseToken(body.r);
      if(!t) return jres({ error: 'Không phải mã QR phòng. Quét mã ở góc trái TV.' }, 400, ch);
      const r = await callR(roomStub(env, t.id), '/tbclaim', { r: body.r, ip });
      return jres(r.data, r.status, ch);
    }
    if(u.pathname === '/api/tokcheck' && req.method === 'POST'){
      if(!originOk) return jres({ error: 'origin' }, 403, ch);
      const body = await req.json().catch(() => ({})), t = parseToken(body.r);
      if(!t) return jres({ valid: false }, 200, ch);
      const role = body.role === 'tv' ? 'tv' : 'tablet';
      return jres(await call(roomStub(env, t.id), '/check', { r: body.r, role }), 200, ch);
    }

    /* nhac.html: kênh tức thì + ghép mã */
    if(u.pathname === '/nhac/ws'){
      const room = u.searchParams.get('room') || '';
      if(!originOk) return new Response('origin', { status: 403 });
      if(!NHAC_ROOM_RE.test(room)) return new Response('room', { status: 400 });
      return env.NHAC.get(env.NHAC.idFromName(room)).fetch(req);
    }
    if(u.pathname === '/api/nhac/pair' && req.method === 'POST'){        // TV (có mật khẩu) xin mã 6 số sống 5 phút
      if(!nhacPass(env) || !same(req.headers.get('x-pass') || '', nhacPass(env))) return jres({ error: 'Sai mật khẩu' }, 401, ch);
      const body = await req.json().catch(() => ({})), room = String(body.room || '');
      if(!NHAC_ROOM_RE.test(room)) return jres({ error: 'Tên phòng không hợp lệ' }, 400, ch);
      return jres(await call(regStub(env), '/pair/new', { room }), 200, ch);
    }
    if(u.pathname === '/api/nhac/claim' && req.method === 'POST'){       // điện thoại đổi mã lấy vé 24 giờ (không cần mật khẩu)
      if(!originOk) return jres({ error: 'origin' }, 403, ch);
      const body = await req.json().catch(() => ({})), code = String(body.code || '').replace(/\D/g, '');
      if(code.length !== 6) return jres({ error: 'Mã gồm 6 chữ số' }, 400, ch);
      const r = await callR(regStub(env), '/pair/claim', { code, ip });
      if(r.status !== 200) return jres(r.data, r.status, ch);
      const exp = Date.now() + PAIR_TOKEN_MS;
      return jres({ room: r.data.room, tok: await nhacToken(env, r.data.room, exp), exp }, 200, ch);
    }
    return jres({ error: 'not found' }, 404, ch);
  }
};
