/* ============================================================
   Kênh phòng cho TV (index.html) và điện thoại (remote.html).
   - Trang mở có ?r=<mã> → nối WebSocket tới Worker bmb-phong (kênh riêng của phòng đó).
   - Không có ?r → dùng BroadcastChannel như cũ (cùng trình duyệt, để thử trên 1 máy).
   Cả hai kiểu đều có giao diện giống nhau: postMessage(), onmessage, và onroom() (chỉ kiểu WebSocket).
   ============================================================ */
(function(){
  const DEFAULT_PHONG_API = 'https://bmb-phong.vumanhhung85.workers.dev';
  const p = new URLSearchParams(location.search);
  const lsGet = k => { try{ return localStorage.getItem(k); }catch(e){ return null; } };
  const lsSet = (k, v) => { try{ localStorage.setItem(k, v); }catch(e){} };

  window.openRoomChannel = function(role, fallbackName){
    let token = (p.get('r') || '').trim();
    if(role === 'tv'){ if(token) lsSet('bmb_r_tv', token); else token = lsGet('bmb_r_tv') || ''; }   // TV nhớ mã, mở lại không cần liên kết dài
    if(!token){
      const bc = new BroadcastChannel('bmb-yt-' + fallbackName);
      bc.ws = false; bc.roomId = fallbackName; bc.onroom = null; bc.status = 'local';
      return bc;
    }
    const api = (p.get('api') || lsGet('phong_api') || DEFAULT_PHONG_API).replace(/\/+$/, '');
    const url = api.replace(/^http/, 'ws') + '/ws?role=' + (role === 'tv' ? 'tv' : 'remote') + '&r=' + encodeURIComponent(token);
    const ch = { ws: true, roomId: token.split('.')[0], onmessage: null, onroom: null, onstatus: null, status: 'connecting', last: null };
    let sock = null, tries = 0, timer = null, ping = null, stopped = false, waitedSince = 0;
    const setStatus = (s, info) => { ch.status = s; if(ch.onstatus) ch.onstatus(s, info); };
    function schedule(ms){ clearTimeout(timer); timer = setTimeout(connect, ms); }
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
        if(c === 4003){                                   // phòng chưa mở lúc quét: chờ nhân viên mở, thử lại tối đa 5 phút
          waitedSince = waitedSince || Date.now();
          if(Date.now() - waitedSince < 300000){ setStatus('waiting'); return schedule(6000); }
        }
        if(c === 4000 || c === 4001 || c === 4002 || c === 4004 || c === 4005 || c === 4003){
          stopped = true; setStatus(c === 4001 ? 'ended' : c === 4002 ? 'rotated' : c === 4004 ? 'network' : c === 4005 ? 'full' : c === 4000 ? 'replaced' : 'expired');
          return;
        }
        setStatus('offline'); tries++; schedule(Math.min(15000, 800 * Math.pow(1.7, tries)));
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
