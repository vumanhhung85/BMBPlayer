/* ============================================================
   sw-quay.js — service worker CHỈ cho thông báo đẩy của màn quầy (quay.html), phạm vi ./quay
   - KHÔNG có sự kiện fetch: không chặn, không lưu đệm trang nào (TV / máy tính bảng / khách không bị ảnh hưởng).
   - Nút "Tiếp nhận" / "Đã xong" trên thông báo gọi thẳng API (action push.act) bằng chữ ký Worker gửi kèm thông báo,
     không cần giữ phiên đăng nhập trong service worker.
   - Địa chỉ API lấy từ ?api= lúc quay.html đăng ký.
   Sửa file này thì tăng SW_VER để trình duyệt nhận bản mới.
   ============================================================ */
var SW_VER = 'q1';
var API = '';
try { API = new URL(self.location.href).searchParams.get('api') || ''; } catch (e) {}

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

function hien(d) {
  d = d || {};
  var st = d.st || '';
  var moi = st === 'MOI' || d.t === 'thu';
  var opt = {
    body: d.body || 'Có thay đổi ở quầy',
    tag: d.tag || 'bmbq',
    renotify: !!(d.renotify && d.tag),
    silent: !!d.silent,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    timestamp: d.at || Date.now(),
    requireInteraction: st === 'MOI',               // máy tính: thông báo đơn mới đứng yên tới khi có người bấm
    actions: (d.actions || []).slice(0, 2),
    data: { id: d.id || '', st: st, act: d.act || null }
  };
  if (moi && !opt.silent) opt.vibrate = [200, 100, 200, 100, 300];
  return self.registration.showNotification(d.title || 'BMBPlayer · Quầy', opt).then(function () {
    if (!d.final) return;
    // xong / huỷ: nếu còn thông báo khác đang hiện thì gỡ luôn cái này cho gọn (để lại khi là cái duy nhất)
    return self.registration.getNotifications().then(function (list) {
      if (list.length > 1) list.forEach(function (n) { if (n.tag === d.tag) n.close(); });
    });
  });
}

/* iOS bắt buộc MỌI lần đẩy đều phải hiện thông báo — kể cả dữ liệu hỏng */
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {}; }
  e.waitUntil(hien(d));
});

function moQuay() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (/quay\.html/.test(list[i].url)) {
        try { list[i].postMessage({ t: 'rev' }); } catch (x) {}
        if (list[i].focus) return list[i].focus();
      }
    }
    return self.clients.openWindow ? self.clients.openWindow('./quay.html') : null;
  });
}

function bao(title, body, tag) {
  return self.registration.showNotification(title, { body: body, tag: tag, icon: 'icon-192.png', badge: 'icon-192.png', silent: true });
}

function bam(data, act) {
  if (!API || !data || !data.act || !data.id) return moQuay();
  var body = { action: 'push.act', orderId: data.id, act: act, u: data.act.u, cn: data.act.cn, exp: data.act.exp, sig: data.act.sig };
  var tag = 'don-' + data.id;
  return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.ok) return bao(act === 'nhan' ? '✅ Đã tiếp nhận' : '🎉 Đã xong', 'Đang cập nhật…', tag);   // thông báo mới từ Worker sẽ thay vào ngay sau
      return bao('⚠️ Chưa xử lý được', (j && j.msg) || 'Mở màn quầy để xử lý.', tag);
    })
    .catch(function () { return bao('⚠️ Không kết nối được', 'Mở màn quầy để xử lý.', tag); });
}

self.addEventListener('notificationclick', function (e) {
  var n = e.notification, data = n.data || {};
  n.close();
  if (e.action === 'nhan' || e.action === 'xong') { e.waitUntil(bam(data, e.action)); return; }
  e.waitUntil(moQuay());
});
