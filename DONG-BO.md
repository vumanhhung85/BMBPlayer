# DONG-BO.md — sổ đồng bộ BMBPlayer ⇄ MHPlayer

**Bản sao GIỐNG HỆT nhau ở hai repo** (`BMBPlayer/DONG-BO.md` và `MHPlayer/DONG-BO.md`). Sửa một bên thì sửa bên kia cho trùng.

Hai app có chung nhiều cơ chế (kênh WebSocket TV ⇄ điện thoại ⇄ máy tính bảng, nhật ký kết nối, âm lượng, đo phát; riêng KHO NHẠC chung mã nguồn nhưng dữ liệu hoàn toàn riêng, xem dưới). Lỗi sửa ở app này thường cũng có ở app kia. Sổ này để không quên.

## Quy tắc (cho anh Hưng và cho Claude)

1. **Đầu phiên** làm việc trên một trong hai app: đọc sổ này, báo ngay những dòng ⏳ và ❓.
2. **Sửa xong một lỗi** (hoặc thêm cơ chế dùng chung): tìm đoạn tương ứng ở app kia. Chuyển ngay được thì chuyển; chưa thì ghi một dòng ⏳ kèm lý do và nói với anh.
3. **Không chép mù.** Hai app khác kiến trúc (BMBPlayer: phòng, quầy, nhiều chi nhánh; MHPlayer: mã bản quyền mỗi TV). Cột "Ghi chú" nói cần chỉnh gì khi chuyển.
4. Ghi vào sổ trong **cùng commit** với bản sửa. Push thì vẫn phải hỏi anh "push đi" như mọi lần.

## Giữ hai app CÁCH LY (không nhầm, không ghi đè của nhau)

Đồng bộ là **chuyển ý tưởng và cách sửa**, không phải chép file. Hai app chạy hoàn toàn riêng và phải giữ như vậy:

| | BMBPlayer | MHPlayer |
|---|---|---|
| Worker | `bmbplayer` | `mhplayer` |
| Tên miền | `bmb.id.vn` | `k.vmh.io.vn` |
| D1 | `bmb_data` (dùng chung với app quản lý BMB) | `mhplayer_data`, `mhplayer_kho_vn`, `mhplayer_kho_en` |
| R2 | `bmbplayer-files` | `mhplayer-files` |
| Kho (CHẠY RIÊNG, không dùng chung) | Worker `kho-karaoke`, `kho-karaoke-en`, D1 riêng của hai kho, anh dán tay | MỘT kho riêng nằm trong Worker `mhplayer` (`src/kho.js`), D1 `mhplayer_kho_vn`/`_en`, nguồn kênh và hạn mức YouTube riêng |
| Khoá YouTube | khoá của kho BMBPlayer | `YT_KEY` của tài khoản Google riêng |
| Bot Telegram | `BMB.VN_Notification` (token ở D1 `cai_dat`) | bot riêng |

Điểm duy nhất MHPlayer đọc từ BMBPlayer: `kho.html` → "Nạp ban đầu", chỉ ĐỌC danh sách mã bài và kênh bằng mật khẩu kho do anh nhập. Ngoài chỗ đó, hai app không gọi nhau.

Quy tắc khi làm việc:
1. Mỗi lần chỉ sửa MỘT repo trong một commit, trừ `DONG-BO.md` (sửa cả hai cho trùng). Trước khi sửa/commit/push: kiểm `pwd` và `git remote -v` đúng repo cần.
2. Không chép tên Worker, ID D1, bucket R2, tên miền, secret hay token từ app này sang app kia. Khi chuyển một bản sửa, đối chiếu lại các chỗ khác nhau trong bảng trên.
3. **Kho là hai kho độc lập.** Sửa kho ở bên này KHÔNG tự động áp sang bên kia: chỉ chung mã nguồn ban đầu (`kho-worker.js`), còn dữ liệu bài, danh sách kênh, hạn mức YouTube, cấu hình và lịch quét là của riêng từng app. Không dán `kho-worker.js` vào MHPlayer bằng tay; chỉ dựng bằng `tools/build-kho.py`, và dựng lại xong phải xem `git diff src/kho.js` để chắc không đè mất phần riêng của MHPlayer (khách không tìm YouTube, admin MH, nạp ban đầu). Có chuyển bản sửa kho sang app kia hay không là do anh quyết, không làm mặc định.
4. Mã đóng WebSocket khác nghĩa (xem "Bản đồ tương ứng"), không chép số.
5. Mỗi app một lần push riêng, mỗi lần một "push đi" của anh, và sau khi push xem build của ĐÚNG Worker.

Ký hiệu: ✅ đã có · ⏳ cần làm · ❓ chưa chắc, cần kiểm · ➖ không áp dụng (có ghi lý do)

## Bản đồ tương ứng (để tìm nhanh)

| Việc | BMBPlayer | MHPlayer |
|---|---|---|
| Phòng WebSocket (Durable Object) | `Room` trong `bmbplayer-worker.js` | `Tivi` trong `src/index.js` |
| Máy khách của kênh | `phong-channel.js` | `public/mh-kenh.js` |
| Điện thoại / máy tính bảng | `remote.html` | `public/remote.html` |
| TV | `index.html` | `public/index.html` |
| Nhật ký kết nối | `kn_*` (D1 `bmb_data`), tab Kết nối ở `quay.html` | bảng `ket_noi`, mục Kết nối ở `public/admin.html` |
| Kho nhạc (hai kho độc lập) | `kho-worker.js` (KHÔNG có trên GitHub, anh dán tay vào 2 Worker kho) | `src/kho.js` — sinh từ `kho-worker.js` bằng `tools/build-kho.py` (có phần sửa riêng cho MH), KHÔNG sửa tay |
| Mã đóng kết nối | 4000 thay · 4001 phòng đóng · 4002 xoay token · 4003 chưa mở · 4004 mạng · 4005 đầy · 4006 cùng máy nối lại · **4007 kết nối ma** | 4000 thay · 4002 hết hiệu lực · 4004 mạng · 4006 nhường chỗ · **4007 hết giờ phiên** · 4008 phiên mới · **4009 kết nối ma** · 4010–4013 bản quyền |

Chú ý: **mã 4007 khác nghĩa** ở hai app. Chuyển mã đóng giữa hai app phải đổi số.

## Sổ

| # | Lỗi / thay đổi | BMBPlayer | MHPlayer | Ghi chú khi chuyển |
|---|---|---|---|---|
| 1 | **Kết nối "ma"** của TV / máy tính bảng / điện thoại: mất mạng hoặc máy ngủ thì Worker không nhận tin đóng, socket cũ vẫn bị đếm → điện thoại thật bị đẩy nhầm, TV ma vẫn báo "còn nối" | ✅ `Room.reapStale`, `reapRemotes`, `sockets()`, `webSocketClose` | ✅ 23/10/2026 (commit 1f46da1) `Tivi.reapStale`, `seen()`, `socks()` | MH dùng 4009 cho "ma" (4007 đã là hết giờ phiên). Ngưỡng im: TV/tablet 120 s, điện thoại 90 s. Dùng `getWebSocketAutoResponseTimestamp` + `a.rx`. Biến `STALE_TV_MS`/`STALE_PH_MS` chỉ để kiểm thử. |
| 2 | Máy khách: socket chết ngầm → `probe()` khi mở lại màn hình / có mạng (gửi sync+ping, 4 s không phản hồi thì bỏ), `recycle()` khi 100 s không nhận tin, **bỏ `onclose` rồi nối lại ngay** (vì `close()` trên socket chết có thể không bao giờ gọi `onclose`) | ✅ `phong-channel.js` | ✅ 23/10/2026 (1f46da1) `mh-kenh.js` | Giống hệt về logic (MH recycle khi im >70 s). |
| 3 | Điện thoại hiện banner "TV mất kết nối" khi `room.tv === false` | ✅ `remote.html` | ✅ 23/10/2026 (1f46da1) `remote.html` | Cần #1 để `tv` đúng. |
| 4 | **Nhiều bộ điều khiển** (2 điện thoại + tablet): đặt rõ giá trị thay vì đảo — play/pause gửi `{on}`, tắt tiếng gửi `{on}`; ưu tiên/lên/xoá bài theo **id 11 ký tự** thay vì chỉ số (hàng chờ đổi liên tục). Worker dựng lại payload từng trường nên **phải thêm `on`, `id` vào danh sách cho phép**, nếu không bị cắt âm thầm | ✅ | ✅ 23/10/2026 (1f46da1) `remote.html` gửi `{on}`, TV `setMute(on)`, Worker cho `out.on`/`out.id` | Lỗi biểu hiện: 2 máy cùng bấm thì icon lệch thực tế. Khi sửa, rà luôn mọi nút tương tự (play, mute, ưu tiên, lên, xoá, tua). |
| 5 | Âm lượng nhất quán: TV giữ `vol`/`userMuted` trong trang (không đọc `getVolume()`), remote khoá đồng bộ 1,5 s sau khi kéo | ✅ | ✅ (có `volHold`/`muteHold` ở remote, `userMuted` ở TV) | MH TV: `setMute(on)` đã có. Cả hai còn mở: icon chưa hiện "tắt tiếng" khi kéo âm lượng về 0. |
| 6 | Giới hạn chất lượng video theo TV (`cl`, `fitYt()`) + đo phát từng bài (`pq`) | ✅ | ✅ | |
| 7 | Nhật ký kết nối chi tiết (noi / dut / cat / tai / phat) | ✅ | ✅ | Dọn kết nối ma ghi `dut` mã 4009 ở MH. |
| 8 | Cảnh báo Telegram "rớt đồng loạt" (nhiều TV cùng chi nhánh rớt trong vài giây) | ✅ `knCanhBao` | ✅ 23/10/2026 (1f46da1) `rotDongLoat` trong `src/tg.js` | MH đếm số TV (của mọi khách) rớt trong cửa sổ thời gian rồi nhóm theo nhà mạng; ngưỡng/giờ im lặng chỉnh trong admin (`tg_kn_*`). |
| 9 | Báo cáo sáng Telegram 7h55 (sức khoẻ BMBPlayer + 2 kho) | ✅ 23/10/2026 `baoCaoSang` | ➖ MH đã có báo cáo sức khoẻ kho 07:45 (`src/tg.js`) | Có thể thêm cho MH: tìm hụt, kênh nhận < 20%, TV rớt nhiều trong 24 giờ. |
| 10 | Worker gọi Worker qua `*.workers.dev` bị Cloudflare chặn (404, "error code: 1042") → dùng Service Binding | ✅ `wrangler.toml` `[[services]]` | ➖ MH không gọi Worker khác | Bài học chung cho app mới. |
| 11 | `kho-worker.js`: bản vá quét bị bỏ đói (scan starvation) + bộ đếm lý do loại (`rej_stat`). **Hai kho độc lập**, chỉ chung mã nguồn | ✅ (anh dán tay vào cả hai Worker kho, 22/10/2026) | ❓ `src/kho.js` có `rej_stat`; **chưa rõ có bản vá quét bỏ đói**. Có chuyển sang kho MH hay không là anh quyết | Nếu anh muốn: xin `kho-worker.js` mới nhất, chạy `python3 -I tools/build-kho.py <kho-worker.js> src/kho.js`, xem `git diff src/kho.js` trước khi commit. Dữ liệu và cài đặt kho MH không bị đụng (nằm trong D1 riêng). |
| 12 | Chấm điểm giả lập cuối bài (mặc định tắt) | ✅ | ➖ Chưa có; đây là tính năng, không phải lỗi | Tuỳ anh có muốn bán cho khách MH không. |
| 13 | **Đếm lượt chọn bài** để sau này lấy top ~5000 bài hay hát nhất: bảng đếm vĩnh viễn theo (ngày, chi nhánh, mã video), cộng khi lệnh `add` của điện thoại/máy tính bảng được nhận; "Thêm cả playlist" gửi `pl:true` nên không tính; quầy có tab 🎤 Bài hay chọn + tải CSV | ✅ 24/10/2026 bảng `bai_chon` (D1 `bmb_data`, không nằm trong `knDon`), `baiChonGhi` gọi từ `Room`, API `admin.baiChon`, `quay.html`, `remote.html` (`pl:true`). **Kho BMB** (độc lập) đã có sẵn `pick_log` (giữ 365 ngày, ghi bởi `reportPick`): 24/10/2026 thêm lệnh `GET /api/kho/top` (gộp các bản của cùng một bài theo `song_key`, chọn bản tốt nhất) trong `kho-worker.js` + thẻ "Bài được chọn nhiều nhất" và nút CSV top 5000 trong `kho.html`. `kho-worker.js` anh dán tay vào 2 Worker kho | ⏳ Chưa có. MH chỉ có `reportPick` gửi vào kho riêng của MH (chưa rõ giữ bao lâu) | Làm ở `Tivi` (`src/index.js`) khi nhận `add`, bảng riêng trong D1 `mhplayer_data`, khoá theo MÃ BẢN QUYỀN thay cho chi nhánh; xem tại `public/admin.html`. Kho MH: `src/kho.js` sinh từ `kho-worker.js` nên dựng lại bằng `tools/build-kho.py` sẽ có `/api/kho/top` (xem `git diff src/kho.js`), nhưng `public/kho.html` của MH chưa có thẻ hiển thị. Anh quyết có làm không. Dữ liệu hai app không trộn. |
| 15 | **Phát từ thư viện video lưu sẵn** (R2 của app Tải Video, sau này NAS của quán): bài có file thì phát bằng `<video>`, không có / lỗi thì YouTube nhúng tiếp đúng giây; công tắc theo chi nhánh | ✅ 25/10/2026 (NAS http trong mạng quán: APK BMBPlayer 2.9, `BMBNative.mixedOk()`; MHPlayer APK riêng chưa liên quan) binding `LIB` → `taivideo-files`, `/api/lib/src` + `/lib/…` (link ký 6 giờ, Range), `order_meta` khoá `lib`, bảng `lib_dem`, TV `index.html` (`P()`, `VP`, `libFind`, `playFile`/`playYt`/`libFail`), quầy Cài đặt | ❓ Chưa có. MH có R2 riêng nhưng chưa có thư viện bài | Đây là tính năng, anh quyết có bán cho khách MH không. Nếu làm: KHÔNG dùng chung bucket/vé của BMB; MH theo mã bản quyền từng TV nên công tắc đặt theo mã bản quyền (hoặc theo khách), vé ký bằng secret của MH. Cấu trúc TV (`P()` thay `player`) chép được, nhưng mã đóng/tin nhắn của `Tivi` khác. |
| 16 | **Theo dõi sức khoẻ NAS của quán** (25/10/2026): Worker không gọi được NAS trong mạng quán nên TV tự kiểm tra 5 phút/lần (ảnh `_bmb/ping.png`, không có thì hỏi no-cors) và gửi tin WebSocket `nh`; trạng thái 🟢🟡🔴⚫⚪ theo chi nhánh, Telegram khi đỏ ≥ 10 phút / khi hết đỏ, mục NAS trong báo cáo sáng | ✅ `index.html` (`nhCheck`, `NH`), `bmbplayer-worker.js` (`nasGhi`, `nasTinh`, `nasXet`, `nasCanhBao`, `bcNas`, `admin.nasTt`; bảng `nas_tv`, `nas_gio`, `nas_su`, `nas_cb`; Room nhận `nh` tối đa 1 tin/45 giây mỗi TV), `quay.html` (chip ở Cài đặt → thư viện, Kết nối → 📀 NAS quán) | ➖ MH chưa có thư viện / NAS (xem #15) | Chỉ cần nếu sau này MH có thư viện + NAS: chép phần TV (`nhCheck`) và hàm thuần `nasTinh`; khoá theo MÃ BẢN QUYỀN thay chi nhánh, bảng và Telegram riêng của MH. |
| 17 | **Giao diện `kho.html` đổi sang bộ màu của Tải Video BMB** (25/10/2026): nền xanh nhạt, thẻ trắng, thanh đầu xanh navy, nút chính màu cam; tiêu đề lớn "Kho BMB Karaoke" (kho tiếng Anh giữ thanh đầu xanh ngọc để phân biệt). Chỉ sửa CSS, tiêu đề và `document.title`, không đụng logic | ✅ `kho.html` | ⏳ MH có kho riêng cùng mã nguồn; chưa đổi, tên "Kho BMB Karaoke" là thương hiệu BMB | Nếu anh muốn: chép khối `<style>` mới, đổi chữ tiêu đề thành tên kho của MH. |

## Việc đang chờ (⏳ / ❓)

- #11 Hỏi anh có muốn đưa bản vá quét bỏ đói sang kho MHPlayer không (kho độc lập, không mặc định).
- #13 Hỏi anh có muốn thêm bộ đếm lượt chọn bài cho MHPlayer không.
- #17 Hỏi anh có muốn đổi giao diện kho của MHPlayer sang bộ màu mới (và đặt tên kho riêng cho MH) không.
- #15 Hỏi anh có muốn có thư viện video lưu sẵn cho MHPlayer không (tính năng, không phải lỗi). Số 15 vì sổ bên MHPlayer đã dùng #13, #14 cho việc khác (hai sổ đang lệch nhau từ #12, cần gộp lại).

## Mẫu dòng mới

```
| N | Mô tả lỗi và biểu hiện | ✅/⏳ chỗ sửa ở BMBPlayer | ✅/⏳/➖ chỗ sửa ở MHPlayer | Cần chỉnh gì khi chuyển |
```
