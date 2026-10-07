# Bản thử tách phòng bằng mã QR (CN03)

Thay cách "mỗi phòng một mạng wifi riêng" bằng **mỗi phòng một kênh riêng**:

- TV mở một liên kết riêng của phòng (mã TV). Khách quét QR dán trên bàn (mã QR) → điện thoại vào đúng kênh của phòng đó, không phụ thuộc wifi nào.
- Nhân viên bấm **Mở phòng** thì khách mới vào được. Bấm **Đóng phòng**: điện thoại bị ngắt, hàng chờ trên TV bị xoá, khách cũ không tự vào lại khi phòng mở cho nhóm sau.
- **Đổi mã QR**: thẻ cũ chết ngay (phòng hờ người chụp lại QR).
- Tuỳ chọn `NET_CHECK` (off / warn / on): yêu cầu điện thoại cùng địa chỉ mạng ra ngoài với TV (wifi quán). Mặc định tắt.
- Khách không cần mật khẩu: Worker phòng cấp "vé khách" (8 giờ) chỉ đủ để tìm/chọn bài trong kho. Lệnh quản trị kho vẫn cần mật khẩu.

## File
| File | Việc |
|---|---|
| `phong-worker.js` + `wrangler-phong.toml` | Worker mới `bmb-phong` (Durable Object mỗi phòng) |
| `phong.html` | Trang nhân viên: thêm phòng, mở/đóng, in QR, chép liên kết TV |
| `phong-channel.js` | Đoạn nối WebSocket dùng chung cho TV và điện thoại |
| `index.html` (TV), `remote.html` (điện thoại) | Có `?r=<mã>` thì dùng kênh phòng; không có thì chạy như cũ |
| `qrcode.js` | Thư viện vẽ QR (MIT, chép vào repo, không phụ thuộc mạng ngoài) |
| `kho-worker.js` | Thêm nhận "vé khách" (`GUEST_SECRET`) cho các lệnh tìm/chọn bài |

## Triển khai (một lần)
Durable Object cần `wrangler` (không dán được trong khung soạn code của Dashboard):
```
npx wrangler login
npx wrangler secret put SECRET        -c wrangler-phong.toml   # chuỗi ngẫu nhiên dài
npx wrangler secret put APP_PASS      -c wrangler-phong.toml   # mật khẩu nhân viên
npx wrangler secret put GUEST_SECRET  -c wrangler-phong.toml   # chuỗi ngẫu nhiên khác
npx wrangler deploy -c wrangler-phong.toml
```
(`secret put` lần đầu có thể bảo tạo Worker trước — cứ đồng ý.) Rồi ở **Worker kho-karaoke**: dán lại `kho-worker.js` mới, thêm secret `GUEST_SECRET` **giống hệt** giá trị trên, bấm Deploy.

Địa chỉ mặc định các trang đang trỏ tới: `https://bmb-phong.vumanhhung85.workers.dev`. Nếu tên miền Worker khác, thêm `?api=<địa chỉ>` vào liên kết một lần (trang nhớ lại).

## Chạy thử phòng CN03
1. Mở `https://bmbplayer.boommusicbox.vn/phong.html`, nhập địa chỉ Worker + mật khẩu → **Thêm phòng**: chi nhánh `CN03`, phòng `P01` (đổi theo phòng thật).
2. **Chép liên kết TV** → mở liên kết đó trên TV của phòng (TV nhớ mã, lần sau mở `index.html` là đủ). Bấm "Bắt đầu phiên hát" một lần.
3. **QR cho khách** → In thẻ, dán lên bàn.
4. Nhân viên bấm **Mở phòng** khi khách vào; **Đóng phòng** khi khách về.

## Chưa làm trong bản thử
- Mở/đóng phòng chưa nối với hệ thống Order (D1 `bmb_data`): hiện nhân viên bấm ở `phong.html`. Khi Order đã chuyển xong, `quay.phong` chỉ cần gọi thêm `/api/phong/mo|dong`.
- Chưa có máy tính bảng gán phòng bằng mã 4 số; TV/QR là đủ cho bản thử.
- Khách chưa thêm bài từ playlist đã lưu hay dán link (cần mật khẩu) — chỉ tìm trong kho, tìm YouTube qua kho, dán link vẫn thêm được theo mã.
