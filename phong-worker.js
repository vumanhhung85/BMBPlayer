/* ============================================================
   BMB Phòng — Worker "bmb-phong" (bản thử cho 1 phòng CN03)
   Thay cách tách phòng bằng wifi (SKPlayer) bằng cách tách phòng theo MÃ:
     - Mỗi phòng = 1 Durable Object (1 "kênh riêng"), TV và điện thoại nối WebSocket vào kênh đó.
     - TV vào bằng liên kết riêng (mã TV). Điện thoại khách vào bằng mã QR dán trên bàn (mã QR).
     - Phòng chỉ nhận điện thoại khi nhân viên bấm MỞ phòng. Bấm ĐÓNG phòng: ngắt hết điện thoại, xoá hàng chờ.
     - Đổi mã QR = mã cũ chết ngay (chụp ảnh QR cũ không dùng được nữa).
     - Tuỳ chọn kiểm mạng: điện thoại phải cùng địa chỉ mạng ra ngoài với TV (NET_CHECK = off | warn | on).
   Worker chỉ chuyển tin giữa TV và điện thoại; không chạm YouTube, không tải video.

   Cần cấu hình (xem phong-README.md):
     Secret : SECRET (chuỗi ngẫu nhiên dài, ký mã QR/TV), APP_PASS (mật khẩu nhân viên),
              GUEST_SECRET (chuỗi ngẫu nhiên, đặt GIỐNG HỆT ở Worker kho-karaoke: để điện thoại khách tìm bài không cần mật khẩu)
     Biến   : ALLOWED_ORIGINS (mặc định https://bmbplayer.boommusicbox.vn), NET_CHECK (mặc định off)
     Binding: Durable Object ROOM → class Room ; REG → class Registry
   ============================================================ */
import { DurableObject } from 'cloudflare:workers';

const enc = new TextEncoder();
const ID_RE = /^[A-Z0-9]{2,8}-[A-Z0-9]{1,10}$/;
const TOKEN_RE = /^([A-Z0-9]{2,8}-[A-Z0-9]{1,10})\.(\d{1,6})\.([\w-]{22})$/;
const ACTIONS = new Set(['add', 'play', 'next', 'replay', 'mute', 'vol', 'prio', 'remove', 'hello']);
const MAX_MSG = 4096, MAX_STATE = 32768, MAX_REMOTES = 12, RATE_PER_SEC = 15;

/* ---------- Mã ---------- */
const b64u = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, text){
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)))).slice(0, 22);
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
const json = (data, status, extra) => new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || {}) });
function netKey(ip){                                   // IPv6: so theo 4 nhóm đầu (cùng /64), IPv4: cả địa chỉ
  ip = String(ip || '');
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
}

/* ============================================================
   Registry — danh sách phòng (1 bản duy nhất)
   ============================================================ */
export class Registry extends DurableObject {
  async fetch(req){
    const u = new URL(req.url);
    if(u.pathname === '/list'){
      const m = await this.ctx.storage.list({ prefix: 'r:' });
      return json({ rooms: [...m.values()].sort((a, b) => a.id < b.id ? -1 : 1) });
    }
    const body = await req.json().catch(() => ({}));
    if(u.pathname === '/add'){
      const id = String(body.id || '');
      if(!ID_RE.test(id)) return json({ error: 'Mã phòng chỉ gồm chữ HOA/số, dạng CN03-P01' }, 400);
      if(await this.ctx.storage.get('r:' + id)) return json({ error: 'Phòng này đã có' }, 409);
      const room = { id, branch: String(body.branch || '').slice(0, 40), name: String(body.name || '').slice(0, 40), created: Date.now() };
      await this.ctx.storage.put('r:' + id, room);
      return json({ room });
    }
    if(u.pathname === '/del'){ await this.ctx.storage.delete('r:' + String(body.id || '')); return json({ ok: true }); }
    return json({ error: 'not found' }, 404);
  }
}

/* ============================================================
   Room — kênh riêng của 1 phòng
   ============================================================ */
export class Room extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async cfg(){
    const m = await this.ctx.storage.get(['open', 'since', 'session', 'genQ', 'genT', 'tvIp']);
    return { open: !!m.get('open'), since: m.get('since') || 0, session: m.get('session') || 0, genQ: m.get('genQ') || 1, genT: m.get('genT') || 1, tvIp: m.get('tvIp') || '' };
  }
  sockets(role){
    const l = this.ctx.getWebSockets(role);
    return role === 'remote' ? l.filter(w => (w.deserializeAttachment() || {}).ok) : l;   // điện thoại chỉ tính sau khi qua kiểm tra lúc 'sync'
  }
  async roomMsg(c, extra){
    c = c || await this.cfg();
    const remotes = this.sockets('remote');
    return Object.assign({ type: 'room', open: c.open, since: c.since, session: c.session, tv: this.sockets('tv').length > 0, remotes: remotes.length }, extra || {});
  }
  async broadcastRoom(){
    const c = await this.cfg(), msg = JSON.stringify(await this.roomMsg(c));
    for(const ws of this.ctx.getWebSockets()){ try{ ws.send(msg); }catch(e){} }
  }

  async fetch(req){
    const u = new URL(req.url);
    if(u.pathname === '/ws') return this.connect(req, u);
    if(u.pathname === '/status'){
      const c = await this.cfg(), net = this.env.NET_CHECK || 'off';
      let off = 0;
      for(const ws of this.sockets('remote')){ const a = ws.deserializeAttachment() || {}; if(a.off) off++; }
      return json(Object.assign({ remotes: this.sockets('remote').length, tv: this.sockets('tv').length > 0, net, offNet: off }, c, { tvIp: undefined }));
    }
    const body = await req.json().catch(() => ({}));
    if(u.pathname === '/open'){
      const c = await this.cfg();
      if(!c.open){ await this.ctx.storage.put({ open: true, since: Date.now(), session: c.session + 1 }); await this.ctx.storage.delete('last'); }
      await this.broadcastRoom(); return json(await this.roomMsg());
    }
    if(u.pathname === '/close'){
      const c = await this.cfg();
      await this.ctx.storage.put({ open: false, since: 0, session: c.session + 1 });
      await this.ctx.storage.delete('last');
      const msg = JSON.stringify(await this.roomMsg(null, { reason: 'closed' }));
      for(const ws of this.sockets('tv')){ try{ ws.send(msg); }catch(e){} }
      for(const ws of this.ctx.getWebSockets('remote')){ try{ ws.send(msg); ws.close(4001, 'closed'); }catch(e){} }
      return json({ ok: true });
    }
    if(u.pathname === '/rotate'){
      const kind = body.kind === 'tv' ? 'tv' : 'qr', c = await this.cfg();
      if(kind === 'tv'){ await this.ctx.storage.put('genT', c.genT + 1); for(const ws of this.sockets('tv')){ try{ ws.close(4002, 'rotated'); }catch(e){} } }
      else { await this.ctx.storage.put('genQ', c.genQ + 1); for(const ws of this.ctx.getWebSockets('remote')){ try{ ws.close(4002, 'rotated'); }catch(e){} } }
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }

  async connect(req, u){
    if(req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const role = u.searchParams.get('role') === 'tv' ? 'tv' : 'remote';
    const t = parseToken(u.searchParams.get('r')), c = await this.cfg();
    const kind = role === 'tv' ? 'tv' : 'qr', gen = role === 'tv' ? c.genT : c.genQ;
    const ok = t && t.gen === gen && same(t.sig, await hmac(this.env.SECRET, t.id + '|' + kind + '|' + gen));
    if(!ok) return new Response('bad token', { status: 403 });
    const ip = req.headers.get('CF-Connecting-IP') || '';
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);

    if(role === 'tv'){
      for(const old of this.sockets('tv')){ try{ old.send(JSON.stringify({ type: 'room', open: c.open, replaced: true })); old.close(4000, 'replaced'); }catch(e){} }
      this.ctx.acceptWebSocket(server, ['tv']);
      server.serializeAttachment({ role, ip, id: t.id, n: 0, t: 0 });
      await this.ctx.storage.put('tvIp', netKey(ip));
      c.tvIp = netKey(ip);
    }else{
      this.ctx.acceptWebSocket(server, ['remote']);
      server.serializeAttachment({ role, ip, id: t.id, n: 0, t: 0, ok: false });   // chưa cho vào: chờ 'sync' mới kiểm phòng mở / mạng / số máy
      return new Response(null, { status: 101, webSocket: client });
    }
    await this.broadcastRoom();                          // báo số máy đang nối cho mọi bên (kể cả máy mới)
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data){
    if(typeof data !== 'string' || data.length > MAX_STATE) return;
    if(data === 'sync'){                                 // máy vừa nối xong xin: tình trạng phòng (+ vé khách) và trạng thái gần nhất của TV
      const a0 = ws.deserializeAttachment() || {}, c = await this.cfg();
      if(a0.role === 'remote' && !a0.ok){
        const net = this.env.NET_CHECK || 'off', off = net !== 'off' && c.tvIp && netKey(a0.ip) !== c.tvIp;
        const deny = !c.open ? [4003, 'notopen'] : (off && net === 'on') ? [4004, 'network'] : this.sockets('remote').length >= MAX_REMOTES ? [4005, 'full'] : null;
        if(deny){ try{ ws.send(JSON.stringify(await this.roomMsg(c, { id: a0.id, reason: deny[1] }))); ws.close(deny[0], deny[1]); }catch(e){} return; }
        a0.ok = true; a0.off = !!off; ws.serializeAttachment(a0);
        await this.broadcastRoom();
      }
      ws.send(JSON.stringify(await this.roomMsg(c, a0.role === 'remote' ? { id: a0.id, you: 'remote', gt: c.open ? await guestTicket(this.env, a0.id) : '' } : { id: a0.id, you: 'tv' })));
      if(a0.role === 'remote'){ const last = await this.ctx.storage.get('last'); if(last) ws.send(last); }
      return;
    }
    const a = ws.deserializeAttachment() || {}, now = Date.now();
    if(now - (a.t || 0) < 1000){ a.n = (a.n || 0) + 1; } else { a.n = 1; a.t = now; }
    ws.serializeAttachment(a);
    if(a.n > RATE_PER_SEC) return;
    let m; try{ m = JSON.parse(data); }catch(e){ return; }
    if(!m || typeof m !== 'object') return;

    if(a.role === 'remote'){
      if(!a.ok || data.length > MAX_MSG || m.type !== 'cmd') return;
      const c = await this.cfg(); if(!c.open) return;
      const p = m.payload || {}; if(!ACTIONS.has(p.action)) return;
      const out = { action: p.action };
      if(p.action === 'add'){
        if(!/^[\w-]{11}$/.test(p.id || '')) return;
        out.id = p.id; out.title = String(p.title || 'Bài không tên').slice(0, 200);
      }else if(p.action === 'vol'){ out.value = Math.max(0, Math.min(100, +p.value || 0));
      }else if(p.action === 'prio' || p.action === 'remove'){ out.index = Math.max(0, Math.min(500, +p.index | 0)); }
      const msg = JSON.stringify({ type: 'cmd', payload: out });
      for(const tv of this.sockets('tv')){ try{ tv.send(msg); }catch(e){} }
      return;
    }
    /* từ TV */
    if(m.type === 'state'){
      const c = await this.cfg(); if(!c.open) return;
      await this.ctx.storage.put('last', data);
      for(const r of this.sockets('remote')){ try{ r.send(data); }catch(e){} }
    }else if(m.type === 'dead'){
      for(const r of this.sockets('remote')){ try{ r.send(data); }catch(e){} }
    }
  }
  async webSocketClose(ws, code, reason){ try{ ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); }catch(e){} await this.broadcastRoom(); }
  async webSocketError(ws){ try{ ws.close(1011, 'error'); }catch(e){} await this.broadcastRoom(); }
}

/* ============================================================
   Cổng vào
   ============================================================ */
const roomStub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));
const regStub = env => env.REG.get(env.REG.idFromName('registry'));
const call = (stub, path, body) => stub.fetch('https://do' + path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());

export default {
  async fetch(req, env){
    const u = new URL(req.url), ch = cors(req, env);
    if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });
    if(!env.SECRET || !env.APP_PASS) return json({ error: 'Worker chưa đặt SECRET / APP_PASS' }, 500, ch);

    /* Kết nối WebSocket của TV / điện thoại */
    if(u.pathname === '/ws'){
      const o = req.headers.get('Origin');
      if(!o || !origins(env).includes(o)) return new Response('origin', { status: 403 });
      const t = parseToken(u.searchParams.get('r'));
      if(!t) return new Response('bad token', { status: 403 });
      return roomStub(env, t.id).fetch(req);
    }

    /* Phần còn lại: chỉ nhân viên (x-pass) */
    if(!u.pathname.startsWith('/api/phong/')) return json({ error: 'not found' }, 404, ch);
    if(!same(req.headers.get('x-pass') || '', env.APP_PASS)) return json({ error: 'Sai mật khẩu' }, 401, ch);
    const act = u.pathname.slice('/api/phong/'.length);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const id = String(body.id || '');

    if(act === 'list'){
      const { rooms } = await call(regStub(env), '/list');
      const out = await Promise.all(rooms.map(async r => {
        const st = await call(roomStub(env, r.id), '/status');
        return Object.assign({}, r, st, { tokQr: await mkToken(env, r.id, 'qr', st.genQ), tokTv: await mkToken(env, r.id, 'tv', st.genT) });
      }));
      return json({ rooms: out, net: env.NET_CHECK || 'off' }, 200, ch);
    }
    if(act === 'tao'){
      const branch = String(body.branch || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), name = String(body.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const r = await regStub(env).fetch('https://do/add', { method: 'POST', body: JSON.stringify({ id: branch + '-' + name, branch, name }) });
      return json(await r.json(), r.status, ch);
    }
    if(!ID_RE.test(id)) return json({ error: 'Thiếu mã phòng' }, 400, ch);
    if(act === 'mo') return json(await call(roomStub(env, id), '/open', {}), 200, ch);
    if(act === 'dong') return json(await call(roomStub(env, id), '/close', {}), 200, ch);
    if(act === 'doima') return json(await call(roomStub(env, id), '/rotate', { kind: body.kind }), 200, ch);
    if(act === 'xoa'){ await call(roomStub(env, id), '/close', {}); await call(regStub(env), '/del', { id }); return json({ ok: true }, 200, ch); }
    return json({ error: 'not found' }, 404, ch);
  }
};
