# BMBPlayer — chọn bài hát + gọi phục vụ (một hệ thống)

**BMBPlayer = BMBPlayer + BMB Order cũ.** Một Worker, một repo, một tên miền: `https://bmbplayer.boommusicbox.vn`.

| Trang | Ai dùng | Làm gì |
|---|---|---|
| `index.html` | TV trong phòng | Phát bài. Chưa gán phòng → hiện mã 6 số + QR. Phòng mở → QR khách ở góc trái (chọn bài + gọi món). Mỗi lượt mở phòng là QR mới. |
| `remote.html` | Khách (quét QR trên TV), máy tính bảng trong phòng | Tab **Tìm bài**, **Hàng chờ**, **Phục vụ** (nước có số lượng, dịch vụ / báo sự cố). |
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
5. Đưa các trang lên GitHub (repo BMBPlayer) → Pages tự cập nhật. TV đang mở tự tải bản mới khi rảnh (hoặc Ctrl+F5).

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
