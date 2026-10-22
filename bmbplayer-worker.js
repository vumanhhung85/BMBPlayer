/* ============================================================
   BMBPlayer — Worker "bmbplayer" (một Worker cho cả hệ thống, deploy MỘT lần bằng wrangler)
   BMBPlayer = chọn bài hát + gọi lễ tân (trước đây là 2 app BMBPlayer và BMB Order)
   ============================================================
   TRANG (Worker static assets, https://bmb.id.vn):
     index.html  — TV: phát bài; chưa gán phòng thì hiện mã 6 số + QR để quầy gán; phòng mở thì hiện
                   QR khách ở góc trái (QR này mở remote.html: chọn bài + gọi lễ tân). Mỗi lượt mở là QR mới.
     remote.html — Khách / máy tính bảng trong phòng: tab Chọn bài + tab Gọi lễ tân.
     quay.html   — Quầy: hàng đợi đơn, mở/đóng phòng, lịch sử, menu, tài khoản, và tab TV & phòng
                   (gán TV, xem/đổi QR khách, gỡ máy tính bảng, admin thêm/xoá phòng, in thẻ đánh giá).
     kho.html, nhac.html — kho karaoke và nhạc TV (Worker kho-karaoke / nhac-playlist riêng, không đổi).

   ĐƯỜNG DẪN CỦA WORKER:
     POST /api               — API quầy + gọi lễ tân (body JSON {action,...}), giữ đúng tên action cũ của Order.
     GET  /ws                — WebSocket kênh phòng (TV / máy tính bảng / điện thoại khách).
     GET  /quay/ws           — WebSocket "cái chuông" của màn quầy (mỗi chi nhánh một QuayHub): có đơn / đổi trạng thái
                               / mở-đóng phòng thì quầy tải lại ngay. Phiên quầy gửi qua Sec-WebSocket-Protocol 'tok.<phiên>'.
     POST /api/tv/pair/*     — TV (hoặc máy tính bảng, kind:'tb') chưa gán phòng xin mã 6 số, chờ quầy gán.
                               Máy tính bảng gán xong nhận thêm quyền thiết bị (dv) của chi nhánh.
     POST /api/tablet/claim  — máy tính bảng ĐÃ có quyền thiết bị quét QR trên TV để vào/đổi phòng (cùng chi nhánh).
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
     Biến   : ALLOWED_ORIGINS (mặc định https://bmb.id.vn), NET_CHECK (off|warn|on), TB_NET (on|off)
     Binding: D1 DB → bmb_data ; Durable Object ROOM → Room, REG → Registry, NHAC → NhacRoom, QHUB → QuayHub
   THÔNG BÁO ĐẨY (Web Push, 10/2026): mỗi máy bật trong quay.html (nút 🔔) → đơn mới hiện thông báo có nút Tiếp nhận,
     đã xác nhận → nút Đã xong (sw-quay.js gọi action push.act, có chữ ký). Máy đang mở trang quầy thì không đẩy trùng.
     Bảng order_push_sub + order_meta (khoá VAPID — đừng xoá) tự tạo. Biến PUSH_LETAN=0 tắt đẩy (chuông WebSocket vẫn chạy). NHAC_PHUT (mặc định 3; 0 = tắt): đơn MỚI quá hạn chưa tiếp nhận thì đẩy thêm 1 thông báo nhắc.
   TELEGRAM: yêu cầu gọi lễ tân (mới / xác nhận / đã phục vụ / huỷ) báo cho quản lý + nhân viên quầy chi nhánh (xem tgDon: có nút Tiếp nhận / Đã xong / Huỷ / Đã nhập POS ngay trên Telegram). CHƯA CÓ: nhắc lại khi quá hạn (SLA); học IP chi nhánh
   ============================================================ */
import { DurableObject } from 'cloudflare:workers';

const enc = new TextEncoder();
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;                                  // mã phòng = order_phong.id của Order (vd P1A2B3C4D5E6)
const TOKEN_RE = /^([A-Za-z0-9_-]{1,40})\.(\d{1,6})\.([\w-]{22})$/;
const ACTIONS = new Set(['add', 'play', 'next', 'replay', 'mute', 'vol', 'prio', 'up', 'remove', 'hello', 'seek']);
const MAX_MSG = 4096, MAX_STATE = 131072, MAX_REMOTES = 2, RATE_PER_SEC = 15;
const SVC_ACTIVE_MS = 2 * 3600 * 1000, SVC_DONE_MS = 15 * 1000;     // yêu cầu gọi lễ tân trên TV: đang xử lý hiện tối đa 2 giờ; xong/huỷ hiện 15 giây

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
/* Quyền thiết bị của máy tính bảng: dv.<chi nhánh (base64url)>.<đời>.<ngẫu nhiên>.<chữ ký>
   Quầy cấp khi gán máy tính bảng bằng mã 6 số. Có quyền này máy mới tự quét QR trên TV để vào/đổi phòng (cùng chi nhánh).
   Quản lý bấm "Thu hồi mọi máy tính bảng" → tăng đời của chi nhánh → mọi quyền cũ hết hiệu lực. */
const DV_RE = /^dv\.([A-Za-z0-9_-]{1,80})\.(\d{1,6})\.([A-Za-z0-9_-]{10})\.([\w-]{22})$/;
const b64uS = t => b64uB(enc.encode(String(t)));
const unb64uS = t => { try{ const b = atob(String(t).replace(/-/g, '+').replace(/_/g, '/')); return new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))); }catch(e){ return ''; } };
async function devGen(env, branch, bump){ const r = await callR(regStub(env), '/dev/gen', { branch: String(branch || ''), bump: !!bump }); return +(r.data && r.data.gen) || 0; }
async function mkDev(env, branch){
  const gen = await devGen(env, branch), rnd = b64uB(crypto.getRandomValues(new Uint8Array(8))).slice(0, 10);
  return 'dv.' + b64uS(branch) + '.' + gen + '.' + rnd + '.' + await hmac(env.SECRET, 'dev|' + branch + '|' + gen + '|' + rnd);
}
async function devOk(env, t){                         // trả mã chi nhánh nếu quyền thiết bị còn hiệu lực
  const m = DV_RE.exec(String(t || '')); if(!m) return '';
  const branch = unb64uS(m[1]), gen = +m[2];
  if(!branch || !same(m[4], await hmac(env.SECRET, 'dev|' + branch + '|' + gen + '|' + m[3]))) return '';
  return gen === await devGen(env, branch) ? branch : '';
}

/* ---------- Tiện ích ---------- */
const origins = env => String(env.ALLOWED_ORIGINS || 'https://bmb.id.vn').split(',').map(s => s.trim()).filter(Boolean);
function cors(req, env){
  const o = req.headers.get('Origin');
  const h = { 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'content-type, x-pass, x-session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS' };
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
// Icon món: emoji, hoặc 'img:<10 hex>' = ảnh trong R2 (khóa mon/<10 hex>, xem khối "Ảnh món" phía dưới)
const iconChu = v => (/^img:[0-9a-f]{10}$/.test(String(v || '')) ? '' : String(v || ''));
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
/* Chỉ mục cho các câu hỏi chạy nhiều nhất (quầy hỏi đơn 45 giây/lần mỗi màn, khách gửi yêu cầu). Không có chỉ mục thì mỗi lần hỏi
   D1 đọc LẠI CẢ BẢNG order_don (càng lâu càng nhiều đơn → chậm + tốn lượt đọc). Tạo một lần mỗi isolate, có rồi thì bỏ qua. */
let idxXong = false;
async function bangChiMuc(env) {
  if (idxXong) return; idxXong = true;
  try {
    await env.DB.batch([
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_order_don_cn_tao ON order_don (chi_nhanh_id, tao_luc)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_order_don_phong_tao ON order_don (phong_id, tao_luc)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_order_phong_cn ON order_phong (chi_nhanh_id)')
    ]);
  } catch (e) { console.error('bangChiMuc:', e); }
}
async function handleApi(request, env, ctx) {
    await bangChiMuc(env);
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
        case 'don.tao':                  res = await donTao(env, body, ctx); break;   // khách / máy tính bảng: mã kênh phòng (body.r, body.role)
        case 'don.trangThai':            res = await donTrangThai(env, body); break;
        case 'don.cuaPhong':             res = await donCuaPhong(env, body); break;
        case 'auth.dangNhap':
        case 'auth.login':               res = await authDangNhap(env, body, ip); break;
        case 'quay.feed':                res = await quayFeed(env, body); break;
        case 'quay.don':                 res = await quayDon(env, body, ctx); break;
        case 'quay.phong':               res = await quayPhong(env, body, ctx); break;
        case 'quay.tv':                  res = await quayTv(env, body); break;
        case 'quay.nhatKy':              res = await quayNhatKy(env, body); break;
        case 'admin.knTongQuan':         res = await adminKnTongQuan(env, body); break;
        case 'admin.knNhatKy':           res = await adminKnNhatKy(env, body); break;
        case 'admin.knIp':               res = await adminKnIp(env, body); break;
        case 'admin.knIpLs':             res = await adminKnIpLs(env, body); break;
        case 'admin.knMay':              res = await adminKnMay(env, body); break;
        case 'quay.ganTv':               res = await quayGanTv(env, body, ip); break;
        case 'quay.tvCheck':             res = await quayTvCheck(env, body, ip); break;
        case 'quay.doiQr':               res = await quayDoiQr(env, body); break;
        case 'quay.goMtb':               res = await quayGoMtb(env, body); break;
        case 'quay.thuHoiMtb':           res = await quayThuHoiMtb(env, body); break;
        case 'quay.goTv':                res = await quayGoTv(env, body); break;
        case 'quay.pos':                 res = await quayPos(env, body, ctx); break;
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
        case 'admin.seekGet':            res = await adminSeekGet(env, body); break;
        case 'admin.seekSet':            res = await adminSeekSet(env, body); break;
        case 'admin.decoGet':            res = await adminDecoGet(env, body); break;
        case 'admin.decoSet':            res = await adminDecoSet(env, body); break;
        case 'admin.scoreGet':           res = await adminScoreGet(env, body); break;
        case 'admin.scoreSet':           res = await adminScoreSet(env, body); break;
        case 'admin.phongThem':          res = await adminPhongThem(env, body); break;
        case 'admin.phongXoa':           res = await adminPhongXoa(env, body); break;
        case 'admin.taiKhoan.danhSach':  res = await tkDanhSach(env, body); break;
        case 'admin.taiKhoan.tao':       res = await tkTao(env, body); break;
        case 'admin.taiKhoan.khoa':      res = await tkKhoa(env, body); break;
        case 'admin.taiKhoan.datLaiMk':  res = await tkDatLaiMk(env, body); break;
        case 'admin.taiKhoan.quyenMenu': res = await tkQuyenMenu(env, body); break;
        case 'push.key':                 res = await pushKey(env); break;                 // khoá công khai VAPID (không cần đăng nhập)
        case 'push.subscribe':           res = await pushDangKy(env, body, request); break;
        case 'push.unsubscribe':         res = await pushHuyDangKy(env, body); break;
        case 'push.test':                res = await pushThu(env, body); break;
        case 'push.act':                 res = await pushBam(env, body, ctx); break;     // nút Tiếp nhận / Đã xong ngay trên thông báo (service worker / app gọi, có chữ ký)
        case 'app.dangKy':               res = await appDangKy(env, body, request); break;   // app BMBPlayer chế độ Quầy: xin khoá máy (cần phiên quầy)
        case 'app.sync':                 res = await appSync(env, body); break;              // dịch vụ nền của app: đơn đang mở + nút có chữ ký
        case 'app.huy':                  res = await appHuy(env, body); break;               // đăng xuất / tắt nhận trên app
        case 'app.veAdmin':              res = await appVeAdmin(env, body); break;           // quản lý: mở admin.html (Bảo trì / Đặt phòng) không đăng nhập lại
        case 'tg.trangThai':             res = await tgRiengTrangThai(env, body); break;   // Telegram riêng của chính tài khoản đang đăng nhập (quản lý + nhân viên quầy)
        case 'tg.taoMa':                 res = await tgRiengTaoMa(env, body); break;
        case 'tg.tamDung':               res = await tgRiengTamDung(env, body); break;
        case 'tg.ngat':                  res = await tgRiengNgat(env, body); break;
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

async function donTao(env, body, ctx) {
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
  await baoLeTan(env, phong.id, { id, st: 'MOI', items, at: now });     // TV của phòng hiện "Đã gửi"
  chayNen(ctx, tgDon(env, id));       // Telegram quản lý + nhân viên quầy (kèm nút Tiếp nhận / Huỷ)
  chayNen(ctx, baoQuayDon(env, id));  // quầy cùng chi nhánh: chuông WebSocket (hàng đợi tự tải lại) + thông báo đẩy có nút Tiếp nhận
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
    sieuAdmin: tk.vai_tro === 'admin' && Number(tk.sieu_admin) === 1,   // chỉ admin cao nhất mới thấy mục Phát hành APK
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

// Đổi trạng thái 1 đơn — dùng chung cho quầy (quay.don) và nút trên Telegram. cn = chi nhánh người thao tác. Trả {ok} hoặc {ok:false, error, msg, status}.
async function doiTrangThai(env, ctx, orderId, act, cn, user) {
  const don = await env.DB.prepare('SELECT chi_nhanh_id, trang_thai, dev_id, phong_id, ten_phong, items, ghi_chu, tao_luc FROM order_don WHERE id = ?').bind(orderId).first();
  if (!don) return { ok: false, error: 'not_found', status: 400 };
  if (don.chi_nhanh_id !== cn) return { ok: false, error: 'forbidden', status: 403 };

  const now = Date.now();
  let sql, params;
  if (act === 'nhan') {
    if (don.dev_id) {
      const chan = await env.DB.prepare(
        'SELECT 1 FROM order_chan_tb WHERE dev_id = ? AND chi_nhanh_id = ? AND den_luc > ?'
      ).bind(don.dev_id, don.chi_nhanh_id, now).first();
      if (chan) return { ok: false, error: 'device_blocked', status: 403, msg: 'Thiết bị gửi đơn này đang bị chặn — hãy huỷ đơn.' };
    }
    sql = `UPDATE order_don SET trang_thai='NHAN', cap_nhat_luc=?, nhan_luc=?, nguoi_xu_ly=? WHERE id=? AND trang_thai='MOI'`;
    params = [now, now, user, orderId];
  } else if (act === 'xong') {
    sql = `UPDATE order_don SET trang_thai='XONG', cap_nhat_luc=?, xong_luc=? WHERE id=? AND trang_thai='NHAN'`;
    params = [now, now, orderId];
  } else {
    sql = `UPDATE order_don SET trang_thai='HUY', cap_nhat_luc=?, nguoi_xu_ly=? WHERE id=? AND trang_thai IN ('MOI','NHAN')`;
    params = [now, user, orderId];
  }
  const r = await env.DB.prepare(sql).bind(...params).run();
  if (!r.meta.changes) return { ok: false, error: 'khong_doi_duoc_trang_thai', status: 400, msg: 'Đơn đã được người khác xử lý. Màn hình sẽ tự cập nhật.' };
  let items = []; try { items = JSON.parse(don.items); } catch (e) {}
  const stMoi = act === 'nhan' ? 'NHAN' : act === 'xong' ? 'XONG' : 'HUY';
  await baoLeTan(env, don.phong_id, { id: orderId, st: stMoi, items, at: don.tao_luc });   // TV hiện "Đã xác nhận / Đã phục vụ / Đã huỷ"
  return { ok: true, st: stMoi };
}

async function quayDon(env, body, ctx) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const orderId = s(body.orderId, 40);
  const act = s(body.act, 10);
  if (!orderId || !['nhan', 'huy', 'xong'].includes(act)) return fail('missing_or_bad_params');
  const r = await doiTrangThai(env, ctx, orderId, act, ss.b, ss.u);
  if (!r.ok) return fail(r.error, r.status || 400, r.msg);
  chayNen(ctx, tgDon(env, orderId, { nguoi: ss.u }));       // Telegram: sửa tin nhắn của đơn (cùng nội dung như khi bấm nút trên Telegram)
  chayNen(ctx, baoQuayDon(env, orderId, { nguoi: ss.u }));   // quầy khác + thông báo đẩy đổi theo trạng thái mới
  return ok({});
}

async function quayPhong(env, body, ctx) {
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
  chayNen(ctx, pokeQuay(env, ss.b, 'phong'));       // màn quầy khác của chi nhánh cập nhật lưới phòng ngay
  return ok({});
}

async function danhDauPos(env, orderId) {
  await env.DB.prepare('UPDATE order_don SET da_nhap_pos = 1 WHERE id = ?').bind(orderId).run();
}
async function quayPos(env, body, ctx) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const orderId = s(body.orderId, 40);
  if (!orderId) return fail('missing_orderId');
  const [, loi2] = await donCuaChiNhanh(env, ss, orderId, 'chi_nhanh_id');
  if (loi2) return loi2;
  await danhDauPos(env, orderId);
  chayNen(ctx, tgDon(env, orderId));       // tin nhắn Telegram đổi thành "Đã nhập POS", mất nút
  chayNen(ctx, baoQuayDon(env, orderId, { push: false }));   // chỉ báo các màn quầy tải lại, không đẩy thông báo
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
/* ---------- Công tắc "thanh tua bài" trên điện thoại / máy tính bảng (admin bật/tắt ở quay.html → Cài đặt) ----------
   Lưu ở order_meta khoá 'seek_on' ('1' | '0'); chưa đặt = BẬT. Áp dụng cho mọi phòng. TV + remote nhận cờ `seek` trong tin 'room';
   Worker còn chặn lệnh 'seek' khi đang tắt (không tin vào trang). Bộ nhớ đệm 20 giây trong mỗi isolate. */
let seekCache = { v: true, at: 0 };
async function seekOn(env) {
  if (Date.now() - seekCache.at < 20000) return seekCache.v;
  let v = true;
  try { const r = await env.DB.prepare(`SELECT v FROM order_meta WHERE k = 'seek_on'`).first(); if (r && r.v === '0') v = false; } catch (e) { /* chưa có bảng = mặc định bật */ }
  seekCache = { v, at: Date.now() };
  return v;
}
async function adminSeekGet(env, body) {
  const [, loi] = await canPhien(env, body, 'admin');
  if (loi) return loi;
  seekCache.at = 0;
  return ok({ on: await seekOn(env) });
}
async function adminSeekSet(env, body) {
  const [, loi] = await canPhien(env, body, 'admin');
  if (loi) return loi;
  const on = body.on === true || body.on === 1 || body.on === '1';
  await pushBangSan(env);                                   // tạo order_meta nếu chưa có
  await env.DB.prepare(`INSERT INTO order_meta (k, v) VALUES ('seek_on', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(on ? '1' : '0').run();
  seekCache = { v: on, at: Date.now() };
  return ok({ on });
}
/* ---------- Trang trí tivi theo dịp lễ (admin chọn ở quay.html → Cài đặt) ----------
   Lưu ở order_meta khoá 'deco': 'auto' (mặc định: TV tự chọn theo ngày) | 'off' | khoá chủ đề ép dùng luôn.
   TV hỏi GET /api/deco (công khai, chỉ trả chuỗi này) mỗi 10 phút. Danh sách chủ đề phải khớp THEMES trong index.html. */
const DECO_OK = ['auto', 'off', 'hoa', 'tim', 'halloween', 'noel', 'co', 'tet', 'trungthu', 'namMoi'];
let decoCache = { v: 'auto', at: 0 };
async function decoGet(env) {
  if (Date.now() - decoCache.at < 60000) return decoCache.v;
  let v = 'auto';
  try { const r = await env.DB.prepare(`SELECT v FROM order_meta WHERE k = 'deco'`).first(); if (r && DECO_OK.includes(r.v)) v = r.v; } catch (e) { /* chưa có bảng = tự động */ }
  decoCache = { v, at: Date.now() };
  return v;
}
async function adminDecoGet(env, body) {
  const [, loi] = await canPhien(env, body, 'admin');
  if (loi) return loi;
  decoCache.at = 0;
  return ok({ deco: await decoGet(env) });
}
async function adminDecoSet(env, body) {
  const [, loi] = await canPhien(env, body, 'admin');
  if (loi) return loi;
  const v = String(body.deco || '');
  if (!DECO_OK.includes(v)) return fail('bad_deco', 400, 'Chủ đề không hợp lệ.');
  await pushBangSan(env);
  await env.DB.prepare(`INSERT INTO order_meta (k, v) VALUES ('deco', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(v).run();
  decoCache = { v, at: Date.now() };
  return ok({ deco: v });
}
/* ---------- Điểm vui cuối bài (admin bật/tắt cho TOÀN BỘ chi nhánh ở quay.html → Cài đặt) ----------
   Lưu ở order_meta khoá 'score': 'off' (mặc định) | 'on' (có tiếng trống/vỗ tay) | 'mute' (im lặng). TV nhận cùng GET /api/deco. */
const SCORE_OK = ['off', 'on', 'mute'];
let scoreCache = { v: 'off', at: 0 };
async function scoreGet(env) {
  if (Date.now() - scoreCache.at < 60000) return scoreCache.v;
  let v = 'off';
  try { const r = await env.DB.prepare(`SELECT v FROM order_meta WHERE k = 'score'`).first(); if (r && SCORE_OK.includes(r.v)) v = r.v; } catch (e) { /* chưa có bảng = tắt */ }
  scoreCache = { v, at: Date.now() };
  return v;
}
async function adminScoreGet(env, body) {
  const [, loi] = await canPhien(env, body, 'admin');
  if (loi) return loi;
  scoreCache.at = 0;
  return ok({ score: await scoreGet(env) });
}
async function adminScoreSet(env, body) {
  const [, loi] = await canPhien(env, body, 'admin');
  if (loi) return loi;
  const v = String(body.score || '');
  if (!SCORE_OK.includes(v)) return fail('bad_score', 400, 'Giá trị không hợp lệ.');
  await pushBangSan(env);
  await env.DB.prepare(`INSERT INTO order_meta (k, v) VALUES ('score', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(v).run();
  scoreCache = { v, at: Date.now() };
  return ok({ score: v });
}
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
// Telegram: báo yêu cầu gọi lễ tân cho quản lý + nhân viên quầy của đúng chi nhánh
// ============================================================
// Dùng chung bot và tài khoản đã kết nối của app quản lý BMB (bmb-quanly-worker):
//   token bot  = cai_dat.tg_bot_token (D1 bmb_data, không phải secret của Worker này)
//   người nhận = tai_khoan của chi nhánh: vai trò manager / quay, đang hoạt động, đã kết nối (tg_chat_id) và không tạm dừng (tg_tam_dung = 0)
// Gửi khi: có yêu cầu mới · lễ tân xác nhận · đã phục vụ · đã huỷ. Không có giờ im lặng ban đêm (quán mở tới 6 giờ sáng, quầy luôn có người).
// Tắt cả tính năng: đặt biến TG_LETAN = "0". Lỗi Telegram không bao giờ làm hỏng việc gửi/xử lý yêu cầu.
const TG_TIEUDE = { MOI: '🛎️ <b>Yêu cầu gọi lễ tân mới</b>', NHAN: '✅ <b>Lễ tân đã xác nhận</b>', XONG: '🎉 <b>Đã phục vụ</b>', HUY: '⚠️ <b>Yêu cầu đã huỷ</b>' };
const escHtml = t => String(t == null ? '' : t).replace(/[&<>]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
const hhmmVn = ms => { const d = new Date(ms + VN_MS); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
// Chạy nền (không bắt khách chờ Telegram); không có ctx (thử nghiệm) thì cứ để chạy
function chayNen(ctx, p) { if (ctx && ctx.waitUntil) ctx.waitUntil(p); }

// ---- Nút bấm ngay trên Telegram (cùng một bộ xử lý với quầy: đổi ở đâu thì tin nhắn + quầy + TV cập nhật theo) ----
//   Mỗi yêu cầu = 1 tin nhắn / người nhận; đổi trạng thái thì SỬA tin nhắn đó (không đẻ thêm tin), nút đổi theo trạng thái.
//   Nút gửi callback_data "od:<việc>:<mã đơn>" (n tiếp nhận · x đã xong · h hỏi huỷ · H xác nhận huỷ · b quay lại · p đã nhập POS).
//   Bot dùng chung với app quản lý BMB nên webhook của bot nằm ở bmb-quanly-worker: Worker đó chuyển callback "od:" sang /api/tg/relay (xem README).
let tgBangXong = false;
async function tgBangSan(env) {
  if (tgBangXong) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS order_tg_msg (don_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, PRIMARY KEY (don_id, chat_id))').run();
  tgBangXong = true;
}
async function tgGoi(token, method, payload) {
  const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000)
  });
  return r.json().catch(() => ({}));      // chỉ đọc kết quả, không ghi log nội dung (tránh lộ chat/token)
}
const tgToken = async env => String(((await env.DB.prepare(`SELECT gia_tri FROM cai_dat WHERE khoa = 'tg_bot_token'`).first()) || {}).gia_tri || '').trim();
const coNuoc = items => (items || []).some(i => i && i.type === 'DR');

function tgBanPhim(don, items) {
  const id = don.id, hang = [];
  if (don.trang_thai === 'MOI') hang.push([{ text: '✅ Tiếp nhận', callback_data: 'od:n:' + id }, { text: '✖ Huỷ', callback_data: 'od:h:' + id }]);
  else if (don.trang_thai === 'NHAN') hang.push([{ text: '🎉 Đã xong', callback_data: 'od:x:' + id }, { text: '✖ Huỷ', callback_data: 'od:h:' + id }]);
  if ((don.trang_thai === 'NHAN' || don.trang_thai === 'XONG') && coNuoc(items) && !don.da_nhap_pos) hang.push([{ text: '🧾 Đã nhập POS', callback_data: 'od:p:' + id }]);
  return { inline_keyboard: hang };
}
const tgBanPhimHoiHuy = id => ({ inline_keyboard: [[{ text: '⚠️ Xác nhận huỷ đơn', callback_data: 'od:H:' + id }, { text: 'Không', callback_data: 'od:b:' + id }]] });

function tgNoiDung(don, items, nguoi, nguoiLam) {
  const mon = items.map(i => '• ' + (iconChu(i.icon) ? escHtml(iconChu(i.icon)) + ' ' : '') + escHtml(i.label) + (i.type === 'DR' && i.qty > 1 ? ' ×' + (+i.qty | 0) : '')).join('\n');
  const dong = [TG_TIEUDE[don.trang_thai] || TG_TIEUDE.MOI, 'Phòng: <b>' + escHtml(don.ten_phong) + '</b> · #' + escHtml(String(don.id).slice(-6).toUpperCase()), mon];
  if (don.ghi_chu) dong.push('Ghi chú: “' + escHtml(String(don.ghi_chu).slice(0, 200)) + '”');
  if (don.trang_thai === 'MOI') {
    dong.push('Gửi từ: ' + (don.nguon === 'TABLET' ? 'máy tính bảng' : 'điện thoại khách'));
    if (don.nghi_ngo) dong.push('⚠️ Phòng đang ở trạng thái đóng lúc khách gửi');
  } else {
    const ten = nguoiLam || nguoi;
    if (ten) dong.push((don.trang_thai === 'NHAN' ? 'Xác nhận: ' : don.trang_thai === 'XONG' ? 'Phục vụ: ' : 'Huỷ: ') + escHtml(ten));
  }
  if (coNuoc(items) && (don.trang_thai === 'NHAN' || don.trang_thai === 'XONG')) dong.push(don.da_nhap_pos ? '🧾 Đã nhập POS' : '🧾 Chưa nhập POS');
  dong.push('🕒 ' + hhmmVn(Date.now()));
  return dong.join('\n');
}

// Gửi / sửa tin nhắn của 1 đơn cho quản lý + nhân viên quầy đúng chi nhánh. opt.nguoi = tài khoản vừa bấm (hiện "Xác nhận/Phục vụ/Huỷ: tên")
async function tgDon(env, orderId, opt = {}) {
  try {
    if (String(env.TG_LETAN || '1') === '0' || !env.DB) return;
    const don = await env.DB.prepare('SELECT id, chi_nhanh_id, ten_phong, items, ghi_chu, nguon, nghi_ngo, trang_thai, nguoi_xu_ly, da_nhap_pos FROM order_don WHERE id = ?').bind(orderId).first();
    if (!don || !don.chi_nhanh_id) return;
    await tgBangSan(env);
    const lenh = [
      env.DB.prepare(`SELECT gia_tri FROM cai_dat WHERE khoa = 'tg_bot_token'`),
      env.DB.prepare(
        `SELECT tg_chat_id FROM tai_khoan
         WHERE chi_nhanh_id = ? AND vai_tro IN ('manager', 'quay') AND hoat_dong = 1 AND tg_chat_id <> '' AND tg_tam_dung = 0`
      ).bind(don.chi_nhanh_id),
      env.DB.prepare('SELECT chat_id, message_id FROM order_tg_msg WHERE don_id = ?').bind(orderId),
      env.DB.prepare('SELECT username, ho_ten FROM tai_khoan WHERE username IN (?, ?)').bind(don.nguoi_xu_ly || '', opt.nguoi || '')
    ];
    const rs = await env.DB.batch(lenh);
    const token = String((rs[0].results[0] || {}).gia_tri || '').trim();
    const chats = [...new Set(rs[1].results.map(r => String(r.tg_chat_id).trim()).filter(Boolean))];
    if (!token || !chats.length) return;
    const daGui = new Map(rs[2].results.map(r => [String(r.chat_id), r.message_id]));
    const ten = u => u ? ((rs[3].results.find(r => r.username === u) || {}).ho_ten || u) : '';
    let items = []; try { items = JSON.parse(don.items); } catch (e) {}
    const text = tgNoiDung(don, items, ten(don.nguoi_xu_ly), ten(opt.nguoi));
    const reply_markup = tgBanPhim(don, items);

    await Promise.allSettled(chats.map(async chat => {
      const cu = daGui.get(chat);
      if (cu) {
        const r = await tgGoi(token, 'editMessageText', { chat_id: chat, message_id: cu, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup });
        if (r.ok || /not modified/i.test(String(r.description || ''))) return;
      }
      const r = await tgGoi(token, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup });
      if (r.ok && r.result && r.result.message_id)
        await env.DB.prepare('INSERT OR REPLACE INTO order_tg_msg (don_id, chat_id, message_id) VALUES (?,?,?)').bind(orderId, chat, r.result.message_id).run();
    }));
    // dọn bản ghi cũ (đơn quá 3 ngày) để bảng không phình — chỉ làm khi có đơn mới
    if (don.trang_thai === 'MOI') await env.DB.prepare('DELETE FROM order_tg_msg WHERE don_id IN (SELECT id FROM order_don WHERE tao_luc < ?)').bind(Date.now() - 3 * 24 * 3600 * 1000).run();
  } catch (e) { console.error('tgDon:', e && e.name); }   // không ghi e.message: có thể chứa địa chỉ có token
}

// Bấm nút trên Telegram: cq = callback_query do Telegram gửi. Chỉ tài khoản quản lý/quầy ĐÚNG chi nhánh của đơn, bấm trong chat riêng với bot.
async function tgCallback(env, ctx, cq) {
  let token = '';
  const tra = (text, hienHop) => tgGoi(token, 'answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: !!hienHop });
  try {
    if (String(env.TG_LETAN || '1') === '0' || !env.DB || !cq || !cq.id) return;
    token = await tgToken(env); if (!token) return;
    const m = /^od:([nxhHbp]):([A-Za-z0-9]{4,12})$/.exec(String(cq.data || ''));
    if (!m) return await tra('Nút không hợp lệ.');
    const chat = cq.message && cq.message.chat, tu = cq.from;
    if (!chat || !tu || chat.type !== 'private' || String(chat.id) !== String(tu.id)) return await tra('Chỉ bấm được trong tin nhắn riêng với bot.', true);
    const tk = await env.DB.prepare(
      `SELECT username, chi_nhanh_id FROM tai_khoan WHERE tg_chat_id = ? AND hoat_dong = 1 AND vai_tro IN ('manager', 'quay') LIMIT 1`
    ).bind(String(chat.id)).first();
    if (!tk) return await tra('Tài khoản Telegram này chưa được cấp quyền xử lý đơn.', true);
    const [, viec, id] = m;
    const don = await env.DB.prepare('SELECT id, chi_nhanh_id, trang_thai, items, da_nhap_pos FROM order_don WHERE id = ?').bind(id).first();
    if (!don || don.chi_nhanh_id !== tk.chi_nhanh_id) return await tra('Không có đơn này ở chi nhánh của bạn.', true);
    let items = []; try { items = JSON.parse(don.items); } catch (e) {}
    const phim = markup => tgGoi(token, 'editMessageReplyMarkup', { chat_id: chat.id, message_id: cq.message.message_id, reply_markup: markup });

    if (viec === 'h') { await phim(tgBanPhimHoiHuy(id)); return await tra('Bấm "Xác nhận huỷ đơn" để huỷ.'); }
    if (viec === 'b') { await phim(tgBanPhim(don, items)); return await tra('Đã giữ nguyên đơn.'); }

    let nguoiLam = '';       // chỉ ghi tên người bấm khi bấm đó thật sự đổi được trạng thái
    if (viec === 'p') {
      await danhDauPos(env, id);
      await tra('Đã ghi nhận nhập POS ✓');
    } else {
      const act = viec === 'n' ? 'nhan' : viec === 'x' ? 'xong' : 'huy';
      const r = await doiTrangThai(env, ctx, id, act, tk.chi_nhanh_id, tk.username);
      if (r.ok) nguoiLam = tk.username;
      await tra(r.ok ? (act === 'nhan' ? 'Đã tiếp nhận ✓' : act === 'xong' ? 'Đã xong ✓' : 'Đã huỷ đơn') : (r.msg || 'Không làm được.'), !r.ok);
    }
    await tgDon(env, id, { nguoi: nguoiLam });      // sửa tin nhắn (cho mọi người nhận) theo trạng thái mới — kể cả khi đơn đã bị người khác xử lý, để nút cũ biến mất
    if (viec === 'p' || nguoiLam) await baoQuayDon(env, id, { nguoi: nguoiLam, push: !!nguoiLam });   // màn quầy tải lại; đổi trạng thái thì đẩy thông báo
  } catch (e) { console.error('tgCallback:', e && e.name); }
}

// ============================================================
// Kênh phòng ↔ API quầy / gọi lễ tân
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
// Báo TV của phòng trạng thái yêu cầu gọi lễ tân (MOI đã gửi · NHAN đã xác nhận · XONG đã phục vụ · HUY đã huỷ) — lỗi thì bỏ qua, đơn vẫn đã lưu
async function baoLeTan(env, phongId, don) {
  try { await call(roomStub(env, phongId), '/svc', { id: phongId, don }); }
  catch (e) { console.error('baoLeTan:', e); }
}
async function phongCuaChiNhanh(env, ss, roomId) {
  if (!roomId) return [null, fail('missing_roomId')];
  const p = await env.DB.prepare('SELECT id, ten_phong, chi_nhanh_id FROM order_phong WHERE id = ?').bind(roomId).first();
  if (!p || p.chi_nhanh_id !== ss.b) return [null, fail('not_found', 404, 'Không có phòng này ở chi nhánh đang chọn.')];
  return [p, null];
}

// ---------- quay.nhatKy: nhật ký kết nối của các phòng (mỗi phòng giữ 60 sự kiện gần nhất) — tìm nguyên nhân phòng/máy bị out ----------
async function quayNhatKy(env, body) {
  const [ss, loi] = await canPhien(env, body, 'quanLy');
  if (loi) return loi;
  const { results } = await env.DB.prepare('SELECT id, ten_phong FROM order_phong WHERE chi_nhanh_id = ?').bind(ss.b).all();
  const ds = await Promise.all((results || []).map(async r => {
    try { const x = await call(roomStub(env, r.id), '/nhatky', { id: r.id }); return (x.nk || []).map(e => Object.assign({ p: r.ten_phong }, e)); } catch (e) { return []; }
  }));
  const all = [].concat(...ds).sort((a, b) => b.t - a.t).slice(0, 300);
  return ok({ log: all, now: Date.now() });
}
// ============================================================
// THEO DÕI KẾT NỐI dài ngày (tab 🔌 Kết nối — chỉ admin)
// Mỗi sự kiện nối / rớt / server cắt / từ chối / mở-đóng phòng của mọi phòng được ghi thêm vào D1 (ngoài 60 dòng trong phòng).
// Thời gian lưu — "theo dõi lâu" cho thiết bị của quán, "theo dõi nhanh" cho điện thoại khách:
//   • kn_sk  (chi tiết từng sự kiện): TV / máy tính bảng / mở-đóng phòng 30 ngày; điện thoại khách 7 ngày
//   • kn_ngay, kn_ip_ngay (tổng hợp theo ngày kinh doanh), kn_ip (IP chi nhánh đã dùng): 180 ngày
//   • kn_may (TV / máy tính bảng của từng phòng: app, IP, nhà mạng, lần nối/rớt cuối): giữ luôn, mỗi phòng 2 dòng
// "Rớt" = máy tự mất kết nối (dut) hoặc server phát hiện máy im lặng quá lâu rồi cắt (cat mã 4007).
// ============================================================
const KN_GIU_TB = 30, KN_GIU_DT = 7, KN_GIU_TH = 180;
let knSan = false, knDonLuc = 0;
async function knBang(env) {
  if (knSan) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS kn_sk (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, cn TEXT NOT NULL DEFAULT '',
      phong_id TEXT NOT NULL DEFAULT '', phong TEXT NOT NULL DEFAULT '', ev TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', code INTEGER,
      why TEXT, ip TEXT NOT NULL DEFAULT '', isp TEXT, asn INTEGER, colo TEXT, dev TEXT, ua TEXT, tuoi INTEGER, im INTEGER, n INTEGER, dg TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS kn_sk_t ON kn_sk (t)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS kn_sk_cn ON kn_sk (cn, t)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS kn_sk_ph ON kn_sk (phong_id, t)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS kn_ngay (ngay TEXT NOT NULL, cn TEXT NOT NULL, phong_id TEXT NOT NULL, role TEXT NOT NULL,
      phong TEXT NOT NULL DEFAULT '', noi INTEGER NOT NULL DEFAULT 0, rot INTEGER NOT NULL DEFAULT 0, cat INTEGER NOT NULL DEFAULT 0,
      tuchoi INTEGER NOT NULL DEFAULT 0, loi INTEGER NOT NULL DEFAULT 0, mo INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ngay, phong_id, role))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS kn_ngay_cn ON kn_ngay (cn, ngay)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS kn_ip (cn TEXT NOT NULL, ip TEXT NOT NULL, isp TEXT, asn INTEGER, colo TEXT, dau INTEGER NOT NULL,
      cuoi INTEGER NOT NULL, noi INTEGER NOT NULL DEFAULT 0, rot INTEGER NOT NULL DEFAULT 0, vai TEXT NOT NULL DEFAULT '', PRIMARY KEY (cn, ip))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS kn_ip_ngay (ngay TEXT NOT NULL, cn TEXT NOT NULL, ip TEXT NOT NULL, noi INTEGER NOT NULL DEFAULT 0,
      rot INTEGER NOT NULL DEFAULT 0, tv INTEGER NOT NULL DEFAULT 0, tb INTEGER NOT NULL DEFAULT 0, dt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ngay, cn, ip))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS kn_may (phong_id TEXT NOT NULL, role TEXT NOT NULL, cn TEXT NOT NULL DEFAULT '', phong TEXT NOT NULL DEFAULT '',
      ip TEXT, isp TEXT, ua TEXT, lan_noi INTEGER, lan_rot INTEGER, tuoi_rot INTEGER, noi INTEGER NOT NULL DEFAULT 0, rot INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (phong_id, role))`)
  ]);
  await env.DB.prepare('ALTER TABLE kn_sk ADD COLUMN dg TEXT').run().catch(() => {});      // bảng tạo từ bản đầu chưa có cột dg (báo cáo từ phía máy)
  knSan = true;
}
/* User-Agent → chuỗi ngắn dễ đọc: "App 2.7 · TV" / "Android 13 · SM-A515F · Chrome 129" / "iPhone iOS 17.5 · Safari" */
function uaGon(ua) {
  ua = String(ua || '');
  if (!ua) return '';
  const app = /BMBPlayerApp\/([\d.]+)\s*\((\w+)\)/.exec(ua);
  if (app) return 'App ' + app[1] + ' · ' + (app[2] === 'tv' ? 'TV' : app[2] === 'tablet' ? 'MTB' : app[2]);
  let os = '', may = '';
  let m = /Android ([\d.]+)(?:;\s*([^;)]+))?/.exec(ua);
  if (m) { os = 'Android ' + m[1]; may = (m[2] || '').replace(/Build\/.*/, '').trim(); if (/^(K|wv)$/.test(may)) may = ''; }
  else if ((m = /(iPhone|iPad)[^)]*OS ([\d_]+)/.exec(ua))) os = m[1] + ' iOS ' + m[2].replace(/_/g, '.');
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux';
  const b = /(Edg|SamsungBrowser|CriOS|Chrome|Firefox|FxiOS)\/(\d+)/.exec(ua);
  let br = b ? { Edg: 'Edge', CriOS: 'Chrome', FxiOS: 'Firefox', SamsungBrowser: 'Samsung' }[b[1]] || b[1] : (/Safari/.test(ua) ? 'Safari' : '');
  if (b) br += ' ' + b[2];
  if (/; wv\)/.test(ua)) br = 'WebView' + (b ? ' ' + b[2] : '');
  return [os, may, br].filter(Boolean).join(' · ').slice(0, 80);
}
const knRot = e => e.ev === 'dut' || (e.ev === 'cat' && e.code === 4007);
/** Ghi 1 sự kiện của phòng vào D1 (gọi từ Room.ghi, nằm trong hàng đợi của phòng). Lỗi D1 không làm hỏng kết nối. */
async function knGhi(env, c, e) {
  if (!env.DB) return;
  await knBang(env);
  const ngay = ngayKinhDoanh(e.t), cn = c.branch || '', pid = c.rid || '', ph = c.name || '';
  if (e.ev === 'tai') {                                    // báo cáo từ phía máy: chỉ lưu chi tiết, không cộng vào số đếm
    await env.DB.prepare(`INSERT INTO kn_sk (t, cn, phong_id, phong, ev, role, ip, isp, dev, ua, dg) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(e.t, cn, pid, ph, 'tai', e.role || '', String(e.ip || ''), e.isp || null, e.dev || null, e.ua || null, JSON.stringify(e.dg || {})).run();
    return;
  }
  const role = e.role || 'phong', rot = knRot(e) ? 1 : 0, ip = String(e.ip || '');
  const vai = e.role === 'tv' ? 'tv' : e.role === 'tablet' ? 'tb' : e.role === 'remote' ? 'dt' : '';
  const st = [
    env.DB.prepare(`INSERT INTO kn_sk (t, cn, phong_id, phong, ev, role, code, why, ip, isp, asn, colo, dev, ua, tuoi, im, n, dg)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(e.t, cn, pid, ph, e.ev, e.role || '', e.code ?? null, e.why ? String(e.why).slice(0, 60) : null,
      ip, e.isp || null, e.asn || null, e.colo || null, e.dev || null, e.ua || null, e.tuoi ?? null, e.im ?? null, e.n ?? null, e.dg ? JSON.stringify(e.dg) : null),
    env.DB.prepare(`INSERT INTO kn_ngay (ngay, cn, phong_id, role, phong, noi, rot, cat, tuchoi, loi, mo) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ngay, phong_id, role) DO UPDATE SET phong = excluded.phong, cn = excluded.cn, noi = noi + excluded.noi, rot = rot + excluded.rot,
      cat = cat + excluded.cat, tuchoi = tuchoi + excluded.tuchoi, loi = loi + excluded.loi, mo = mo + excluded.mo`)
      .bind(ngay, cn, pid, role, ph, e.ev === 'noi' ? 1 : 0, rot, e.ev === 'cat' && !rot ? 1 : 0, e.ev === 'tuchoi' ? 1 : 0, e.ev === 'loi' ? 1 : 0, e.ev === 'mo' ? 1 : 0)
  ];
  if (ip && cn && (e.ev === 'noi' || rot)) {
    st.push(env.DB.prepare(`INSERT INTO kn_ip (cn, ip, isp, asn, colo, dau, cuoi, noi, rot, vai) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cn, ip) DO UPDATE SET isp = COALESCE(excluded.isp, isp), asn = COALESCE(excluded.asn, asn), colo = COALESCE(excluded.colo, colo),
      cuoi = MAX(cuoi, excluded.cuoi), noi = noi + excluded.noi, rot = rot + excluded.rot,
      vai = CASE WHEN excluded.vai = '' OR instr(vai, excluded.vai) > 0 THEN vai ELSE vai || ',' || excluded.vai END`)
      .bind(cn, ip, e.isp || null, e.asn || null, e.colo || null, e.t, e.t, e.ev === 'noi' ? 1 : 0, rot, vai));
    st.push(env.DB.prepare(`INSERT INTO kn_ip_ngay (ngay, cn, ip, noi, rot, tv, tb, dt) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(ngay, cn, ip) DO UPDATE SET noi = noi + excluded.noi, rot = rot + excluded.rot, tv = tv + excluded.tv, tb = tb + excluded.tb, dt = dt + excluded.dt`)
      .bind(ngay, cn, ip, e.ev === 'noi' ? 1 : 0, rot, e.ev === 'noi' && vai === 'tv' ? 1 : 0, e.ev === 'noi' && vai === 'tb' ? 1 : 0, e.ev === 'noi' && vai === 'dt' ? 1 : 0));
  }
  if (pid && (e.role === 'tv' || e.role === 'tablet') && (e.ev === 'noi' || rot)) {
    st.push(e.ev === 'noi'
      ? env.DB.prepare(`INSERT INTO kn_may (phong_id, role, cn, phong, ip, isp, ua, lan_noi, noi) VALUES (?,?,?,?,?,?,?,?,1)
          ON CONFLICT(phong_id, role) DO UPDATE SET cn = excluded.cn, phong = excluded.phong, ip = excluded.ip, isp = COALESCE(excluded.isp, isp),
          ua = COALESCE(excluded.ua, ua), lan_noi = excluded.lan_noi, noi = noi + 1`).bind(pid, e.role, cn, ph, ip || null, e.isp || null, e.ua || null, e.t)
      : env.DB.prepare(`INSERT INTO kn_may (phong_id, role, cn, phong, lan_rot, tuoi_rot, rot) VALUES (?,?,?,?,?,?,1)
          ON CONFLICT(phong_id, role) DO UPDATE SET lan_rot = excluded.lan_rot, tuoi_rot = excluded.tuoi_rot, rot = rot + 1`)
        .bind(pid, e.role, cn, ph, e.t, e.tuoi ?? null));
  }
  await env.DB.batch(st);
  if (Date.now() - knDonLuc > 3600000) { knDonLuc = Date.now(); await knDon(env).catch(err => console.error('knDon', err)); }
}
/** Dọn dữ liệu quá hạn (tối đa 1 lần/giờ mỗi bản Worker, mỗi lần xoá có giới hạn để không nghẽn D1) */
async function knDon(env) {
  const now = Date.now(), ngTH = ngayKinhDoanh(now - KN_GIU_TH * 86400000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM kn_sk WHERE id IN (SELECT id FROM kn_sk WHERE t < ? LIMIT 20000)').bind(now - KN_GIU_TB * 86400000),
    env.DB.prepare(`DELETE FROM kn_sk WHERE id IN (SELECT id FROM kn_sk WHERE t < ? AND role = 'remote' LIMIT 20000)`).bind(now - KN_GIU_DT * 86400000),
    env.DB.prepare('DELETE FROM kn_ngay WHERE ngay < ?').bind(ngTH),
    env.DB.prepare('DELETE FROM kn_ip_ngay WHERE ngay < ?').bind(ngTH),
    env.DB.prepare('DELETE FROM kn_ip WHERE cuoi < ?').bind(now - KN_GIU_TH * 86400000)
  ]);
}
/* ---------- API tab Kết nối (chỉ admin; cn = '' là xem tất cả chi nhánh) ---------- */
async function knPhien(env, body) {
  const ss = await getSession(env, Object.assign({}, body, { branchId: '' }));
  if (!ss) return [null, failSession()];
  if (ss.r !== 'admin') return [null, fail('forbidden', 403, 'Chỉ admin xem được tab Kết nối.')];
  await knBang(env);
  const so = +body.ngay, ngay = so === 15 || so === 30 ? so : so === 1 ? 1 : 7;
  const tu = Date.now() - ngay * 86400000;
  return [{ ss, cn: s(body.cn, 40), ngay, tu, tuNgay: ngayKinhDoanh(tu) }, null];
}
const knCn = (q, cot) => q.cn ? [` AND ${cot} = ?`, [q.cn]] : ['', []];
async function knTenCn(env) {
  const { results } = await env.DB.prepare(`SELECT id, COALESCE(NULLIF(ten_ngan,''), ten, id) AS ten FROM chi_nhanh`).all();
  const m = {}; for (const r of results || []) m[r.id] = r.ten; return m;
}
async function adminKnTongQuan(env, body) {
  const [q, loi] = await knPhien(env, body);
  if (loi) return loi;
  const [w, b] = knCn(q, 'cn'), RT = `(ev = 'dut' OR (ev = 'cat' AND code = 4007))`;
  const [theoCn, theoNgay, topPhong, dongLoat, nhaMang, ten, taiRows, taiTop, dauDl] = await Promise.all([
    env.DB.prepare(`SELECT cn, role, SUM(noi) AS noi, SUM(rot) AS rot, SUM(cat) AS cat, SUM(tuchoi) AS tuchoi, SUM(mo) AS mo
      FROM kn_ngay WHERE ngay >= ?${w} GROUP BY cn, role`).bind(q.tuNgay, ...b).all(),
    env.DB.prepare(`SELECT ngay, role, SUM(noi) AS noi, SUM(rot) AS rot FROM kn_ngay WHERE ngay >= ?${w} GROUP BY ngay, role ORDER BY ngay`).bind(q.tuNgay, ...b).all(),
    env.DB.prepare(`SELECT cn, phong_id, MAX(phong) AS phong, role, SUM(rot) AS rot, SUM(noi) AS noi FROM kn_ngay
      WHERE ngay >= ? AND role IN ('tv','tablet')${w} GROUP BY phong_id, role HAVING SUM(rot) > 0 ORDER BY SUM(rot) DESC LIMIT 15`).bind(q.tuNgay, ...b).all(),
    env.DB.prepare(`SELECT cn, t / 10000 AS w, MIN(t) AS t, COUNT(*) AS so, COUNT(DISTINCT phong_id) AS so_phong,
      GROUP_CONCAT(DISTINCT phong) AS phong, GROUP_CONCAT(DISTINCT role) AS vai, GROUP_CONCAT(DISTINCT isp) AS isp, GROUP_CONCAT(DISTINCT ip) AS ip
      FROM kn_sk WHERE t >= ? AND ${RT}${w} GROUP BY cn, w HAVING COUNT(DISTINCT phong_id) >= 2 ORDER BY w DESC LIMIT 60`).bind(q.tu, ...b).all(),
    env.DB.prepare(`SELECT cn, COALESCE(isp, '?') AS isp, COUNT(DISTINCT ip) AS so_ip, SUM(ev = 'noi') AS noi, SUM(${RT}) AS rot
      FROM kn_sk WHERE t >= ? AND role IN ('tv','tablet')${w} GROUP BY cn, isp ORDER BY rot DESC LIMIT 60`).bind(q.tu, ...b).all(),
    knTenCn(env),
    env.DB.prepare(`SELECT role, json_extract(dg,'$.down') AS d, json_extract(dg,'$.why') AS w, json_extract(dg,'$.on') AS onl, json_extract(dg,'$.hid') AS h
      FROM kn_sk WHERE ev = 'tai' AND t >= ?${w} ORDER BY t DESC LIMIT 4000`).bind(q.tu, ...b).all(),
    env.DB.prepare(`SELECT cn, phong_id, MAX(phong) AS phong, role, COUNT(*) AS n, MAX(json_extract(dg,'$.down')) AS mx, AVG(json_extract(dg,'$.rtt')) AS rtt, MAX(json_extract(dg,'$.rttMax')) AS rttMax
      FROM kn_sk WHERE ev = 'tai' AND role IN ('tv','tablet') AND t >= ?${w} GROUP BY phong_id, role ORDER BY mx DESC LIMIT 10`).bind(q.tu, ...b).all(),
    env.DB.prepare('SELECT MIN(t) AS t FROM kn_sk').first()
  ]);
  /* Mất kết nối bao lâu + nguyên nhân (máy tự báo): phân loại theo lý do máy ghi nhận lúc mất */
  const mat = {}, nn = { ngu: 0, offline: 0, chet: 0, dut: 0, khac: 0 };
  for (const x of taiRows.results || []) {
    const o = mat[x.role] = mat[x.role] || { ds: [] }; if (x.d != null) o.ds.push(+x.d);
    const w0 = String(x.w || '');
    nn[x.h ? 'ngu' : x.onl === 0 ? 'offline' : w0 === 'silent' ? 'chet' : w0 === 'close:1006' ? 'dut' : 'khac']++;
  }
  const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
  const matTk = {};
  for (const k of Object.keys(mat)) { const a = mat[k].ds.sort((x, y) => x - y); matTk[k] = { n: a.length, p50: pct(a, .5), p90: pct(a, .9), max: a.length ? a[a.length - 1] : null }; }
  return ok({ ngay: q.ngay, cn: q.cn, ten, theoCn: theoCn.results, theoNgay: theoNgay.results, topPhong: topPhong.results,
    dongLoat: dongLoat.results, nhaMang: nhaMang.results, mat: matTk, matNguyenNhan: nn, matTop: taiTop.results, dauDuLieu: dauDl ? dauDl.t : null,
    giu: { tb: KN_GIU_TB, dt: KN_GIU_DT, th: KN_GIU_TH }, now: Date.now() });
}
async function adminKnNhatKy(env, body) {
  const [q, loi] = await knPhien(env, body);
  if (loi) return loi;
  let sql = 'SELECT * FROM kn_sk WHERE t >= ?', b = [q.tu];
  if (q.cn) { sql += ' AND cn = ?'; b.push(q.cn); }
  const pid = s(body.phong, 40), role = s(body.role, 10), ev = s(body.ev, 10), ip = s(body.ip, 64), truoc = +body.truoc || 0, quanh = +body.quanh || 0;
  if (pid) { sql += ' AND phong_id = ?'; b.push(pid); }
  if (['tv', 'tablet', 'remote'].includes(role)) { sql += ' AND role = ?'; b.push(role); }
  if (ev === 'rot') sql += ` AND (ev = 'dut' OR (ev = 'cat' AND code = 4007))`;
  else if (['noi', 'dut', 'cat', 'tuchoi', 'mo', 'dong', 'loi', 'xoa', 'tai'].includes(ev)) { sql += ' AND ev = ?'; b.push(ev); }
  if (ip) { sql += ' AND ip = ?'; b.push(ip); }
  if (quanh) { sql += ' AND t BETWEEN ? AND ?'; b.push(quanh - 120000, quanh + 120000); }     // ±2 phút quanh 1 sự cố
  if (truoc) { sql += ' AND t < ?'; b.push(truoc); }
  sql += ' ORDER BY t DESC LIMIT 300';
  const [{ results }, ten] = await Promise.all([env.DB.prepare(sql).bind(...b).all(), knTenCn(env)]);
  return ok({ log: results, ten, het: results.length < 300 });
}
async function adminKnIp(env, body) {
  const [q, loi] = await knPhien(env, body);
  if (loi) return loi;
  const [w, b] = knCn(q, 'n.cn');
  const [{ results }, ten] = await Promise.all([env.DB.prepare(`SELECT n.cn, n.ip, i.isp, i.asn, i.colo, i.dau, i.cuoi, i.vai,
      SUM(n.noi) AS noi, SUM(n.rot) AS rot, SUM(n.tv) AS tv, SUM(n.tb) AS tb, SUM(n.dt) AS dt, COUNT(*) AS so_ngay, MAX(n.ngay) AS ngay_cuoi
    FROM kn_ip_ngay n LEFT JOIN kn_ip i ON i.cn = n.cn AND i.ip = n.ip
    WHERE n.ngay >= ?${w} GROUP BY n.cn, n.ip ORDER BY n.cn, (SUM(n.tv) + SUM(n.tb)) DESC, SUM(n.noi) DESC LIMIT 500`).bind(q.tuNgay, ...b).all(), knTenCn(env)]);
  return ok({ ds: results, ten });
}
async function adminKnIpLs(env, body) {
  const [q, loi] = await knPhien(env, body);
  if (loi) return loi;
  const ip = s(body.ip, 64);
  if (!ip) return fail('missing_ip');
  const [w, b] = knCn(q, 'cn');
  const [ngay, sk, info] = await Promise.all([
    env.DB.prepare(`SELECT ngay, cn, noi, rot, tv, tb, dt FROM kn_ip_ngay WHERE ip = ? AND ngay >= ?${w} ORDER BY ngay DESC`).bind(ip, q.tuNgay, ...b).all(),
    env.DB.prepare(`SELECT * FROM kn_sk WHERE ip = ? AND t >= ?${w} ORDER BY t DESC LIMIT 200`).bind(ip, q.tu, ...b).all(),
    env.DB.prepare(`SELECT * FROM kn_ip WHERE ip = ?${w}`).bind(ip, ...b).all()
  ]);
  return ok({ ip, ngay: ngay.results, log: sk.results, info: info.results, ten: await knTenCn(env) });
}
async function adminKnMay(env, body) {
  const [q, loi] = await knPhien(env, body);
  if (loi) return loi;
  if (!q.cn) return fail('chua_chon_chi_nhanh', 400, 'Chọn một chi nhánh để xem thiết bị từng phòng.');
  const [phong, may, rotK] = await Promise.all([
    env.DB.prepare('SELECT id, ten_phong, dang_mo, mo_luc FROM order_phong WHERE chi_nhanh_id = ?').bind(q.cn).all(),
    env.DB.prepare('SELECT * FROM kn_may WHERE cn = ?').bind(q.cn).all(),
    env.DB.prepare(`SELECT phong_id, role, SUM(rot) AS rot, SUM(noi) AS noi FROM kn_ngay WHERE cn = ? AND ngay >= ? AND role IN ('tv','tablet') GROUP BY phong_id, role`).bind(q.cn, q.tuNgay).all()
  ]);
  const rows = (phong.results || []).sort(sapPhong);
  const ds = await Promise.all(rows.map(async r => {
    let st = {};
    try { st = await call(roomStub(env, r.id), '/status', { id: r.id, open: !!r.dang_mo, mo: r.mo_luc || 0 }); } catch (e) { st = { err: 1 }; }
    const m = role => (may.results || []).find(x => x.phong_id === r.id && x.role === role) || null;
    const k = role => (rotK.results || []).find(x => x.phong_id === r.id && x.role === role) || { rot: 0, noi: 0 };
    return { id: r.id, ten: r.ten_phong, open: !!r.dang_mo, tvOn: !!st.tv, tbOn: st.tablets || 0, dt: st.remotes || 0, err: !!st.err,
      tv: m('tv'), tb: m('tablet'), tvK: k('tv'), tbK: k('tablet') };
  }));
  return ok({ ds, now: Date.now() });
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
    // Một phòng lỗi (Durable Object bận/khởi động lại) thì phòng đó hiện như chưa có TV — KHÔNG làm hỏng cả bảng 23+ phòng
    let st = {};
    try { st = await call(roomStub(env, r.id), '/status', { id: r.id, open: !!r.dang_mo, mo: r.mo_luc || 0 }); } catch (e) { console.error('quayTv status', r.id, e); st = { err: 1 }; }
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
  const tvIp = String(pk.data.ip || ''), kind = pk.data.kind === 'tb' ? 'tb' : 'tv';
  if ((env.TV_NET || 'on') === 'off' || !tvIp) return { same: true, tvIp, kind };      // tắt kiểm / mã cũ chưa ghi IP: không chặn
  if (tvIp === netKey(ip)) return { same: true, tvIp, kind };
  const m = await mangCo(env, ss.b, tvIp);
  return { same: m.has, tvIp, kind };
}
const MSG_KHAC_MANG = 'TV này đang ở mạng chưa từng thấy của chi nhánh. Có thể do chi nhánh có 2 đường mạng hoặc nhà mạng vừa đổi IP — hoặc đây là TV của chi nhánh khác. Chỉ gán nếu chắc chắn TV đang ở chi nhánh này.';
async function quayTvCheck(env, body, ip) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const code = String(body.code || '').replace(/\D/g, '');
  if (code.length !== 6) return fail('bad_code', 400, 'Mã trên TV gồm 6 chữ số.');
  const r = await tvCungMang(env, ss, code, ip);
  if (r.err) return r.err;
  return ok({ same: r.same, canForce: true, kind: r.kind });
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
  const tb = net.kind === 'tb';                                         // mã 6 số do máy tính bảng xin (lần đầu / bị thu hồi)
  if (!net.same && body.force !== true) return fail('khac_mang', 403, tb ? MSG_KHAC_MANG.replace(/TV/g, 'Máy tính bảng') : MSG_KHAC_MANG, { canForce: true, kind: net.kind });
  const { gen } = await call(roomStub(env, p.id), '/rotate', { id: p.id, kind: net.kind });   // máy cũ của phòng (TV / máy tính bảng) bị đẩy ra
  const tok = await mkToken(env, p.id, net.kind, gen);
  const dv = tb ? await mkDev(env, p.chi_nhanh_id) : '';
  const st = await callR(regStub(env), '/tvpair/set', { code, tok, id: p.id, name: p.ten_phong, dv });
  if (st.status !== 200) return fail('bad_code', st.status, st.data.error);
  await mangHoc(env, ss.b, net.tvIp);                                  // máy đã gán: nhớ IP này là của chi nhánh
  await env.DB.prepare('INSERT INTO nhat_ky (luc, loai, noi_dung) VALUES (?,?,?)').bind(Date.now(), tb ? 'MTB_GAN' : 'TV_GAN', ss.u + ' @' + ss.b + ': ' + p.ten_phong + (net.same ? '' : ' (xác nhận dù khác mạng)')).run();
  return ok({ roomName: p.ten_phong, kind: net.kind });
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
// ---------- quay.thuHoiMtb: thu hồi MỌI máy tính bảng của chi nhánh (mất máy, nghi bị lộ): gỡ khỏi mọi phòng + quyền tự quét QR hết hiệu lực ----------
async function quayThuHoiMtb(env, body) {
  const [ss, loi] = await canPhien(env, body, 'quanLy');
  if (loi) return loi;
  await devGen(env, ss.b, true);
  const { results } = await env.DB.prepare('SELECT id FROM order_phong WHERE chi_nhanh_id = ?').bind(ss.b).all();
  for (const p of results || []) await call(roomStub(env, p.id), '/rotate', { id: p.id, kind: 'tb' });
  await env.DB.prepare('INSERT INTO nhat_ky (luc, loai, noi_dung) VALUES (?,?,?)').bind(Date.now(), 'MTB_THU_HOI', ss.u + ' @' + ss.b + ': ' + (results || []).length + ' phòng').run();
  return ok({ rooms: (results || []).length });
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
      await this.ctx.storage.put('t:' + code, { key, exp, tok: '', ip: netKey(body.ip), kind: body.kind === 'tb' ? 'tb' : 'tv' });
      return jres({ code, key, exp });
    }
    if(u.pathname === '/tvpair/poll'){
      const k = 't:' + String(body.code || ''), v = await this.ctx.storage.get(k);
      if(!v || v.exp < Date.now()) return jres({ error: 'expired' }, 404);
      if(!same(String(body.key || ''), v.key)) return jres({ error: 'key' }, 403);
      if(!v.tok) return jres({ wait: true });
      await this.ctx.storage.delete(k);
      return jres({ tok: v.tok, id: v.id, name: v.name || '', dv: v.dv || '' });
    }
    if(u.pathname === '/tvpair/peek'){
      if(await this.limited('rp:', body.ip, 30)) return jres({ error: 'Nhập sai quá nhiều lần, đợi 10 phút.' }, 429);
      const v = await this.ctx.storage.get('t:' + String(body.code || ''));
      if(!v || v.exp < Date.now()) return jres({ error: 'Mã trên TV không đúng hoặc đã hết hạn. Xem lại mã đang hiện trên TV.' }, 404);
      if(v.tok) return jres({ error: 'Mã này vừa được dùng. Đợi TV hiện mã mới.' }, 409);
      return jres({ ok: true, ip: v.ip || '', kind: v.kind || 'tv' });
    }
    if(u.pathname === '/tvpair/set'){
      const k = 't:' + String(body.code || ''), v = await this.ctx.storage.get(k);
      if(!v || v.exp < Date.now()) return jres({ error: 'Mã trên TV đã hết hạn.' }, 404);
      v.tok = String(body.tok || ''); v.id = String(body.id || ''); v.name = String(body.name || '').slice(0, 60); v.dv = String(body.dv || '');
      v.exp = Date.now() + 60000;                       // TV hỏi lại 2–3 giây/lần nên 1 phút là thừa
      await this.ctx.storage.put(k, v);
      return jres({ ok: true });
    }

    /* Đời quyền thiết bị máy tính bảng của từng chi nhánh (tăng khi quản lý thu hồi) */
    if(u.pathname === '/dev/gen'){
      const k = 'dg:' + String(body.branch || ''); let g = (await this.ctx.storage.get(k)) || 1;
      if(body.bump){ g++; await this.ctx.storage.put(k, g); }
      return jres({ gen: g });
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
  async remember(id){ if(ID_RE.test(id || '')) this.nkRid = id; if(ID_RE.test(id || '') && (await this.ctx.storage.get('rid')) !== id) await this.ctx.storage.put('rid', id); }
  sockets(role){
    const l = this.ctx.getWebSockets(role);
    return l.filter(w => { const a = w.deserializeAttachment() || {}; return role === 'remote' ? !!a.ok : a.ok !== false; });   // điện thoại khách chỉ tính sau khi qua kiểm tra lúc 'sync'; socket vừa bị dọn (ok=false) không tính
  }
  /* Kết nối "ma" của TV / máy tính bảng: mất mạng đột ngột thì Worker không nhận tin đóng, quầy và điện thoại vẫn tưởng TV còn nối.
     Máy ping 25 giây/lần; im quá 120 giây → đóng (mã 4007, máy tự nối lại) và không đếm nữa. Trả về số socket đã dọn. */
  reapStale(){
    const now = Date.now(); let n = 0;
    for(const role of ['tv', 'tablet']) for(const w of this.ctx.getWebSockets(role)){
      const a = w.deserializeAttachment() || {};
      if(a.ok === false) continue;
      let last = Math.max(+a.at || 0, +a.t || 0);
      try{ const ts = this.ctx.getWebSocketAutoResponseTimestamp(w); if(ts) last = Math.max(last, ts.getTime()); }catch(e){}
      if(!last || now - last <= 120000) continue;            // không có mốc giờ nào (socket cũ trước bản này): để yên
      try{ a.ok = false; a.reaped = 1; w.serializeAttachment(a); }catch(e){}
      try{ w.close(4007, 'stale'); }catch(e){}
      this.ghi('cat', { role, code: 4007, why: 'im >120s', im: Math.round((now - last) / 1000), ip: netKey(a.ip), isp: a.isp, tuoi: a.at ? Math.round((now - a.at) / 1000) : undefined });
      n++;
    }
    return n;
  }
  /* Kết nối "ma" của điện thoại khách: máy ngủ / tab bị trình duyệt đóng băng / mất wifi thì Worker thường KHÔNG nhận được tin đóng,
     socket cũ vẫn được đếm. Máy đó mở lại là nối thêm socket mới → sau vài lần, phòng "đủ số điện thoại" dù chẳng ai đang dùng.
     Mỗi lần có máy mới xin vào: (1) cùng máy (mã máy bmb_dev, gửi qua ?d=) → đóng socket cũ của chính máy đó (mã 4006);
     (2) socket không ping quá 90 giây (máy khách ping 25 giây/lần, Worker tự trả 'pong' và ghi giờ) → coi là đã mất, đóng. */
  reapRemotes(cur, a0){
    const now = Date.now();
    for(const w of this.ctx.getWebSockets('remote')){
      if(w === cur) continue;
      const a = w.deserializeAttachment() || {};
      let last = Math.max(+a.at || 0, +a.t || 0);
      try{ const ts = this.ctx.getWebSocketAutoResponseTimestamp(w); if(ts) last = Math.max(last, ts.getTime()); }catch(e){}
      const dup = !!(a0.dev && a.dev === a0.dev);
      if(dup || now - last > 90000){             // bỏ cờ ok trước (socket đang đóng vẫn còn trong getWebSockets) → không bị đếm nữa
        try{ a.ok = false; a.reaped = 1; w.serializeAttachment(a); }catch(e){}
        try{ w.close(dup ? 4006 : 4007, dup ? 'dup' : 'stale'); }catch(e){}
        this.ghi('cat', { role: 'remote', code: dup ? 4006 : 4007, why: dup ? 'cùng máy nối lại' : 'im >90s', im: Math.round((now - last) / 1000), dev: (a.dev || '').slice(0, 8), ip: netKey(a.ip), isp: a.isp });
      }
    }
  }
  /* Nhật ký kết nối: 60 sự kiện gần nhất của phòng (nối / đóng + mã / từ chối / mở-đóng phòng). Chỉ ghi chuyện hiếm, không ghi tin nhắn. */
  ghi(ev, o){
    const e = Object.assign({ t: Date.now(), ev }, o || {});
    try{ console.log('nk', this.nkRid || '', JSON.stringify(e)); }catch(x){}
    this.nkQ = (this.nkQ || Promise.resolve()).then(async () => {          // xếp hàng: nhiều sự kiện cùng lúc không ghi đè nhau
      let l = (await this.ctx.storage.get('nk')) || [];
      const e2 = Object.assign({}, e); delete e2.ua; delete e2.asn; delete e2.colo;     // 60 dòng trong phòng: gọn, chi tiết máy nằm ở D1
      l.push(e2); if(l.length > 60) l = l.slice(-60);
      await this.ctx.storage.put('nk', l);
      if(this.env.DB){                                                     // lưu dài ngày cho tab Kết nối (admin); D1 chậm/lỗi thì bỏ qua sau 4 giây
        const c = await this.cfg();
        if(!c.rid && this.nkRid) c.rid = this.nkRid;
        await Promise.race([knGhi(this.env, c, e), new Promise(r => setTimeout(r, 4000))]).catch(err => console.error('knGhi', err));
      }
    }).catch(() => {});
    return this.nkQ;
  }
  listeners(){ return this.sockets('remote').concat(this.sockets('tablet')); }        // máy nhận trạng thái TV
  async roomMsg(c, extra){
    c = c || await this.cfg();
    return Object.assign({ type: 'room', open: c.open, since: c.since, session: c.session, name: c.name, bname: c.bname, branch: c.branch, tv: this.sockets('tv').length > 0,
      remotes: this.sockets('remote').length, tablets: this.sockets('tablet').length, seek: await seekOn(this.env) }, extra || {});
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
  /* Yêu cầu gọi lễ tân của phòng (đã gửi / đã xác nhận / đã phục vụ / đã huỷ) — TV hiện để khách biết.
     Còn hiện: đang chờ hoặc đã xác nhận (tối đa 2 giờ), đã phục vụ / đã huỷ thì chỉ ~15 giây rồi biến mất. */
  svcView(list, now){
    return (list || []).filter(x => (x.st === 'MOI' || x.st === 'NHAN') ? now - x.upd < SVC_ACTIVE_MS : now - x.upd < SVC_DONE_MS).slice(-6);
  }
  async svcSend(list, ws){
    const msg = JSON.stringify({ type: 'svc', list });
    for(const w of (ws ? [ws] : this.ctx.getWebSockets('tv'))){ try{ w.send(msg); }catch(e){} }
  }
  async svcPut(d){
    const c = await this.cfg(), now = Date.now();
    if(!c.open) return;                                // phòng đang đóng: không báo gì lên TV
    const st = ['MOI', 'NHAN', 'XONG', 'HUY'].includes(d.st) ? d.st : 'MOI', id = String(d.id || '').slice(0, 40);
    if(!id) return;
    const items = (Array.isArray(d.items) ? d.items : []).slice(0, 12).map(i => ({ label: String(i.label || '').slice(0, 60), type: i.type === 'DR' ? 'DR' : 'SV', icon: String(i.icon || '').slice(0, 8), qty: Math.max(1, Math.min(99, +i.qty | 0 || 1)) }));
    let list = (await this.ctx.storage.get('svc')) || [];
    const row = { id, st, items, at: +d.at || now, upd: now }, i = list.findIndex(x => x.id === id);
    if(i >= 0) list[i] = row; else list.push(row);
    list = list.slice(-10);
    await this.ctx.storage.put('svc', list);
    await this.svcSend(this.svcView(list, now));
  }
  async endGuests(){                                   // hết lượt: ngắt điện thoại khách (kể cả máy đang chờ phòng mở)
    const msg = JSON.stringify(await this.roomMsg(null, { open: false, reason: 'closed' }));
    const n = this.ctx.getWebSockets('remote').length;
    for(const ws of this.ctx.getWebSockets('remote')){ try{ if((ws.deserializeAttachment() || {}).ok) ws.send(msg); ws.close(4001, 'closed'); }catch(e){} }
    if(n) this.ghi('cat', { role: 'remote', code: 4001, why: 'hết lượt/đóng phòng', n });
  }
  async applyOpen(c, mo){                              // lượt mới: phiên mới + QR khách mới (QR lượt trước chết luôn)
    await this.ghi('mo', { mo: mo || 0 });
    await this.endGuests();
    await this.ctx.storage.put({ open: true, since: mo || Date.now(), moLuc: mo, session: c.session + 1, genQ: c.genQ + 1 });
    await this.ctx.storage.delete(['last', 'svc']);
    await this.broadcastRoom();
  }
  async applyClose(c){
    await this.ghi('dong', {});
    await this.ctx.storage.put({ open: false, since: 0, moLuc: 0, session: c.session + 1 });
    await this.ctx.storage.delete(['last', 'svc']);
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
      await this.ghi('xoa', { why: 'phòng không còn trong D1' });
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
    this.reapStale();
    await this.syncDb();
    await this.ctx.storage.setAlarm(Date.now() + RESYNC_MS);
  }
  /* Quầy hỏi tình trạng (tab TV & phòng, 23+ phòng mỗi lần): KHÔNG đọc D1 mỗi lần nữa — quầy gửi kèm trạng thái mở/đóng đọc từ D1,
     chỉ khi lệch với phòng này đang nhớ thì mới đọc lại D1 (mở/đóng đã được báo sang ngay lúc bấm + lưới an toàn 5 phút). */
  async status(body){
    if(this.reapStale()) await this.broadcastRoom();
    let c = await this.cfg();
    if(!body || body.open === undefined || !!body.open !== c.open || (body.open && (+body.mo || 0) !== c.moLuc) || !c.rid) c = await this.syncDb();
    const net = this.env.NET_CHECK || 'off';
    let off = 0;
    for(const ws of this.sockets('remote')){ const a = ws.deserializeAttachment() || {}; if(a.off) off++; }
    return { remotes: this.sockets('remote').length, tablets: this.sockets('tablet').length, tv: this.sockets('tv').length > 0, net, offNet: off,
      open: c.open, since: c.since, genQ: c.genQ, genT: c.genT, tvIp: (await this.ctx.storage.get('tvIp')) || '' };
  }

  async fetch(req){
    const u = new URL(req.url);
    if(u.pathname === '/ws') return this.connect(req, u);
    const body = await req.json().catch(() => ({}));
    if(u.pathname === '/check'){                         // mã còn dùng được không: TV/máy tính bảng tự quên mã chết; gọi lễ tân kiểm mã khách
      const role = body.role === 'tv' ? 'tv' : body.role === 'remote' ? 'remote' : 'tablet', t = parseToken(body.r);
      if(t) await this.remember(t.id);
      const c = await this.syncDb(), gen = c[GEN[role]];
      const valid = !!(t && !c.gone && t.gen === gen && same(t.sig, await hmac(this.env.SECRET, t.id + '|' + KIND[role] + '|' + gen)));
      return jres({ valid, open: c.open, role, id: t ? t.id : '' });
    }
    await this.remember(String(body.id || ''));
    if(u.pathname === '/status') return jres(await this.status(body));
    if(u.pathname === '/sync'){ const c = await this.syncDb(); return jres({ ok: true, open: c.open }); }
    if(u.pathname === '/nhatky') return jres({ nk: (await this.ctx.storage.get('nk')) || [] });
    if(u.pathname === '/svc'){ await this.svcPut(body.don || {}); return jres({ ok: true }); }
    if(u.pathname === '/rotate'){
      const role = body.kind === 'tv' ? 'tv' : body.kind === 'tb' ? 'tablet' : 'remote', c = await this.cfg();
      const g = c[GEN[role]] + 1;
      await this.ctx.storage.put(GEN[role], g);
      const nr = this.ctx.getWebSockets(role).length;
      for(const ws of this.ctx.getWebSockets(role)){ try{ ws.close(4002, 'rotated'); }catch(e){} }
      if(nr) await this.ghi('cat', { role, code: 4002, why: 'đổi mã', n: nr });
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
    let kn = {}; try{ kn = JSON.parse(req.headers.get('x-bmb-kn') || '{}') || {}; }catch(e){}           // nhà mạng / trung tâm Cloudflare (Worker chính gắn vào)
    const mx = { isp: String(kn.isp || '').slice(0, 40) || undefined, asn: +kn.asn || undefined, colo: String(kn.colo || '').slice(0, 6) || undefined, ua: uaGon(req.headers.get('User-Agent')) || undefined };
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);

    if(role === 'remote'){
      this.ctx.acceptWebSocket(server, ['remote']);
      const dev = /^[\w-]{6,40}$/.test(u.searchParams.get('d') || '') ? u.searchParams.get('d') : '';
      server.serializeAttachment({ role, ip, id: t.id, n: 0, t: 0, ok: false, dev, at: Date.now(), isp: mx.isp, ua: mx.ua });
      await this.ghi('noi', Object.assign({ role, dev: dev.slice(0, 8), ip: netKey(ip) }, mx));   // chưa cho vào: chờ 'sync' mới kiểm phòng mở / mạng / số máy
      return new Response(null, { status: 101, webSocket: client });
    }
    if(role === 'tv'){
      for(const old of this.sockets('tv')){
        const oa = old.deserializeAttachment() || {};
        let last = Math.max(+oa.at || 0, +oa.t || 0);
        try{ const ts = this.ctx.getWebSocketAutoResponseTimestamp(old); if(ts) last = Math.max(last, ts.getTime()); }catch(e){}
        const im = last ? Math.round((Date.now() - last) / 1000) : -1;
        try{ oa.ok = false; oa.reaped = 1; old.serializeAttachment(oa); }catch(e){}      // không đếm nữa, không bị dọn/ghi nhật ký lần 2
        try{ old.send(JSON.stringify({ type: 'room', open: c.open, replaced: true })); old.close(4000, 'replaced'); }catch(e){}
        await this.ghi('cat', Object.assign(im > 40 ? { role: 'tv', code: 4000, why: 'dọn kết nối ma cũ của TV (TV nối lại)', im } : { role: 'tv', code: 4000, why: 'TV mới thay TV cũ', im }, { ip: netKey(oa.ip), isp: oa.isp }));
      }
      await this.ctx.storage.put('tvIp', netKey(ip));
      if(c.branch) await mangHoc(this.env, c.branch, ip);   // TV của chi nhánh nối vào: nhớ IP (kể cả đường mạng thứ 2)
      if(!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + RESYNC_MS);
    }
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, ip, id: t.id, n: 0, t: 0, ok: true, at: Date.now(), isp: mx.isp, ua: mx.ua });
    await this.ghi('noi', Object.assign({ role, ip: netKey(ip) }, mx));
    await this.broadcastRoom();                          // báo số máy đang nối cho mọi bên
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data){
    if(typeof data !== 'string' || data.length > MAX_STATE) return;
    if(data === 'sync'){                                 // máy vừa nối xong xin: tình trạng phòng (+ mã/vé theo vai trò) và trạng thái gần nhất của TV
      const a0 = ws.deserializeAttachment() || {};
      const c = a0.role === 'remote' && !a0.ok ? await this.syncDb() : await this.cfg();
      if(a0.role === 'remote' && !a0.ok){
        this.reapRemotes(ws, a0);                         // bỏ kết nối "ma" trước khi đếm số máy (xem reapRemotes)
        this.reapStale();                                 // TV / máy tính bảng ma: roomMsg bên dưới báo đúng TV còn nối hay không
        const net = this.env.NET_CHECK || 'off', off = net !== 'off' && c.tvIp && !(await this.mangOk(a0.ip, c));
        const deny = !c.open ? [4003, 'notopen'] : (off && net === 'on') ? [4004, 'network'] : this.sockets('remote').length >= MAX_REMOTES ? [4005, 'full'] : null;
        if(deny){ try{ ws.send(JSON.stringify(await this.roomMsg(c, { id: a0.id, reason: deny[1] }))); ws.close(deny[0], deny[1]); }catch(e){} await this.ghi('tuchoi', { role: 'remote', code: deny[0], why: deny[1], dem: this.sockets('remote').length, dev: (a0.dev || '').slice(0, 8), ip: netKey(a0.ip), isp: a0.isp }); return; }
        a0.ok = true; a0.off = !!off; ws.serializeAttachment(a0);
        await this.broadcastRoom();
      }
      const extra = a0.role === 'remote' ? { gt: c.open ? await guestTicket(this.env, a0.id) : '' } : await this.roleExtra(c, a0.role);
      ws.send(JSON.stringify(await this.roomMsg(c, Object.assign({ id: a0.id, you: a0.role }, extra))));
      if(a0.role !== 'tv' && c.open){ const last = await this.ctx.storage.get('last'); if(last) ws.send(last); }
      if(a0.role === 'tv' && c.open){ const v = this.svcView(await this.ctx.storage.get('svc'), Date.now()); if(v.length) await this.svcSend(v, ws); }   // TV vừa nối: hiện lại yêu cầu đang chờ
      return;
    }
    const a = ws.deserializeAttachment() || {}, now = Date.now();
    if(now - (a.t || 0) < 1000){ a.n = (a.n || 0) + 1; } else { a.n = 1; a.t = now; }
    ws.serializeAttachment(a);
    if(a.n > RATE_PER_SEC) return;
    let m; try{ m = JSON.parse(data); }catch(e){ return; }
    if(!m || typeof m !== 'object') return;

    if(m.type === 'dg'){                                 // máy tự báo sau khi nối lại: vì sao mất, mất bao lâu, ping, loại mạng (xem phong-channel.js)
      if(now - (a.dgT || 0) < 15000 || data.length > 600) return;
      a.dgT = now; try{ ws.serializeAttachment(a); }catch(e){}
      const g = m.d || {}, nu = (v, mx) => Number.isFinite(+v) && v !== '' && v !== null ? Math.max(0, Math.min(mx, Math.round(+v))) : undefined, tx = (v, n) => String(v == null ? '' : v).replace(/[^\w:.-]/g, '').slice(0, n) || undefined;
      const dg = { down: nu(g.down, 7 * 86400000), why: tx(g.why, 16), tries: nu(g.tries, 999), on: g.on === 0 ? 0 : 1, hid: g.hid ? 1 : 0, rtt: nu(g.rtt, 60000), rttMax: nu(g.rttMax, 60000),
        net: tx(g.net, 8), nrtt: nu(g.nrtt, 60000), dl: Number.isFinite(+g.dl) ? Math.round(+g.dl * 10) / 10 : undefined, ty: tx(g.ty, 12) };
      await this.ghi('tai', { role: a.role, ip: netKey(a.ip), isp: a.isp, dev: (a.dev || '').slice(0, 8) || undefined, ua: a.ua, dg });
      return;
    }

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
      }else if(p.action === 'prio' || p.action === 'up' || p.action === 'remove'){ out.index = Math.max(0, Math.min(500, +p.index | 0)); if(/^[\w-]{11}$/.test(p.id || '')) out.id = p.id;   // id bài: TV đối chiếu, hàng chờ đã đổi thì bỏ lệnh
      }else if(p.action === 'play' || p.action === 'mute'){ if(typeof p.on === 'boolean') out.on = p.on;                       // đặt hẳn phát/dừng, bật/tắt tiếng (không đảo)
      }else if(p.action === 'seek'){                                 // tua bài đang hát: t = giây tuyệt đối, hoặc by = ±giây; admin tắt thì bỏ
        if(!(await seekOn(this.env))) return;
        if(typeof p.t === 'number' && isFinite(p.t)) out.t = Math.max(0, Math.min(86400, p.t));
        else if(typeof p.by === 'number' && isFinite(p.by)) out.by = Math.max(-600, Math.min(600, p.by));
        else return;
      }
      const msg = JSON.stringify({ type: 'cmd', payload: out });
      for(const tv of this.sockets('tv')){ try{ tv.send(msg); }catch(e){} }
      return;
    }
    /* từ TV */
    if(m.type === 'state'){
      const c = await this.cfg(); if(!c.open) return;
      await this.ctx.storage.put('last', data);
      for(const r of this.listeners()){ try{ r.send(data); }catch(e){} }
    }else if(m.type === 'dead' || m.type === 'pos'){          // 'pos' = giây đang phát (nhẹ, không lưu): remote vẽ thanh tua
      if(m.type === 'pos' && data.length > 512) return;
      for(const r of this.listeners()){ try{ r.send(data); }catch(e){} }
    }
  }
  async webSocketClose(ws, code, reason){
    const a = ws.deserializeAttachment() || {};
    try{ ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); }catch(e){}
    const wasOk = a.ok, wasReaped = a.reaped;
    try{ a.ok = false; ws.serializeAttachment(a); }catch(e){}                        // socket đang đóng không còn được đếm (TV nối lại ngay sau đó không bị coi là 'thay TV cũ')
    if(!wasReaped && code < 4000 && (wasOk || a.role !== 'remote')) await this.ghi('dut', { role: a.role, code, why: String(reason || '').slice(0, 30), tuoi: a.at ? Math.round((Date.now() - a.at) / 1000) : undefined, dev: (a.dev || '').slice(0, 8) || undefined, ip: netKey(a.ip), isp: a.isp });   // máy tự rớt (mạng/ngủ/đóng app); socket do server cắt đã ghi dòng 'cat'
    await this.broadcastRoom();
  }
  async webSocketError(ws){
    const a = ws.deserializeAttachment() || {};
    try{ ws.close(1011, 'error'); }catch(e){}
    await this.ghi('loi', { role: a.role, code: 1011, ip: netKey(a.ip), isp: a.isp });
    await this.broadcastRoom();
  }
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
const NHAC_ACTIONS = new Set(['toggle', 'next', 'prev', 'vol', 'shuffle', 'repeat', 'playid', 'reload', 'playlist', 'hello', 'fs', 'mute', 'seek']);   // fs = phóng to / thu nhỏ màn hình TV
const NHAC_ROOM_RE = /^[\w-]{1,20}$/;
const PAIR_MS = 5 * 60 * 1000, PAIR_TOKEN_MS = 24 * 3600 * 1000, MAX_LIST = 400000;
const nhacPass = env => env.NHAC_PASS || env.APP_PASS;
/* Vé người dùng của nhac.html: nhac-<id>.<hết hạn ms>.<chữ ký>, do Worker nhac-playlist cấp (cùng GUEST_SECRET, cùng cách ký với vé khách của kho).
   Cho người trong nhà dùng mã riêng vẫn ghép TV / điều khiển tức thì được. Chỉ dùng cho phòng nhạc. */
async function nhacUserOk(env, t){
  if(!env.GUEST_SECRET) return false;
  const m = /^(nhac-u[a-z0-9]{5})\.(\d{13})\.([\w-]{22})$/.exec(String(t || ''));
  if(!m || +m[2] < Date.now()) return false;
  return same(m[3], await hmac(env.GUEST_SECRET, 'guest|' + m[1] + '.' + m[2]));
}
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
      else if(m.guest && await nhacUserOk(this.env, m.guest)){ role = m.role === 'tv' ? 'tv' : 'remote'; full = true; }       // mã riêng của người trong nhà
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
      if(m.action === 'fs' && typeof p.on === 'boolean') out.on = p.on;
      if(m.action === 'seek'){                                  // tua (chỉ phòng nhạc nhac.html): t = giây tuyệt đối, by = ±giây
        if(p.t != null && Number.isFinite(+p.t)) out.t = Math.max(0, Math.min(86400, +p.t));
        else if(p.by != null && Number.isFinite(+p.by)) out.by = Math.max(-600, Math.min(600, +p.by));
        else return;
      }
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

// ============================================================
// QUẦY THỜI GIAN THỰC (WebSocket "cái chuông") + THÔNG BÁO ĐẨY (Web Push)
// ------------------------------------------------------------
// • Mỗi chi nhánh một Durable Object QuayHub. Màn quầy (quay.html) nối /quay/ws; có đơn mới / đổi trạng thái / mở-đóng phòng
//   thì Worker "rung chuông" ({t:'rev'}) và quầy tự gọi lại quay.feed. Chuông KHÔNG chở dữ liệu: WebSocket rớt thì quầy vẫn
//   tự hỏi định kỳ như cũ, không mất đơn nào.
// • Thông báo đẩy: mỗi máy (điện thoại / PC) tự bật trong quay.html (nút 🔔). Đơn mới → máy của quản lý + quầy chi nhánh đó
//   nhận thông báo có nút "Tiếp nhận"; đã xác nhận → thông báo đổi thành nút "Đã xong"; xong/huỷ → thông báo đổi theo.
//   Máy đang mở màn quầy (tab đang hiện) thì KHÔNG đẩy, vì màn quầy đã kêu chuông.
// • Khoá VAPID tự sinh lần đầu, lưu ở order_meta (D1). ĐỪNG xoá dòng 'vapid': xoá là mọi máy phải bật lại thông báo.
// • Telegram vẫn chạy song song (kênh dự phòng).
// ============================================================
const QHUB_MAX_SOCK_USER = 4;            // mỗi tài khoản tối đa 4 màn quầy nối cùng lúc (đóng cái cũ nhất)
const PUSH_MAX_MAY_USER = 6;             // mỗi tài khoản tối đa 6 máy nhận thông báo
const NHAC_MS_MAC_DINH = 3 * 60 * 1000;      // đơn MỚI sau 3 phút chưa ai tiếp nhận → đẩy thêm 1 thông báo nhắc (đổi bằng biến NHAC_PHUT; 0 = tắt)
const PUSH_NUT_HAN_MS = 12 * 3600 * 1000;    // nút trên thông báo dùng được trong 12 giờ
const DV_Q_RE = /^[A-Za-z0-9_-]{8,40}$/;     // mã máy (quay.html tự sinh, nhớ trong trình duyệt; app tự sinh)
const TRANG_THAI_TEN = { MOI: 'chờ xác nhận', NHAN: 'đã xác nhận', XONG: 'đã phục vụ', HUY: 'đã huỷ' };

const quayHub = (env, cn) => (env.QHUB && cn) ? env.QHUB.get(env.QHUB.idFromName('cn:' + cn)) : null;
async function pokeQuay(env, cn, why) {
  const st = quayHub(env, cn);
  if (!st) return;
  try { await st.fetch('https://hub/poke', { method: 'POST', body: JSON.stringify({ why: why || '' }) }); }
  catch (e) { console.error('pokeQuay:', e && e.name); }
}
/** Mã các máy đang mở màn quầy (tab đang hiện) của chi nhánh → khỏi đẩy thông báo cho máy đó */
async function quayDangXem(env, cn) {
  const st = quayHub(env, cn);
  if (!st) return [];
  try { const j = await (await st.fetch('https://hub/visible')).json(); return Array.isArray(j.visible) ? j.visible : []; }
  catch (e) { return []; }
}
/** GET /quay/ws?b=<chi nhánh (admin)>&dv=<mã máy> — phiên quầy gửi qua Sec-WebSocket-Protocol: ['bmbq.v1', 'tok.<phiên>'] */
async function quayWs(req, env) {
  if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Cần WebSocket', { status: 426 });
  if (!env.QHUB) return new Response('Chưa bật thời gian thực', { status: 501 });
  const u = new URL(req.url);
  const protos = String(req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(x => x.trim());
  const tok = protos.find(x => x.startsWith('tok.')), dk = protos.find(x => x.startsWith('dk.'));
  if (dk) {                                  // app BMBPlayer chế độ Quầy (dịch vụ nền): khoá máy dài hạn, không tính là "đang xem"
    const may = await appMay(env, dk).catch(() => null);
    if (!may) return new Response('may', { status: 403 });
    return quayHub(env, may.cn).fetch('https://hub/ws', { headers: { Upgrade: 'websocket', 'X-User': may.u, 'X-Dv': 'app-' + may.dv, 'X-Vis': '0' } });
  }
  const ss = await getSession(env, { session: tok ? tok.slice(4) : '', branchId: u.searchParams.get('b') || '' }).catch(() => null);
  if (!ss || !ss.b) return new Response('phien', { status: 403 });
  const dv = DV_Q_RE.test(u.searchParams.get('dv') || '') ? u.searchParams.get('dv') : '';
  return quayHub(env, ss.b).fetch('https://hub/ws', { headers: { Upgrade: 'websocket', 'X-User': ss.u, 'X-Dv': dv } });
}

export class QuayHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    try { this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) { /* môi trường thử */ }
  }
  socks() { return this.ctx.getWebSockets(); }
  info(ws) { try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; } }
  visibleList() {
    const set = new Set();
    for (const ws of this.socks()) { const a = this.info(ws); if (a.dv && a.v) set.add(a.dv); }
    return [...set];
  }
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.socks()) { try { ws.send(s); } catch (e) { /* socket đã đóng */ } }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/poke') {
      let why = ''; try { why = String((await request.json()).why || '').slice(0, 20); } catch (e) {}
      this.broadcast({ t: 'rev', why, at: Date.now() });
      return new Response('ok');
    }
    if (url.pathname === '/nhac') {                     // hẹn nhắc 1 đơn mới (không đặt lại nếu đã hẹn)
      let b = {}; try { b = await request.json(); } catch (e) {}
      if (!/^[\w-]{4,40}$/.test(String(b.id || '')) || !(b.sau > 0)) return new Response('bad', { status: 400 });
      const k = 'n:' + b.id;
      if (!(await this.ctx.storage.get(k))) await this.ctx.storage.put(k, Date.now() + Math.min(+b.sau, 3600000));
      await this.datBao();
      return new Response('ok');
    }
    if (url.pathname === '/visible') return new Response(JSON.stringify({ visible: this.visibleList() }), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/ws') {
      const user = request.headers.get('X-User') || '';
      if (!user) return new Response('no user', { status: 400 });
      const mine = this.socks().filter(w => this.info(w).u === user);
      while (mine.length >= QHUB_MAX_SOCK_USER) { try { mine.shift().close(1000, 'replaced'); } catch (e) {} }
      const pair = new WebSocketPair(), client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ u: user, dv: request.headers.get('X-Dv') || '', v: request.headers.get('X-Vis') === '0' ? 0 : 1 });
      try { server.send(JSON.stringify({ t: 'hello', at: Date.now() })); } catch (e) {}
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'bmbq.v1' } });
    }
    return new Response('not found', { status: 404 });
  }
  async webSocketMessage(ws, data) {
    let m; try { m = JSON.parse(String(data)); } catch (e) { return; }
    if (!m || m.t !== 'vis') return;
    const a = this.info(ws), v = m.v ? 1 : 0;
    if (a.u && v !== a.v) ws.serializeAttachment(Object.assign({}, a, { v }));
  }
  /** đặt báo thức vào giờ nhắc gần nhất */
  async datBao() {
    const m = await this.ctx.storage.list({ prefix: 'n:' });
    let min = 0; for (const t of m.values()) if (!min || t < min) min = t;
    if (min) await this.ctx.storage.setAlarm(Math.max(min, Date.now() + 1000));
  }
  async alarm() {
    const m = await this.ctx.storage.list({ prefix: 'n:' }), now = Date.now();
    for (const [k, t] of m) {
      if (t > now + 500) continue;
      await this.ctx.storage.delete(k);
      try { await nhacDon(this.env, k.slice(2)); } catch (e) { console.error('nhacDon:', e && e.name, e && e.message); }
    }
    await this.datBao();
  }
  async webSocketClose(ws, code, reason) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch (e) {} }
  async webSocketError(ws) { try { ws.close(1011, 'error'); } catch (e) {} }
}

/* ---------- Bảng riêng của thông báo đẩy (tự tạo, không phải dán SQL) ---------- */
let pushBangXong = false;
async function pushBangSan(env) {
  if (pushBangXong) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS order_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS order_push_sub (endpoint TEXT PRIMARY KEY, username TEXT NOT NULL, chi_nhanh_id TEXT NOT NULL,
      dv TEXT NOT NULL DEFAULT '', p256dh TEXT NOT NULL, auth TEXT NOT NULL, ua TEXT NOT NULL DEFAULT '', tao_luc INTEGER NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_order_push_sub_cn ON order_push_sub (chi_nhanh_id)')
  ]);
  pushBangXong = true;
}

/* ---------- Web Push: VAPID + mã hoá aes128gcm (RFC 8291), tự làm bằng WebCrypto ---------- */
const b64uBytes = buf => { const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64uBytes = str => { str = String(str).replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const bin = atob(str), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
const noiBytes = (...xs) => { let n = 0; for (const x of xs) n += x.length; const out = new Uint8Array(n); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };

let _vapid = null;
async function getVapid(env) {
  if (_vapid) return _vapid;
  await pushBangSan(env);
  let r = await env.DB.prepare(`SELECT v FROM order_meta WHERE k = 'vapid'`).first();
  if (!r) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = b64uBytes(await crypto.subtle.exportKey('raw', kp.publicKey));
    await env.DB.prepare(`INSERT OR IGNORE INTO order_meta (k, v) VALUES ('vapid', ?)`).bind(JSON.stringify({ pub, jwk })).run();
    r = await env.DB.prepare(`SELECT v FROM order_meta WHERE k = 'vapid'`).first();   // hai isolate cùng sinh: lấy bản đã lưu
  }
  const o = JSON.parse(r.v);
  _vapid = { pub: o.pub, key: await crypto.subtle.importKey('jwk', o.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  return _vapid;
}
async function vapidAuth(env, endpoint) {
  const v = await getVapid(env);
  const part = x => b64uBytes(enc.encode(JSON.stringify(x)));
  const head = part({ typ: 'JWT', alg: 'ES256' });
  const claims = part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: origins(env)[0] || 'https://bmb.id.vn' });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, enc.encode(head + '.' + claims));
  return 'vapid t=' + head + '.' + claims + '.' + b64uBytes(sig) + ', k=' + v.pub;
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
/** RFC 8291 aes128gcm. sub = { p256dh, auth } dạng base64url */
export async function encryptPush(sub, plain) {
  const uaPub = unb64uBytes(sub.p256dh), authSecret = unb64uBytes(sub.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const prk = await hkdf(authSecret, shared, noiBytes(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, noiBytes(plain, new Uint8Array([2]))));
  return noiBytes(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function sendPush(env, sub, payload, opts) {
  opts = opts || {};
  let res;
  try {
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        'TTL': String(opts.ttl || 3600), 'Urgency': opts.urgency || 'normal',
        'Authorization': await vapidAuth(env, sub.endpoint)
      },
      body: await encryptPush(sub, enc.encode(JSON.stringify(payload))),
      signal: AbortSignal.timeout(8000)
    });
  } catch (e) { return 0; }
  if (res.status === 404 || res.status === 410) await env.DB.prepare('DELETE FROM order_push_sub WHERE endpoint = ?').bind(sub.endpoint).run();   // máy đã gỡ / tắt thông báo
  return res.status;
}

/* ---------- Chữ ký cho nút trên thông báo (service worker không giữ phiên quầy) ---------- */
const nutKy = (env, orderId, u, cn, exp) => hmac(env.SECRET, 'pa|' + orderId + '|' + u + '|' + cn + '|' + exp);

/* ---------- Gửi thông báo của 1 đơn ---------- */
function pushNoiDung(don, items, nguoi) {
  const mon = items.map(i => (iconChu(i.icon) ? iconChu(i.icon) + ' ' : '') + i.label + (i.type === 'DR' && i.qty > 1 ? ' ×' + (+i.qty | 0) : '')).join(', ');
  const st = don.trang_thai;
  const title = st === 'MOI' ? '🛎️ ' + don.ten_phong + ' gọi lễ tân'
    : st === 'NHAN' ? '✅ ' + don.ten_phong + ' · đã xác nhận'
    : st === 'XONG' ? '🎉 ' + don.ten_phong + ' · đã phục vụ'
    : '⚠️ ' + don.ten_phong + ' · đã huỷ';
  const dong = [mon || '(không có món)'];
  if (don.ghi_chu) dong.push('“' + String(don.ghi_chu).slice(0, 120) + '”');
  if (st === 'MOI' && don.nghi_ngo) dong.push('⚠️ Phòng đang đóng lúc khách gửi');
  if (st !== 'MOI' && nguoi) dong.push((st === 'NHAN' ? 'Xác nhận: ' : st === 'XONG' ? 'Phục vụ: ' : 'Huỷ: ') + nguoi);
  return { title, body: dong.join('\n') };
}
/** Báo quầy chi nhánh của đơn: rung chuông WebSocket + (mặc định) đẩy thông báo. opt.nguoi = tài khoản vừa thao tác; opt.push=false: chỉ rung chuông */
async function baoQuayDon(env, orderId, opt = {}) {
  try {
    if (!env.DB) return;
    const don = await env.DB.prepare('SELECT id, chi_nhanh_id, ten_phong, items, ghi_chu, nghi_ngo, trang_thai, nguoi_xu_ly, tao_luc FROM order_don WHERE id = ?').bind(orderId).first();
    if (!don || !don.chi_nhanh_id) return;
    await pokeQuay(env, don.chi_nhanh_id, 'don');
    if (opt.push === false || String(env.PUSH_LETAN || '1') === '0') return;
    if (don.trang_thai === 'MOI') await henNhacDon(env, don);
    await pushDon(env, don, opt);
  } catch (e) { console.error('baoQuayDon:', e && e.name, e && e.message); }
}
/** Hẹn nhắc đơn MỚI (báo thức của QuayHub chi nhánh). NHAC_PHUT=0 → tắt */
async function henNhacDon(env, don) {
  const phut = env.NHAC_PHUT === undefined || env.NHAC_PHUT === '' ? NHAC_MS_MAC_DINH / 60000 : +env.NHAC_PHUT;
  const st = quayHub(env, don.chi_nhanh_id);
  if (!st || !(phut > 0)) return;
  try { await st.fetch('https://hub/nhac', { method: 'POST', body: JSON.stringify({ id: don.id, sau: phut * 60000 }) }); }
  catch (e) { console.error('henNhacDon:', e && e.name); }
}
/** Đến giờ nhắc: đơn còn MỚI → rung chuông lại + đẩy thông báo nhắc (đơn đã tiếp nhận/xong/huỷ thì thôi) */
export async function nhacDon(env, orderId) {
  if (!env.DB) return 0;
  const don = await env.DB.prepare('SELECT id, chi_nhanh_id, ten_phong, items, ghi_chu, nghi_ngo, trang_thai, nguoi_xu_ly, tao_luc FROM order_don WHERE id = ?').bind(orderId).first();
  if (!don || don.trang_thai !== 'MOI' || !don.chi_nhanh_id) return 0;
  await pokeQuay(env, don.chi_nhanh_id, 'nhac');
  if (String(env.PUSH_LETAN || '1') === '0') return 0;
  return await pushDon(env, don, { nhac: true });
}
async function pushDon(env, don, opt) {
  await pushBangSan(env);
  // máy của quản lý + quầy đúng chi nhánh (admin: máy admin đã bật khi đang chọn chi nhánh này), tài khoản còn hoạt động
  const subs = (await env.DB.prepare(
    `SELECT s.endpoint, s.username, s.chi_nhanh_id, s.dv, s.p256dh, s.auth, t.ho_ten FROM order_push_sub s
       JOIN tai_khoan t ON t.username = s.username AND t.hoat_dong = 1 AND t.vai_tro IN ('admin', 'manager', 'quay')
      WHERE s.chi_nhanh_id = ?1 AND (t.vai_tro = 'admin' OR t.chi_nhanh_id = ?1)`
  ).bind(don.chi_nhanh_id).all()).results || [];
  if (!subs.length) return 0;
  const dangXem = new Set(await quayDangXem(env, don.chi_nhanh_id));
  const nhan = subs.filter(s => !(s.dv && dangXem.has(s.dv)));
  if (!nhan.length) return 0;
  let items = []; try { items = JSON.parse(don.items); } catch (e) {}
  const tenNguoi = async u => {
    if (!u) return '';
    const r = await env.DB.prepare('SELECT ho_ten FROM tai_khoan WHERE username = ?').bind(u).first();
    return (r && r.ho_ten) || u;
  };
  const nd = pushNoiDung(don, items, await tenNguoi(opt.nguoi || don.nguoi_xu_ly));
  const st = don.trang_thai, moi = st === 'MOI';
  if (opt.nhac) {
    const ph = Math.max(1, Math.round((Date.now() - don.tao_luc) / 60000));
    nd.title = '⏰ ' + don.ten_phong + ' đợi ' + ph + ' phút chưa ai tiếp nhận';
  }
  const exp = Date.now() + PUSH_NUT_HAN_MS;
  const actions = moi ? [{ action: 'nhan', title: '✅ Tiếp nhận' }] : st === 'NHAN' ? [{ action: 'xong', title: '🎉 Đã xong' }] : [];
  const ky = {};
  let gui = 0;
  await Promise.allSettled(nhan.map(async s => {
    const khoa = s.username + '|' + s.chi_nhanh_id;
    if (actions.length && !ky[khoa]) ky[khoa] = await nutKy(env, don.id, s.username, s.chi_nhanh_id, exp);
    const payload = {
      t: 'don', id: don.id, st, title: nd.title, body: nd.body, tag: 'don-' + don.id, at: don.tao_luc,
      renotify: moi, silent: !moi, final: st === 'XONG' || st === 'HUY', actions,
      act: actions.length ? { u: s.username, cn: s.chi_nhanh_id, exp, sig: ky[khoa] } : null
    };
    const code = await sendPush(env, s, payload, moi ? { urgency: 'high', ttl: 900 } : { urgency: 'normal', ttl: 3600 });
    if (code >= 200 && code < 300) gui++;
  }));
  return gui;
}


/* ---------- App BMBPlayer chế độ QUẦY (APK 2.0): dịch vụ nền giữ WebSocket + tự hiện thông báo, không qua Web Push ----------
   Đăng nhập quầy trong app → app.dangKy cấp "khoá máy" (dk) gắn tài khoản + chi nhánh + mã máy. Dịch vụ nền dùng dk để nối /quay/ws
   (nghe chuông) và gọi app.sync (lấy đơn đang mở kèm chữ ký nút Tiếp nhận / Đã xong). Khoá không hết hạn theo phiên 12 giờ,
   nhưng mất hiệu lực ngay khi: đăng xuất bằng nút (app.huy), tài khoản bị khoá / đổi vai trò / đổi chi nhánh, hoặc máy bị gỡ. */
const APP_MAX_MAY_USER = 6;
let appBangXong = false;
async function appBangSan(env) {
  if (appBangXong) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS order_app_may (dv TEXT PRIMARY KEY, username TEXT NOT NULL, chi_nhanh_id TEXT NOT NULL,
      ten TEXT NOT NULL DEFAULT '', ua TEXT NOT NULL DEFAULT '', tao_luc INTEGER NOT NULL, lan_cuoi INTEGER NOT NULL DEFAULT 0)`).run();
  appBangXong = true;
}
const appKy = (env, u, cn, dv, t) => hmac(env.SESSION_SECRET, 'dk|' + u + '|' + cn + '|' + dv + '|' + t);
/** dk.<base64url {u,cn,dv,t}>.<chữ ký> → {u, cn, dv} nếu còn hiệu lực */
async function appMay(env, dk) {
  const m = /^dk\.([A-Za-z0-9_-]{10,400})\.([\w-]{22})$/.exec(String(dk || ''));
  if (!m || !env.SESSION_SECRET) return null;
  let p; try { p = JSON.parse(unb64uS(m[1])); } catch (e) { return null; }
  if (!p || typeof p.u !== 'string' || typeof p.cn !== 'string' || !DV_Q_RE.test(p.dv || '') || !p.t) return null;
  if (!same(m[2], await appKy(env, p.u, p.cn, p.dv, p.t))) return null;
  await appBangSan(env);
  const r = await env.DB.prepare(
    `SELECT a.tao_luc, t.vai_tro, t.chi_nhanh_id FROM order_app_may a JOIN tai_khoan t ON t.username = a.username AND t.hoat_dong = 1
      WHERE a.dv = ? AND a.username = ? AND a.chi_nhanh_id = ?`).bind(p.dv, p.u, p.cn).first();
  if (!r || r.tao_luc !== p.t || !VAI_TRO_ORDER.includes(r.vai_tro) || (r.vai_tro !== 'admin' && r.chi_nhanh_id !== p.cn)) return null;
  return { u: p.u, cn: p.cn, dv: p.dv, r: r.vai_tro };
}
async function appDangKy(env, body, request) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const dv = s(body.dv, 40);
  if (!DV_Q_RE.test(dv)) return fail('bad_dv', 400, 'Mã máy không hợp lệ.');
  await appBangSan(env);
  const t = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO order_app_may (dv, username, chi_nhanh_id, ten, ua, tao_luc, lan_cuoi) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(dv) DO UPDATE SET username = excluded.username, chi_nhanh_id = excluded.chi_nhanh_id, ten = excluded.ten,
          ua = excluded.ua, tao_luc = excluded.tao_luc, lan_cuoi = excluded.lan_cuoi`)
      .bind(dv, ss.u, ss.b, s(body.ten, 60), s(request.headers.get('User-Agent') || '', 160), t, t),
    env.DB.prepare(`DELETE FROM order_app_may WHERE username = ?1 AND dv NOT IN
        (SELECT dv FROM order_app_may WHERE username = ?1 ORDER BY tao_luc DESC LIMIT ${APP_MAX_MAY_USER})`).bind(ss.u)
  ]);
  const p = b64uS(JSON.stringify({ u: ss.u, cn: ss.b, dv, t }));
  const cn = await env.DB.prepare(`SELECT COALESCE(NULLIF(ten_ngan,''), ten, id) AS ten FROM chi_nhanh WHERE id = ?`).bind(ss.b).first();
  return ok({ dk: 'dk.' + p + '.' + await appKy(env, ss.u, ss.b, dv, t), branchName: (cn && cn.ten) || ss.b, ql: await qlCo(env, ss.r) });
}
async function appHuy(env, body) {
  const may = await appMay(env, s(body.dk, 600));
  if (!may) return ok({});                                   // đã hết hiệu lực từ trước
  await env.DB.prepare('DELETE FROM order_app_may WHERE dv = ?').bind(may.dv).run();
  return ok({});
}
/** Đơn đang chờ / đang xử lý của chi nhánh (ngày kinh doanh hiện tại) + đơn vừa xong/huỷ 15 phút gần đây (để app gỡ thông báo) */
async function appSync(env, body) {
  const may = await appMay(env, s(body.dk, 600));
  if (!may) return fail('may_het_han', 403, 'Máy này đã bị gỡ khỏi quầy — mở app và đăng nhập lại.');
  const now = Date.now();
  const [rs, tk] = await env.DB.batch([
    env.DB.prepare(`SELECT id, ten_phong, items, ghi_chu, nghi_ngo, trang_thai, nguoi_xu_ly, tao_luc, cap_nhat_luc FROM order_don
      WHERE chi_nhanh_id = ?1 AND tao_luc >= ?2 AND (trang_thai IN ('MOI', 'NHAN') OR cap_nhat_luc >= ?3) ORDER BY tao_luc ASC LIMIT 60`)
      .bind(may.cn, mocNgay(ngayKinhDoanh()), now - 15 * 60000),
    env.DB.prepare('SELECT username, ho_ten FROM tai_khoan WHERE username IN (SELECT nguoi_xu_ly FROM order_don WHERE chi_nhanh_id = ? AND tao_luc >= ?)').bind(may.cn, mocNgay(ngayKinhDoanh()))
  ]);
  const ten = new Map(tk.results.map(r => [r.username, r.ho_ten || r.username]));
  const exp = now + PUSH_NUT_HAN_MS;
  const orders = [];
  for (const d of rs.results) {
    let items = []; try { items = JSON.parse(d.items); } catch (e) {}
    const nd = pushNoiDung(d, items, ten.get(d.nguoi_xu_ly) || d.nguoi_xu_ly || '');
    const coNut = d.trang_thai === 'MOI' || d.trang_thai === 'NHAN';
    orders.push({ id: d.id, st: d.trang_thai, room: d.ten_phong, title: nd.title, body: nd.body, at: d.tao_luc, upd: d.cap_nhat_luc || d.tao_luc,
      act: coNut ? { u: may.u, cn: may.cn, exp, sig: await nutKy(env, d.id, may.u, may.cn, exp) } : null });
  }
  if (Math.random() < 0.05) await env.DB.prepare('UPDATE order_app_may SET lan_cuoi = ? WHERE dv = ?').bind(now, may.dv).run();
  return ok({ now, u: may.u, cn: may.cn, orders, ql: await qlThongBao(env, may, body.tbSau) });
}


/* ---------- App chế độ Quầy cho QUẢN LÝ CHI NHÁNH: Bảo trì / Đặt phòng (admin.html) + thông báo sự cố / đặt phòng ----------
   Hai công tắc ở admin.html → Cài đặt (bảng cai_dat dùng chung): app_ql_baotri, app_ql_thongbao. Chỉ tài khoản manager.
   - Thông báo: bmb-quanly-worker ghi bảng app_thong_bao (đúng các tin Telegram riêng gửi quản lý chi nhánh) rồi gọi
     /api/app/relay để rung chuông; app gọi app.sync kèm tbSau (id cuối đã thấy) → nhận phần mới.
   - Mở admin.html không đăng nhập lại: app.veAdmin ghi 1 vé dùng 1 lần (sso_ve, 60 giây) → admin.html#ve=… → sso_doi. */
const QL_VAI_TRO = ['manager'];
async function qlBangSan(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_thong_bao (id INTEGER PRIMARY KEY AUTOINCREMENT, chi_nhanh_id TEXT NOT NULL,
      loai TEXT NOT NULL, ma TEXT NOT NULL DEFAULT '', tieu_de TEXT NOT NULL DEFAULT '', noi_dung TEXT NOT NULL DEFAULT '',
      muc_do INTEGER, im_lang INTEGER NOT NULL DEFAULT 0, tru_user TEXT NOT NULL DEFAULT '', tao_luc INTEGER NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_app_thong_bao_cn ON app_thong_bao (chi_nhanh_id, id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sso_ve (ve TEXT PRIMARY KEY, username TEXT NOT NULL, tao_luc INTEGER NOT NULL, het_han INTEGER NOT NULL)')
  ]);
}
let qlBangXong = false;
async function qlCaiDat(env) {
  const { results } = await env.DB.prepare(`SELECT khoa, gia_tri FROM cai_dat WHERE khoa IN ('app_ql_baotri', 'app_ql_thongbao')`).all();
  const m = {}; (results || []).forEach(r => { m[r.khoa] = r.gia_tri; });
  return { tabs: m.app_ql_baotri === 'Y', tb: m.app_ql_thongbao === 'Y' };
}
async function qlCo(env, vaiTro) {
  if (!QL_VAI_TRO.includes(vaiTro)) return { tabs: false, tb: false };
  return qlCaiDat(env);
}
/** Thông báo quản lý mới hơn tbSau. Lần đầu (app chưa có mốc: tbSau trống hoặc âm) chỉ trả mốc, không dồn tin cũ. */
async function qlThongBao(env, may, tbSau) {
  const dau = tbSau === undefined || tbSau === null || tbSau === '' || !(Number(tbSau) >= 0);
  const co = await qlCo(env, may.r);
  if (!co.tb) return { tabs: co.tabs, tb: [], moc: dau ? -1 : Math.floor(Number(tbSau)) };
  if (!qlBangXong) { await qlBangSan(env); qlBangXong = true; }
  const sau = dau ? 0 : Math.floor(Number(tbSau));
  if (dau) {
    const r = await env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM app_thong_bao WHERE chi_nhanh_id = ?').bind(may.cn).first();
    return { tabs: co.tabs, tb: [], moc: (r && r.m) || 0 };
  }
  const { results } = await env.DB.prepare(`SELECT id, loai, ma, tieu_de, noi_dung, muc_do, im_lang, tru_user, tao_luc FROM app_thong_bao
      WHERE chi_nhanh_id = ?1 AND id > ?2 AND tao_luc > ?3 ORDER BY id ASC LIMIT 30`).bind(may.cn, sau, Date.now() - 24 * 3600000).all();
  let moc = sau;
  const tb = [];
  for (const x of results || []) {
    moc = Math.max(moc, x.id);
    if (x.tru_user && x.tru_user === may.u) continue;            // chính người này vừa làm: khỏi báo lại
    tb.push({ id: x.id, loai: x.loai, ma: x.ma, title: x.tieu_de, body: x.noi_dung, md: x.muc_do, im: !!x.im_lang, at: x.tao_luc });
  }
  return { tabs: co.tabs, tb, moc };
}
/** App xin vé mở admin.html (Bảo trì / Đặt phòng) đã đăng nhập sẵn */
async function appVeAdmin(env, body) {
  const may = await appMay(env, s(body.dk, 600));
  if (!may) return fail('may_het_han', 403, 'Máy này đã bị gỡ khỏi quầy — mở app và đăng nhập lại.');
  const co = await qlCo(env, may.r);
  if (!co.tabs) return fail('forbidden', 403, 'Chức năng Bảo trì / Đặt phòng trong app chưa được bật cho tài khoản này.');
  if (!qlBangXong) { await qlBangSan(env); qlBangXong = true; }
  const ve = b64uB(crypto.getRandomValues(new Uint8Array(24)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sso_ve (ve, username, tao_luc, het_han) VALUES (?,?,?,?)').bind(ve, may.u, now, now + 60000),
    env.DB.prepare('DELETE FROM sso_ve WHERE het_han < ?').bind(now - 3600000)
  ]);
  return ok({ ve, url: 'https://boommusicbox.vn/admin.html' });
}

/* ---------- Kết nối Telegram riêng ngay trong quầy (quay.html) ----------
   Cùng cơ chế với admin.html → Cài đặt → Thông báo: mã dùng 1 lần (bảng tg_ma_ket_noi) → deep link t.me/<bot>?start=<mã> → bot (webhook nằm ở
   bmb-quanly-worker) ghi tg_chat_id vào tai_khoan. Worker này chỉ tạo mã / đọc trạng thái / tạm dừng / ngắt cho CHÍNH tài khoản đang đăng nhập.
   Người nhận tin "gọi lễ tân" = manager + quay đã kết nối (xem tgDon). */
let tgRiengXong = false;
async function tgRiengBangSan(env) {
  if (tgRiengXong) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS tg_ma_ket_noi (ma TEXT PRIMARY KEY, username TEXT NOT NULL, het_han INTEGER NOT NULL)').run();
  tgRiengXong = true;
}
async function tgRiengBot(env) {
  const { results } = await env.DB.prepare(`SELECT khoa, gia_tri FROM cai_dat WHERE khoa IN ('tg_bot_token', 'tg_bot_username')`).all();
  const m = {}; (results || []).forEach(r => { m[r.khoa] = String(r.gia_tri || '').trim(); });
  let bot = m.tg_bot_username || '';
  if (!bot && m.tg_bot_token) {
    const j = await fetch('https://api.telegram.org/bot' + m.tg_bot_token + '/getMe', { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => ({}));
    bot = (j && j.ok && j.result && j.result.username) || '';
  }
  return { coBot: !!m.tg_bot_token, bot };
}
async function tgRiengDoc(env, ss) {
  const [u, b] = await Promise.all([
    env.DB.prepare('SELECT tg_chat_id, tg_ten, tg_tam_dung, tg_ket_noi_luc FROM tai_khoan WHERE username = ?').bind(ss.u).first(),
    tgRiengBot(env)
  ]);
  return ok({ coBot: b.coBot, bot: b.bot, ketNoi: !!(u && u.tg_chat_id && u.tg_ket_noi_luc), ten: (u && u.tg_ten) || '', tamDung: !!(u && u.tg_tam_dung) });
}
async function tgRiengTrangThai(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  await tgRiengBangSan(env);
  return tgRiengDoc(env, ss);
}
async function tgRiengTaoMa(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  await tgRiengBangSan(env);
  const b = await tgRiengBot(env);
  if (!b.bot) return fail('chua_co_bot', 400, 'Hệ thống chưa cài bot Telegram — báo admin.');
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const ma = [...crypto.getRandomValues(new Uint8Array(20))].map(x => A[x % A.length]).join('');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tg_ma_ket_noi WHERE het_han < ?').bind(now),      // chỉ dọn mã hết hạn (mã cũ của chính người này giữ lại tới khi kết nối xong)
    env.DB.prepare('INSERT INTO tg_ma_ket_noi (ma, username, het_han) VALUES (?,?,?)').bind(ma, ss.u, now + 15 * 60000)
  ]);
  return ok({ link: 'https://t.me/' + b.bot + '?start=' + ma });
}
async function tgRiengTamDung(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  await env.DB.prepare('UPDATE tai_khoan SET tg_tam_dung = ? WHERE username = ?').bind(body.bat ? 1 : 0, ss.u).run();
  return tgRiengDoc(env, ss);
}
async function tgRiengNgat(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const u = await env.DB.prepare('SELECT tg_chat_id FROM tai_khoan WHERE username = ?').bind(ss.u).first();
  if (u && u.tg_chat_id) {
    try { const t = await tgToken(env); if (t) await tgGoi(t, 'sendMessage', { chat_id: u.tg_chat_id, text: '🔕 Đã ngắt kết nối Telegram từ màn Quầy.' }); } catch (e) {}
  }
  await env.DB.prepare(`UPDATE tai_khoan SET tg_chat_id = '', tg_ten = '', tg_tam_dung = 0, tg_ket_noi_luc = NULL WHERE username = ?`).bind(ss.u).run();
  return tgRiengDoc(env, ss);
}

/* ---------- API thông báo đẩy (action trong POST /api) ---------- */
async function pushKey(env) { return ok({ key: (await getVapid(env)).pub }); }
async function pushDangKy(env, body, request) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  const sub = body.sub || {}, k = sub.keys || {};
  const ep = s(sub.endpoint, 800);
  let u; try { u = new URL(ep); } catch (e) { u = null; }
  if (!u || u.protocol !== 'https:') return fail('bad_endpoint', 400, 'Địa chỉ thông báo không hợp lệ.');
  const p256dh = s(k.p256dh, 200), auth = s(k.auth, 100);
  if (!p256dh || !auth) return fail('bad_keys', 400, 'Khoá thông báo không hợp lệ.');
  const dv = DV_Q_RE.test(s(body.dv, 40)) ? s(body.dv, 40) : '';
  await pushBangSan(env);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO order_push_sub (endpoint, username, chi_nhanh_id, dv, p256dh, auth, ua, tao_luc) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET username = excluded.username, chi_nhanh_id = excluded.chi_nhanh_id, dv = excluded.dv,
          p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, tao_luc = excluded.tao_luc`)
      .bind(ep, ss.u, ss.b, dv, p256dh, auth, s(request.headers.get('User-Agent') || '', 160), Date.now()),
    env.DB.prepare(`DELETE FROM order_push_sub WHERE username = ?1 AND endpoint NOT IN
        (SELECT endpoint FROM order_push_sub WHERE username = ?1 ORDER BY tao_luc DESC LIMIT ${PUSH_MAX_MAY_USER})`).bind(ss.u)
  ]);
  return ok({});
}
async function pushHuyDangKy(env, body) {
  const ep = s((body.sub && body.sub.endpoint) || body.endpoint, 800);
  if (!ep) return fail('missing_endpoint');
  await pushBangSan(env);
  await env.DB.prepare('DELETE FROM order_push_sub WHERE endpoint = ?').bind(ep).run();   // chỉ người giữ máy biết endpoint
  return ok({});
}
async function pushThu(env, body) {
  const [ss, loi] = await canPhien(env, body);
  if (loi) return loi;
  await pushBangSan(env);
  const ep = s(body.endpoint, 800);
  const sub = await env.DB.prepare('SELECT * FROM order_push_sub WHERE endpoint = ? AND username = ?').bind(ep, ss.u).first();
  if (!sub) return fail('chua_bat', 404, 'Máy này chưa bật thông báo.');
  const code = await sendPush(env, sub, { t: 'thu', title: '🔔 BMBPlayer · thử thông báo', body: 'Máy này sẽ nhận yêu cầu gọi lễ tân của chi nhánh đang chọn.', tag: 'thu', renotify: true }, { urgency: 'high', ttl: 120 });
  if (code >= 200 && code < 300) return ok({});
  return fail('gui_loi', 502, code === 404 || code === 410 ? 'Máy đã tắt thông báo — bấm Bật lại.' : 'Dịch vụ thông báo của trình duyệt chưa nhận (mã ' + code + '). Thử lại sau.');
}
/** Bấm nút trên thông báo: {orderId, act:'nhan'|'xong', u, cn, exp, sig} — chữ ký do Worker cấp lúc gửi thông báo cho đúng tài khoản đó */
async function pushBam(env, body, ctx) {
  const orderId = s(body.orderId, 40), act = s(body.act, 10), u = s(body.u, 40), cn = s(body.cn, 40), exp = Math.floor(Number(body.exp) || 0);
  if (!orderId || !['nhan', 'xong'].includes(act) || !u || !cn || !exp) return fail('missing_or_bad_params');
  if (Date.now() > exp) return fail('het_han', 403, 'Thông báo đã cũ — mở màn quầy để xử lý.');
  if (!same(s(body.sig, 40), await nutKy(env, orderId, u, cn, exp))) return fail('forbidden', 403, 'Nút không hợp lệ.');
  const tk = await env.DB.prepare('SELECT username, vai_tro, chi_nhanh_id FROM tai_khoan WHERE username = ? AND hoat_dong = 1').bind(u).first();
  if (!tk || !VAI_TRO_ORDER.includes(tk.vai_tro) || (tk.vai_tro !== 'admin' && tk.chi_nhanh_id !== cn))
    return fail('forbidden', 403, 'Tài khoản này không còn quyền xử lý đơn ở chi nhánh này.');
  const r = await doiTrangThai(env, ctx, orderId, act, cn, u);
  if (!r.ok) return fail(r.error, r.status || 400, r.msg);
  chayNen(ctx, tgDon(env, orderId, { nguoi: u }));
  chayNen(ctx, baoQuayDon(env, orderId, { nguoi: u }));
  return ok({ st: r.st });
}


/* ============================================================
   Ảnh món (menu mẫu + món riêng)
   Ảnh đã được trình duyệt cắt vuông, thu 256 px, nén WebP/JPEG (~10–25 KB) trước khi gửi lên.
   Lưu R2 (binding FILES) khóa mon/<10 ký tự đầu SHA-256>. Trong bảng menu, cột icon giữ 'img:<10 hex>'
   (không đổi cấu trúc D1). Cùng nội dung → cùng khóa nên không bị lưu trùng; phục vụ kèm cache 1 năm (immutable).
   ============================================================ */
const MON_ANH_MAX = 150 * 1024;
const MON_ANH_RE = /^\/mon\/([0-9a-f]{10})$/;
function loaiAnh(b) {
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  return '';
}
async function monAnhTai(req, env, ch) {
  const ss = await getSession(env, { session: req.headers.get('x-session') || '' }).catch(() => null);
  if (!ss) return jres({ ok: false, error: 'unauthorized', msg: 'Phiên đã hết, đăng nhập lại.' }, 401, ch);
  if (!ss.suaMenu) return jres({ ok: false, error: 'forbidden', msg: 'Tài khoản chưa được cấp quyền sửa menu.' }, 403, ch);
  if (!env.FILES) return jres({ ok: false, error: 'no_r2', msg: 'Worker chưa gắn R2 (binding FILES).' }, 501, ch);
  const len = Number(req.headers.get('content-length') || 0);
  if (!len || len > MON_ANH_MAX) return jres({ ok: false, error: 'size', msg: 'Ảnh rỗng hoặc quá lớn (tối đa 150 KB sau khi nén).' }, 413, ch);
  const buf = await req.arrayBuffer();
  const u8 = new Uint8Array(buf), ct = loaiAnh(u8);
  if (buf.byteLength !== len || !ct) return jres({ ok: false, error: 'khong_phai_anh', msg: 'File không phải ảnh WebP/JPEG/PNG.' }, 400, ch);
  const dg = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  const h = Array.from(dg.slice(0, 5), x => x.toString(16).padStart(2, '0')).join('');
  await env.FILES.put('mon/' + h, buf, { httpMetadata: { contentType: ct } });
  return jres({ ok: true, icon: 'img:' + h }, 200, ch);
}
async function monAnhDoc(env, h) {
  const o = env.FILES ? await env.FILES.get('mon/' + h) : null;
  if (!o) return new Response('Không có ảnh.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=60' } });
  return new Response(o.body, { headers: { 'content-type': (o.httpMetadata && o.httpMetadata.contentType) || 'image/webp', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' } });
}


/* ============================================================
   Phát hành APK (từ 10/2026) — thay cho việc chép dist/BMBPlayer.apk lên GitHub.
   Chỉ admin CAO NHẤT (tai_khoan.sieu_admin = 1) tải lên được, từ quay.html → Cài đặt.
   File nằm trong R2 (binding FILES, bucket bmbplayer-files) tại apk/BMBPlayer.apk; số phiên bản nằm ở bảng riêng order_app_phat_hanh
   (không đụng cai_dat dùng chung với app quản lý BMB).
     PUT /api/admin/apk?vc=&vn=&pk=   (header x-session)   tải lên + phát hành
     GET /api/app/ver                  {vc, vn, url}       công khai — APK hỏi để tự cập nhật
     GET /app.apk                      file APK mới nhất   công khai
   ============================================================ */
const APK_KEY = 'apk/BMBPlayer.apk';
const APK_MAX = 60 * 1024 * 1024;
const APK_PKG = 'vn.boommusicbox.bmbplayer';
async function apkBang(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS order_app_phat_hanh (khoa TEXT PRIMARY KEY, gia_tri TEXT NOT NULL DEFAULT \'\')').run();
}
async function apkPhienBan(env) {
  try {
    await apkBang(env);
    const { results } = await env.DB.prepare(`SELECT khoa, gia_tri FROM order_app_phat_hanh WHERE khoa IN ('vc','vn','luc','kb')`).all();
    const m = {}; for (const r of results) m[r.khoa] = r.gia_tri;
    return { vc: Number(m.vc) || 0, vn: m.vn || '', luc: Number(m.luc) || 0, kb: Number(m.kb) || 0 };
  } catch (e) { return { vc: 0, vn: '', luc: 0, kb: 0 }; }
}
async function apkPhatHanh(req, env, u, ch) {
  const ss = await getSession(env, { session: req.headers.get('x-session') || '' }).catch(() => null);
  if (!ss) return jres({ ok: false, error: 'unauthorized', msg: 'Phiên đã hết, đăng nhập lại.' }, 401, ch);
  const tk = await env.DB.prepare('SELECT sieu_admin FROM tai_khoan WHERE username = ?').bind(ss.u).first();
  if (ss.r !== 'admin' || !tk || Number(tk.sieu_admin) !== 1)
    return jres({ ok: false, error: 'forbidden', msg: 'Chỉ admin cao nhất mới phát hành được APK.' }, 403, ch);
  if (!env.FILES) return jres({ ok: false, error: 'no_r2', msg: 'Worker chưa gắn R2 (binding FILES). Xem wrangler.toml.' }, 501, ch);
  const vc = Math.floor(Number(u.searchParams.get('vc')));
  const vn = s(u.searchParams.get('vn') || '', 20), pk = s(u.searchParams.get('pk') || '', 80);
  if (!(vc >= 1 && vc < 1e9) || !vn || !/^[0-9A-Za-z._-]+$/.test(vn)) return jres({ ok: false, error: 'ver', msg: 'Thiếu hoặc sai versionCode / versionName.' }, 400, ch);
  if (pk !== APK_PKG) return jres({ ok: false, error: 'pkg', msg: 'Đây không phải APK BMBPlayer (' + APK_PKG + ').' }, 400, ch);
  const cu = await apkPhienBan(env);
  if (vc <= cu.vc) return jres({ ok: false, error: 'vc_thap', msg: 'versionCode ' + vc + ' không lớn hơn bản đang phát hành (' + cu.vc + '). Máy sẽ không cập nhật được.' }, 409, ch);
  const len = Number(req.headers.get('content-length') || 0);
  if (!len || len > APK_MAX) return jres({ ok: false, error: 'size', msg: 'File rỗng hoặc quá lớn (tối đa 60 MB).' }, 413, ch);
  const buf = await req.arrayBuffer();
  const mag = new Uint8Array(buf.slice(0, 4));
  if (buf.byteLength !== len || mag[0] !== 0x50 || mag[1] !== 0x4B) return jres({ ok: false, error: 'khong_phai_apk', msg: 'File không phải APK (zip).' }, 400, ch);
  await env.FILES.put(APK_KEY, buf, { httpMetadata: { contentType: 'application/vnd.android.package-archive', contentDisposition: 'attachment; filename="BMBPlayer.apk"' } });
  await apkBang(env);
  const now = Date.now();
  await env.DB.batch([
    ...[['vc', String(vc)], ['vn', vn], ['luc', String(now)], ['kb', String(len)]].map(([k, v]) =>
      env.DB.prepare('INSERT INTO order_app_phat_hanh (khoa, gia_tri) VALUES (?,?) ON CONFLICT(khoa) DO UPDATE SET gia_tri = excluded.gia_tri').bind(k, v)),
    ghiNhatKy(env, 'APK_RELEASE', ss.u + ' phát hành BMBPlayer ' + vn + ' (' + vc + '), ' + Math.round(len / 1024) + ' KB')
  ]);
  return jres({ ok: true, vc, vn }, 200, ch);
}

export default {
  async fetch(req, env, ctx){
    const u = new URL(req.url);
    if(!env.SECRET) return jres({ error: 'Worker chưa đặt secret SECRET' }, 500);

    /* Nút bấm Telegram: bmb-quanly-worker (nơi đặt webhook của bot) chuyển callback "od:" sang đây, kèm header x-relay-secret = secret TG_RELAY_SECRET */
    if(u.pathname === '/api/tg/relay' && req.method === 'POST'){
      const kho = String(env.TG_RELAY_SECRET || '');
      if(!kho) return new Response('not found', { status: 404 });
      const gui = req.headers.get('x-relay-secret') || '';
      if(gui.length !== kho.length || !same(gui, kho)) return new Response('forbidden', { status: 403 });
      const up = await req.json().catch(() => null);
      if(up && up.callback_query) await tgCallback(env, ctx, up.callback_query);
      return jres({ ok: true });
    }

    /* bmb-quanly-worker vừa ghi thông báo quản lý (sự cố / đặt phòng) → rung chuông chi nhánh để app quản lý lấy về ngay.
       Cùng secret với nút Telegram: TG_RELAY_SECRET (ở đây) = BMBPLAYER_RELAY_SECRET (bên bmb-quanly-worker). */
    if(u.pathname === '/api/app/relay' && req.method === 'POST'){
      const kho = String(env.TG_RELAY_SECRET || '');
      if(!kho) return new Response('not found', { status: 404 });
      const gui = req.headers.get('x-relay-secret') || '';
      if(gui.length !== kho.length || !same(gui, kho)) return new Response('forbidden', { status: 403 });
      const b = await req.json().catch(() => ({}));
      const cn = String(b.cn || '').slice(0, 40);
      if(cn) ctx.waitUntil(pokeQuay(env, cn, 'ql'));
      return jres({ ok: true });
    }

    /* Ảnh món: GET /mon/<hash> (công khai, cache dài) · PUT /api/admin/mon-anh (cần phiên có quyền sửa menu) */
    { const mm = MON_ANH_RE.exec(u.pathname); if(mm && req.method === 'GET') return monAnhDoc(env, mm[1]); }
    if(u.pathname === '/api/admin/mon-anh'){
      const ch0 = cors(req, env), org = req.headers.get('Origin');
      if(org && !origins(env).includes(org)) return jres({ ok: false, error: 'origin' }, 403, ch0);
      if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch0 });
      if(req.method === 'PUT') return monAnhTai(req, env, ch0);
      return jres({ ok: false, error: 'method' }, 405, ch0);
    }

    /* Phát hành / tự cập nhật APK (xem khối "Phát hành APK" phía trên) */
    if(u.pathname === '/api/app/ver' && req.method === 'GET'){
      const v = await apkPhienBan(env);
      return jres({ vc: v.vc, vn: v.vn, url: u.origin + '/app.apk' }, 200, { 'Access-Control-Allow-Origin': '*' });
    }
    if(u.pathname === '/app.apk' && req.method === 'GET'){
      const o = env.FILES ? await env.FILES.get(APK_KEY) : null;
      if(!o) return new Response('Chưa phát hành bản APK nào.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return new Response(o.body, { headers: { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': 'attachment; filename="BMBPlayer.apk"', 'content-length': String(o.size), 'cache-control': 'no-store' } });
    }
    if(u.pathname === '/api/admin/apk'){
      const ch0 = cors(req, env), org = req.headers.get('Origin');
      if(org && !origins(env).includes(org)) return jres({ ok: false, error: 'origin' }, 403, ch0);
      if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch0 });
      if(req.method === 'GET'){                                   // quay.html hỏi bản đang phát hành (cần phiên quầy)
        const ss = await getSession(env, { session: req.headers.get('x-session') || '' }).catch(() => null);
        if(!ss) return jres({ ok: false, error: 'unauthorized' }, 401, ch0);
        return jres(Object.assign({ ok: true, r2: !!env.FILES }, await apkPhienBan(env)), 200, ch0);
      }
      if(req.method === 'PUT') return apkPhatHanh(req, env, u, ch0);
      return jres({ ok: false, error: 'method' }, 405, ch0);
    }

    /* API quầy + gọi lễ tân (giữ nguyên cách gọi của quay.html cũ: POST JSON {action,...}) */
    if(u.pathname === '/api' || u.pathname === '/api/') return handleApi(req, env, ctx);

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

    // Chủ đề trang trí tivi đang chọn (công khai, chỉ một chuỗi ngắn)
    if(u.pathname === '/api/deco' && req.method === 'GET'){
      return jres({ deco: await decoGet(env), score: await scoreGet(env) }, 200, Object.assign({ 'Cache-Control': 'no-store' }, originOk ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}));
    }

    /* Màn quầy (quay.html): WebSocket "cái chuông" của chi nhánh — có đơn / đổi trạng thái thì quầy tự tải lại hàng đợi */
    if(u.pathname === '/quay/ws'){
      if(!originOk) return new Response('origin', { status: 403 });
      return quayWs(req, env);
    }

    /* Kết nối WebSocket của TV / máy tính bảng / điện thoại */
    if(u.pathname === '/ws'){
      if(!originOk) return new Response('origin', { status: 403 });
      const t = parseToken(u.searchParams.get('r'));
      if(!t) return new Response('bad token', { status: 403 });
      const cf = req.cf || {}, h = new Headers(req.headers);              // nhà mạng của máy (Viettel/VNPT/FPT…) → biết đường mạng nào của chi nhánh hay rớt
      h.set('x-bmb-kn', JSON.stringify({ isp: String(cf.asOrganization || '').slice(0, 40), asn: cf.asn || 0, colo: cf.colo || '' }));
      return roomStub(env, t.id).fetch(new Request(req, { headers: h }));
    }

    /* TV chưa gán phòng: xin mã 6 số, rồi hỏi lại tới khi quầy gán (không cần mật khẩu, chỉ đúng tên miền) */
    if(u.pathname === '/api/tv/pair/new' && req.method === 'POST'){
      if(!originOk) return jres({ error: 'origin' }, 403, ch);
      const body = await req.json().catch(() => ({}));
      const r = await callR(regStub(env), '/tvpair/new', { ip, kind: body.kind === 'tb' ? 'tb' : 'tv' });   // kind tb: máy tính bảng chưa gán xin mã
      return jres(r.data, r.status, ch);
    }
    if(u.pathname === '/api/tv/pair/poll' && req.method === 'POST'){
      if(!originOk) return jres({ error: 'origin' }, 403, ch);
      const body = await req.json().catch(() => ({}));
      const r = await callR(regStub(env), '/tvpair/poll', { code: String(body.code || '').replace(/\D/g, ''), key: String(body.key || '') });
      return jres(r.data, r.status, ch);
    }
    /* Máy tính bảng ĐÃ được quầy cho phép (có quyền thiết bị dv, hoặc đang giữ mã máy tính bảng còn hiệu lực)
       đổi QR khách đang hiện trên TV lấy mã máy tính bảng của phòng đó (đổi phòng trong cùng chi nhánh).
       Điện thoại khách có QR nhưng không có quyền thiết bị → bị từ chối (trước đây ai có QR cũng chiếm được máy tính bảng của phòng). */
    if(u.pathname === '/api/tablet/claim' && req.method === 'POST'){
      if(!originOk) return jres({ error: 'origin' }, 403, ch);
      const body = await req.json().catch(() => ({})), t = parseToken(body.r);
      if(!t) return jres({ error: 'Không phải mã QR phòng. Quét mã ở góc trái TV.' }, 400, ch);
      const ph = await env.DB.prepare('SELECT chi_nhanh_id FROM order_phong WHERE id = ?').bind(t.id).first();
      if(!ph) return jres({ error: 'Không có phòng này.' }, 404, ch);
      let branch = await devOk(env, body.dv);
      if(!branch){                                       // máy gán từ bản cũ (chưa có dv): mã máy tính bảng đang dùng được thì vẫn cho
        const cur = parseToken(body.tb);
        if(cur){
          const ck = await call(roomStub(env, cur.id), '/check', { r: body.tb, role: 'tablet' }).catch(() => ({}));
          if(ck.valid){ const p0 = await env.DB.prepare('SELECT chi_nhanh_id FROM order_phong WHERE id = ?').bind(cur.id).first(); branch = p0 ? p0.chi_nhanh_id : ''; }
        }
      }
      if(!branch) return jres({ error: 'Máy này chưa được quầy cho phép làm máy tính bảng. Nhờ nhân viên quầy quét mã gán đang hiện trên máy.', need: 'pair' }, 403, ch);
      if(branch !== ph.chi_nhanh_id) return jres({ error: 'Máy tính bảng này thuộc chi nhánh khác. Nhờ nhân viên quầy gán lại.', need: 'pair' }, 403, ch);
      const r = await callR(roomStub(env, t.id), '/tbclaim', { r: body.r, ip });
      if(r.status === 200 && r.data.tok) r.data.dv = await mkDev(env, branch);
      return jres(r.data, r.status, ch);
    }
    if(u.pathname === '/api/tokcheck' && req.method === 'POST'){
      if(!originOk) return jres({ error: 'origin' }, 403, ch);
      const body = await req.json().catch(() => ({})), t = parseToken(body.r);
      if(!t) return jres({ valid: false }, 200, ch);
      const role = body.role === 'tv' ? 'tv' : body.role === 'remote' ? 'remote' : 'tablet';
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
      const body = await req.json().catch(() => ({})), room = String(body.room || '');
      const passOk = !!nhacPass(env) && same(req.headers.get('x-pass') || '', nhacPass(env));
      if(!passOk && !(body.guest && await nhacUserOk(env, body.guest))) return jres({ error: 'Sai mật khẩu' }, 401, ch);
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
