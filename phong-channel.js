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
    /* Điện thoại khách gửi kèm mã máy (cùng mã bmb_dev của gọi lễ tân): máy nối lại thì Worker đóng socket cũ của chính máy đó,
       không để socket "ma" chiếm chỗ làm phòng báo đủ số điện thoại */
    let dev = '';
    if(wsRole === 'remote'){ dev = lsGet('bmb_dev') || ''; if(!dev){ dev = 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); lsSet('bmb_dev', dev); } }
    const url = api.replace(/^http/, 'ws') + '/ws?role=' + wsRole + '&r=' + encodeURIComponent(token) + (dev ? '&d=' + encodeURIComponent(dev) : '');
    const persistent = wsRole !== 'remote';               // TV và máy tính bảng: luôn chờ / nối lại, không bỏ cuộc
    const ch = { ws: true, role: wsRole, tablet: wsRole === 'tablet', token, roomId: token.split('.')[0], onmessage: null, onroom: null, onstatus: null, status: 'connecting', last: null };
    let sock = null, tries = 0, timer = null, ping = null, stopped = false, waitedSince = 0, checking = false, lastRx = Date.now();
    /* Chẩn đoán phía máy: máy tự biết vì sao mất kết nối (thiết bị báo offline? tab ẩn? socket chết ngầm?), mất bao lâu, ping bao nhiêu ms, loại mạng.
       Lần nối lại thành công kế tiếp, máy gửi 1 tin {type:'dg'} → Worker ghi vào nhật ký (tab 🔌 Kết nối của admin). Không gửi lúc kết nối bình thường. */
    let loss = null, pingT = 0; const rtts = [];
    const markLoss = (why, at) => { if(loss) return; loss = { at: at || Date.now(), why, on: navigator.onLine !== false, hid: !!document.hidden, tries: 0 }; };
    const netInfo = () => { const c = navigator.connection || {}; return { net: c.effectiveType || '', nrtt: c.rtt, dl: c.downlink, ty: c.type || '' }; };
    const sendDiag = () => {
      if(!loss) return; const l = loss; loss = null;
      const a = rtts.length ? Math.round(rtts.reduce((x, y) => x + y, 0) / rtts.length) : undefined, mx = rtts.length ? Math.max.apply(null, rtts) : undefined;
      try{ sock.send(JSON.stringify({ type: 'dg', d: Object.assign({ down: Date.now() - l.at, why: l.why, tries: l.tries, on: l.on ? 1 : 0, hid: l.hid ? 1 : 0, rtt: a, rttMax: mx }, netInfo()) })); }catch(e){}
    };
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
      if(checking) return; checking = true;
      try{
        const r = await fetch(api + '/api/tokcheck', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ r: token, role: wsRole }) });
        if(r.ok){ const d = await r.json(); if(d.valid === false){
          if(persistent) dead();
          else{ stopped = true; clearTimeout(timer); setStatus('rotated'); }   // điện thoại khách giữ mã QR lượt trước: dừng hẳn, không nối lại mãi (mỗi lần nối tốn 1 lượt Worker + Durable Object + D1)
        } }
      }catch(e){}
      checking = false;
    }
    function connect(){
      if(stopped) return;
      setStatus('connecting');
      try{ sock = new WebSocket(url); }catch(e){ return schedule(5000); }
      sock.onopen = () => { if(loss) loss.tries = tries; tries = 0; lastRx = Date.now(); try{ sock.send('sync'); }catch(e){} sendDiag(); clearInterval(ping);
        ping = setInterval(() => {
          if(Date.now() - lastRx > 100000) return recycle();             // 100 giây không nhận được gì (kể cả 'pong' 25 giây/lần): socket đã chết ngầm → nối lại
          pingT = Date.now(); try{ sock.send('ping'); }catch(e){}
        }, 25000); };
      sock.onmessage = ev => {
        lastRx = Date.now();
        if(ev.data === 'pong'){ if(pingT){ rtts.push(Date.now() - pingT); if(rtts.length > 12) rtts.shift(); pingT = 0; } return; }
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
        if(c === 4006){ stopped = true; setStatus('dup'); return; }        // cùng máy vừa mở phòng ở tab/lần nối khác → tab này nhường
        if(c === 4003){                                   // khách quét lúc phòng chưa mở: chờ nhân viên mở, thử lại tối đa 5 phút
          waitedSince = waitedSince || Date.now();
          if(Date.now() - waitedSince < 300000){ setStatus('waiting'); return schedule(6000); }
        }
        if(c === 4000 || c === 4001 || c === 4002 || c === 4004 || c === 4005 || c === 4003){
          stopped = true; setStatus(c === 4001 ? 'ended' : c === 4002 ? 'rotated' : c === 4004 ? 'network' : c === 4005 ? 'full' : c === 4000 ? 'replaced' : 'expired');
          return;
        }
        markLoss('close:' + c);
        setStatus('offline'); tries++;
        if(tries === 3 || tries % 10 === 0) checkToken();
        schedule(Math.min(15000, 800 * Math.pow(1.7, tries)));
      };
      sock.onerror = () => {};
    }
    /* Socket chết ngầm (điện thoại ngủ máy / đổi mạng: trình duyệt vẫn báo 'đang nối' nhưng không còn tin nào tới): bỏ và nối lại.
       Máy khác đổi trạng thái (tắt tiếng, dừng nhạc...) mà máy này không nhận được thì icon bị lệch thực tế. */
    function recycle(){ markLoss('silent', lastRx); clearInterval(ping); const s = sock; try{ s.onclose = null; s.close(); }catch(e){} setStatus('offline'); schedule(200); }
    function probe(){
      if(stopped) return;
      if(!sock || sock.readyState > 1){ schedule(100); return; }
      if(sock.readyState !== 1) return;
      const s0 = sock, t0 = Date.now();
      pingT = Date.now(); try{ s0.send('sync'); s0.send('ping'); }catch(e){}                   // xin lại trạng thái mới nhất + thử xem còn sống không
      setTimeout(() => { if(!stopped && sock === s0 && lastRx < t0) recycle(); }, 4000);
    }
    window.addEventListener('online', probe);
    ch.postMessage = msg => { if(sock && sock.readyState === 1) sock.send(JSON.stringify(msg)); };
    ch.close = () => { stopped = true; try{ sock.close(); }catch(e){} };
    document.addEventListener('visibilitychange', () => {   // điện thoại ngủ máy rồi mở lại: nối lại ngay (hoặc làm tươi trạng thái nếu còn nối)
      if(document.visibilityState === 'visible') probe();
    });
    connect();
    return ch;
  };
})();
