# BMBPlayer — chọn bài hát + gọi lễ tân (một hệ thống)

**BMBPlayer = BMBPlayer + BMB Order cũ.** Một Worker, một repo, một tên miền: `https://bmb.id.vn`.

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
Địa chỉ chính thức: `https://bmb.id.vn` (chốt 11/10/2026). Gắn bằng Custom domain của Worker, không cần GitHub Pages.
1. Cloudflare → Add a domain `bmb.id.vn` (Free) → đổi nameserver ở nhà đăng ký sang 2 nameserver Cloudflare cấp → chờ Active (đã làm).
2. Cloudflare → Workers & Pages → `bmbplayer` → Settings → Domains & Routes → Add → Custom domain → để trống ô Subdomain (tên miền gốc) (đã làm).
3. Mở `https://bmb.id.vn/quay.html` kiểm tra; góc TV phải hiện giờ deploy mới.
4. Trong thời gian chạy song song, các địa chỉ cũ vẫn hoạt động: `bmbplayer.vmh.io.vn` (Worker, tên gõ tắt cũ) và `bmbplayer.boommusicbox.vn` (GitHub Pages, DNS ở Mắt Bão). Mọi tài liệu, QR, link gửi nhân viên chỉ dùng `https://bmb.id.vn`.
5. Chạy ổn một thời gian: GitHub → repo BMBPlayer → Settings → Pages → tắt; xoá file `CNAME`; bỏ `bmbplayer.boommusicbox.vn` (và địa chỉ không dùng) khỏi `ALLOWED_ORIGINS`; chuyển repo Private (chú ý: link tải APK dạng raw.githubusercontent trên nhánh `android-apk` sẽ không còn mở công khai, cần chỗ phát hành khác).
   Quay lại Pages nếu cần: gỡ Custom domain ở bước 2, tạo lại CNAME `bmbplayer` → `vumanhhung85.github.io` ở nơi quản lý DNS của boommusicbox.vn (Mắt Bão).

## Telegram báo yêu cầu gọi lễ tân

- Khi khách gửi yêu cầu, và khi lễ tân **xác nhận / đã phục vụ / huỷ**, bot gửi tin cho **quản lý (`manager`) và nhân viên quầy (`quay`) của đúng chi nhánh**: phòng, món, ghi chú, người xử lý, giờ.
- Dùng chung bot và tài khoản đã kết nối của app quản lý BMB: token đọc từ `cai_dat.tg_bot_token` trong D1 `bmb_data` (không cần đặt secret mới); người nhận là `tai_khoan` đang hoạt động, đã kết nối Telegram (`tg_chat_id`) và không tạm dừng (`tg_tam_dung = 0`). Ai chưa kết nối thì bỏ qua. Admin và kỹ thuật không nhận.
- Không có giờ im lặng ban đêm (quán mở đến 6 giờ sáng, quầy luôn có người). Muốn tắt hẳn: thêm biến `TG_LETAN` = `0` ở Dash (Variable, không phải Secret).
- Lỗi Telegram (mạng, bot bị chặn…) không làm hỏng việc gửi/xử lý yêu cầu; tin gửi nền sau khi đã trả lời khách.

## Chuyển CN03 sang (thay thẳng)
1. Quầy CN03 mở `https://bmb.id.vn/quay.html`, đăng nhập tài khoản cũ.
2. Mỗi TV: mở `https://bmb.id.vn/` → hiện mã 6 số. Quầy → tab **TV & phòng** → **Gán TV** ở đúng phòng → quét QR trên TV (hoặc quét QR trên TV bằng camera điện thoại → mở thẳng trang quầy).
3. Máy tính bảng trong phòng (app BMBPlayer chế độ máy tính bảng, hoặc `https://bmb.id.vn/remote.html?tb=1`):
   - **Lần đầu**: máy hiện mã 6 số + QR (không nhập mật khẩu, không thấy địa chỉ Worker). Nhân viên dùng điện thoại **đã đăng nhập quầy** quét QR đó → bấm **Gán máy tính bảng này vào đây** ở đúng phòng → máy tự vào phòng và nhận *quyền thiết bị* của chi nhánh.
   - **Lần sau** (đổi phòng): bấm ô **PHÒNG** → quét QR góc trái TV (phòng phải đang mở). Chỉ máy đã có quyền thiết bị của cùng chi nhánh mới làm được; điện thoại khách quét QR không chiếm được máy tính bảng của phòng.
   - Mất máy / nghi bị mang đi: quản lý bấm **🔒 Thu hồi mọi máy tính bảng** ở tab TV & phòng → mọi máy tính bảng của chi nhánh bị gỡ, quyền cũ hết hiệu lực, phải nhờ quầy gán lại từng máy.
4. Gỡ thẻ QR dán bàn cũ (không còn dùng).
5. Chạy ổn rồi: chép 3 file chuyển hướng (`index.html`, `quay.html`, `sw.js` — gửi kèm riêng, không nằm trong repo này) vào repo **BMB_Order** (để máy còn mở order.boommusicbox.vn tự chuyển sang), sau đó xoá Worker `bmb-order-worker` (và `bmb-phong` nếu đã từng deploy), cuối cùng gỡ tên miền order.

## Ghi nhớ khi sửa
- Đổi tên miền trang: sửa `ALLOWED_ORIGINS` trong `wrangler.toml` rồi `npx wrangler deploy`.
- Sửa Worker: luôn `npx wrangler deploy` (Durable Object không dán được vào ô sửa code của Dashboard).
- Tên bảng trong D1 vẫn là `order_*` — chỉ là tên nội bộ, người dùng không thấy.
- Phần chọn bài phát YouTube nhúng: điều khoản YouTube không cho dùng phục vụ khách thương mại — xem ghi chú bản quyền trước khi đưa cho khách thật.

## Tên miền (quy ước tài liệu)
- Địa chỉ chính thức duy nhất trong mọi tài liệu, hướng dẫn, QR, link gửi nhân viên: `https://bmb.id.vn/` (trang TV `/`, quầy `/quay.html`, khách/máy tính bảng `/remote.html`).
- `bmbplayer.vmh.io.vn` và `bmbplayer.boommusicbox.vn` chỉ là địa chỉ cũ chạy song song trong thời gian chuyển; sẽ bỏ sau khi tắt GitHub Pages.
- Một Worker `bmbplayer` nhận mọi tên miền đã nằm trong Cloudflare (`bmb.id.vn`, `vmh.io.vn`) và luôn cùng một phiên bản. `boommusicbox.vn` không nằm trong Cloudflare nên chỉ chạy qua GitHub Pages.
- Tất cả địa chỉ đang dùng phải có trong `ALLOWED_ORIGINS` của Worker `bmbplayer` (`wrangler.toml`) và của Worker `kho-karaoke` (Dash). Đăng nhập và dữ liệu lưu trên máy tách riêng theo địa chỉ, nên mỗi thiết bị dùng một địa chỉ cố định; mã QR trên TV theo địa chỉ TV đang mở.
