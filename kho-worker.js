/* =====================================================================
   kho-worker.js — KHO KARAOKE cho BMBPlayer (Cloudflare Worker + D1)
   ---------------------------------------------------------------------
   Việc tự chạy (Cron Trigger mỗi 10 phút, mỗi lần làm MỘT việc nhỏ):
     • scan      : quét danh sách video của các NGUỒN đã thêm (kênh hoặc playlist)
                   (playlistItems ≈ 1 đơn vị/50 bài) → lọc bài karaoke phát nhúng được → lưu D1.
                   Một lượt quét gom NHIỀU nguồn (tối đa 30 nguồn / 2×PAGES_PER_TICK trang / 20 giây):
                   nguồn đã quét đủ chỉ kiểm bổ sung theo nhịp đăng bài (đăng trong 14 ngày → mỗi ngày,
                   trong 60 ngày → 3 ngày, lâu hơn → 7 ngày; playlist → 3 ngày), thường chỉ tốn 1 trang.
                   Nguồn gắn ⭐ (tin dùng): bản của nguồn đó được ưu tiên khi các bản hoà lượt chọn.
   Cột/bảng mới (kind, star, newest_at, next_scan, owner_id, videos.src, channel_hide) Worker tự thêm khi chạy,
   không cần chạy lại schema.
     • refresh   : làm mới bài đã quá 7 ngày (videos.list ≈ 1 đơn vị/50 bài),
                   đo lượt xem tăng/ngày để biết bài nào đang được hát nhiều;
                   bài quá 30 ngày chưa làm mới thì xoá (quy định dữ liệu YouTube)
     • hot       : 6 giờ/lần lấy top nhạc thịnh hành Việt Nam (videos chart=mostPopular, 4 đơn vị)
                   → ghép với kho → tính bảng "Bài hot"
     • hotsearch : bài hot chưa có bản karaoke trong kho → tìm "tên bài karaoke"
                   (tối đa HOT_SEARCH_PER_DAY lượt/ngày, phần còn lại để anh tìm tay)
   Tìm YouTube cho remote.html (/api/kho/ytsearch): đếm lượt chung mọi máy, từ khoá đã tìm
   trong 7 ngày không tốn lượt, hết lượt/lỗi → tự gợi ý bài gần giống trong kho.
   Cùng một bài có nhiều bản: ưu tiên bản được chọn nhiều nhất (pick_log),
   hoà thì bản nhiều lượt xem YouTube hơn.

   Bindings / biến cần đặt trong Cloudflare:
     DB                 : D1 database (chạy kho-schema.sql trước)
     YT_KEY  (secret)   : khoá YouTube Data API (cùng project với nhac-playlist cũng được)
     YT_KEY_2 (secret)  : (tuỳ chọn) khoá DỰ PHÒNG — tạo trong CÙNG project Google với YT_KEY.
                          Chỉ dùng khi YT_KEY hỏng (bị xoá/hết hạn/bị chặn); KHÔNG đổi key khi hết hạn mức
                          (hạn mức tính theo project, dùng nhiều project để có thêm hạn mức là vi phạm chính sách YouTube)
     APP_PASS (secret)  : mật khẩu, gửi qua header x-pass (nên đặt giống nhac-playlist)
     ALLOWED_ORIGINS    : ví dụ https://vumanhhung85.github.io,http://localhost:8000
     DAILY_UNIT_BUDGET  : (tuỳ chọn) trần đơn vị/ngày kho được dùng, mặc định 5000
     PAGES_PER_TICK     : (tuỳ chọn) số trang 50 bài mỗi lần chạy, mặc định 4
     HOT_SEARCH_PER_DAY : (tuỳ chọn) lượt tìm tự động/ngày cho bài hot, mặc định 20
     SEARCH_LIMIT       : (tuỳ chọn) hạn mức lượt tìm/ngày của project, mặc định 100
     DAILY_WRITE_LIMIT  : (tuỳ chọn) trần số dòng D1 được ghi mỗi ngày, mặc định 1000000
                          (chạm trần → kho tự dừng ghi tới ngày mới; chống lỗi ghi lặp làm phát sinh phí)
   Cron Trigger: * /10 * * * *   (viết liền: "*\/10 * * * *")
   Chỉ dùng cá nhân/thử nghiệm — không dùng phát cho khách BMB.
   ===================================================================== */

const DAY = 86400000;
const REFRESH_AGE = 7 * DAY;      // làm mới mỗi 7 ngày (đồng thời là chu kỳ đo độ hot)
const MAX_AGE = 30 * DAY;         // dữ liệu API YouTube lưu tối đa 30 ngày
const HOT_EVERY = 6 * 3600000;    // lấy bảng thịnh hành 6 giờ/lần
const LOCK_MS = 9 * 60000;
const RUN_WRITE_CAP = 100000;     // một lượt chạy/một yêu cầu ghi quá số dòng này → chặn ngay (chắc chắn là lỗi lặp)
const SCAN_MAX_SOURCES = 30;      // một lượt quét kiểm tối đa bấy nhiêu nguồn
const SCAN_MS = 20000;            // ... và không quá 20 giây
const LATE_MS = 3 * DAY;          // nguồn trễ hạn kiểm bổ sung quá 3 ngày → cảnh báo trên kho.html
const YT = 'https://www.googleapis.com/youtube/v3/';
const ID_RE = /^[\w-]{11}$/;

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const conf = env => ({ pages: Math.min(num(env.PAGES_PER_TICK, 4), 10), budget: num(env.DAILY_UNIT_BUDGET, 5000), hotSearch: num(env.HOT_SEARCH_PER_DAY, 20), searchLimit: num(env.SEARCH_LIMIT, 100), writeLimit: num(env.DAILY_WRITE_LIMIT, 1000000) });
const CACHE_FRESH = 7 * DAY;      // cùng một từ khoá đã tìm trong 7 ngày → trả lại kết quả cũ, không tốn lượt
let cacheReady = false;
async function ensureCache(env) {
  if (cacheReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS yt_cache (q TEXT PRIMARY KEY, items TEXT, at INTEGER)`).run();
  cacheReady = true;
}
// Tự thêm cột/bảng của bản mới vào D1 đang chạy (mỗi isolate kiểm 1 lần) — anh không phải chạy lại schema
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const cols = async t => new Set(((await env.DB.prepare(`PRAGMA table_info(${t})`).all()).results || []).map(r => r.name));
  const ch = await cols('channels'), vd = await cols('videos');
  if (!ch.size || !vd.size) throw Object.assign(new Error('D1 chưa có bảng của kho — chạy kho-schema.sql trong console D1 trước'), { reason: 'noschema' });
  const alters = [];
  const add = (t, have, name, def) => { if (!have.has(name)) alters.push(`ALTER TABLE ${t} ADD COLUMN ${name} ${def}`); };
  add('channels', ch, 'kind', "TEXT DEFAULT 'channel'");
  add('channels', ch, 'star', 'INTEGER DEFAULT 0');
  add('channels', ch, 'newest_at', 'INTEGER DEFAULT 0');
  add('channels', ch, 'next_scan', 'INTEGER DEFAULT 0');
  add('channels', ch, 'owner_id', 'TEXT');
  add('videos', vd, 'src', 'TEXT');
  for (const q of alters) {
    try { await env.DB.prepare(q).run(); }
    catch (e) { if (!/duplicate column/i.test(String(e.message || e))) throw e; }   // isolate khác vừa thêm trước
  }
  await env.DB.batch([
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_videos_src ON videos (src)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS channel_hide (id TEXT PRIMARY KEY, at INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS yt_cache (q TEXT PRIMARY KEY, items TEXT, at INTEGER)`)
  ]);
  schemaReady = true; cacheReady = true;
}
const pacificDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

/* ---------------- Xử lý tên bài ---------------- */
const nd = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const ascii = s => nd(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Các cụm "nhiễu" trong tiêu đề karaoke/MV: coi như dấu phân cách, phần còn lại mới là tên bài/ca sĩ.
const NOISE = new RegExp('\\b(?:' + [
  'karaoke', 'beat goc', 'beat chuan', 'beat moi', 'beat', 'thieu giong nam', 'thieu giong nu', 'thieu nam', 'thieu nu',
  'tone nam', 'tone nu', 'ton nam', 'ton nu', 'giong nam', 'giong nu', 'song ca', 'nhac song', 'de hat', 'de ca',
  'chat luong cao', 'full hd', 'hd', '4k', '1080p', '720p', 'chuan', 'moi nhat', 'hay nhat', 'phoi moi', 'phoi chuan',
  'co loi', 'lyrics', 'lyric', 'official', 'music video', 'mv', 'm v', 'audio', 'visualizer', 'version', 'ver', 'ban chuan',
  'am thanh chuan', 'hat cung', 'nhac san', 'organ', 'remix', 'phien ban', 'sieu hay', 'de nghe', 'mien phi'
].join('|') + ')\\b', 'g');
const SPLIT = /\s[-–—~]+\s|[|｜:()\[\]{}“”"«»•·【】]+|\s\/\s/;
const CREDIT = /^(?:st|sang tac|tac gia|nhac|loi|loi viet|ca si|trinh bay|tb|thu am|tone|ton|giong|nam|nu|official|channel)(?: |$)/;

function tidy(s) {
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length < 2 || /^\d+$/.test(s) || CREDIT.test(s) || s.split(' ').length > 14) return '';
  return s;
}
function segments(title) {
  const out = [];
  const t = nd(title).replace(/\b(?:st|sang tac|tac gia|nhac|loi|loi viet|ca si|trinh bay|tb)\s*:\s*[^|｜()\[\]–—]*/g, ' | ');
  for (const piece of t.split(SPLIT)) {
    const p = (piece || '').replace(/#\S+/g, ' ').replace(/\b(?:ft|feat|featuring)\b.*$/, ' ')
      .replace(/\b(?:19|20)\d\d\b/g, ' ').replace(/[^a-z0-9 ]+/g, ' ');
    for (const sub of (' ' + p + ' ').replace(NOISE, '|').split('|')) {
      const c = tidy(sub);
      if (c && !out.includes(c)) out.push(c);
      if (out.length >= 5) return out;
    }
  }
  return out;
}
function toneOf(t) {
  if (/\bthieu (?:giong )?nam\b/.test(t)) return 'thieu-nam';
  if (/\bthieu (?:giong )?nu\b/.test(t)) return 'thieu-nu';
  if (/\bsong ca\b/.test(t)) return 'song-ca';
  if (/\b(?:tone|ton|giong) nam\b/.test(t)) return 'nam';
  if (/\b(?:tone|ton|giong) nu\b/.test(t)) return 'nu';
  return '';
}
function durSec(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}
// Chuỗi tìm kiếm gọn từ tiêu đề MV (giữ dấu tiếng Việt để YouTube tìm chuẩn hơn)
function cleanQuery(title) {
  return String(title || '').replace(/#\S+/g, ' ').replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, ' ')
    .replace(/official|music video|\bm\/?v\b|lyrics?|visuali[sz]er|\baudio\b|\b4k\b|\bhd\b/gi, ' ')
    .replace(/[|｜•·"“”]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
}

// Video YouTube (videos.list đủ part) → dòng lưu kho, hoặc null nếu không phải bài karaoke phát nhúng được
function toRow(v, mode) {
  const sn = v.snippet || {}, cd = v.contentDetails || {}, st = v.statistics || {}, ss = v.status || {};
  if (!ID_RE.test(v.id || '') || !ss.embeddable || ss.privacyStatus === 'private') return null;
  if (sn.liveBroadcastContent && sn.liveBroadcastContent !== 'none') return null;
  const rr = cd.regionRestriction;
  if (rr && ((rr.blocked || []).includes('VN') || (rr.allowed && !rr.allowed.includes('VN')))) return null;
  const d = durSec(cd.duration);
  if (d < 60 || d > 1800) return null;
  const t = nd(sn.title);
  if (!/\b(?:karaoke|beat)\b/.test(t) || /\b(?:cover|reaction|huong dan|tutorial|shorts|day hat|tap hat|review)\b/.test(t)) return null;
  const segs = segments(sn.title);
  if (!segs.length) return null;
  const key = (mode === 'artist' && segs.length > 1) ? segs[1] : segs[0];
  const words = new Set((ascii(sn.title) + ' ' + ascii(sn.channelTitle)).split(' ').filter(Boolean));
  return {
    id: v.id, ch: String(sn.channelId || ''), cht: String(sn.channelTitle || '').slice(0, 100),
    title: String(sn.title || '').slice(0, 200), segs: JSON.stringify(segs), key, tone: toneOf(t),
    dur: d, views: +st.viewCount || 0, pub: Date.parse(sn.publishedAt) || 0, txt: [...words].join(' ')
  };
}

/* ---------------- YouTube API ---------------- */
// Lỗi do CHÍNH khoá (bị xoá, hết hạn, bị giới hạn sai...) → thử khoá dự phòng. Lỗi hạn mức KHÔNG đổi khoá.
const KEY_REASONS = /^(?:keyInvalid|keyExpired|ipRefererBlocked|API_KEY_[A-Z_]+)$/;
const keyBadUntil = [0, 0];       // nhớ trong isolate: khoá hỏng thì 10 phút sau mới thử lại
function ytKeys(env) { return [env.YT_KEY, env.YT_KEY_2].map(k => String(k || '').trim()); }
function isKeyError(res, er) {
  if (res.status !== 400 && res.status !== 403) return false;
  const rs = [].concat((er.errors || []).map(x => x.reason), (er.details || []).map(x => x.reason)).filter(Boolean);
  if (rs.some(r => /quota|rateLimit/i.test(r))) return false;
  return rs.some(r => KEY_REASONS.test(r)) || /api key/i.test(er.message || '');
}
async function yt(env, run, path, params, cost) {
  const keys = ytKeys(env);
  if (!keys[0] && !keys[1]) throw Object.assign(new Error('Chưa đặt secret YT_KEY cho Worker'), { reason: 'nokey' });
  const now = Date.now();
  let order = [0, 1].filter(i => keys[i]);
  const good = order.filter(i => keyBadUntil[i] < now);
  order = good.length ? good.concat(order.filter(i => !good.includes(i))) : order;
  if (path === 'search') run.searches++; else run.units += cost;
  let last;
  for (const i of order) {
    const u = new URL(YT + path);
    for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) u.searchParams.set(k, String(v));
    u.searchParams.set('key', keys[i]);
    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(10000) });
    let d = {}; try { d = await res.json(); } catch (e) {}
    if (res.ok) { run.keyOk[i] = true; keyBadUntil[i] = 0; return d; }
    const er = d.error || {}, reason = (er.errors && er.errors[0] && er.errors[0].reason) || '';
    if (isKeyError(res, er)) {
      keyBadUntil[i] = now + 600000;
      run.keyBad[i] = { reason: ((er.details || []).map(x => x.reason).find(Boolean)) || reason || ('HTTP ' + res.status), msg: String(er.message || '').slice(0, 160), at: now };
      last = Object.assign(new Error('Khoá YouTube ' + (i ? 'YT_KEY_2' : 'YT_KEY') + ' không dùng được: ' + (er.message || res.status)), { reason: 'badkey', status: 502 });
      continue;                   // thử khoá còn lại
    }
    if (/quota|rateLimit/i.test(reason)) { if (path === 'search') run.searchQuotaHit = true; else run.quotaHit = true; }
    throw Object.assign(new Error(er.message || ('YouTube lỗi ' + res.status)), { reason, status: res.status });
  }
  if (order.length > 1) last.message = 'Cả YT_KEY và YT_KEY_2 đều không dùng được — ' + last.message.replace(/^Khoá YouTube YT_KEY(?:_2)? không dùng được: /, '');
  throw last;
}

/* ---------------- Đồng hồ đếm dòng ghi D1 (chống lỗi ghi lặp) ---------------- */
function meter(db, run) {
  if (db._raw) db = db._raw;
  const acc = r => {
    const m = (r && r.meta) || {};
    run.writes += +m.rows_written || 0;
    if (run.writes > RUN_WRITE_CAP) throw Object.assign(new Error('Một lượt ghi hơn ' + RUN_WRITE_CAP + ' dòng — đã chặn để an toàn'), { reason: 'writecap' });
    return r;
  };
  const wrap = st => ({
    _st: st,
    bind: (...a) => wrap(st.bind(...a)),
    run: async () => acc(await st.run()),
    all: async () => acc(await st.all()),
    first: c => st.first(c),
    raw: o => st.raw(o)
  });
  return {
    _raw: db,
    prepare: q => wrap(db.prepare(q)),
    batch: async list => { const rs = await db.batch(list.map(x => x._st || x)); rs.forEach(acc); return rs; },
    exec: q => db.exec(q)
  };
}
// Hôm nay đã ghi quá trần chưa (đọc 1 lần cho mỗi lượt chạy)
async function writesBlocked(env, run, c) {
  if (run.writeStop === undefined) {
    const r = await env.DB.prepare(`SELECT v FROM meta WHERE k = ?1`).bind('writes:' + run.day).first();
    run.writesBefore = +(r && r.v) || 0;
    run.writeStop = run.writesBefore >= c.writeLimit;
  }
  return run.writeStop;
}

/* ---------------- D1: ghi/xoá ---------------- */
// Kiểu tiêu đề (Tên bài trước / Ca sĩ trước) cho từng video: theo NGUỒN đã đưa video vào kho (playlist), không có thì theo kênh đăng
async function orderModes(env, items) {
  const m = {};
  if (!items.length) return m;
  const r = await env.DB.prepare(`SELECT json_extract(j.value,'$.id') AS id, COALESCE(cs.order_mode, cc.order_mode) AS mode FROM json_each(?1) j
      LEFT JOIN videos v ON v.id = json_extract(j.value,'$.id') LEFT JOIN channels cs ON cs.id = v.src
      LEFT JOIN channels cc ON cc.id = json_extract(j.value,'$.ch')`)
    .bind(JSON.stringify(items.map(v => ({ id: v.id, ch: (v.snippet || {}).channelId || '' })))).all();
  (r.results || []).forEach(x => { m[x.id] = x.mode; });
  return m;
}
async function ingest(env, rows, now) {
  if (!rows.length) return;
  const J = JSON.stringify(rows);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO videos (id, channel_id, channel, title, segs, song_key, tone, duration, views, views_delta, published_at, fetched_at, src)
      SELECT json_extract(value,'$.id'), json_extract(value,'$.ch'), json_extract(value,'$.cht'), json_extract(value,'$.title'),
             json_extract(value,'$.segs'), json_extract(value,'$.key'), json_extract(value,'$.tone'), json_extract(value,'$.dur'),
             json_extract(value,'$.views'), 0, json_extract(value,'$.pub'), ?2, json_extract(value,'$.src')
      FROM json_each(?1) WHERE true
      ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, title = excluded.title, segs = excluded.segs, src = COALESCE(videos.src, excluded.src),
        song_key = excluded.song_key, tone = excluded.tone, duration = excluded.duration,
        views_delta = MAX(0, (excluded.views - videos.views) * 86400000.0 / (excluded.fetched_at - videos.fetched_at)),
        views = excluded.views, fetched_at = excluded.fetched_at
      WHERE excluded.fetched_at - videos.fetched_at > 43200000`).bind(J, now),
    env.DB.prepare(`DELETE FROM videos_fts WHERE rowid IN (SELECT rid FROM videos WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?1)))`).bind(J),
    env.DB.prepare(`INSERT INTO videos_fts (rowid, txt) SELECT v.rid, json_extract(j.value,'$.txt') FROM json_each(?1) j JOIN videos v ON v.id = json_extract(j.value,'$.id')`).bind(J)
  ]);
}
async function removeIds(env, ids, now) {
  if (!ids.length) return;
  const J = JSON.stringify(ids);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM videos_fts WHERE rowid IN (SELECT rid FROM videos WHERE id IN (SELECT value FROM json_each(?1)))`).bind(J),
    env.DB.prepare(`DELETE FROM videos WHERE id IN (SELECT value FROM json_each(?1))`).bind(J),
    env.DB.prepare(`INSERT OR IGNORE INTO rejected (id, at) SELECT value, ?2 FROM json_each(?1)`).bind(J, now)
  ]);
}
// Lấy chi tiết ≤50 id, lưu bài đạt, loại (và nhớ) bài không đạt.
// opt.src = nguồn (kênh/playlist) đang quét, opt.mode = kiểu tiêu đề của nguồn đó
async function fetchAndIngest(env, run, ids, now, opt) {
  if (!ids.length) return { added: 0, rejected: 0, rows: [] };
  opt = opt || {};
  const d = await yt(env, run, 'videos', { part: 'snippet,contentDetails,statistics,status', id: ids.join(',') }, 1);
  const items = d.items || [];
  const modes = opt.mode ? {} : await orderModes(env, items);
  const rows = [];
  for (const v of items) {
    const r = toRow(v, opt.mode || modes[v.id]);
    if (r) { r.src = opt.src || null; rows.push(r); }
  }
  const okIds = new Set(rows.map(r => r.id));
  const bad = ids.filter(i => !okIds.has(i));
  if (!(await writesBlocked(env, run, conf(env)))) {   // chạm trần ghi hôm nay → vẫn trả kết quả, chỉ không lưu kho
    await ingest(env, rows, now);
    await removeIds(env, bad, now);
  }
  return { added: rows.length, rejected: bad.length, rows, items };
}
async function knownIds(env, ids) {
  const J = JSON.stringify(ids);
  const r = await env.DB.prepare(`SELECT id FROM videos WHERE id IN (SELECT value FROM json_each(?1)) UNION SELECT id FROM rejected WHERE id IN (SELECT value FROM json_each(?1))`).bind(J).all();
  return new Set((r.results || []).map(x => x.id));
}
async function picksById(env, ids, since) {
  const m = {};
  if (!ids.length) return m;
  const r = await env.DB.prepare(`SELECT id, COUNT(*) AS n FROM pick_log WHERE id IN (SELECT value FROM json_each(?1)) AND ts >= ?2 GROUP BY id`).bind(JSON.stringify(ids), since || 0).all();
  (r.results || []).forEach(x => { m[x.id] = x.n; });
  return m;
}

/* ---------------- Các việc định kỳ ---------------- */
// Bao lâu nữa kiểm bổ sung nguồn đã quét đủ: theo ngày đăng bài mới nhất của kênh
function nextGap(ch, newest, now) {
  if (ch.kind === 'playlist') return 3 * DAY;              // playlist ít đổi, và phải đọc lại cả danh sách
  const age = newest ? now - newest : 0;
  if (!newest || age < 14 * DAY) return DAY;
  if (age < 60 * DAY) return 3 * DAY;
  return 7 * DAY;
}
const VCOUNT = `CASE WHEN kind = 'playlist' THEN (SELECT COUNT(*) FROM videos WHERE src = ?1)
  ELSE (SELECT COUNT(*) FROM videos WHERE channel_id = ?1 AND (src IS NULL OR src = ?1)) END`;

// Quét MỘT nguồn tối đa pageLimit trang. Kênh: danh sách uploads mới nhất trước → kiểm bổ sung dừng khi chạm bài cũ.
// Playlist: thứ tự tuỳ người tạo → kiểm bổ sung đọc lại cả danh sách (nối tiếp qua page_token), chỉ bài lạ mới tốn videos.list.
async function scanOne(env, run, c, ch, now, pageLimit) {
  const supp = !!ch.full_done, pl = ch.kind === 'playlist', prevNewest = +ch.newest_at || 0;
  let token = supp && !pl ? '' : (ch.page_token || '');
  const r = { pages: 0, seen: 0, added: 0, rejected: 0, done: false, newest: prevNewest, err: null };
  try {
    while (r.pages < pageLimit) {
      const d = await yt(env, run, 'playlistItems', { part: 'contentDetails', playlistId: ch.uploads, maxResults: 50, pageToken: token }, 1);
      r.pages++;
      const cds = (d.items || []).map(x => x.contentDetails || {});
      const ids = cds.map(x => x.videoId).filter(i => ID_RE.test(i || ''));
      const pubs = cds.map(x => Date.parse(x.videoPublishedAt) || 0).filter(Boolean);
      if (pubs.length) r.newest = Math.max(r.newest, ...pubs);
      r.seen += ids.length;
      const known = ids.length ? await knownIds(env, ids) : new Set();
      const fresh = ids.filter(i => !known.has(i));
      if (pl && known.size && !(await writesBlocked(env, run, c)))   // bài đã có trong kho (vd. do tìm YouTube) → ghi nhận thuộc playlist này
        await env.DB.prepare(`UPDATE videos SET src = ?1 WHERE src IS NULL AND id IN (SELECT value FROM json_each(?2))`).bind(ch.id, JSON.stringify([...known])).run();
      if (fresh.length) { const x = await fetchAndIngest(env, run, fresh, now, { src: ch.id, mode: ch.order_mode || 'song' }); r.added += x.added; r.rejected += x.rejected; }
      token = d.nextPageToken || '';
      if (!token) { r.done = true; break; }
      // kênh, kiểm bổ sung: cả trang đều đã biết, hoặc đã chạm bài đăng trước lần kiểm trước → hết bài mới
      if (supp && !pl && (!fresh.length || (prevNewest && pubs.length && Math.min(...pubs) <= prevNewest))) { r.done = true; break; }
    }
  } catch (e) { r.err = e; }
  r.token = token;
  return r;
}

async function scanJob(env, run, c, now) {
  const t0 = Date.now(), list = [], tried = [], maxPages = c.pages * 2;
  let pages = 0, seen = 0, added = 0, rejected = 0, stop = null;
  while (tried.length < SCAN_MAX_SOURCES && pages < maxPages && Date.now() - t0 < SCAN_MS) {
    const ch = await env.DB.prepare(`SELECT * FROM channels WHERE enabled = 1 AND (full_done = 0 OR next_scan <= ?1)
        AND id NOT IN (SELECT value FROM json_each(?2))
        ORDER BY full_done ASC, (page_token IS NULL) ASC, star DESC, next_scan ASC, added_at ASC LIMIT 1`).bind(now, JSON.stringify(tried)).first();
    if (!ch) break;
    if (!ch.full_done && pages >= c.pages) break;        // quét toàn bộ kênh mới chỉ dùng phần trang thường của lượt
    tried.push(ch.id);
    const lim = ch.full_done ? Math.min(c.pages, maxPages - pages) : c.pages - pages;
    const r = await scanOne(env, run, c, ch, now, lim);
    pages += r.pages; seen += r.seen; added += r.added; rejected += r.rejected;
    const item = { t: ch.title, k: ch.kind || 'channel', m: ch.full_done ? 'bổ sung' : 'toàn bộ', p: r.pages, a: r.added, x: r.rejected, d: r.done };
    list.push(item);
    if (r.err && (r.err.reason === 'playlistNotFound' || r.err.status === 404)) {
      await env.DB.prepare(`UPDATE channels SET enabled = 0, note = ?2 WHERE id = ?1`).bind(ch.id, 'Không đọc được danh sách video (nguồn bị xoá hoặc chuyển riêng tư) — đã tắt').run();
      item.e = 'không đọc được, đã tắt';
      continue;
    }
    const full = ch.full_done || r.done ? 1 : 0;
    // nguồn quét xong (toàn bộ hoặc bổ sung) → hẹn lần kiểm sau; playlist đọc dở → giữ hạn cũ để lượt sau đọc tiếp
    const finished = !r.err && (r.done || (ch.full_done && ch.kind !== 'playlist'));
    const token = ch.full_done && ch.kind !== 'playlist' ? null : (r.done ? null : (r.token || null));
    const recount = r.added > 0 || (r.done && !ch.full_done) ? 1 : 0;
    if (r.pages || r.err) await env.DB.prepare(`UPDATE channels SET page_token = ?2, full_done = ?3,
        last_scan = CASE WHEN ?4 = 1 THEN ?5 ELSE last_scan END, next_scan = CASE WHEN ?4 = 1 THEN ?6 ELSE next_scan END,
        newest_at = MAX(IFNULL(newest_at, 0), ?7), note = NULL,
        video_count = CASE WHEN ?8 = 1 THEN ${VCOUNT} ELSE video_count END WHERE id = ?1`)
      .bind(ch.id, r.err && !r.pages ? ch.page_token : token, full, finished ? 1 : 0, now, now + nextGap(ch, r.newest, now), r.newest, recount).run();
    if (r.err) { stop = r.err; item.e = String(r.err.message || r.err).slice(0, 160); break; }   // hết hạn mức/lỗi mạng → dừng lượt này
  }
  if (!list.length) {
    if (stop) throw stop;
    return { job: 'scan', idle: true };
  }
  if (stop && !list.some(x => x.p > 0)) throw stop;
  const rep = { job: 'scan', sources: list.length, list: list.slice(0, 15), pages, seen, added, rejected, done: list.every(x => x.d),
    channel: list.length === 1 ? list[0].t : list.length + ' nguồn', mode: list.length === 1 ? list[0].m : 'gộp' };
  if (stop) { rep.error = String(stop.message || stop); rep.reason = stop.reason || ''; }
  return rep;
}

async function refreshJob(env, run, c, now) {
  // xoá phần quá hạn 30 ngày (phòng khi làm mới không kịp) và dọn bảng phụ
  const stale = (await env.DB.prepare(`SELECT id FROM videos WHERE fetched_at < ?1 LIMIT 500`).bind(now - MAX_AGE).all()).results || [];
  if (stale.length) await removeIds(env, stale.map(x => x.id), now);
  await ensureCache(env);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM yt_cache WHERE at < ?1`).bind(now - MAX_AGE),
    env.DB.prepare(`DELETE FROM rejected WHERE at < ?1`).bind(now - MAX_AGE),
    env.DB.prepare(`DELETE FROM pick_log WHERE ts < ?1`).bind(now - 365 * DAY),
    env.DB.prepare(`DELETE FROM meta WHERE (k LIKE 'units:%' OR k LIKE 'search:%' OR k LIKE 'writes:%') AND k NOT IN (?1, ?2, ?3)`).bind('units:' + run.day, 'search:' + run.day, 'writes:' + run.day)
  ]);
  const due = (await env.DB.prepare(`SELECT id FROM videos WHERE fetched_at < ?1 ORDER BY fetched_at LIMIT ?2`).bind(now - REFRESH_AGE, c.pages * 50).all()).results || [];
  if (!due.length) return { job: 'refresh', idle: true, purged: stale.length };
  let ok = 0, gone = 0;
  for (let i = 0; i < due.length; i += 50) {
    const r = await fetchAndIngest(env, run, due.slice(i, i + 50).map(x => x.id), now);
    ok += r.added; gone += r.rejected;
  }
  return { job: 'refresh', refreshed: ok, removed: gone, purged: stale.length };
}

// Ghép bài hot (chưa có song_key) với kho: so từng cụm tên trong tiêu đề MV với song_key
async function rematch(env) {
  const rows = (await env.DB.prepare(`SELECT id, cands FROM hot WHERE song_key IS NULL`).all()).results || [];
  if (!rows.length) return 0;
  const all = new Set();
  rows.forEach(r => { try { JSON.parse(r.cands || '[]').forEach(k => all.add(k)); } catch (e) {} });
  if (!all.size) return 0;
  const found = new Set(((await env.DB.prepare(`SELECT DISTINCT song_key FROM videos WHERE song_key IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify([...all])).all()).results || []).map(x => x.song_key));
  const upd = [];
  rows.forEach(r => { let cs = []; try { cs = JSON.parse(r.cands || '[]'); } catch (e) {} const k = cs.find(x => found.has(x)); if (k) upd.push({ id: r.id, k }); });
  if (upd.length) await env.DB.prepare(`UPDATE hot SET song_key = (SELECT json_extract(value,'$.k') FROM json_each(?1) WHERE json_extract(value,'$.id') = hot.id)
      WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))`).bind(JSON.stringify(upd)).run();
  return upd.length;
}

/* Điểm hot của một bài =
     thịnh hành (hạng 1 → 100 điểm, hạng 200 → ~0)
   + 15 × log10(1 + lượt xem tăng/ngày của bản karaoke tăng nhanh nhất)
   + 15 × log2(1 + số lần anh chọn bài này trong 30 ngày)              */
async function rebuildHot(env, now) {
  const S = {};
  const get = k => (S[k] = S[k] || { rank: 0, delta: 0, picks: 0, label: '' });
  ((await env.DB.prepare(`SELECT song_key, MIN(rank) AS rank, label FROM hot WHERE song_key IS NOT NULL GROUP BY song_key`).all()).results || [])
    .forEach(r => { const s = get(r.song_key); s.rank = r.rank; s.label = r.label; });
  ((await env.DB.prepare(`SELECT song_key, views_delta FROM videos WHERE views_delta > 0 ORDER BY views_delta DESC LIMIT 400`).all()).results || [])
    .forEach(r => { const s = get(r.song_key); s.delta = Math.max(s.delta, r.views_delta); });
  ((await env.DB.prepare(`SELECT v.song_key, COUNT(*) AS n FROM pick_log p JOIN videos v ON v.id = p.id WHERE p.ts >= ?1 GROUP BY v.song_key ORDER BY n DESC LIMIT 200`).bind(now - 30 * DAY).all()).results || [])
    .forEach(r => { get(r.song_key).picks = r.n; });
  const scored = Object.entries(S).map(([k, s]) => ({
    k, ...s, score: (s.rank ? Math.max(0, 100 - (s.rank - 1) * 0.5) : 0) + 15 * Math.log10(1 + s.delta) + 15 * Math.log2(1 + s.picks)
  })).sort((a, b) => b.score - a.score).slice(0, 100);
  const keys = scored.map(x => x.k);
  const vers = keys.length ? ((await env.DB.prepare(`SELECT v.id, v.song_key, v.views, MAX(IFNULL(c1.star, 0), IFNULL(c2.star, 0)) AS star FROM videos v LEFT JOIN channels c1 ON c1.id = v.channel_id LEFT JOIN channels c2 ON c2.id = v.src
      WHERE v.song_key IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(keys)).all()).results || []) : [];
  const pk = await picksById(env, vers.map(v => v.id), 0);
  const best = {}, cnt = {};
  vers.forEach(v => {
    cnt[v.song_key] = (cnt[v.song_key] || 0) + 1;
    const b = best[v.song_key], n = pk[v.id] || 0;
    if (!b || better(n, v.star, v.views, b.n, b.star, b.views)) best[v.song_key] = { id: v.id, n, star: v.star, views: v.views };
  });
  const out = scored.filter(x => best[x.k]).map(x => ({ k: x.k, score: Math.round(x.score * 10) / 10, rank: x.rank || null, delta: Math.round(x.delta), picks: x.picks, best: best[x.k].id, versions: cnt[x.k] || 1, label: x.label || '' }));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM hot_songs`),
    env.DB.prepare(`INSERT INTO hot_songs (song_key, score, trend_rank, delta, picks, best_id, versions, label)
      SELECT json_extract(value,'$.k'), json_extract(value,'$.score'), json_extract(value,'$.rank'), json_extract(value,'$.delta'),
             json_extract(value,'$.picks'), json_extract(value,'$.best'), json_extract(value,'$.versions'), json_extract(value,'$.label') FROM json_each(?1)`).bind(JSON.stringify(out))
  ]);
  return out.length;
}

async function hotJob(env, run, c, now) {
  const items = []; let token = '';
  for (let p = 0; p < 4; p++) {
    const d = await yt(env, run, 'videos', { part: 'snippet', chart: 'mostPopular', regionCode: 'VN', videoCategoryId: '10', maxResults: 50, pageToken: token }, 1);
    items.push(...(d.items || []));
    token = d.nextPageToken || '';
    if (!token) break;
  }
  const rows = items.map((v, i) => {
    const sn = v.snippet || {};
    const chn = ascii(sn.channelTitle).replace(/\b(?:official|channel|music|entertainment|vevo|tv|records?)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const cands = segments(sn.title).filter(s => !(chn && (chn === s || chn.includes(s))));
    return { id: v.id, rank: i + 1, label: String(sn.title || '').slice(0, 200), q: cleanQuery(sn.title), cands: JSON.stringify(cands) };
  }).filter(r => r.cands !== '[]');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO hot (id, source, rank, label, q, cands, song_key, searched, seen_at)
      SELECT json_extract(value,'$.id'), 'yt', json_extract(value,'$.rank'), json_extract(value,'$.label'), json_extract(value,'$.q'), json_extract(value,'$.cands'), NULL, 0, ?2
      FROM json_each(?1) WHERE true
      ON CONFLICT(id) DO UPDATE SET rank = excluded.rank, label = excluded.label, q = excluded.q, cands = excluded.cands, seen_at = excluded.seen_at`).bind(JSON.stringify(rows), now),
    env.DB.prepare(`DELETE FROM hot WHERE (source = 'yt' AND seen_at < ?1) OR (source = 'manual' AND seen_at < ?2)`).bind(now, now - MAX_AGE),
    env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('hot_at', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(now))
  ]);
  const matched = await rematch(env);
  const songs = await rebuildHot(env, now);
  return { job: 'hot', trending: rows.length, matched, hotSongs: songs };
}

async function hotSearchJob(env, run, c, now) {
  const left = c.hotSearch - (run.searchUsed + run.searches);
  if (left <= 0) return { job: 'hotsearch', idle: true, reason: 'hết lượt tìm tự động hôm nay' };
  const rows = (await env.DB.prepare(`SELECT id, q, label FROM hot WHERE song_key IS NULL AND searched = 0 ORDER BY CASE source WHEN 'manual' THEN 0 ELSE 1 END, rank LIMIT ?1`).bind(Math.min(2, left)).all()).results || [];
  if (!rows.length) return { job: 'hotsearch', idle: true };
  let added = 0;
  for (const r of rows) {
    const d = await yt(env, run, 'search', { part: 'id', type: 'video', videoEmbeddable: 'true', regionCode: 'VN', relevanceLanguage: 'vi', maxResults: 15, q: (r.q || r.label) + ' karaoke' }, 0);
    const ids = (d.items || []).map(x => x.id && x.id.videoId).filter(i => ID_RE.test(i || ''));
    if (ids.length) added += (await fetchAndIngest(env, run, ids, now)).added;
    await env.DB.prepare(`UPDATE hot SET searched = 1 WHERE id = ?1`).bind(r.id).run();
  }
  const matched = await rematch(env);
  if (matched) await rebuildHot(env, now);
  return { job: 'hotsearch', searched: rows.length, added, matched };
}

// Ghép lại bài hot với kho (không gọi YouTube) — chạy sau khi quét nhanh xong
async function rehotJob(env, run, c, now) {
  const matched = await rematch(env);
  const hotSongs = await rebuildHot(env, now);
  return { job: 'rehot', matched, hotSongs };
}
const JOBS = { scan: scanJob, refresh: refreshJob, hot: hotJob, hotsearch: hotSearchJob, rehot: rehotJob };

/* ---------------- Bộ điều phối ---------------- */
async function metaGet(env, keys) {
  const r = await env.DB.prepare(`SELECT k, v FROM meta WHERE k IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(keys)).all();
  const m = {}; (r.results || []).forEach(x => { m[x.k] = x.v; }); return m;
}
function newRun() { return { units: 0, searches: 0, day: pacificDay(), used: 0, searchUsed: 0, quotaHit: false, writes: 0, keyOk: {}, keyBad: {} }; }
async function flush(env, run, c) {
  if (run.flushed) return;          // mỗi lượt chỉ cộng sổ một lần
  run.flushed = true;
  const st = [];
  const add = (k, n) => env.DB.prepare(`INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + ?2 AS TEXT)`).bind(k, n);
  if (run.units) st.push(add('units:' + run.day, run.units));
  if (run.searches) st.push(add('search:' + run.day, run.searches));
  if (run.quotaHit) st.push(env.DB.prepare(`INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind('units:' + run.day, String(c.budget)));
  if (run.searchQuotaHit) st.push(env.DB.prepare(`INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind('search:' + run.day, String(c.searchLimit)));
  for (const i of [0, 1]) {
    if (run.keyBad[i] && !run.keyOk[i]) st.push(env.DB.prepare(`INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind('keybad:' + i, JSON.stringify(run.keyBad[i])));
    else if (run.keyOk[i]) st.push(env.DB.prepare(`DELETE FROM meta WHERE k = ?1`).bind('keybad:' + i));
  }
  if (run.writes) st.push(add('writes:' + run.day, run.writes));
  if (st.length) await env.DB.batch(st);
}

async function tick(env, force) {
  const now = Date.now(), c = conf(env), run = newRun();
  env = Object.assign({}, env, { DB: meter(env.DB, run) });
  const lk = await env.DB.prepare(`UPDATE meta SET v = ?1 WHERE k = 'lock' AND CAST(v AS INTEGER) < ?2`).bind(String(now), now - LOCK_MS).run();
  if (!lk.meta || !lk.meta.changes) return { job: 'busy', note: 'Một lượt chạy khác đang làm việc, thử lại sau ít phút' };
  let rep;
  try {
    await ensureSchema(env);
    const m = await metaGet(env, ['units:' + run.day, 'search:' + run.day, 'hot_at', 'tick', 'writes:' + run.day]);
    run.used = +m['units:' + run.day] || 0; run.searchUsed = +m['search:' + run.day] || 0;
    run.writesBefore = +m['writes:' + run.day] || 0; run.writeStop = run.writesBefore >= c.writeLimit;
    const t = (+m.tick || 0) + 1;
    if (run.writeStop) rep = { job: 'idle', reason: 'Hôm nay đã ghi ' + run.writesBefore + ' dòng D1, chạm trần ' + c.writeLimit + ' — kho tạm dừng tới ngày mới để tránh phát sinh phí' };
    else if (!force && run.used >= c.budget) rep = { job: 'idle', reason: 'Đã dùng hết trần ' + c.budget + ' đơn vị hôm nay' };
    else {
      let order;
      if (force && force !== 'auto') order = [force];
      else if (now - (+m.hot_at || 0) > HOT_EVERY) order = ['hot', 'scan', 'refresh'];
      else if (t % 3 === 0) order = ['refresh', 'scan', 'hotsearch'];
      else if (t % 3 === 1) order = ['hotsearch', 'scan', 'refresh'];
      else order = ['scan', 'refresh', 'hotsearch'];
      for (const j of order) { rep = await JOBS[j](env, run, c, now); if (!rep.idle) break; }
      if (rep.idle && order.length > 1) rep = { job: 'idle', idle: true, reason: 'kho đã cập nhật đủ, chưa có việc mới' };
    }
    await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('tick', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(t)).run();
  } catch (e) {
    rep = { job: 'error', error: String(e.message || e), reason: e.reason || '' };
  } finally {
    rep = Object.assign(rep || {}, { at: now, units: run.units, searches: run.searches, writes: run.writes });
    try { await flush(env, run, c); } catch (e) {}
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('last', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(JSON.stringify(rep)),
        env.DB.prepare(`UPDATE meta SET v = '0' WHERE k = 'lock'`)
      ]);
    } catch (e) {}
  }
  return rep;
}

/* ---------------- HTTP ---------------- */
function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || !allowed.length || allowed.includes('*') || allowed.includes(origin);
  return {
    ok, h: {
      'Access-Control-Allow-Origin': origin && ok ? origin : (allowed[0] || '*'),
      'Access-Control-Allow-Headers': 'x-pass, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400', 'Vary': 'Origin', 'Content-Type': 'application/json; charset=utf-8'
    }
  };
}
const J = (data, status, h) => new Response(JSON.stringify(data), { status: status || 200, headers: h });

// Link nguồn → cách hỏi YouTube. Nhận: kênh (@ten, /channel/UC…, /user/…) hoặc playlist (…list=PL…, mã PL…/OLAK5uy_…)
function parseSource(s) {
  s = String(s || '').trim();
  try { s = decodeURIComponent(s); } catch (e) {}
  let m = /[?&]list=([\w-]{10,64})/.exec(s) || /^((?:PL|OLAK5uy_|UU|FL)[\w-]{10,60})$/.exec(s);
  if (m) {
    if (/^(?:RD|LL|WL)/.test(m[1])) return { bad: 'Danh sách tự sinh (Mix/Đã thích/Xem sau) không đọc được qua API — chọn playlist do kênh tạo' };
    if (/^UU[\w-]{22}$/.test(m[1])) return { id: 'UC' + m[1].slice(2) };     // playlist "Tải lên" của kênh = chính kênh đó
    return { playlist: m[1] };
  }
  m = /(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/.exec(s);
  if (m) return { id: m[1] };
  m = /(?:^|youtube\.com\/)@([^\s/?#&]{3,100})/.exec(s);
  if (m) return { forHandle: '@' + m[1] };
  m = /youtube\.com\/user\/([\w.-]{2,100})/.exec(s);
  if (m) return { forUsername: m[1] };
  if (/youtube\.com\/c\//.test(s)) return { bad: 'Link dạng youtube.com/c/… không đọc được qua API — mở kênh, bấm vào tên @… rồi copy link dạng youtube.com/@ten' };
  return null;
}
// Đọc thông tin nguồn từ YouTube (1 đơn vị)
async function resolveSource(env, run, input) {
  const q = parseSource(input);
  if (!q) throw Object.assign(new Error('Không nhận ra link: dán link kênh (youtube.com/@ten-kenh) hoặc link playlist (…list=PL…)'), { status: 400 });
  if (q.bad) throw Object.assign(new Error(q.bad), { status: 400 });
  if (q.playlist) {
    const d = await yt(env, run, 'playlists', { part: 'snippet,contentDetails', id: q.playlist, maxResults: 1 }, 1);
    const it = (d.items || [])[0];
    if (!it) throw Object.assign(new Error('Không tìm thấy playlist (có thể là playlist riêng tư)'), { status: 404 });
    const sn = it.snippet || {};
    return { kind: 'playlist', id: it.id, title: String(sn.title || '').slice(0, 100), handle: String(sn.channelTitle || '').slice(0, 100),
      uploads: it.id, ytCount: +(it.contentDetails || {}).itemCount || 0, owner: sn.channelId || '' };
  }
  const d = await yt(env, run, 'channels', Object.assign({ part: 'snippet,contentDetails,statistics' }, q), 1);
  const it = (d.items || [])[0];
  if (!it) throw Object.assign(new Error('Không tìm thấy kênh'), { status: 404 });
  const uploads = it.contentDetails && it.contentDetails.relatedPlaylists && it.contentDetails.relatedPlaylists.uploads;
  if (!uploads) throw Object.assign(new Error('Kênh không có danh sách video công khai'), { status: 400 });
  return { kind: 'channel', id: it.id, title: String(it.snippet.title || '').slice(0, 100), handle: String(it.snippet.customUrl || '').slice(0, 100),
    uploads, ytCount: +(it.statistics || {}).videoCount || 0, owner: it.id };
}
// Đổi kiểu tiêu đề của một nguồn → gom lại song_key các bản của nguồn đó
function rekeyStmt(env, ch, order) {
  const where = ch.kind === 'playlist' ? `src = ?1` : `channel_id = ?1 AND (src IS NULL OR src = ?1)`;
  return env.DB.prepare(`UPDATE videos SET song_key = CASE WHEN ?2 = 'artist' AND json_array_length(segs) > 1 THEN json_extract(segs,'$[1]') ELSE json_extract(segs,'$[0]') END
    WHERE ${where} AND song_key <> CASE WHEN ?2 = 'artist' AND json_array_length(segs) > 1 THEN json_extract(segs,'$[1]') ELSE json_extract(segs,'$[0]') END`).bind(ch.id, order);
}
/* Số liệu theo nguồn, tính từ kho (không tốn đơn vị YouTube). Nguồn của một bản = playlist đã đưa nó vào (src), không có thì kênh đăng.
   n = số bản, songs = số bài, uniq = số bài CHỈ nguồn này có, picks = lượt chọn 30 ngày */
async function sourceStats(env, now) {
  const [a, b, p] = await Promise.all([
    env.DB.prepare(`SELECT COALESCE(src, channel_id) AS s, MAX(channel) AS title, COUNT(*) AS n, COUNT(DISTINCT song_key) AS songs FROM videos GROUP BY s`).all(),
    env.DB.prepare(`SELECT s, COUNT(*) AS uniq FROM (SELECT MIN(COALESCE(src, channel_id)) AS s FROM videos GROUP BY song_key
        HAVING COUNT(DISTINCT COALESCE(src, channel_id)) = 1) GROUP BY s`).all(),
    env.DB.prepare(`SELECT COALESCE(v.src, v.channel_id) AS s, COUNT(*) AS n FROM pick_log p JOIN videos v ON v.id = p.id WHERE p.ts >= ?1 GROUP BY s`).bind(now - 30 * DAY).all()
  ]);
  const S = {};
  const get = k => (S[k] = S[k] || { n: 0, songs: 0, uniq: 0, picks: 0, title: '' });
  (a.results || []).forEach(r => { const x = get(r.s); x.n = r.n; x.songs = r.songs; x.title = r.title || ''; });
  (b.results || []).forEach(r => { get(r.s).uniq = r.uniq; });
  (p.results || []).forEach(r => { get(r.s).picks = r.n; });
  return S;
}
const chOut = (c, st) => ({ id: c.id, kind: c.kind || 'channel', title: c.title, handle: c.handle, enabled: !!c.enabled, order: c.order_mode,
  fullDone: !!c.full_done, star: !!c.star, lastScan: c.last_scan, nextScan: c.next_scan || 0, newestAt: c.newest_at || 0, owner: c.owner_id || '',
  videos: c.video_count, ytCount: c.yt_count, note: c.note || '', addedAt: c.added_at || 0,
  songs: st ? st.songs : null, uniq: st ? st.uniq : null, picks30: st ? st.picks : null });

// Tìm trong kho. relaxed = true: chỉ cần khớp MỘT trong các từ (dùng để gợi ý "bài gần giống" khi không tìm được trên YouTube)
const QUERY_NOISE = new Set(['karaoke', 'beat', 'tone', 'ton', 'nhac', 'song', 'bai', 'hat', 'lyric', 'lyrics', 'hd', 'mv']);
async function groupSearch(env, q, limit, relaxed) {
  let words = ascii(q).split(' ').filter(Boolean);
  const core = words.filter(w => !QUERY_NOISE.has(w));
  if (core.length) words = core;
  words = words.slice(0, 8);
  if (relaxed) words = words.filter(w => w.length > 1 || words.length === 1);
  if (!words.length) return [];
  const match = words.map(w => '"' + w + '"*').join(relaxed ? ' OR ' : ' ');
  const rows = (await env.DB.prepare(`SELECT v.id, v.title, v.channel, v.song_key, v.tone, v.views, v.duration, MAX(IFNULL(c1.star, 0), IFNULL(c2.star, 0)) AS star
      FROM videos_fts JOIN videos v ON v.rid = videos_fts.rowid LEFT JOIN channels c1 ON c1.id = v.channel_id LEFT JOIN channels c2 ON c2.id = v.src
      WHERE videos_fts MATCH ?1 ORDER BY videos_fts.rank LIMIT 300`).bind(match).all()).results || [];
  const pk = await picksById(env, rows.map(r => r.id), 0);
  const qn = words.join(' '), G = {};
  rows.forEach((r, i) => {
    const gk = r.song_key + '|' + (r.tone || ''), n = pk[r.id] || 0;
    const g = G[gk] = G[gk] || { key: r.song_key, tone: r.tone || '', versions: 0, picks: 0, maxViews: 0, star: 0, best: null, bn: -1, pos: i };
    g.versions++; g.picks += n; g.maxViews = Math.max(g.maxViews, r.views || 0); g.star = Math.max(g.star, r.star || 0);
    if (!g.best || better(n, r.star, r.views, g.bn, g.best.star, g.best.views)) { g.best = r; g.bn = n; }
  });
  const nRows = rows.length || 1;
  return Object.values(G).map(g => ({
    key: g.key, tone: g.tone, versions: g.versions, picks: g.picks, best: vOut(g.best, g.bn),
    s: (g.key === qn ? 6 : g.key.startsWith(qn) ? 4 : g.key.includes(qn) ? 2 : 0) + (relaxed ? 4 : 1) * (1 - g.pos / nRows)
      + Math.log10(1 + g.maxViews) * 0.6 + Math.log2(1 + g.picks) * 1.5 + (g.star ? 1 : 0)
  })).sort((a, b) => b.s - a.s).slice(0, limit).map(({ s, ...g }) => g);
}
async function searchUsed(env, run) {
  const r = await env.DB.prepare(`SELECT v FROM meta WHERE k = ?1`).bind('search:' + run.day).first();
  return +(r && r.v) || 0;
}
async function hotList(env, lim) {
  const rows = (await env.DB.prepare(`SELECT h.song_key, h.score, h.trend_rank, h.delta, h.picks, h.versions, h.label, v.id, v.title, v.channel, v.tone, v.views, v.duration
      FROM hot_songs h JOIN videos v ON v.id = h.best_id ORDER BY h.score DESC LIMIT ?1`).bind(lim).all()).results || [];
  return rows.map(r => ({ key: r.song_key, score: r.score, trendRank: r.trend_rank, delta: r.delta, picks: r.picks, versions: r.versions, label: r.label, best: vOut(r, 0) }));
}
// Gợi ý từ kho khi chưa có bài hot: bài được chọn nhiều, rồi bài mới, rồi bài nhiều lượt xem
async function suggestList(env, now, lim) {
  const picked = (await env.DB.prepare(`SELECT v.id, v.title, v.channel, v.tone, v.views, v.duration, COUNT(*) AS n FROM pick_log p JOIN videos v ON v.id = p.id
      WHERE p.ts >= ?1 GROUP BY v.id ORDER BY n DESC LIMIT ?2`).bind(now - 90 * DAY, lim).all()).results || [];
  const fresh = (await env.DB.prepare(`SELECT id, title, channel, tone, views, duration FROM videos WHERE published_at > ?1 ORDER BY views DESC LIMIT ?2`).bind(now - 30 * DAY, lim).all()).results || [];
  const top = (await env.DB.prepare(`SELECT id, title, channel, tone, views, duration FROM videos ORDER BY views DESC LIMIT ?1`).bind(lim).all()).results || [];
  const seen = new Set(), out = [];
  [...picked, ...fresh, ...top].forEach(r => { if (!seen.has(r.id) && out.length < lim) { seen.add(r.id); out.push(vOut(r, r.n || 0)); } });
  return out;
}
const vOut = (r, n) => ({ id: r.id, title: r.title, channel: r.channel, tone: r.tone || '', views: r.views || 0, duration: r.duration || 0, picks: n || 0, star: r.star ? 1 : 0 });
// Bản nào tốt hơn trong cùng một bài: nhiều lượt chọn hơn → nguồn ⭐ tin dùng → nhiều lượt xem hơn
function better(n, star, views, bn, bstar, bviews) {
  if (n !== bn) return n > bn;
  if ((star || 0) !== (bstar || 0)) return (star || 0) > (bstar || 0);
  return (views || 0) > (bviews || 0);
}

async function handle(req, env, ctx) {
  const run = newRun();
  try { return await route(req, env, ctx, run); }
  finally { if (env.DB && !run.flushed && (run.writes || run.units || run.searches)) ctx.waitUntil(flush({ DB: meter(env.DB, run) }, run, conf(env)).catch(() => {})); }
}
async function route(req, env, ctx, run) {
  const { ok, h } = cors(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (!ok) return J({ error: 'Origin không được phép', reason: 'origin' }, 403, h);
  const url = new URL(req.url), p = url.pathname.replace(/\/+$/, '');
  if (p === '' || p === '/') return J({ ok: true, app: 'kho-karaoke' }, 200, h);
  if (!env.APP_PASS || req.headers.get('x-pass') !== env.APP_PASS) return J({ error: 'Sai mật khẩu', reason: 'auth' }, 401, h);
  if (!env.DB) return J({ error: 'Worker chưa gắn D1 với tên DB' }, 500, h);
  const c = conf(env), now = Date.now();
  const rawEnv = env;
  env = Object.assign({}, env, { DB: meter(env.DB, run) });
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const done = () => ctx.waitUntil(flush(env, run, c).catch(() => {}));
  try {
    await ensureSchema(env);
    /* ----- dùng cho remote.html ----- */
    if (p === '/api/kho/search' && req.method === 'GET') {
      return J({ groups: await groupSearch(env, url.searchParams.get('q') || '', Math.min(num(url.searchParams.get('limit'), 40), 80)) }, 200, h);
    }
    if (p === '/api/kho/versions' && req.method === 'GET') {
      const key = url.searchParams.get('key') || '', tone = url.searchParams.get('tone');
      const rows = (await env.DB.prepare(`SELECT v.id, v.title, v.channel, v.tone, v.views, v.duration, MAX(IFNULL(c1.star, 0), IFNULL(c2.star, 0)) AS star FROM videos v LEFT JOIN channels c1 ON c1.id = v.channel_id LEFT JOIN channels c2 ON c2.id = v.src
          WHERE v.song_key = ?1 AND (?2 IS NULL OR v.tone = ?2) LIMIT 80`).bind(key, tone == null ? null : tone).all()).results || [];
      const pk = await picksById(env, rows.map(r => r.id), 0);
      const items = rows.map(r => vOut(r, pk[r.id])).sort((a, b) => b.picks - a.picks || b.star - a.star || b.views - a.views);
      return J({ items }, 200, h);
    }
    if (p === '/api/kho/hot' && req.method === 'GET') {
      const lim = Math.min(num(url.searchParams.get('limit'), 50), 100);
      const items = await hotList(env, lim);
      const suggest = items.length < 10 ? await suggestList(env, now, 30) : [];
      return J({ items, suggest, quota: { used: await searchUsed(env, run), limit: c.searchLimit } }, 200, h);
    }
    if (p === '/api/kho/new' && req.method === 'GET') {
      return J({ items: await suggestList(env, now, 50) }, 200, h);
    }
    if (p === '/api/kho/quota' && req.method === 'GET') {
      return J({ used: await searchUsed(env, run), limit: c.searchLimit }, 200, h);
    }
    /* Tìm trên YouTube cho remote — luôn trả về thứ gì đó để chọn:
         cache  : từ khoá này đã tìm trong 7 ngày → trả lại, không tốn lượt
         youtube: tìm thật (1 lượt) → bài karaoke tìm được tự vào kho
         fallback: hết lượt / YouTube lỗi / quá chậm → bài gần giống trong kho (+ bài hot nếu không có) */
    if (p === '/api/kho/ytsearch' && req.method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
      if (!q) return J({ error: 'Thiếu từ khoá' }, 400, h);
      await ensureCache(env);
      const qk = ascii(q);
      const used = await searchUsed(env, run);
      const quota = n => ({ used: n, limit: c.searchLimit });
      const cached = await env.DB.prepare(`SELECT items, at FROM yt_cache WHERE q = ?1`).bind(qk).first();
      if (cached && now - cached.at < CACHE_FRESH) {
        let items = []; try { items = JSON.parse(cached.items); } catch (e) {}
        const pk = await picksById(env, items.map(x => x.id), 0);
        items.forEach(x => { x.picks = pk[x.id] || 0; });
        return J({ source: 'cache', items, quota: quota(used) }, 200, h);
      }
      const fallback = async reason => {
        const groups = await groupSearch(env, q, 30, true);
        const hot = groups.length ? [] : (await hotList(env, 20));
        const sug = groups.length || hot.length ? [] : await suggestList(env, now, 20);
        done();
        return J({ source: 'fallback', reason, groups, hot, suggest: sug, quota: quota(Math.max(used, run.searchQuotaHit ? c.searchLimit : used)) }, 200, h);
      };
      if (used >= c.searchLimit) return fallback('limit');
      if (!ytKeys(env).some(Boolean)) return fallback('nokey');
      try {
        const d = await yt(env, run, 'search', { part: 'id', type: 'video', videoEmbeddable: 'true', regionCode: 'VN', relevanceLanguage: 'vi', maxResults: 25, q }, 0);
        const ids = (d.items || []).map(x => x.id && x.id.videoId).filter(i => ID_RE.test(i || ''));
        let items = [];
        if (ids.length) {
          const r = await fetchAndIngest(env, run, ids, now);
          const byId = {}; (r.items || []).forEach(v => { byId[v.id] = v; });
          items = ids.map(i => byId[i]).filter(Boolean).filter(v => {
            const ss = v.status || {}, cd = v.contentDetails || {}, rr = cd.regionRestriction;
            if (!ss.embeddable || ss.privacyStatus === 'private') return false;
            if (rr && ((rr.blocked || []).includes('VN') || (rr.allowed && !rr.allowed.includes('VN')))) return false;
            return durSec(cd.duration) >= 60;
          }).map(v => ({ id: v.id, title: String(v.snippet.title || '').slice(0, 200), channel: String(v.snippet.channelTitle || '').slice(0, 100),
            tone: toneOf(nd(v.snippet.title)), views: +(v.statistics || {}).viewCount || 0, duration: durSec(v.contentDetails.duration), picks: 0 }));
          const isK = x => /\b(?:karaoke|beat)\b/.test(nd(x.title)) ? 0 : 1;      // bản karaoke lên trước, giữ thứ tự YouTube
          items = items.map((x, i) => [isK(x), i, x]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(a => a[2]);
        }
        await env.DB.prepare(`INSERT INTO yt_cache (q, items, at) VALUES (?1, ?2, ?3) ON CONFLICT(q) DO UPDATE SET items = excluded.items, at = excluded.at`)
          .bind(qk, JSON.stringify(items), now).run();
        if (!items.length) {
          const groups = await groupSearch(env, q, 30, true);
          done();
          return J({ source: 'youtube', items, groups, quota: quota(used + 1) }, 200, h);
        }
        done();
        return J({ source: 'youtube', items, quota: quota(used + 1) }, 200, h);
      } catch (e) {
        return fallback(e.reason === 'quotaExceeded' || run.searchQuotaHit ? 'limit' : (e.name === 'TimeoutError' ? 'timeout' : 'error'));
      }
    }
    /* Dự phòng cho remote khi Worker nhac-playlist không kết nối được: đọc 1 video / nạp playlist (bài karaoke tự vào kho) */
    const pubItem = v => ({ id: v.id, title: String(v.snippet.title || '').slice(0, 200), channel: String(v.snippet.channelTitle || '').slice(0, 100),
      thumb: 'https://i.ytimg.com/vi/' + v.id + '/mqdefault.jpg' });
    const playable = v => { const ss = v.status || {}, rr = (v.contentDetails || {}).regionRestriction;
      return ss.embeddable && ss.privacyStatus !== 'private' && !(rr && ((rr.blocked || []).includes('VN') || (rr.allowed && !rr.allowed.includes('VN')))); };
    if (p === '/api/kho/video' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) return J({ error: 'id không hợp lệ' }, 400, h);
      const r = await fetchAndIngest(env, run, [id], now);
      done();
      const v = (r.items || [])[0];
      if (!v) return J({ error: 'Không tìm thấy video' }, 404, h);
      if (!playable(v)) return J({ error: 'Video không cho phát nhúng', reason: 'notEmbeddable' }, 400, h);
      return J({ item: pubItem(v) }, 200, h);
    }
    if (p === '/api/kho/import' && req.method === 'GET') {
      const list = url.searchParams.get('list') || '';
      if (!/^[\w-]{10,64}$/.test(list)) return J({ error: 'Mã playlist không hợp lệ' }, 400, h);
      const ids = []; let token = '';
      try {
        for (let i = 0; i < 4; i++) {
          const d = await yt(env, run, 'playlistItems', { part: 'contentDetails', playlistId: list, maxResults: 50, pageToken: token }, 1);
          (d.items || []).forEach(x => { const vid = x.contentDetails && x.contentDetails.videoId; if (ID_RE.test(vid || '') && !ids.includes(vid)) ids.push(vid); });
          token = d.nextPageToken || ''; if (!token) break;
        }
      } catch (e) {
        done();
        if (e.status === 404 || e.reason === 'playlistNotFound') return J({ error: 'Không đọc được playlist', reason: 'playlistNotFound' }, 404, h);
        throw e;
      }
      const out = [];
      for (let i = 0; i < ids.length; i += 50) {
        const r = await fetchAndIngest(env, run, ids.slice(i, i + 50), now);
        const by = {}; (r.items || []).forEach(v => { by[v.id] = v; });
        ids.slice(i, i + 50).forEach(x => { if (by[x] && playable(by[x])) out.push(pubItem(by[x])); });
      }
      done();
      return J({ items: out, skipped: ids.length - out.length }, 200, h);
    }
    /* Kiểm lại bài nghi đã bị gỡ (trình phát báo lỗi 100/101/150, hoặc remote thấy ảnh bìa xám): 1 đơn vị cho ≤50 bài,
       bài thật sự không còn phát được thì xoá khỏi kho ngay, không đợi lượt làm mới 7 ngày */
    if (p === '/api/kho/check' && req.method === 'POST') {
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [body.id]).map(String).filter(i => ID_RE.test(i)))].slice(0, 50);
      if (!ids.length) return J({ error: 'Thiếu id' }, 400, h);
      // chỉ kiểm bài đang có trong kho; báo từ ảnh bìa thì bỏ qua bài vừa kiểm trong 3 giờ (đỡ tốn lượt khi nhiều máy cùng báo)
      const minAge = body.reason === 'player' ? 0 : 3 * 3600000;
      const rows = (await env.DB.prepare(`SELECT id FROM videos WHERE id IN (SELECT value FROM json_each(?1)) AND fetched_at <= ?2`).bind(JSON.stringify(ids), now - minAge).all()).results || [];
      const todo = rows.map(r => r.id);
      if (!todo.length) return J({ checked: 0, removed: [], ok: [] }, 200, h);
      const r = await fetchAndIngest(env, run, todo, now);
      const okIds = new Set(r.rows.map(x => x.id)), removed = todo.filter(i => !okIds.has(i));
      if (removed.length && await env.DB.prepare(`SELECT 1 AS x FROM hot_songs WHERE best_id IN (SELECT value FROM json_each(?1)) LIMIT 1`).bind(JSON.stringify(removed)).first())
        await rebuildHot(env, now);       // bản ưu tiên của một bài hot vừa bị gỡ → chọn bản khác
      if (removed.length) await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('gone', ?1) ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + ?1 AS TEXT)`).bind(removed.length).run();
      done();
      return J({ checked: todo.length, removed, ok: todo.filter(i => okIds.has(i)) }, 200, h);
    }
    if (p === '/api/kho/pick' && req.method === 'POST') {
      const id = String(body.id || '');
      if (!ID_RE.test(id)) return J({ error: 'id không hợp lệ' }, 400, h);
      await env.DB.prepare(`INSERT INTO pick_log (id, ts) VALUES (?1, ?2)`).bind(id, now).run();
      const has = await env.DB.prepare(`SELECT 1 AS x FROM videos WHERE id = ?1 UNION SELECT 1 FROM rejected WHERE id = ?1`).bind(id).first();
      let added = 0;
      if (!has && ytKeys(env).some(Boolean)) { try { added = (await fetchAndIngest(env, run, [id], now)).added; } catch (e) {} }   // bài mới anh tự tìm → bổ sung vào kho
      done();
      return J({ ok: true, added }, 200, h);
    }

    /* ----- quản trị (kho.html) ----- */
    if (p === '/api/kho/stats' && req.method === 'GET') {
      const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
      const [v, s, ch, hs, hq, pk] = await Promise.all([
        one(`SELECT COUNT(*) AS n FROM videos`), one(`SELECT COUNT(DISTINCT song_key) AS n FROM videos`),
        one(`SELECT COUNT(*) AS n, SUM(enabled) AS on_, SUM(CASE WHEN kind = 'playlist' THEN 1 ELSE 0 END) AS pl,
            SUM(CASE WHEN enabled = 1 AND full_done = 0 THEN 1 ELSE 0 END) AS pend,
            SUM(CASE WHEN enabled = 1 AND full_done = 1 AND next_scan <= ?1 THEN 1 ELSE 0 END) AS due,
            SUM(CASE WHEN enabled = 1 AND full_done = 1 AND next_scan < ?2 THEN 1 ELSE 0 END) AS late,
            MIN(CASE WHEN enabled = 1 AND full_done = 1 THEN next_scan END) AS oldest FROM channels`, now, now - LATE_MS),
        one(`SELECT COUNT(*) AS n FROM hot_songs`),
        one(`SELECT COUNT(*) AS n FROM hot WHERE song_key IS NULL AND searched = 0`), one(`SELECT COUNT(*) AS n FROM pick_log WHERE ts >= ?1`, now - 30 * DAY)
      ]);
      const m = await metaGet(env, ['units:' + run.day, 'search:' + run.day, 'last', 'hot_at', 'writes:' + run.day, 'keybad:0', 'keybad:1']);
      let last = null; try { last = JSON.parse(m.last || 'null'); } catch (e) {}
      const kb = i => { try { return JSON.parse(m['keybad:' + i] || 'null'); } catch (e) { return null; } };
      const ks = ytKeys(env), keys = [0, 1].map(i => ({ name: i ? 'YT_KEY_2' : 'YT_KEY', set: !!ks[i], bad: ks[i] ? kb(i) : null }));
      return J({ videos: v.n, songs: s.n, channels: ch.n, channelsOn: ch.on_ || 0, playlists: ch.pl || 0, pendingFull: ch.pend || 0,
        dueNow: ch.due || 0, late: ch.late || 0, oldestDue: ch.oldest || 0, hotSongs: hs.n, hotPending: hq.n, picks30: pk.n,
        unitsToday: +m['units:' + run.day] || 0, searchesToday: +m['search:' + run.day] || 0, budget: c.budget, hotSearchPerDay: c.hotSearch,
        pagesPerTick: c.pages, hotAt: +m.hot_at || 0, last, keys,
        writesToday: +m['writes:' + run.day] || 0, writeLimit: c.writeLimit }, 200, h);
    }
    if (p === '/api/kho/run' && req.method === 'POST') {
      const job = ['auto', 'scan', 'refresh', 'hot', 'hotsearch', 'rehot'].includes(body.job) ? body.job : 'auto';
      const report = await tick(rawEnv, job);
      const st = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM channels WHERE enabled = 1 AND full_done = 0) AS pending,
          (SELECT COUNT(*) FROM channels WHERE enabled = 1 AND full_done = 1 AND next_scan <= ?3) AS due,
          (SELECT COUNT(*) FROM videos) AS videos, (SELECT v FROM meta WHERE k = ?1) AS units, (SELECT v FROM meta WHERE k = ?2) AS writes`).bind('units:' + run.day, 'writes:' + run.day, Date.now()).first();
      return J({ report, pending: st.pending, due: st.due, videos: st.videos, units: +st.units || 0, budget: c.budget, writes: +st.writes || 0, writeLimit: c.writeLimit }, 200, h);
    }
    if (p === '/api/kho/channels' && req.method === 'GET') {
      const rows = (await env.DB.prepare(`SELECT * FROM channels ORDER BY added_at`).all()).results || [];
      const S = await sourceStats(env, now);
      const have = new Set(rows.map(r => r.id)), owners = new Set(rows.filter(r => r.kind === 'playlist').map(r => r.owner_id));
      const hidden = new Set(((await env.DB.prepare(`SELECT id FROM channel_hide`).all()).results || []).map(x => x.id));
      // Gợi ý kênh từ chính kho: kênh chưa thêm nhưng đã có bản karaoke vào kho (qua tìm YouTube, tìm bài hot, dán link) — không tốn lượt tìm
      const discover = Object.entries(S).filter(([id, x]) => /^UC[\w-]{22}$/.test(id) && !have.has(id) && !hidden.has(id) && (x.n >= 3 || x.picks > 0))
        .sort((a, b) => b[1].picks - a[1].picks || b[1].uniq - a[1].uniq || b[1].n - a[1].n).slice(0, 20)
        .map(([id, x]) => ({ id, title: x.title, n: x.n, songs: x.songs, uniq: x.uniq, picks30: x.picks, viaPlaylist: owners.has(id) }));
      return J({ channels: rows.map(r => chOut(r, S[r.id] || { n: 0, songs: 0, uniq: 0, picks: 0 })), discover }, 200, h);
    }
    // Xem trước một nguồn trước khi thêm (≈3 đơn vị, KHÔNG ghi gì vào kho): tỉ lệ bài karaoke, bài mới nhất, cách tách tên bài
    if (p === '/api/kho/channel/preview' && req.method === 'GET') {
      const s = await resolveSource(env, run, url.searchParams.get('input') || '');
      const d = await yt(env, run, 'playlistItems', { part: 'contentDetails', playlistId: s.uploads, maxResults: 50 }, 1);
      const cds = (d.items || []).map(x => x.contentDetails || {});
      const ids = cds.map(x => x.videoId).filter(i => ID_RE.test(i || ''));
      const newest = Math.max(0, ...cds.map(x => Date.parse(x.videoPublishedAt) || 0));
      const vd = ids.length ? await yt(env, run, 'videos', { part: 'snippet,contentDetails,statistics,status', id: ids.join(',') }, 1) : { items: [] };
      done();
      const rows = (vd.items || []).map(v => toRow(v, 'song')).filter(Boolean);
      const segs = rows.map(r => JSON.parse(r.segs));
      // Đoán kiểu tiêu đề: đoạn nào trùng tên bài đã có trong kho nhiều hơn thì đó là tên bài
      const A = segs.map(x => x[0]), B = segs.filter(x => x.length > 1).map(x => x[1]);
      const hit = new Set(((await env.DB.prepare(`SELECT DISTINCT song_key FROM videos WHERE song_key IN (SELECT value FROM json_each(?1))`)
        .bind(JSON.stringify([...new Set(A.concat(B))])).all()).results || []).map(x => x.song_key));
      const hitsSong = A.filter(k => hit.has(k)).length, hitsArtist = B.filter(k => hit.has(k)).length;
      const ex = await env.DB.prepare(`SELECT enabled, order_mode, star FROM channels WHERE id = ?1`).bind(s.id).first();
      return J({ source: s, sampled: ids.length, karaoke: rows.length, newestAt: newest || 0,
        guess: hitsArtist >= 2 && hitsArtist > hitsSong * 1.5 ? 'artist' : 'song', hitsSong, hitsArtist,
        existing: ex ? { enabled: !!ex.enabled, order: ex.order_mode, star: !!ex.star } : null,
        samples: rows.slice(0, 12).map((r, i) => ({ title: r.title, song: segs[i][0] || '', artist: segs[i][1] || '', tone: r.tone })) }, 200, h);
    }
    if (p === '/api/kho/channel/add' && req.method === 'POST') {
      const s = await resolveSource(env, run, body.id && /^(?:UC[\w-]{22}|PL[\w-]{10,60}|OLAK5uy_[\w-]{10,60}|FL[\w-]{10,60})$/.test(body.id)
        ? (body.id.startsWith('UC') ? body.id : 'https://www.youtube.com/playlist?list=' + body.id) : body.input);
      done();
      const order = body.order === 'artist' || body.order === 'song' ? body.order : null;
      const star = typeof body.star === 'boolean' ? (body.star ? 1 : 0) : null;
      const ex = await env.DB.prepare(`SELECT id, kind, order_mode FROM channels WHERE id = ?1`).bind(s.id).first();
      const st = [env.DB.prepare(`INSERT INTO channels (id, title, handle, uploads, enabled, order_mode, full_done, last_scan, video_count, yt_count, added_at, kind, star, owner_id, next_scan, newest_at)
          VALUES (?1, ?2, ?3, ?4, 1, COALESCE(?7, 'song'), 0, 0, 0, ?5, ?6, ?8, COALESCE(?9, 0), ?10, 0, 0)
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, handle = excluded.handle, uploads = excluded.uploads, yt_count = excluded.yt_count,
            enabled = 1, note = NULL, order_mode = COALESCE(?7, order_mode), star = COALESCE(?9, star), kind = excluded.kind, owner_id = excluded.owner_id`)
        .bind(s.id, s.title, s.handle, s.uploads, s.ytCount, now, order, s.kind, star, s.owner),
        env.DB.prepare(`DELETE FROM channel_hide WHERE id = ?1`).bind(s.id)];
      if (ex && order && ex.order_mode !== order) st.push(rekeyStmt(env, { id: s.id, kind: s.kind }, order));
      await env.DB.batch(st);
      return J({ ok: true, existed: !!ex, channel: { id: s.id, kind: s.kind, title: s.title, ytCount: s.ytCount } }, 200, h);
    }
    if (p === '/api/kho/channel/suggest' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || 'karaoke').slice(0, 80);
      const d = await yt(env, run, 'search', { part: 'id', type: 'channel', q, regionCode: 'VN', relevanceLanguage: 'vi', maxResults: 20 }, 0);
      const ids = (d.items || []).map(x => x.id && x.id.channelId).filter(Boolean);
      let items = [];
      if (ids.length) {
        const c2 = await yt(env, run, 'channels', { part: 'snippet,statistics', id: ids.join(',') }, 1);
        const have = new Set(((await env.DB.prepare(`SELECT id FROM channels`).all()).results || []).map(x => x.id));
        items = (c2.items || []).map(x => ({ id: x.id, title: x.snippet.title, handle: x.snippet.customUrl || '', subs: +(x.statistics || {}).subscriberCount || 0,
          videos: +(x.statistics || {}).videoCount || 0, added: have.has(x.id) })).sort((a, b) => b.subs - a.subs);
      }
      done();
      return J({ items }, 200, h);
    }
    if (p === '/api/kho/channel/hide' && req.method === 'POST') {
      const id = String(body.id || '');
      if (!/^UC[\w-]{22}$/.test(id)) return J({ error: 'id kênh không hợp lệ' }, 400, h);
      await env.DB.prepare(`INSERT INTO channel_hide (id, at) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET at = excluded.at`).bind(id, now).run();
      return J({ ok: true }, 200, h);
    }
    if (p === '/api/kho/channel/samples' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const rows = (await env.DB.prepare(`SELECT title, song_key, tone FROM videos WHERE src = ?1 OR (src IS NULL AND channel_id = ?1) ORDER BY views DESC LIMIT 10`).bind(id).all()).results || [];
      return J({ items: rows }, 200, h);
    }
    if (p === '/api/kho/channel/update' && req.method === 'POST') {
      const id = String(body.id || '');
      const ch = await env.DB.prepare(`SELECT id, kind, order_mode FROM channels WHERE id = ?1`).bind(id).first();
      if (!ch) return J({ error: 'Không có nguồn này' }, 404, h);
      const st = [];
      if (typeof body.enabled === 'boolean') st.push(env.DB.prepare(`UPDATE channels SET enabled = ?2, note = NULL WHERE id = ?1`).bind(id, body.enabled ? 1 : 0));
      if (typeof body.star === 'boolean') st.push(env.DB.prepare(`UPDATE channels SET star = ?2 WHERE id = ?1`).bind(id, body.star ? 1 : 0));
      if ((body.order === 'song' || body.order === 'artist') && body.order !== ch.order_mode) {
        st.push(env.DB.prepare(`UPDATE channels SET order_mode = ?2 WHERE id = ?1`).bind(id, body.order));
        st.push(rekeyStmt(env, ch, body.order));
      }
      if (body.rescan) st.push(env.DB.prepare(`UPDATE channels SET full_done = 0, page_token = NULL, enabled = 1 WHERE id = ?1`).bind(id));
      if (st.length) await env.DB.batch(st);
      if (typeof body.star === 'boolean') await rebuildHot(env, now);    // bản ưu tiên của bài hot có thể đổi
      return J({ ok: true }, 200, h);
    }
    if (p === '/api/kho/channel/remove' && req.method === 'POST') {
      const id = String(body.id || '');
      const ch = await env.DB.prepare(`SELECT id, kind FROM channels WHERE id = ?1`).bind(id).first();
      if (!ch) return J({ ok: true }, 200, h);
      const where = ch.kind === 'playlist' ? `src = ?1` : `channel_id = ?1 AND (src IS NULL OR src = ?1)`;
      const st = [env.DB.prepare(`DELETE FROM channels WHERE id = ?1`).bind(id)];
      if (body.purge) st.unshift(
        env.DB.prepare(`DELETE FROM videos_fts WHERE rowid IN (SELECT rid FROM videos WHERE ${where})`).bind(id),
        env.DB.prepare(`DELETE FROM videos WHERE ${where}`).bind(id));
      else if (ch.kind === 'playlist') st.push(env.DB.prepare(`UPDATE videos SET src = NULL WHERE src = ?1`).bind(id));   // giữ bài, trả về tính theo kênh đăng
      if (ch.kind !== 'playlist')     // kênh đã xoá thì không hiện lại trong "Gợi ý từ kho"
        st.push(env.DB.prepare(`INSERT INTO channel_hide (id, at) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET at = excluded.at`).bind(id, now));
      await env.DB.batch(st);
      return J({ ok: true }, 200, h);
    }
    if (p === '/api/kho/hot/raw' && req.method === 'GET') {
      const rows = (await env.DB.prepare(`SELECT id, source, rank, label, song_key, searched FROM hot ORDER BY CASE source WHEN 'manual' THEN 0 ELSE 1 END, rank LIMIT 300`).all()).results || [];
      return J({ items: rows }, 200, h);
    }
    if (p === '/api/kho/hot/manual' && req.method === 'POST') {
      const lines = String(body.text || '').split(/\r?\n/).map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean).slice(0, 200);
      const rows = lines.map((l, i) => ({ id: 'm:' + ascii(l).slice(0, 80), rank: i + 1, label: l.slice(0, 200), q: cleanQuery(l), cands: JSON.stringify(segments(l)) })).filter(r => r.cands !== '[]');
      const st = [];
      if (body.replace) st.push(env.DB.prepare(`DELETE FROM hot WHERE source = 'manual'`));
      st.push(env.DB.prepare(`INSERT INTO hot (id, source, rank, label, q, cands, song_key, searched, seen_at)
          SELECT json_extract(value,'$.id'), 'manual', json_extract(value,'$.rank'), json_extract(value,'$.label'), json_extract(value,'$.q'), json_extract(value,'$.cands'), NULL, 0, ?2
          FROM json_each(?1) WHERE true ON CONFLICT(id) DO UPDATE SET rank = excluded.rank, seen_at = excluded.seen_at`).bind(JSON.stringify(rows), now));
      await env.DB.batch(st);
      const matched = await rematch(env);
      const songs = await rebuildHot(env, now);
      return J({ ok: true, added: rows.length, matched, hotSongs: songs }, 200, h);
    }
    return J({ error: 'Không có đường dẫn này' }, 404, h);
  } catch (e) {
    done();
    const st = e.reason === 'quotaExceeded' ? 429 : (e.status && e.status < 500 ? e.status : 500);
    return J({ error: String(e.message || e), reason: e.reason || '' }, st === 401 ? 502 : st, h);
  }
}

export default {
  fetch: (req, env, ctx) => handle(req, env, ctx),
  scheduled: (ev, env, ctx) => { ctx.waitUntil(tick(env, null)); }
};
