# BMBPlayer — chọn bài hát + gọi lễ tân (một hệ thống)

**BMBPlayer = BMBPlayer + BMB Order cũ.** Một Worker, một repo, một tên miền: `https://bmbplayer.boommusicbox.vn`.

| Trang | Ai dùng | Làm gì |
|---|---|---|
| `index.html` | TV trong phòng | Phát bài. Chưa gán phòng → hiện mã 6 số + QR. Phòng mở → QR khách ở góc trái (chọn bài + gọi lễ tân). Mỗi lượt mở phòng là QR mới. Khi khách gọi lễ tân, TV hiện trạng thái từng yêu cầu: **Đã gửi → Lễ tân đã xác nhận → Đã phục vụ** (hoặc Đã huỷ); đã phục vụ/huỷ tự ẩn sau ~12 giây. |
| `remote.html` | Khách (quét QR trên TV), máy tính bảng trong phòng | Tab **Tìm bài**, **Hàng chờ**, **Gọi lễ tân** (nước có số lượng, dịch vụ / báo sự cố). |
| `quay.html` | Quầy, quản lý, admin | Hàng đợi đơn, mở/đóng phòng, lịch sử, menu, tài khoản quầy, tab **TV & phòng** (gán TV, QR khách, đổi QR, gỡ máy tính bảng, admin thêm/xoá phòng, in thẻ đánh giá). |
| `kho.html`, `nhac.html` | Admin / nghe nhạc | Kho karaoke và nhạc TV — Worker `kho-karaoke`, `nhac-playlist` riêng, **không đổi**. |

Đã bỏ: QR dán bàn, mã 4 số, tab "Mạng", trang `phong.html`, Worker `bmb-phong`, Worker `bmb-order-worker`, tên miền `order.boommusicbox.vn`.
Dữ liệu cũ (phòng, menu, đơn, tài khoản) **giữ nguyên** trong D1 `bmb_data` — không phải chuyển gì.

## Deploy (một lần)
Trên máy có Node (thư mục repo BMBPlayer, PowerShell):

1. `npx wrangler login`
2. `npx wrangler d1 list` → chép ID của **bmb_data** vào `database_id` trong `wrangler.toml`.
3. Đặt secret (mỗi lệnh hỏi giá trị, dán vào rồi Enter). Tạo chuỗi ngẫu nhiên bằng:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   ```
   npx wrangler secret put SESSION_SECRET   # chuỗi ngẫu nhiên mới (ký phiên đăng nhập quầy)
   npx wrangler secret put SECRET           # chuỗi ngẫu nhiên mới khác (ký mã TV / QR)
   npx wrangler secret put GUEST_SECRET     # GIỐNG HỆT secret GUEST_SECRET của Worker kho-karaoke
   npx wrangler secret put APP_PASS         # mật khẩu nhac.html (nên giống APP_PASS của nhac-playlist)
   ```
   Tuỳ chọn: `LEGACY_SECRET` (giống bmb-quanly-worker — chỉ cần nếu còn tài khoản mật khẩu kiểu cũ).
   Không nhớ GUEST_SECRET của kho-karaoke: đặt giá trị mới ở đây, rồi vào Cloudflare → Worker **kho-karaoke** → Settings → Variables and Secrets → sửa `GUEST_SECRET` thành đúng giá trị đó.
4. `npx wrangler deploy` → Worker `https://bmbplayer.vumanhhung85.workers.dev`.
5. Trang HTML do chính Worker `bmbplayer` phục vụ (mục `[assets]` trong `wrangler.toml`, từ 10/2026 — thay GitHub Pages).
   Push `main` → Cloudflare Workers Builds deploy cùng lúc cả trang lẫn API. File không công khai liệt kê trong `.assetsignore`.
   TV đang mở tự tải bản mới khi rảnh (hoặc Ctrl+F5); dòng nhỏ góc TV "Web dd/mm hh:mm" là giờ deploy (lấy từ `/api/ver`).
   Lùi bản: Cloudflare → Worker bmbplayer → Deployments → chọn bản cũ → Rollback.

## Chuyển tên miền từ GitHub Pages sang Worker (làm một lần)
1. Cloudflare → DNS của boommusicbox.vn: xoá bản ghi `bmbplayer` (CNAME trỏ `vumanhhung85.github.io`).
2. Cloudflare → Workers & Pages → `bmbplayer` → Settings → Domains & Routes → Add → Custom domain → `bmbplayer.boommusicbox.vn`.
3. Đợi vài phút (cấp chứng chỉ), mở `https://bmbplayer.boommusicbox.vn/quay.html` kiểm tra; góc TV phải hiện giờ deploy mới.
4. Ổn định ~1 tuần: GitHub → repo BMBPlayer → Settings → Pages → tắt; xoá file `CNAME`; bỏ địa chỉ workers.dev khỏi `ALLOWED_ORIGINS`.
   Muốn quay lại GitHub Pages: gỡ Custom domain ở bước 2, tạo lại CNAME `bmbplayer` → `vumanhhung85.github.io`.

## Telegram báo yêu cầu gọi lễ tân

- Khi khách gửi yêu cầu, và khi lễ tân **xác nhận / đã phục vụ / huỷ**, bot gửi tin cho **quản lý (`manager`) và nhân viên quầy (`quay`) của đúng chi nhánh**: phòng, món, ghi chú, người xử lý, giờ.
- Dùng chung bot và tài khoản đã kết nối của app quản lý BMB: token đọc từ `cai_dat.tg_bot_token` trong D1 `bmb_data` (không cần đặt secret mới); người nhận là `tai_khoan` đang hoạt động, đã kết nối Telegram (`tg_chat_id`) và không tạm dừng (`tg_tam_dung = 0`). Ai chưa kết nối thì bỏ qua. Admin và kỹ thuật không nhận.
- Không có giờ im lặng ban đêm (quán mở đến 6 giờ sáng, quầy luôn có người). Muốn tắt hẳn: thêm biến `TG_LETAN` = `0` ở Dash (Variable, không phải Secret).
- Lỗi Telegram (mạng, bot bị chặn…) không làm hỏng việc gửi/xử lý yêu cầu; tin gửi nền sau khi đã trả lời khách.

## Chuyển CN03 sang (thay thẳng)
1. Quầy CN03 mở `https://bmbplayer.boommusicbox.vn/quay.html`, đăng nhập tài khoản cũ.
2. Mỗi TV: mở `https://bmbplayer.boommusicbox.vn/` → hiện mã 6 số. Quầy → tab **TV & phòng** → **Gán TV** ở đúng phòng → quét QR trên TV (hoặc quét QR trên TV bằng camera điện thoại → mở thẳng trang quầy).
3. Máy tính bảng trong phòng: mở `https://bmbplayer.boommusicbox.vn/remote.html` (hoặc "Thêm vào màn hình chính") → mở phòng → bấm ô **PHÒNG** → quét QR góc trái TV. Máy dùng wifi quán.
4. Gỡ thẻ QR dán bàn cũ (không còn dùng).
5. Chạy ổn rồi: chép 3 file chuyển hướng (`index.html`, `quay.html`, `sw.js` — gửi kèm riêng, không nằm trong repo này) vào repo **BMB_Order** (để máy còn mở order.boommusicbox.vn tự chuyển sang), sau đó xoá Worker `bmb-order-worker` (và `bmb-phong` nếu đã từng deploy), cuối cùng gỡ tên miền order.

## Ghi nhớ khi sửa
- Đổi tên miền trang: sửa `ALLOWED_ORIGINS` trong `wrangler.toml` rồi `npx wrangler deploy`.
- Sửa Worker: luôn `npx wrangler deploy` (Durable Object không dán được vào ô sửa code của Dashboard).
- Tên bảng trong D1 vẫn là `order_*` — chỉ là tên nội bộ, người dùng không thấy.
- Phần chọn bài phát YouTube nhúng: điều khoản YouTube không cho dùng phục vụ khách thương mại — xem ghi chú bản quyền trước khi đưa cho khách thật.

## Tên miền riêng vmh.io.vn (từ 10/2026)
Tên miền chính thức của BMBPlayer: `https://bmbplayer.vmh.io.vn` (không dùng boommusicbox.vn nữa, để trang chủ/đặt phòng BMB không bị ảnh hưởng). Làm song song, địa chỉ cũ vẫn chạy cho tới khi chuyển xong:
1. Cloudflare → Add a domain → `vmh.io.vn` (gói Free) → đổi nameserver của vmh.io.vn (ở nơi mua) sang 2 nameserver Cloudflare cấp.
2. Workers & Pages → `bmbplayer` → Settings → Domains & Routes → Add → Custom domain → `bmbplayer.vmh.io.vn`.
3. Worker `kho-karaoke` → Variables → `ALLOWED_ORIGINS` thêm `https://bmbplayer.vmh.io.vn` (nếu không, kho nhạc báo lỗi CORS ở địa chỉ mới).
4. Mỗi TV/máy tính bảng/quầy mở địa chỉ mới (TV: sau khi mở, mã QR tự dùng địa chỉ mới). Quầy cần đăng nhập lại (đổi tên miền thì trình duyệt coi là trang khác).
5. Ổn định ~1 tuần: bỏ `bmbplayer.boommusicbox.vn` khỏi `ALLOWED_ORIGINS`, tắt GitHub Pages, xoá `CNAME`.
