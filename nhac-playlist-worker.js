/* Playlist Worker (nhac-playlist) — playlist yêu thích + TÀI KHOẢN TỪNG NGƯỜI (10/2026)
   Lưu playlist (chỉ ID video + thứ tự) trong D1, khoá YouTube API ở phía server,
   tiêu đề/ảnh luôn lấy mới từ YouTube khi mở playlist.

   Binding:   DB (D1 database)
   Secrets:   YT_KEY (YouTube Data API key), APP_PASS (mã QUẢN TRỊ — mã của anh Hưng, như trước)
              GUEST_SECRET (tuỳ chọn, GIỐNG HỆT Worker kho-karaoke/bmbplayer) — để người dùng thường
              vẫn dùng được kho karaoke (tìm bài, bài hot) bằng vé khách; không đặt thì họ chỉ dùng được tìm YouTube + link.
   Variable:  ALLOWED_ORIGINS (các địa chỉ trang được gọi, cách nhau bằng dấu phẩy)
              USER_SEARCH_PER_WEEK (tuỳ chọn, mặc định 5) — lượt tìm YouTube mỗi người mỗi tuần (tuần tính từ thứ Hai, giờ Việt Nam)
              MAX_USERS (tuỳ chọn, mặc định 20)

   Cách phân quyền:
   - APP_PASS = quản trị: dùng cũ y nguyên, playlist cũ (tên không có dấu ~) thuộc quản trị, tìm YouTube không giới hạn,
     tạo/đặt lại/xoá mã của người khác.
   - Mỗi người khác có MỘT MÃ riêng (gửi qua header x-pass như mật khẩu cũ). Playlist của họ lưu cùng bảng playlists,
     tên thật được gắn tiền tố "<mã người>~" nên KHÔNG cần sửa cấu trúc bảng cũ. Chỉ thấy/sửa playlist của chính mình.
   - Mã người dùng lưu dạng băm (SHA-256 + muối ngẫu nhiên), không đọc lại được; quên mã thì quản trị đặt mã mới.
   - Bảng mới (users, search_usage, search_cache, auth_fail, cfg) Worker tự tạo ở lần chạy đầu — không phải chạy SQL.
   - Tìm YouTube: từ khoá đã tìm trong 7 ngày trả lại kết quả cũ, KHÔNG tốn lượt (của người dùng lẫn của hạn mức YouTube).
   - Sai mã quá 10 lần trong 10 phút (cùng địa chỉ IP) → khoá tạm 10 phút.
*/
const MAX_PLAYLISTS = 30, MAX_ITEMS = 500, MAX_IMPORT = 200;
const DAY = 86400000, CACHE_FRESH = 7 * DAY;
const ID_RE = /^[\w-]{11}$/;
const LIST_RE = /^[\w-]{10,64}$/;
const ROOM_RE = /^[\w-]{1,20}$/;
const UID_RE = /^u[a-z0-9]{5}$/;
const ACTIONS = ['hello', 'toggle', 'next', 'prev', 'vol', 'shuffle', 'repeat', 'playid', 'reload', 'playlist'];
const SEP = '~';
const CODE_MIN = 6, CODE_MAX = 40;

function safeEqual(a, b){
  a = String(a); b = String(b);
  let r = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for(let i = 0; i < n; i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}
const cleanName = s => { s = String(s || '').trim(); return s.length >= 1 && s.length <= 40 && !s.includes(SEP) ? s : null; };
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const randStr = (alpha, n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => alpha[b % alpha.length]).join('');
const genCode = () => randStr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);       // bỏ O/0, I/1 cho khỏi nhầm
const genId = () => 'u' + randStr('abcdefghijklmnopqrstuvwxyz0123456789', 5);

/* ---------- Tuần (giờ Việt Nam, bắt đầu thứ Hai) ---------- */
function weekKey(now){
  const d = new Date(now + 7 * 3600000);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const weekResetAt = now => Date.parse(weekKey(now) + 'T00:00:00Z') - 7 * 3600000 + 7 * DAY;   // 00:00 thứ Hai tuần sau, giờ VN

/* ---------- Bảng mới: tự tạo lần chạy đầu ---------- */
let schemaReady = false, SALT = '';
async function ensureSchema(env){
  if(schemaReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER, pass_at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS search_usage (uid TEXT NOT NULL, week TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, week))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS search_cache (q TEXT PRIMARY KEY, items TEXT, at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS auth_fail (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT)')
  ]);
  await env.DB.prepare("INSERT OR IGNORE INTO cfg (k, v) VALUES ('salt', ?1)").bind(randStr('abcdefghijklmnopqrstuvwxyz0123456789', 32)).run();
  SALT = (await env.DB.prepare("SELECT v FROM cfg WHERE k = 'salt'").first()).v;
  schemaReady = true;
}
const hashCode = code => sha(SALT + '|' + code);

/* ---------- Xác thực ---------- */
async function authenticate(env, pass, ip){
  if(!pass) return { user: null };
  if(safeEqual(pass, env.APP_PASS)) return { user: { admin: true, id: 'admin', name: 'Quản trị' } };
  const now = Date.now(), k = ip + ':' + Math.floor(now / 600000);
  const f = await env.DB.prepare('SELECT n FROM auth_fail WHERE k = ?1').bind(k).first();
  if(f && f.n >= 10) return { locked: true };
  const r = await env.DB.prepare('SELECT id, name FROM users WHERE hash = ?1').bind(await hashCode(pass)).first();
  if(r && UID_RE.test(r.id)) return { user: { admin: false, id: r.id, name: r.name } };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO auth_fail (k, n, at) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + 1, at = ?2').bind(k, now),
    env.DB.prepare('DELETE FROM auth_fail WHERE at < ?1').bind(now - 3600000)
  ]);
  return { user: null };
}

/* ---------- Phạm vi playlist theo người ---------- */
const keyOf = (u, name) => u.admin ? name : u.id + SEP + name;
const shownName = (u, key) => u.admin ? key : key.slice(u.id.length + 1);
function scopeSql(u, col){          // u.id đã qua UID_RE nên ghép thẳng vào câu SQL là an toàn
  if(u.admin) return col + " NOT LIKE '%" + SEP + "%'";
  if(!UID_RE.test(u.id)) throw new Error('uid');
  return col + " LIKE '" + u.id + SEP + "%'";
}

/* ---------- Lượt tìm YouTube theo tuần ---------- */
const weekLimit = env => num(env.USER_SEARCH_PER_WEEK, 5);
async function quotaInfo(env, u){
  if(u.admin) return { unlimited: true };
  const now = Date.now(), wk = weekKey(now), limit = weekLimit(env);
  const r = await env.DB.prepare('SELECT n FROM search_usage WHERE uid = ?1 AND week = ?2').bind(u.id, wk).first();
  const used = Math.min(limit, r ? r.n : 0);
  return { limit, used, left: Math.max(0, limit - used), week: wk, resetAt: weekResetAt(now) };
}

/* ---------- Vé khách cho kho-karaoke (cùng cách ký với Worker bmbplayer) ---------- */
async function khoTicket(env, u){
  if(!env.GUEST_SECRET) return null;
  const exp = Date.now() + 6 * 3600000, payload = 'nhac-' + u.id + '.' + exp;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.GUEST_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('guest|' + payload)));
  const sig = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
  return { ticket: payload + '.' + sig, exp };
}

/* ---------- YouTube Data API ---------- */
async function yt(path, params, env){
  const url = 'https://www.googleapis.com/youtube/v3/' + path + '?' + new URLSearchParams(Object.assign({}, params, { key: env.YT_KEY }));
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if(!res.ok){
    const er = data.error || {};
    const e = new Error(er.message || 'Lỗi YouTube API');
    e.reason = (er.errors && er.errors[0] && er.errors[0].reason) || '';
    e.status = e.reason === 'quotaExceeded' ? 429 : (e.reason === 'playlistNotFound' ? 404 : 502);
    throw e;
  }
  return data;
}
async function fetchMeta(ids, env){            // tối đa 50 video / lần gọi, 1 đơn vị quota
  const out = {};
  for(let i = 0; i < ids.length; i += 50){
    const data = await yt('videos', { part:'snippet,status', id: ids.slice(i, i + 50).join(',') }, env);
    for(const v of data.items || []){
      const th = (v.snippet.thumbnails && (v.snippet.thumbnails.medium || v.snippet.thumbnails.default)) || {};
      out[v.id] = { id:v.id, title:v.snippet.title, channel:v.snippet.channelTitle, thumb:th.url || '',
                    embeddable: !(v.status && v.status.embeddable === false) };
    }
  }
  return out;
}
async function listPlaylistIds(list, env){
  const ids = []; let token = '', pages = 0;
  do{
    const params = { part:'snippet', maxResults:'50', playlistId:list };
    if(token) params.pageToken = token;
    const data = await yt('playlistItems', params, env);
    for(const x of data.items || []){
      const id = x.snippet && x.snippet.resourceId && x.snippet.resourceId.videoId;
      if(id && ID_RE.test(id) && !ids.includes(id)) ids.push(id);
    }
    token = data.nextPageToken || ''; pages++;
  }while(token && pages < 4 && ids.length < MAX_IMPORT);
  return ids.slice(0, MAX_IMPORT);
}

/* ---------- D1 ---------- */
async function ensurePlaylist(env, u, name){
  const key = keyOf(u, name);
  const ex = await env.DB.prepare('SELECT 1 AS x FROM playlists WHERE name = ?1').bind(key).first();
  if(ex) return true;
  const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM playlists WHERE ' + scopeSql(u, 'name')).first();
  if(c.c >= MAX_PLAYLISTS) return false;
  await env.DB.prepare('INSERT OR IGNORE INTO playlists(name, created_at) VALUES(?1, ?2)').bind(key, Date.now()).run();
  return true;
}
const itemCount = async (env, key) =>
  (await env.DB.prepare('SELECT COUNT(*) AS c FROM playlist_items WHERE playlist = ?1').bind(key).first()).c;

/* ---------- Xử lý yêu cầu ---------- */
export default {
  async fetch(request, env){
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const corsOk = allowed.includes(origin);
    const cors = corsOk ? {
      'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'content-type, x-pass',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400' } : {};
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: Object.assign({ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }, cors) });

    if(request.method === 'OPTIONS') return new Response(null, { status: corsOk ? 204 : 403, headers: cors });
    if(!corsOk) return json({ error:'Địa chỉ trang không được phép (kiểm tra ALLOWED_ORIGINS)', reason:'origin' }, 403);
    if(!env.APP_PASS || !env.YT_KEY || !env.DB) return json({ error:'Worker chưa cấu hình đủ DB, YT_KEY, APP_PASS', reason:'config' }, 500);

    const url = new URL(request.url);
    const path = url.pathname, method = request.method;

    try{
      await ensureSchema(env);
      const ip = request.headers.get('CF-Connecting-IP') || 'x';
      const auth = await authenticate(env, request.headers.get('x-pass') || '', ip);
      if(auth.locked) return json({ error:'Nhập sai mã quá nhiều lần. Đợi khoảng 10 phút rồi thử lại.', reason:'locked' }, 429);
      const u = auth.user;
      if(!u) return json({ error:'Sai mã', reason:'unauthorized' }, 401);
      const body = method === 'POST' ? await request.json().catch(() => ({})) : {};

      /* --- Tài khoản của chính mình --- */
      if(path === '/api/me' && method === 'GET'){
        const out = { id: u.id, name: u.name, admin: u.admin, search: await quotaInfo(env, u) };
        const t = await khoTicket(env, u);
        if(t && !u.admin) out.kho = t;           // quản trị dùng thẳng mã như cũ
        return json(out);
      }
      if(path === '/api/me/pass' && method === 'POST'){
        if(u.admin) return json({ error:'Mã quản trị đổi trong Cloudflare (secret APP_PASS), không đổi ở đây.' }, 400);
        const np = String(body.pass || '');
        if(np.length < CODE_MIN || np.length > CODE_MAX || !/^[\x21-\x7E]+$/.test(np))       // chỉ ký tự ASCII: mã đi trong header HTTP, chữ có dấu tiếng Việt sẽ làm trình duyệt báo lỗi
          return json({ error:'Mã gồm ' + CODE_MIN + '–' + CODE_MAX + ' ký tự: chữ không dấu, số hoặc ký hiệu, không có khoảng trắng.' }, 400);
        if(safeEqual(np, env.APP_PASS)) return json({ error:'Mã này không dùng được, hãy chọn mã khác.' }, 409);
        try{
          await env.DB.prepare('UPDATE users SET hash = ?1, pass_at = ?2 WHERE id = ?3').bind(await hashCode(np), Date.now(), u.id).run();
        }catch(e){
          if(/UNIQUE/i.test(String(e.message || e))) return json({ error:'Mã này đã có người dùng, hãy chọn mã khác.' }, 409);
          throw e;
        }
        return json({ ok:true });
      }

      /* --- Quản trị người dùng (chỉ APP_PASS) --- */
      if(path.startsWith('/api/admin/')){
        if(!u.admin) return json({ error:'Chỉ quản trị mới dùng được mục này.' }, 403);
        const limit = weekLimit(env), wk = weekKey(Date.now());
        if(path === '/api/admin/users' && method === 'GET'){
          const { results } = await env.DB.prepare(
            'SELECT u.id AS id, u.name AS name, u.created_at AS created_at, COALESCE(s.n, 0) AS used FROM users u LEFT JOIN search_usage s ON s.uid = u.id AND s.week = ?1 ORDER BY u.created_at').bind(wk).all();
          return json({ users: results.map(r => ({ id:r.id, name:r.name, created_at:r.created_at, used: Math.min(limit, r.used) })), limit, week: wk });
        }
        if(method === 'POST'){
          if(path === '/api/admin/users/create'){
            const name = String(body.name || '').trim().slice(0, 40);
            if(!name) return json({ error:'Thiếu tên người dùng' }, 400);
            const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
            if(c.c >= num(env.MAX_USERS, 20)) return json({ error:'Đã đủ ' + num(env.MAX_USERS, 20) + ' người dùng' }, 400);
            for(let i = 0; i < 6; i++){
              const id = genId(), code = genCode();
              try{
                await env.DB.prepare('INSERT INTO users (id, name, hash, created_at, pass_at) VALUES (?1, ?2, ?3, ?4, ?4)').bind(id, name, await hashCode(code), Date.now()).run();
                return json({ id, name, code });         // mã chỉ hiện đúng một lần này
              }catch(e){ if(!/UNIQUE|PRIMARY/i.test(String(e.message || e))) throw e; }
            }
            return json({ error:'Không tạo được mã, thử lại.' }, 500);
          }
          const id = String(body.id || '');
          if(!UID_RE.test(id)) return json({ error:'Mã người dùng không hợp lệ' }, 400);
          const row = await env.DB.prepare('SELECT id, name FROM users WHERE id = ?1').bind(id).first();
          if(!row) return json({ error:'Không thấy người dùng này' }, 404);
          if(path === '/api/admin/users/reset'){
            for(let i = 0; i < 6; i++){
              const code = genCode();
              try{
                await env.DB.prepare('UPDATE users SET hash = ?1, pass_at = ?2 WHERE id = ?3').bind(await hashCode(code), Date.now(), id).run();
                return json({ id, name: row.name, code });
              }catch(e){ if(!/UNIQUE/i.test(String(e.message || e))) throw e; }
            }
            return json({ error:'Không tạo được mã, thử lại.' }, 500);
          }
          if(path === '/api/admin/users/delete'){
            await env.DB.batch([
              env.DB.prepare('DELETE FROM playlist_items WHERE playlist LIKE ?1').bind(id + SEP + '%'),
              env.DB.prepare('DELETE FROM playlists WHERE name LIKE ?1').bind(id + SEP + '%'),
              env.DB.prepare('DELETE FROM search_usage WHERE uid = ?1').bind(id),
              env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id) ]);
            return json({ ok:true });
          }
        }
        return json({ error:'Không có đường dẫn này' }, 404);
      }

      /* --- Danh sách playlist (của chính mình) --- */
      if(path === '/api/playlists' && method === 'GET'){
        await env.DB.prepare('INSERT OR IGNORE INTO playlists(name, created_at) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM playlists p WHERE ' + scopeSql(u, 'p.name') + ')')
          .bind(keyOf(u, 'Yêu thích'), Date.now()).run();
        const { results } = await env.DB.prepare(
          'SELECT p.name AS name, COUNT(i.video_id) AS count FROM playlists p LEFT JOIN playlist_items i ON i.playlist = p.name WHERE ' + scopeSql(u, 'p.name') + ' GROUP BY p.name ORDER BY p.created_at').all();
        return json({ playlists: results.map(r => ({ name: shownName(u, r.name), count: r.count })) });
      }

      /* --- Đọc 1 playlist (kèm tiêu đề, ảnh mới nhất từ YouTube) --- */
      if(path === '/api/playlist' && method === 'GET'){
        const name = cleanName(url.searchParams.get('name'));
        if(!name) return json({ error:'Thiếu tên playlist' }, 400);
        const { results } = await env.DB.prepare('SELECT video_id FROM playlist_items WHERE playlist = ?1 ORDER BY position').bind(keyOf(u, name)).all();
        const ids = results.map(r => r.video_id);
        const meta = ids.length ? await fetchMeta(ids, env) : {};
        const items = ids.map(id => meta[id] || { id, title:'(video không còn khả dụng)', channel:'', thumb:'', embeddable:false, unavailable:true });
        return json({ name, items });
      }

      /* --- Tìm trên YouTube: mỗi người 5 lượt/tuần (quản trị không giới hạn); từ khoá đã tìm trong 7 ngày không tốn lượt --- */
      if(path === '/api/search' && method === 'GET'){
        const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
        if(!q) return json({ error:'Thiếu từ khoá' }, 400);
        const now = Date.now(), nq = q.toLowerCase().replace(/\s+/g, ' ');
        const hit = await env.DB.prepare('SELECT items, at FROM search_cache WHERE q = ?1').bind(nq).first();
        if(hit && now - hit.at < CACHE_FRESH){
          let items = null; try{ items = JSON.parse(hit.items); }catch(e){}
          if(items) return json({ items, cached:true, search: await quotaInfo(env, u) });
        }
        let counted = false;
        if(!u.admin){
          const wk = weekKey(now), limit = weekLimit(env);
          const noLeft = async () => json({ error:'Hết ' + limit + ' lượt tìm YouTube tuần này. Từ thứ Hai tuần sau có lượt mới. Dán link và tìm trong kho vẫn dùng được.',
                                             reason:'userQuota', search: await quotaInfo(env, u) }, 429);
          const used0 = await env.DB.prepare('SELECT n FROM search_usage WHERE uid = ?1 AND week = ?2').bind(u.id, wk).first();
          if(used0 && used0.n >= limit) return noLeft();
          // cộng lượt NGUYÊN TỬ: hai yêu cầu cùng lúc không vượt được hạn mức (changes = 0 nghĩa là câu cập nhật bị WHERE n < giới hạn chặn)
          const r = await env.DB.prepare('INSERT INTO search_usage (uid, week, n) VALUES (?1, ?2, 1) ON CONFLICT(uid, week) DO UPDATE SET n = n + 1 WHERE n < ?3').bind(u.id, wk, limit).run();
          if(r.meta && r.meta.changes === 0) return noLeft();
          counted = true;
        }
        let data;
        try{
          data = await yt('search', { part:'snippet', type:'video', videoEmbeddable:'true', maxResults:'15', q, regionCode:'VN', relevanceLanguage:'vi' }, env);
        }catch(e){
          if(counted) await env.DB.prepare('UPDATE search_usage SET n = MAX(0, n - 1) WHERE uid = ?1 AND week = ?2').bind(u.id, weekKey(now)).run();   // YouTube lỗi → hoàn lại lượt
          throw e;
        }
        const items = (data.items || []).filter(x => x.id && x.id.videoId).map(x => ({
          id:x.id.videoId, title:x.snippet.title, channel:x.snippet.channelTitle,
          thumb:(x.snippet.thumbnails && (x.snippet.thumbnails.medium || x.snippet.thumbnails.default) || {}).url || '', embeddable:true }));
        await env.DB.batch([
          env.DB.prepare('INSERT OR REPLACE INTO search_cache (q, items, at) VALUES (?1, ?2, ?3)').bind(nq, JSON.stringify(items), now),
          env.DB.prepare('DELETE FROM search_cache WHERE at < ?1').bind(now - CACHE_FRESH) ]);
        return json({ items, search: await quotaInfo(env, u) });
      }

      /* --- Đọc 1 video từ link (1 đơn vị quota, không tính lượt) --- */
      if(path === '/api/video' && method === 'GET'){
        const id = url.searchParams.get('id') || '';
        if(!ID_RE.test(id)) return json({ error:'Mã video không hợp lệ' }, 400);
        const v = (await fetchMeta([id], env))[id];
        if(!v) return json({ error:'Không tìm thấy video (đã xoá hoặc riêng tư)' }, 404);
        if(!v.embeddable) return json({ error:'Chủ video không cho phép phát nhúng', reason:'notEmbeddable' }, 422);
        return json({ item: v });
      }

      /* --- Đọc nhiều video cùng lúc (dùng để làm mới danh mục), tối đa 100 --- */
      if(path === '/api/videos' && method === 'GET'){
        const ids = [...new Set((url.searchParams.get('ids') || '').split(',').filter(x => ID_RE.test(x)))].slice(0, 100);
        if(!ids.length) return json({ error:'Thiếu danh sách video' }, 400);
        const meta = await fetchMeta(ids, env);
        return json({ items: ids.map(id => meta[id]).filter(Boolean) });
      }

      /* --- Xem trước một playlist YouTube (chưa lưu) --- */
      if(path === '/api/import' && method === 'GET'){
        const list = url.searchParams.get('list') || '';
        if(!LIST_RE.test(list)) return json({ error:'Mã playlist không hợp lệ' }, 400);
        const ids = await listPlaylistIds(list, env);
        if(!ids.length) return json({ error:'Playlist trống hoặc riêng tư' }, 404);
        const meta = await fetchMeta(ids, env);
        const items = ids.map(id => meta[id]).filter(v => v && v.embeddable);
        return json({ items, skipped: ids.length - items.length });
      }

      /* --- Điều khiển từ xa: lệnh (remote → trang phát) và trạng thái (trang phát → remote) --- */
      if(path === '/api/cmd' && method === 'GET'){
        const room = url.searchParams.get('room') || '';
        if(!ROOM_RE.test(room)) return json({ error:'Tên phòng không hợp lệ' }, 400);
        const after = parseInt(url.searchParams.get('after') || '-1', 10);
        if(!(after >= 0)){          // lần đầu: chỉ báo mã lệnh mới nhất, không phát lại lệnh cũ
          const m = await env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM commands WHERE room = ?1').bind(room).first();
          return json({ items: [], last: m.m });
        }
        const { results } = await env.DB.prepare('SELECT id, action, payload FROM commands WHERE room = ?1 AND id > ?2 ORDER BY id LIMIT 20').bind(room, after).all();
        return json({ items: results.map(r => { let p = null; try{ p = r.payload ? JSON.parse(r.payload) : null; }catch(e){} return { id:r.id, action:r.action, payload:p }; }) });
      }
      if(path === '/api/cmd' && method === 'POST'){
        const room = String(body.room || ''), action = String(body.action || '');
        if(!ROOM_RE.test(room) || !ACTIONS.includes(action)) return json({ error:'Lệnh không hợp lệ' }, 400);
        let payload = null;
        if(body.payload && typeof body.payload === 'object'){
          payload = JSON.stringify(body.payload);
          if(payload.length > 500) return json({ error:'Lệnh quá lớn' }, 400);
        }
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare('INSERT INTO commands(room, action, payload, created_at) VALUES(?1, ?2, ?3, ?4)').bind(room, action, payload, now),
          env.DB.prepare('DELETE FROM commands WHERE created_at < ?1').bind(now - 600000) ]);   // dọn lệnh cũ hơn 10 phút
        return json({ ok:true });
      }
      if(path === '/api/state' && method === 'GET'){
        const room = url.searchParams.get('room') || '';
        if(!ROOM_RE.test(room)) return json({ error:'Tên phòng không hợp lệ' }, 400);
        const row = await env.DB.prepare('SELECT state, updated_at FROM room_state WHERE room = ?1').bind(room).first();
        if(!row) return json({ state:null, age:null });
        let st = null; try{ st = JSON.parse(row.state); }catch(e){}
        return json({ state: st, age: Date.now() - row.updated_at });
      }
      if(path === '/api/state' && method === 'POST'){
        const room = String(body.room || '');
        if(!ROOM_RE.test(room) || !body.state || typeof body.state !== 'object') return json({ error:'Trạng thái không hợp lệ' }, 400);
        const s = JSON.stringify(body.state);
        if(s.length > 2000) return json({ error:'Trạng thái quá lớn' }, 400);
        await env.DB.prepare('INSERT INTO room_state(room, state, updated_at) VALUES(?1, ?2, ?3) ON CONFLICT(room) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at').bind(room, s, Date.now()).run();
        return json({ ok:true });
      }

      /* --- Ghi dữ liệu playlist (của chính mình) --- */
      if(method === 'POST'){
        const name = cleanName(body.name);
        if(!name) return json({ error:'Tên playlist 1–40 ký tự, không dùng dấu ~' }, 400);
        const key = keyOf(u, name);

        if(path === '/api/playlist/create'){
          if(!(await ensurePlaylist(env, u, name))) return json({ error:'Tối đa ' + MAX_PLAYLISTS + ' playlist' }, 400);
          return json({ ok:true });
        }
        if(path === '/api/playlist/delete'){
          await env.DB.batch([
            env.DB.prepare('DELETE FROM playlist_items WHERE playlist = ?1').bind(key),
            env.DB.prepare('DELETE FROM playlists WHERE name = ?1').bind(key) ]);
          return json({ ok:true });
        }
        if(path === '/api/playlist/add'){
          const id = String(body.id || '');
          if(!ID_RE.test(id)) return json({ error:'Mã video không hợp lệ' }, 400);
          if(!(await ensurePlaylist(env, u, name))) return json({ error:'Tối đa ' + MAX_PLAYLISTS + ' playlist' }, 400);
          if(await itemCount(env, key) >= MAX_ITEMS) return json({ error:'Playlist đã đầy (' + MAX_ITEMS + ' bài)' }, 400);
          await env.DB.prepare(
            'INSERT OR IGNORE INTO playlist_items(playlist, video_id, position, added_at) VALUES(?1, ?2, (SELECT COALESCE(MAX(position), 0) + 1 FROM playlist_items WHERE playlist = ?1), ?3)'
          ).bind(key, id, Date.now()).run();
          return json({ ok:true });
        }
        if(path === '/api/playlist/addmany'){
          const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => ID_RE.test(x)))].slice(0, MAX_IMPORT);
          if(!ids.length) return json({ error:'Không có bài hợp lệ' }, 400);
          if(!(await ensurePlaylist(env, u, name))) return json({ error:'Tối đa ' + MAX_PLAYLISTS + ' playlist' }, 400);
          if(await itemCount(env, key) + ids.length > MAX_ITEMS) return json({ error:'Playlist sẽ vượt ' + MAX_ITEMS + ' bài' }, 400);
          await env.DB.prepare(
            'INSERT OR IGNORE INTO playlist_items(playlist, video_id, position, added_at) SELECT ?1, value, (SELECT COALESCE(MAX(position), 0) FROM playlist_items WHERE playlist = ?1) + key + 1, ?3 FROM json_each(?2)'
          ).bind(key, JSON.stringify(ids), Date.now()).run();
          return json({ ok:true, added: ids.length });
        }
        if(path === '/api/playlist/remove'){
          const id = String(body.id || '');
          if(!ID_RE.test(id)) return json({ error:'Mã video không hợp lệ' }, 400);
          await env.DB.prepare('DELETE FROM playlist_items WHERE playlist = ?1 AND video_id = ?2').bind(key, id).run();
          return json({ ok:true });
        }
        if(path === '/api/playlist/move'){
          const id = String(body.id || ''), dir = String(body.dir || '');
          if(!ID_RE.test(id) || !['top','up','down'].includes(dir)) return json({ error:'Yêu cầu không hợp lệ' }, 400);
          const cur = await env.DB.prepare('SELECT position FROM playlist_items WHERE playlist = ?1 AND video_id = ?2').bind(key, id).first();
          if(!cur) return json({ error:'Không thấy bài trong playlist' }, 404);
          let np = null;
          if(dir === 'top'){
            const row = await env.DB.prepare('SELECT MIN(position) AS m FROM playlist_items WHERE playlist = ?1').bind(key).first();
            np = (row && row.m != null ? row.m : 1) - 1;
          }else if(dir === 'up'){
            const { results } = await env.DB.prepare('SELECT position FROM playlist_items WHERE playlist = ?1 AND position < ?2 ORDER BY position DESC LIMIT 2').bind(key, cur.position).all();
            if(results.length) np = results.length > 1 ? (results[0].position + results[1].position) / 2 : results[0].position - 1;
          }else{
            const { results } = await env.DB.prepare('SELECT position FROM playlist_items WHERE playlist = ?1 AND position > ?2 ORDER BY position ASC LIMIT 2').bind(key, cur.position).all();
            if(results.length) np = results.length > 1 ? (results[0].position + results[1].position) / 2 : results[0].position + 1;
          }
          if(np != null) await env.DB.prepare('UPDATE playlist_items SET position = ?1 WHERE playlist = ?2 AND video_id = ?3').bind(np, key, id).run();
          return json({ ok:true });
        }
      }

      return json({ error:'Không có đường dẫn này' }, 404);
    }catch(e){
      return json({ error: e.message || 'Lỗi máy chủ', reason: e.reason || '' }, e.status || 500);
    }
  }
};
