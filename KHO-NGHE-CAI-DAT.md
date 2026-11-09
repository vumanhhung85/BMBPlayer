# 🎧 Kho nghe — hướng dẫn cài (11/2026)

Kho nghe là **kho thứ ba**, độc lập với kho Việt (`kho-karaoke`) và kho quốc tế (`kho-karaoke-en`). Nó giữ danh sách mix dài cho chế độ 🎧 Nghe nhạc của BMBPlayer.

- Worker riêng **`kho-nghe`**, D1 riêng **`kho_nghe`**.
- File `kho-nghe-worker.js` **không nằm trên GitHub** (giống `kho-worker.js`). Anh dán tay vào Worker trong Cloudflare Dash.
- Quản trị ở **kho.html → nút "🎧 Kho nghe"** (cạnh Kho Việt / Kho quốc tế), mở thẳng bằng `kho.html#nghe`.
- Worker `bmbplayer` tự đồng bộ bản sao danh sách mỗi phút qua Service Binding `KHO_NGHE`. Kho nghe lỗi thì khách vẫn nghe danh sách lần đồng bộ cuối.

## Thứ tự bắt buộc

Tạo Worker `kho-nghe` **trước**, rồi mới push BMBPlayer. File `wrangler.toml` của `bmbplayer` đã khai Service Binding tới `kho-nghe`. Worker đó chưa có thì deploy `bmbplayer` sẽ lỗi.

## 1. Tạo D1

Cloudflare Dash → **Storage & Databases → D1 → Create** → tên `kho_nghe`.

Để trống. Worker tự tạo bảng ở lần chạy đầu.

## 2. Tạo Worker kho-nghe

1. **Workers & Pages → Create → Worker** → tên **`kho-nghe`** (đúng tên này, Service Binding dùng nó) → Deploy (Hello World).
2. **Edit code**: xoá hết, dán toàn bộ `kho-nghe-worker.js` → **Deploy**.
3. **Settings → Bindings → Add**:
   - **D1 database**: tên biến `DB` → `kho_nghe`.
   - *(tuỳ chọn)* **R2 bucket**: tên biến `LIB` → `taivideo-files`. Chỉ đọc, để kho.html hiện 📀 cho mix đã có file `videos/nghe/<mã>.mp4`.
4. **Settings → Variables and Secrets**:

   | Tên | Loại | Giá trị |
   |---|---|---|
   | `YT_KEY` | Secret | **Cùng khoá** với kho Việt (cùng project Google) |
   | `YT_KEY_2` | Secret (tuỳ chọn) | Khoá dự phòng **cùng project** |
   | `APP_PASS` | Secret | Mật khẩu mới cho Kho nghe (kho.html nhập mật khẩu này) |
   | `ALLOWED_ORIGINS` | Text | `https://bmb.id.vn,https://bmbplayer.vmh.io.vn,https://bmbplayer.boommusicbox.vn,https://bmbplayer.vumanhhung85.workers.dev` |
   | `DAILY_UNIT_BUDGET` | Text (tuỳ chọn) | Mặc định `500` |

   Hạn mức YouTube tính theo project, dùng chung với hai kho kia. Kho nghe cần rất ít: kiểm nhúng 1 đơn vị/50 mix mỗi ngày; gom 1 nguồn 2.000 video ≈ 80 đơn vị một lần. Kho nghe **không** dùng lệnh tìm (100 đơn vị/lần).

5. **Settings → Triggers → Cron Triggers → Add**: `*/15 * * * *`.
6. Kiểm tra: mở `https://kho-nghe.vumanhhung85.workers.dev`. Phải thấy `{"ok":true,"app":"kho-nghe",...}`.

## 3. Nối Worker bmbplayer

Worker **`bmbplayer` → Settings → Variables and Secrets → Add**:

- `KHO_NGHE_PASS`, loại **Secret**, giá trị = **APP_PASS của kho-nghe**.

Loại Secret không bị deploy xoá. Service Binding `KHO_NGHE` đã có sẵn trong `wrangler.toml`, sẽ được áp ở lần deploy tới (sau khi anh nói "push đi").

## 4. Dùng

1. **kho.html → Kết nối**: ô "🎧 Kho nghe" đã điền sẵn địa chỉ. Nhập mật khẩu (để trống thì dùng chung mật khẩu kho Việt) → Lưu.
2. **🎧 Kho nghe → Nguồn**: dán link kênh / playlist chuyên nonstop, remix, chill… và chọn nhóm mặc định. Chỉ tick **"Được phép tải"** khi kênh cho phép hoặc anh có thoả thuận.
3. **Chờ duyệt → Gom ngay**. Mix đạt chuẩn hiện thành thẻ: nhúng được, không chặn ở Việt Nam, không giới hạn tuổi, dài **20–150 phút** (đổi ở thẻ Tình trạng).
   - Bấm ▶ trên ảnh để xem thử.
   - Chọn nhóm rồi ✓ Duyệt. Chọn nhiều thẻ thì duyệt một lần.
   - ✕ Bỏ: kho không gợi ý lại mix đó.
4. **Danh sách**: đúng những gì khách thấy.
   - 📌 ghim, 🙈 ẩn.
   - ⬇ đánh dấu cần lưu R2, chỉ dùng được với nguồn được phép tải.
   - ↺ bỏ cờ "TV báo lỗi".
5. **Quầy → Cài đặt → Nghe nhạc**: bật/tắt, "khi mix hết", "phát bản lưu R2" (mặc định TẮT). Ở đây còn có danh sách xem nhanh và trạng thái "✓ Đồng bộ".

## Kho nghe tự làm gì

- **15 phút/lần** (Cron): kiểm nhúng **mỗi ngày** mọi mix đã duyệt bằng YouTube API. Mix bị tắt nhúng / xoá / chặn ở VN / giới hạn tuổi thì tự ẩn khỏi khách, hết hỏng thì tự hiện lại. Sau đó gom mix mới từ các nguồn.
- **TV báo lỗi** khi phát (mã 100/101/150): mix bị ẩn ngay, giữ cờ tới khi anh bấm ↺.
- **Dữ liệu YouTube lưu tối đa 30 ngày**:
  - Mix chờ duyệt không làm mới được quá 30 ngày thì bị xoá.
  - Mix đã duyệt thì bị ẩn tới khi làm mới được.
- **Báo cáo sáng Telegram (07:55)** có mục 🎧: số mix khách nghe được, số chờ duyệt, mix vừa hỏng, khoá YouTube, lịch tự chạy của kho.

## App Tải Video (sau này)

Kho nghe đã có đường dẫn cùng khuôn kho Việt/EN: `POST /api/kho/export`, `POST /api/kho/has`, `GET /api/kho/channels`, `POST /api/kho/channel/update {id, dl}`.

- Mặc định chỉ xuất mix anh đánh dấu ⬇ **và** thuộc nguồn "được phép tải". Gửi `all:true` để lấy mọi mix đã duyệt của nguồn được phép tải.
- Thư mục lưu: `videos/nghe/<mã YouTube>.mp4`, 720p.
- Tải Video cần thêm Service Binding `KHO_NGHE` → `kho-nghe` và Secret mật khẩu, giống `KHO_VI`/`KHO_EN`. Phần này **chưa làm** và chưa thử với Tải Video thật.
