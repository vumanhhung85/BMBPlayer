/* BMBPlayer APK 3.0 — lớp tương thích cho TV có Android System WebView cũ (bản 64–85, vd Android 9 gốc = WebView 66,
   TV không có CH Play nên không cập nhật được). APK chèn tệp này vào đầu trang (chỉ khi WebView < 86), trang trên máy chủ không đổi.
   Viết kiểu ES5 để chạy được trên WebView cũ.
   1) Bù hàm JS mới: Element.replaceChildren (Chrome 86).
   2) Viết lại CSS trong các thẻ <style>: inset (87), clamp()/min()/max() (79), aspect-ratio (88), gap của flex (84). */
(function () {
  'use strict';
  if (window.__bmbCompat) return;
  window.__bmbCompat = 1;

  // ---------- 1) Hàm JS ----------
  function addRC(proto) {
    if (!proto || proto.replaceChildren) return;
    proto.replaceChildren = function () {
      while (this.lastChild) this.removeChild(this.lastChild);
      for (var i = 0; i < arguments.length; i++) {
        var n = arguments[i];
        this.appendChild(n instanceof Node ? n : document.createTextNode(String(n)));
      }
    };
  }
  try { addRC(Element.prototype); addRC(Document.prototype); addRC(DocumentFragment.prototype); } catch (e) {}
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (a, b) {
      if (a instanceof RegExp) return this.replace(a, b);
      return this.split(String(a)).join(typeof b === 'function' ? b(a) : b);
    };
  }
  if (!window.queueMicrotask) window.queueMicrotask = function (f) { Promise.resolve().then(f); };
  if (!window.globalThis) window.globalThis = window;

  // ---------- 2) CSS ----------
  var UNIT = /(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?)(px|vw|vh|vmin|vmax|rem|em|pt|%)?/gi;

  /** Đổi một biểu thức (không còn ngoặc lồng) ra số px; trả null nếu có thứ không quy đổi được (%, var…). */
  function px(expr) {
    var W = window.innerWidth || document.documentElement.clientWidth || 1280;
    var H = window.innerHeight || document.documentElement.clientHeight || 720;
    var bad = false;
    var s = String(expr).replace(UNIT, function (all, n, u) {
      var v = parseFloat(n);
      u = (u || '').toLowerCase();
      if (u === 'px' || u === '') return '(' + v + ')';
      if (u === 'vw') return '(' + v * W / 100 + ')';
      if (u === 'vh') return '(' + v * H / 100 + ')';
      if (u === 'vmin') return '(' + v * Math.min(W, H) / 100 + ')';
      if (u === 'vmax') return '(' + v * Math.max(W, H) / 100 + ')';
      if (u === 'rem' || u === 'em') return '(' + v * 16 + ')';
      if (u === 'pt') return '(' + v * 4 / 3 + ')';
      bad = true; return '0';
    });
    if (bad || /[^\d\s.+\-*/()e]/i.test(s)) return null;
    try { var r = Function('return (' + s + ')')(); return isFinite(r) ? r : null; } catch (e) { return null; }
  }

  function splitArgs(s) {           // tách theo dấu phẩy cấp ngoài cùng
    var out = [], d = 0, cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(') d++; else if (c === ')') d--;
      if (c === ',' && d === 0) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out.map(function (x) { return x.trim(); });
  }

  /** Thay clamp()/min()/max() (kể cả calc() bên trong) bằng giá trị px tính theo cỡ màn hình hiện tại. */
  function fixFuncs(css) {
    var re = /\b(clamp|min|max|calc)\(([^()]*)\)/i, guard = 0, m;
    while ((m = re.exec(css)) && guard++ < 5000) {
      var name = m[1].toLowerCase(), args = splitArgs(m[2]), rep;
      var nums = args.map(px);
      var ok = nums.every(function (n) { return n !== null; });
      if (name === 'calc') {
        rep = ok ? (+nums[0].toFixed(2)) + 'px' : 'CALC\u0001(' + m[2] + ')';      // calc hợp lệ trên WebView cũ: giữ nguyên
      } else if (name === 'clamp') {
        rep = ok && nums.length === 3 ? (+Math.max(nums[0], Math.min(nums[1], nums[2])).toFixed(2)) + 'px'
            : (args.length === 3 ? 'CALC\u0001(' + args[1] + ')' : args[0]);
      } else {
        rep = ok ? (+Math[name].apply(Math, nums).toFixed(2)) + 'px' : args[0];
      }
      css = css.slice(0, m.index) + rep + css.slice(m.index + m[0].length);
    }
    return css.replace(/CALC\u0001\(/g, 'calc(');
  }

  function fixInset(decls) {
    return decls.replace(/(^|[;{\s])inset\s*:\s*([^;}]+)/gi, function (all, pre, v) {
      var imp = /!important/i.test(v) ? ' !important' : '';
      var p = v.replace(/!important/i, '').trim().split(/\s+/);
      var t = p[0], r = p[1] || t, b = p[2] || t, l = p[3] || r;
      return pre + 'top:' + t + imp + ';right:' + r + imp + ';bottom:' + b + imp + ';left:' + l + imp;
    });
  }

  function decl(decls, prop) {
    var m = new RegExp('(?:^|[;\\s])' + prop + '\\s*:\\s*([^;}]+)', 'i').exec(decls);
    return m ? m[1].replace(/!important/i, '').trim() : null;
  }

  /** Xử lý từng khối "bộ chọn { khai báo }": inset, aspect-ratio, gap của flex (gap của grid WebView 66 đã hiểu). */
  function fixBlocks(css, extra) {
    return css.replace(/([^{}]+)\{([^{}]*)\}/g, function (all, sel, d) {
      var s = sel.trim();
      if (/^@|^(from|to|\d+(\.\d+)?%)\s*(,|$)/i.test(s)) return all;
      d = fixInset(d);
      var ar = decl(d, 'aspect-ratio'), w = decl(d, 'width');
      if (ar && w && !decl(d, 'height')) {
        var q = ar.split('/'), ratio = parseFloat(q[0]) / (parseFloat(q[1]) || 1);
        var wpx = px(w);
        if (ratio > 0) d += ';height:' + (wpx !== null ? (+(wpx / ratio).toFixed(2)) + 'px' : 'calc(' + w + ' / ' + ratio + ')');
      }
      var gap = decl(d, 'gap'), disp = decl(d, 'display') || '';
      if (gap && !/grid/i.test(disp)) {
        var g = gap.split(/\s+/), col = /column/i.test(decl(d, 'flex-direction') || '');
        var sp = col ? g[0] : (g[1] || g[0]);
        var sels = s.split(',').map(function (x) { return x.trim() + ' > * + *'; }).join(',');
        extra.push(sels + '{margin-' + (col ? 'top' : 'left') + ':' + sp + '}');
      }
      return sel + '{' + d + '}';
    });
  }

  function fixCss(text) {
    var extra = [];
    var out = fixBlocks(fixFuncs(text), extra);
    // Luật bù gap đặt ĐẦU tệp để các luật riêng của trang (margin của từng phần tử) vẫn thắng khi cùng độ ưu tiên
    return (extra.length ? '/* bmb-compat gap */\n' + extra.join('\n') + '\n' : '') + out;
  }

  var styles = [];
  function run() {
    var list = document.querySelectorAll('style');
    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      if (st.__bmbOrig == null) { st.__bmbOrig = st.textContent; styles.push(st); }
    }
    for (var j = 0; j < styles.length; j++) {
      try { styles[j].textContent = fixCss(styles[j].__bmbOrig); } catch (e) {}
    }
  }
  window.__bmbCompatCss = fixCss;            // để thử nghiệm

  var t = 0, lastW = 0, lastH = 0;
  function onResize() {
    if (window.innerWidth === lastW && window.innerHeight === lastH) return;
    lastW = window.innerWidth; lastH = window.innerHeight;
    clearTimeout(t); t = setTimeout(run, 150);
  }
  function boot() {
    run();
    lastW = window.innerWidth; lastH = window.innerHeight;
    window.addEventListener('resize', onResize);
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}   // để trang đo lại khung video (fitYt) theo CSS mới
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
