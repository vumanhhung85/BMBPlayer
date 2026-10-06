/* =====================================================================
   kho-worker.js — KHO KARAOKE cho BMBPlayer (Cloudflare Worker + D1)
   ---------------------------------------------------------------------
   Việc tự chạy (Cron Trigger mỗi 10 phút, mỗi lần làm MỘT việc nhỏ):
     • scan      : quét danh sách video đã đăng của các kênh karaoke đã thêm
                   (playlistItems ≈ 1 đơn vị/50 bài) → lọc bài karaoke phát nhúng được → lưu D1
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
     APP_PASS (secret)  : mật khẩu, gửi qua header x-pass (nên đặt giống nhac-playlist)
     ALLOWED_ORIGINS    : ví dụ https://vumanhhung85.github.io,http://localhost:8000
     DAILY_UNIT_BUDGET  : (tuỳ chọn) trần đơn vị/ngày kho được dùng, mặc định 5000
     PAGES_PER_TICK     : (tuỳ chọn) số trang 50 bài mỗi lần chạy, mặc định 4
     HOT_SEARCH_PER_DAY : (tuỳ chọn) lượt tìm tự động/ngày cho bài hot, mặc định 20
     SEARCH_LIMIT       : (tuỳ chọn) hạn mức lượt tìm/ngày của project, mặc định 100
   Cron Trigger: * /10 * * * *   (viết liền: "*\/10 * * * *")
   Chỉ dùng cá nhân/thử nghiệm — không dùng phát cho khách BMB.
   ===================================================================== */

const DAY = 86400000;
const REFRESH_AGE = 7 * DAY;      // làm mới mỗi 7 ngày (đồng thời là chu kỳ đo độ hot)
const MAX_AGE = 30 * DAY;         // dữ liệu API YouTube lưu tối đa 30 ngày
const HOT_EVERY = 6 * 3600000;    // lấy bảng thịnh hành 6 giờ/lần
const LOCK_MS = 9 * 60000;
const YT = 'https://www.googleapis.com/youtube/v3/';
const ID_RE = /^[\w-]{11}$/;

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const conf = env => ({ pages: Math.min(num(env.PAGES_PER_TICK, 4), 10), budget: num(env.DAILY_UNIT_BUDGET, 5000), hotSearch: num(env.HOT_SEARCH_PER_DAY, 20), searchLimit: num(env.SEARCH_LIMIT, 100) });
const CACHE_FRESH = 7 * DAY;      // cùng một từ khoá đã tìm trong 7 ngày → trả lại kết quả cũ, không tốn lượt
let cacheReady = false;
async function ensureCache(env) {
  if (cacheReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS yt_cache (q TEXT PRIMARY KEY, items TEXT, at INTEGER)`).run();
  cacheReady = true;
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
async function yt(env, run, path, params, cost) {
  if (!env.YT_KEY) throw Object.assign(new Error('Chưa đặt secret YT_KEY cho Worker'), { reason: 'nokey' });
  const u = new URL(YT + path);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) u.searchParams.set(k, String(v));
  u.searchParams.set('key', env.YT_KEY);
  if (path === 'search') run.searches++; else run.units += cost;
  const res = await fetch(u.toString(), { signal: AbortSignal.timeout(10000) });
  let d = {}; try { d = await res.json(); } catch (e) {}
  if (!res.ok) {
    const er = d.error || {}, reason = (er.errors && er.errors[0] && er.errors[0].reason) || '';
    if (/quota|rateLimit/i.test(reason)) { if (path === 'search') run.searchQuotaHit = true; else run.quotaHit = true; }
    throw Object.assign(new Error(er.message || ('YouTube lỗi ' + res.status)), { reason, status: res.status });
  }
  return d;
}

/* ---------------- D1: ghi/xoá ---------------- */
async function channelModes(env, chIds) {
  const m = {};
  if (!chIds.length) return m;
  const r = await env.DB.prepare(`SELECT id, order_mode FROM channels WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(chIds)).all();
  (r.results || []).forEach(x => { m[x.id] = x.order_mode; });
  return m;
}
async function ingest(env, rows, now) {
  if (!rows.length) return;
  const J = JSON.stringify(rows);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO videos (id, channel_id, channel, title, segs, song_key, tone, duration, views, views_delta, published_at, fetched_at)
      SELECT json_extract(value,'$.id'), json_extract(value,'$.ch'), json_extract(value,'$.cht'), json_extract(value,'$.title'),
             json_extract(value,'$.segs'), json_extract(value,'$.key'), json_extract(value,'$.tone'), json_extract(value,'$.dur'),
             json_extract(value,'$.views'), 0, json_extract(value,'$.pub'), ?2
      FROM json_each(?1) WHERE true
      ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, title = excluded.title, segs = excluded.segs,
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
// Lấy chi tiết ≤50 id, lưu bài đạt, loại (và nhớ) bài không đạt
async function fetchAndIngest(env, run, ids, now) {
  if (!ids.length) return { added: 0, rejected: 0, rows: [] };
  const d = await yt(env, run, 'videos', { part: 'snippet,contentDetails,statistics,status', id: ids.join(',') }, 1);
  const items = d.items || [];
  const modes = await channelModes(env, [...new Set(items.map(v => (v.snippet || {}).channelId).filter(Boolean))]);
  const rows = [];
  for (const v of items) { const r = toRow(v, modes[(v.snippet || {}).channelId]); if (r) rows.push(r); }
  const okIds = new Set(rows.map(r => r.id));
  const bad = ids.filter(i => !okIds.has(i));
  await ingest(env, rows, now);
  await removeIds(env, bad, now);
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
async function scanJob(env, run, c, now) {
  const ch = await env.DB.prepare(`SELECT * FROM channels WHERE enabled = 1 AND (full_done = 0 OR last_scan < ?1) ORDER BY full_done ASC, (page_token IS NULL) ASC, last_scan ASC LIMIT 1`).bind(now - DAY).first();
  if (!ch) return { job: 'scan', idle: true };
  let token = ch.full_done ? '' : (ch.page_token || ''), pages = 0, seen = 0, added = 0, rejected = 0, done = false;
  try {
    while (pages < c.pages) {
      const d = await yt(env, run, 'playlistItems', { part: 'contentDetails', playlistId: ch.uploads, maxResults: 50, pageToken: token }, 1);
      pages++;
      const ids = (d.items || []).map(x => x.contentDetails && x.contentDetails.videoId).filter(i => ID_RE.test(i || ''));
      seen += ids.length;
      const known = ids.length ? await knownIds(env, ids) : new Set();
      const fresh = ids.filter(i => !known.has(i));
      if (fresh.length) { const r = await fetchAndIngest(env, run, fresh, now); added += r.added; rejected += r.rejected; }
      token = d.nextPageToken || '';
      if (!token) { done = true; break; }
      if (ch.full_done && !fresh.length) { done = true; break; }   // quét bổ sung: đã chạm vùng bài cũ
    }
  } catch (e) {
    if (e.reason === 'playlistNotFound' || e.status === 404) {
      await env.DB.prepare(`UPDATE channels SET enabled = 0, note = ?2 WHERE id = ?1`).bind(ch.id, 'Không đọc được danh sách video của kênh').run();
      return { job: 'scan', channel: ch.title, error: 'Kênh không đọc được, đã tắt' };
    }
    throw e;
  }
  const full = ch.full_done || done ? 1 : 0;
  await env.DB.prepare(`UPDATE channels SET page_token = ?2, full_done = ?3, last_scan = CASE WHEN ?4 = 1 THEN ?5 ELSE last_scan END,
      video_count = (SELECT COUNT(*) FROM videos WHERE channel_id = ?1), note = NULL WHERE id = ?1`)
    .bind(ch.id, ch.full_done ? null : (token || null), full, done ? 1 : 0, now).run();
  return { job: 'scan', channel: ch.title, mode: ch.full_done ? 'bổ sung' : 'toàn bộ', pages, seen, added, rejected, done };
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
    env.DB.prepare(`DELETE FROM meta WHERE (k LIKE 'units:%' OR k LIKE 'search:%') AND k NOT IN (?1, ?2)`).bind('units:' + run.day, 'search:' + run.day)
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
  const vers = keys.length ? ((await env.DB.prepare(`SELECT id, song_key, views FROM videos WHERE song_key IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(keys)).all()).results || []) : [];
  const pk = await picksById(env, vers.map(v => v.id), 0);
  const best = {}, cnt = {};
  vers.forEach(v => {
    cnt[v.song_key] = (cnt[v.song_key] || 0) + 1;
    const b = best[v.song_key], n = pk[v.id] || 0;
    if (!b || n > b.n || (n === b.n && v.views > b.views)) best[v.song_key] = { id: v.id, n, views: v.views };
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
function newRun() { return { units: 0, searches: 0, day: pacificDay(), used: 0, searchUsed: 0, quotaHit: false }; }
async function flush(env, run, c) {
  const st = [];
  const add = (k, n) => env.DB.prepare(`INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + ?2 AS TEXT)`).bind(k, n);
  if (run.units) st.push(add('units:' + run.day, run.units));
  if (run.searches) st.push(add('search:' + run.day, run.searches));
  if (run.quotaHit) st.push(env.DB.prepare(`INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind('units:' + run.day, String(c.budget)));
  if (run.searchQuotaHit) st.push(env.DB.prepare(`INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind('search:' + run.day, String(c.searchLimit)));
  if (st.length) await env.DB.batch(st);
}

async function tick(env, force) {
  const now = Date.now(), c = conf(env), run = newRun();
  const lk = await env.DB.prepare(`UPDATE meta SET v = ?1 WHERE k = 'lock' AND CAST(v AS INTEGER) < ?2`).bind(String(now), now - LOCK_MS).run();
  if (!lk.meta || !lk.meta.changes) return { job: 'busy', note: 'Một lượt chạy khác đang làm việc, thử lại sau ít phút' };
  let rep;
  try {
    const m = await metaGet(env, ['units:' + run.day, 'search:' + run.day, 'hot_at', 'tick']);
    run.used = +m['units:' + run.day] || 0; run.searchUsed = +m['search:' + run.day] || 0;
    const t = (+m.tick || 0) + 1;
    if (!force && run.used >= c.budget) rep = { job: 'idle', reason: 'Đã dùng hết trần ' + c.budget + ' đơn vị hôm nay' };
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
    rep = Object.assign(rep || {}, { at: now, units: run.units, searches: run.searches });
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

function parseChannelInput(s) {
  s = String(s || '').trim();
  let m = /(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/.exec(s);
  if (m) return { id: m[1] };
  m = /(?:^|youtube\.com\/)@([\w.\-·]{3,100})/.exec(s);
  if (m) return { forHandle: '@' + m[1] };
  return null;
}
const chOut = c => ({ id: c.id, title: c.title, handle: c.handle, enabled: !!c.enabled, order: c.order_mode, fullDone: !!c.full_done,
  lastScan: c.last_scan, videos: c.video_count, ytCount: c.yt_count, note: c.note || '' });

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
  const rows = (await env.DB.prepare(`SELECT v.id, v.title, v.channel, v.song_key, v.tone, v.views, v.duration FROM videos_fts JOIN videos v ON v.rid = videos_fts.rowid
      WHERE videos_fts MATCH ?1 ORDER BY rank LIMIT 300`).bind(match).all()).results || [];
  const pk = await picksById(env, rows.map(r => r.id), 0);
  const qn = words.join(' '), G = {};
  rows.forEach((r, i) => {
    const gk = r.song_key + '|' + (r.tone || ''), n = pk[r.id] || 0;
    const g = G[gk] = G[gk] || { key: r.song_key, tone: r.tone || '', versions: 0, picks: 0, maxViews: 0, best: null, bn: -1, pos: i };
    g.versions++; g.picks += n; g.maxViews = Math.max(g.maxViews, r.views || 0);
    if (n > g.bn || (n === g.bn && (r.views || 0) > (g.best.views || 0))) { g.best = r; g.bn = n; }
  });
  const nRows = rows.length || 1;
  return Object.values(G).map(g => ({
    key: g.key, tone: g.tone, versions: g.versions, picks: g.picks, best: vOut(g.best, g.bn),
    s: (g.key === qn ? 6 : g.key.startsWith(qn) ? 4 : g.key.includes(qn) ? 2 : 0) + (relaxed ? 4 : 1) * (1 - g.pos / nRows)
      + Math.log10(1 + g.maxViews) * 0.6 + Math.log2(1 + g.picks) * 1.5
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
const vOut = (r, n) => ({ id: r.id, title: r.title, channel: r.channel, tone: r.tone || '', views: r.views || 0, duration: r.duration || 0, picks: n || 0 });

async function handle(req, env, ctx) {
  const { ok, h } = cors(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (!ok) return J({ error: 'Origin không được phép', reason: 'origin' }, 403, h);
  const url = new URL(req.url), p = url.pathname.replace(/\/+$/, '');
  if (p === '' || p === '/') return J({ ok: true, app: 'kho-karaoke' }, 200, h);
  if (!env.APP_PASS || req.headers.get('x-pass') !== env.APP_PASS) return J({ error: 'Sai mật khẩu', reason: 'auth' }, 401, h);
  if (!env.DB) return J({ error: 'Worker chưa gắn D1 với tên DB' }, 500, h);
  const c = conf(env), run = newRun(), now = Date.now();
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const done = () => ctx.waitUntil(flush(env, run, c).catch(() => {}));
  try {
    /* ----- dùng cho remote.html ----- */
    if (p === '/api/kho/search' && req.method === 'GET') {
      return J({ groups: await groupSearch(env, url.searchParams.get('q') || '', Math.min(num(url.searchParams.get('limit'), 40), 80)) }, 200, h);
    }
    if (p === '/api/kho/versions' && req.method === 'GET') {
      const key = url.searchParams.get('key') || '', tone = url.searchParams.get('tone');
      const rows = (await env.DB.prepare(`SELECT id, title, channel, tone, views, duration FROM videos WHERE song_key = ?1 AND (?2 IS NULL OR tone = ?2) LIMIT 80`).bind(key, tone == null ? null : tone).all()).results || [];
      const pk = await picksById(env, rows.map(r => r.id), 0);
      const items = rows.map(r => vOut(r, pk[r.id])).sort((a, b) => b.picks - a.picks || b.views - a.views);
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
      if (!env.YT_KEY) return fallback('nokey');
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
    if (p === '/api/kho/pick' && req.method === 'POST') {
      const id = String(body.id || '');
      if (!ID_RE.test(id)) return J({ error: 'id không hợp lệ' }, 400, h);
      await env.DB.prepare(`INSERT INTO pick_log (id, ts) VALUES (?1, ?2)`).bind(id, now).run();
      const has = await env.DB.prepare(`SELECT 1 AS x FROM videos WHERE id = ?1 UNION SELECT 1 FROM rejected WHERE id = ?1`).bind(id).first();
      let added = 0;
      if (!has && env.YT_KEY) { try { added = (await fetchAndIngest(env, run, [id], now)).added; } catch (e) {} }   // bài mới anh tự tìm → bổ sung vào kho
      done();
      return J({ ok: true, added }, 200, h);
    }

    /* ----- quản trị (kho.html) ----- */
    if (p === '/api/kho/stats' && req.method === 'GET') {
      const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
      const [v, s, ch, hs, hq, pk] = await Promise.all([
        one(`SELECT COUNT(*) AS n FROM videos`), one(`SELECT COUNT(DISTINCT song_key) AS n FROM videos`),
        one(`SELECT COUNT(*) AS n, SUM(enabled) AS on_ FROM channels`), one(`SELECT COUNT(*) AS n FROM hot_songs`),
        one(`SELECT COUNT(*) AS n FROM hot WHERE song_key IS NULL AND searched = 0`), one(`SELECT COUNT(*) AS n FROM pick_log WHERE ts >= ?1`, now - 30 * DAY)
      ]);
      const m = await metaGet(env, ['units:' + run.day, 'search:' + run.day, 'last', 'hot_at']);
      let last = null; try { last = JSON.parse(m.last || 'null'); } catch (e) {}
      return J({ videos: v.n, songs: s.n, channels: ch.n, channelsOn: ch.on_ || 0, hotSongs: hs.n, hotPending: hq.n, picks30: pk.n,
        unitsToday: +m['units:' + run.day] || 0, searchesToday: +m['search:' + run.day] || 0, budget: c.budget, hotSearchPerDay: c.hotSearch,
        pagesPerTick: c.pages, hotAt: +m.hot_at || 0, last }, 200, h);
    }
    if (p === '/api/kho/run' && req.method === 'POST') {
      const job = ['auto', 'scan', 'refresh', 'hot', 'hotsearch', 'rehot'].includes(body.job) ? body.job : 'auto';
      const report = await tick(env, job);
      const st = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM channels WHERE enabled = 1 AND full_done = 0) AS pending,
          (SELECT COUNT(*) FROM videos) AS videos, (SELECT v FROM meta WHERE k = ?1) AS units`).bind('units:' + run.day).first();
      return J({ report, pending: st.pending, videos: st.videos, units: +st.units || 0, budget: c.budget }, 200, h);
    }
    if (p === '/api/kho/channels' && req.method === 'GET') {
      const rows = (await env.DB.prepare(`SELECT * FROM channels ORDER BY added_at`).all()).results || [];
      return J({ channels: rows.map(chOut) }, 200, h);
    }
    if (p === '/api/kho/channel/add' && req.method === 'POST') {
      const q = parseChannelInput(body.input);
      if (!q) return J({ error: 'Dán link kênh dạng youtube.com/@ten-kenh hoặc youtube.com/channel/UC…' }, 400, h);
      const d = await yt(env, run, 'channels', Object.assign({ part: 'snippet,contentDetails,statistics' }, q), 1);
      done();
      const it = (d.items || [])[0];
      if (!it) return J({ error: 'Không tìm thấy kênh' }, 404, h);
      const uploads = it.contentDetails && it.contentDetails.relatedPlaylists && it.contentDetails.relatedPlaylists.uploads;
      if (!uploads) return J({ error: 'Kênh không có danh sách video công khai' }, 400, h);
      await env.DB.prepare(`INSERT INTO channels (id, title, handle, uploads, enabled, order_mode, full_done, last_scan, video_count, yt_count, added_at)
          VALUES (?1, ?2, ?3, ?4, 1, 'song', 0, 0, 0, ?5, ?6)
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, handle = excluded.handle, uploads = excluded.uploads, yt_count = excluded.yt_count, enabled = 1`)
        .bind(it.id, String(it.snippet.title || '').slice(0, 100), String(it.snippet.customUrl || '').slice(0, 100), uploads, +(it.statistics || {}).videoCount || 0, now).run();
      return J({ ok: true, channel: { id: it.id, title: it.snippet.title, ytCount: +(it.statistics || {}).videoCount || 0 } }, 200, h);
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
    if (p === '/api/kho/channel/samples' && req.method === 'GET') {
      const rows = (await env.DB.prepare(`SELECT title, song_key, tone FROM videos WHERE channel_id = ?1 ORDER BY views DESC LIMIT 10`).bind(url.searchParams.get('id') || '').all()).results || [];
      return J({ items: rows }, 200, h);
    }
    if (p === '/api/kho/channel/update' && req.method === 'POST') {
      const id = String(body.id || '');
      const st = [];
      if (typeof body.enabled === 'boolean') st.push(env.DB.prepare(`UPDATE channels SET enabled = ?2, note = NULL WHERE id = ?1`).bind(id, body.enabled ? 1 : 0));
      if (body.order === 'song' || body.order === 'artist') {
        st.push(env.DB.prepare(`UPDATE channels SET order_mode = ?2 WHERE id = ?1`).bind(id, body.order));
        st.push(env.DB.prepare(`UPDATE videos SET song_key = CASE WHEN ?2 = 'artist' AND json_array_length(segs) > 1 THEN json_extract(segs,'$[1]') ELSE json_extract(segs,'$[0]') END WHERE channel_id = ?1`).bind(id, body.order));
      }
      if (body.rescan) st.push(env.DB.prepare(`UPDATE channels SET full_done = 0, page_token = NULL, enabled = 1 WHERE id = ?1`).bind(id));
      if (st.length) await env.DB.batch(st);
      return J({ ok: true }, 200, h);
    }
    if (p === '/api/kho/channel/remove' && req.method === 'POST') {
      const id = String(body.id || '');
      const st = [env.DB.prepare(`DELETE FROM channels WHERE id = ?1`).bind(id)];
      if (body.purge) st.unshift(
        env.DB.prepare(`DELETE FROM videos_fts WHERE rowid IN (SELECT rid FROM videos WHERE channel_id = ?1)`).bind(id),
        env.DB.prepare(`DELETE FROM videos WHERE channel_id = ?1`).bind(id));
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
