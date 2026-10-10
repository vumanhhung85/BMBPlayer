/* ============================================================
   Màn quét QR dùng chung (quay.html gán TV, remote.html gán máy tính bảng)
   - Camera và ô nhập tay hiện CÙNG LÚC (không bắt chờ camera lỗi mới cho nhập).
   - Bộ giải mã: BarcodeDetector (Chrome Android) → jsQR (jsqr.min.js cùng thư mục) → chỉ nhập tay.
   Dùng: openQrScanner({ title, hint, manualPlaceholder, manualHint,
                         onResult: async (raw, typed) => true (xong, đóng) | 'lời báo lỗi' (quét tiếp) })
   ============================================================ */
(function(){
  const css = `
  #qsOv{position:fixed; inset:0; z-index:100; background:rgba(0,0,0,.88); display:flex; align-items:center; justify-content:center; padding:14px}
  #qsBox{width:min(440px,100%); background:#14141c; border:1px solid #2a2a3a; border-radius:16px; padding:14px; color:#f2f2f7; font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  #qsBox h3{margin:0 0 4px; font-size:18px}
  #qsBox .h{color:#9a9ab0; font-size:13px; margin-bottom:10px}
  #qsCam{position:relative; width:100%; aspect-ratio:1; background:#000; border-radius:12px; overflow:hidden}
  #qsCam video{width:100%; height:100%; object-fit:cover}
  #qsCam i{position:absolute; inset:18%; border:3px solid rgba(192,132,252,.9); border-radius:14px; box-shadow:0 0 0 999px rgba(0,0,0,.25)}
  #qsMsg{min-height:1.4em; margin:8px 0; font-size:14px; color:#fbbf24}
  #qsRow{display:flex; gap:8px}
  #qsIn{flex:1; min-width:0; background:#0e0e16; border:1px solid #2a2a3a; color:#f2f2f7; border-radius:10px; padding:11px 12px; font-size:18px; letter-spacing:.06em}
  #qsBox button{background:#20202e; border:1px solid #2a2a3a; color:#f2f2f7; border-radius:10px; padding:10px 14px; font-size:15px; font-weight:700}
  #qsBox button.p{background:linear-gradient(135deg,#7c3aed,#c084fc); border:none}
  #qsBox .mh{color:#9a9ab0; font-size:12px; margin-top:6px}
  #qsClose{width:100%; margin-top:10px}`;
  let S = null;

  function el(t, id, txt){ const e = document.createElement(t); if(id) e.id = id; if(txt != null) e.textContent = txt; return e; }
  function stop(){
    if(!S) return;
    clearInterval(S.tm); S.tm = null;
    if(S.stream) S.stream.getTracks().forEach(t => { try{ t.stop(); }catch(e){} });
    S.ov.remove(); S = null;
  }
  function msg(t, ok){ if(!S) return; S.m.textContent = t || ''; S.m.style.color = ok ? '#34d399' : '#fbbf24'; }
  function loadJsQR(){
    return new Promise(res => {
      if(window.jsQR) return res(true);
      const srcs = ['./jsqr.min.js', 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js'];
      (function go(i){
        if(i >= srcs.length) return res(false);
        const s = document.createElement('script'); s.src = srcs[i];
        s.onload = () => window.jsQR ? res(true) : go(i + 1); s.onerror = () => go(i + 1);
        document.head.append(s);
      })(0);
    });
  }
  async function hit(raw, typed){
    if(!S || S.busy) return;
    S.busy = true; clearInterval(S.tm); S.tm = null;
    msg('Đang kiểm tra…', true);
    let r;
    try{ r = await S.opt.onResult(String(raw || '').trim(), !!typed); }catch(e){ r = e.message || 'Mất kết nối, thử lại.'; }
    if(!S) return;
    S.busy = false;
    if(r === true){ stop(); return; }
    msg(typeof r === 'string' ? r : 'Mã không đúng, quét lại.');
    setTimeout(() => { if(S && !S.tm) loop(); }, 1500);
  }
  function loop(){
    if(!S || !S.engine) return;
    const v = S.v;
    if(S.engine === 'bd'){
      S.tm = setInterval(async () => {
        if(!S || S.busy || S.scan || !v.videoWidth) return;
        S.scan = true;
        try{ const c = await S.det.detect(v); if(S){ S.scan = false; if(c && c.length) hit(c[0].rawValue); } }
        catch(e){ if(S){ S.scan = false; if(++S.err >= 5){ clearInterval(S.tm); S.tm = null; useJsQR(); } } }
      }, 350);
    }else{
      const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
      S.tm = setInterval(() => {
        if(!S || S.busy || !v.videoWidth) return;
        try{
          const sc = Math.min(1, 520 / Math.max(v.videoWidth, v.videoHeight));
          cv.width = Math.round(v.videoWidth * sc); cv.height = Math.round(v.videoHeight * sc);
          cx.drawImage(v, 0, 0, cv.width, cv.height);
          const r = window.jsQR(cx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, { inversionAttempts: 'dontInvert' });
          if(r && r.data) hit(r.data);
        }catch(e){}
      }, 280);
    }
  }
  async function useJsQR(){
    if(!S) return;
    if(await loadJsQR()){ if(S){ S.engine = 'js'; loop(); } }
    else if(S){ S.engine = ''; msg('Máy này không tự đọc được mã QR — hãy nhập tay ở ô bên dưới.'); }
  }
  async function pickEngine(){
    if('BarcodeDetector' in window && BarcodeDetector.getSupportedFormats){
      try{
        const f = await BarcodeDetector.getSupportedFormats();
        if(f && f.includes('qr_code')){ S.det = new BarcodeDetector({ formats: ['qr_code'] }); S.engine = 'bd'; S.err = 0; return loop(); }
      }catch(e){}
    }
    useJsQR();
  }

  window.openQrScanner = async function(opt){
    stop();
    if(!document.getElementById('qsCss')){ const st = el('style', 'qsCss'); st.textContent = css; document.head.append(st); }
    const ov = el('div', 'qsOv'), box = el('div', 'qsBox');
    const cam = el('div', 'qsCam'), v = el('video'); v.setAttribute('playsinline', ''); v.muted = true; v.autoplay = true;
    cam.append(v, el('i'));
    const m = el('div', 'qsMsg');
    const row = el('div', 'qsRow'), inp = el('input', 'qsIn'), go = el('button', null, 'Xác nhận');
    inp.placeholder = opt.manualPlaceholder || 'Nhập mã'; inp.autocomplete = 'off'; inp.inputMode = opt.numeric ? 'numeric' : 'text';
    go.className = 'p'; row.append(inp, go);
    const close = el('button', 'qsClose', 'Đóng');
    box.append(el('h3', null, opt.title || 'Quét mã QR'), el('div', null, ''), cam, m, row);
    box.children[1].className = 'h'; box.children[1].textContent = opt.hint || '';
    if(opt.manualHint){ const mh = el('div', null, opt.manualHint); mh.className = 'mh'; box.append(mh); }
    box.append(close); ov.append(box); document.body.append(ov);
    S = { ov, v, m, opt, tm: null, busy: false, engine: '', stream: null };
    close.onclick = stop;
    const typed = () => { if(inp.value.trim()) hit(inp.value, true); };
    go.onclick = typed; inp.addEventListener('keydown', e => { if(e.key === 'Enter') typed(); });
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ msg('Trình duyệt không mở được camera — nhập tay ở ô bên dưới.'); return; }
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if(!S){ stream.getTracks().forEach(t => t.stop()); return; }
      S.stream = stream; v.srcObject = stream;
      try{ await v.play(); }catch(e){ v.addEventListener('click', () => v.play(), { once: true }); }
      pickEngine();
    }catch(e){
      msg(e && e.name === 'NotAllowedError' ? 'Chưa cho phép dùng camera — bấm biểu tượng ổ khoá trên thanh địa chỉ để cho phép, hoặc nhập tay.' : 'Không mở được camera — nhập tay ở ô bên dưới.');
    }
  };
  window.closeQrScanner = stop;
})();
