/* ============================================================
   Kênh phòng cho TV (index.html), máy tính bảng và điện thoại khách (remote.html).
   - TV: mở có ?r=<mã TV> hoặc đã nhớ mã (gán bằng mã 6 số ở quay.html) → nối WebSocket tới Worker bmbplayer.
   - Điện thoại khách: mở có ?r=<QR khách đang hiện trên TV>.
   - Máy tính bảng: không có ?r nhưng đã được gán (nhớ mã máy tính bảng) → tự theo phòng qua mọi lượt mở/đóng.
   - Không có mã nào → BroadcastChannel như cũ (cùng trình duyệt, để thử trên 1 máy).
   Mọi kiểu đều có giao diện giống nhau: postMessage(), onmessage, và onroom()/onstatus() (chỉ kiểu WebSocket).
   ============================================================ */
(function(){
  const DEFAULT_API = 'https://bmbplayer.vumanhhung85.workers.dev';     // Worker gộp bmbplayer
  const p = new URLSearchParams(location.search);
  const lsGet = k => { try{ return localStorage.getItem(k); }catch(e){ return null; } };
  const lsSet = (k, v) => { try{ localStorage.setItem(k, v); }catch(e){} };
  const lsDel = k => { try{ localStorage.removeItem(k); }catch(e){} };
  if(p.get('api')) lsSet('bmb_api', p.get('api').replace(/\/+$/, ''));
  window.phongApi = () => (p.get('api') || lsGet('bmb_api') || DEFAULT_API).replace(/\/+$/, '');
  window.TB_KEY = 'bmb_r_tb'; window.TV_KEY = 'bmb_r_tv';

  window.openRoomChannel = function(role, fallbackName){
    let token = (p.get('r') || '').trim();
    if(role === 'tv'){ if(token) lsSet(TV_KEY, token); else token = lsGet(TV_KEY) || ''; }   // TV nhớ mã, mở lại không cần liên kết
    else if(!token && lsGet(TB_KEY)){ role = 'tablet'; token = lsGet(TB_KEY); }             // máy tính bảng đã gán phòng
    if(!token){
      const bc = new BroadcastChannel('bmb-yt-' + fallbackName);
      bc.ws = false; bc.roomId = fallbackName; bc.onroom = null; bc.status = 'local'; bc.role = role;
      return bc;
    }
    const api = phongApi(), wsRole = role === 'tv' ? 'tv' : role === 'tablet' ? 'tablet' : 'remote';
    const url = api.replace(/^http/, 'ws') + '/ws?role=' + wsRole + '&r=' + encodeURIComponent(token);
    const persistent = wsRole !== 'remote';               // TV và máy tính bảng: luôn chờ / nối lại, không bỏ cuộc
    const ch = { ws: true, role: wsRole, tablet: wsRole === 'tablet', token, roomId: token.split('.')[0], onmessage: null, onroom: null, onstatus: null, status: 'connecting', last: null };
    let sock = null, tries = 0, timer = null, ping = null, stopped = false, waitedSince = 0, checking = false;
    const setStatus = (s, info) => { ch.status = s; if(ch.onstatus) ch.onstatus(s, info); };
    function schedule(ms){ clearTimeout(timer); timer = setTimeout(connect, ms); }
    function dead(){                                     // mã bị đổi (gán TV/máy tính bảng khác): quên mã, báo trang
      stopped = true;
      if(wsRole === 'tv') lsDel(TV_KEY); else if(wsRole === 'tablet') lsDel(TB_KEY);
      setStatus('rotated');
    }
    /* Mã hết hiệu lực trong lúc máy tắt thì Worker từ chối ngay ở bước nối (trình duyệt chỉ thấy "mất kết nối"):
       sau vài lần không nối được, hỏi Worker xem mã còn dùng được không. */
    async function checkToken(){
      if(checking || !persistent) return; checking = true;
      try{
        const r = await fetch(api + '/api/tokcheck', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ r: token, role: wsRole }) });
        if(r.ok){ const d = await r.json(); if(d.valid === false) dead(); }
      }catch(e){}
      checking = false;
    }
    function connect(){
      if(stopped) return;
      setStatus('connecting');
      try{ sock = new WebSocket(url); }catch(e){ return schedule(5000); }
      sock.onopen = () => { tries = 0; try{ sock.send('sync'); }catch(e){} clearInterval(ping); ping = setInterval(() => { try{ sock.send('ping'); }catch(e){} }, 25000); };
      sock.onmessage = ev => {
        if(ev.data === 'pong') return;
        let m; try{ m = JSON.parse(ev.data); }catch(e){ return; }
        if(m.type === 'room'){
          ch.last = m; setStatus(m.open ? 'open' : 'closed', m);
          if(ch.onroom) ch.onroom(m);
          return;
        }
        if(ch.onmessage) ch.onmessage({ data: m });
      };
      sock.onclose = ev => {
        clearInterval(ping);
        if(stopped) return;
        const c = ev.code;
        if(c === 4002 && persistent) return dead();
        if(c === 4003){                                   // khách quét lúc phòng chưa mở: chờ nhân viên mở, thử lại tối đa 5 phút
          waitedSince = waitedSince || Date.now();
          if(Date.now() - waitedSince < 300000){ setStatus('waiting'); return schedule(6000); }
        }
        if(c === 4000 || c === 4001 || c === 4002 || c === 4004 || c === 4005 || c === 4003){
          stopped = true; setStatus(c === 4001 ? 'ended' : c === 4002 ? 'rotated' : c === 4004 ? 'network' : c === 4005 ? 'full' : c === 4000 ? 'replaced' : 'expired');
          return;
        }
        setStatus('offline'); tries++;
        if(tries === 3 || tries % 10 === 0) checkToken();
        schedule(Math.min(15000, 800 * Math.pow(1.7, tries)));
      };
      sock.onerror = () => {};
    }
    ch.postMessage = msg => { if(sock && sock.readyState === 1) sock.send(JSON.stringify(msg)); };
    ch.close = () => { stopped = true; try{ sock.close(); }catch(e){} };
    document.addEventListener('visibilitychange', () => {   // điện thoại ngủ máy rồi mở lại: nối lại ngay
      if(document.visibilityState === 'visible' && !stopped && (!sock || sock.readyState > 1)) schedule(100);
    });
    connect();
    return ch;
  };
})();
