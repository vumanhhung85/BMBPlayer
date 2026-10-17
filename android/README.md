# BMBPlayer — ứng dụng Android (vỏ WebView)

Ứng dụng chỉ là "khung" toàn màn hình mở trang `https://bmb.id.vn` (từ bản 1.7; các bản ≤1.6 mở bmbplayer.boommusicbox.vn). Sửa trang web là mọi máy tự cập nhật, **không phải cài lại APK**.

- Android 5.0 trở lên (cần WebView/Chrome bản 86 trở lên — app tự báo nếu cũ). TV box, Android TV, máy tính bảng, điện thoại.
- Phát có tiếng ngay, không cần chạm. Toàn màn hình, giữ màn hình sáng.
- Lần đầu mở: app tự nhận biết, không hỏi gì (2.0): **TV** (Android TV / TV box không cảm ứng), **Máy tính bảng** (màn hình rộng, cạnh ngắn ≥ 600dp), **Quầy** (điện thoại — khách không cài APK nên điện thoại có app là của nhân viên). Nhận sai thì đổi trong menu nhân viên → "Đổi chế độ". Máy đã cài bản cũ giữ nguyên chế độ đang dùng.
- Tự mở khi bật máy (chỉ chế độ TV; **máy tính bảng không tự mở**). Android 10+: bấm "Cho phép" khi app hỏi, hoặc chọn BMBPlayer làm màn hình chính (Home).
- Mất mạng / máy chủ lỗi: màn hình "Đang chờ mạng", có mạng là tự mở lại. WebView bị tắt vì thiếu RAM: tự dựng lại.
- **Menu nhân viên**: nút MENU trên điều khiển, hoặc bấm QUAY LẠI 3 lần, hoặc chạm 5 lần góc trên bên phải. Có: tải lại, đổi chế độ, mở ứng dụng khác, Wi-Fi, Cài đặt, chọn màn hình chính, bật/tắt tự mở, xoá dữ liệu trang (gán lại phòng), thoát.
- Trang web nhận biết đang chạy trong app qua User-Agent có chữ `BMBPlayerApp/<phiên bản> (tv|tablet|quay)`.

## Dựng APK
GitHub Actions (`.github/workflows/apk.yml`) tự dựng khi đẩy lên nhánh `android-apk` → Release `apk-build` có bản **chưa ký**.

## Ký APK (bắt buộc trước khi cài)
Khoá ký **không để trong repo**. Cần file `bmbplayer-release.p12` + mật khẩu (anh Hưng giữ). Các bản cập nhật sau phải ký bằng đúng khoá này thì mới cài đè được (giữ nguyên phòng đã gán).

```
pip install cryptography
python3 android/tools/sign_apk.py BMBPlayer-unsigned.apk BMBPlayer-1.x.apk bmbplayer-release.p12 bmbplayer <mat-khau>
```
Ký v1 (jarsigner, Android 5–6) + căn lề 4 byte + v2 (Android 7+). Cần JDK (jarsigner) và Python.

## Cập nhật phiên bản app
Tăng `versionCode` (và `versionName`) trong `android/app/build.gradle`, đẩy lên nhánh `android-apk`, ký bản mới bằng khoá cũ.

## Chạy lâu dài (từ 1.8–1.9)
- 1.8: máy tính bảng không giữ sáng màn hình; 3 phút không chạm thì tắt đèn nền (máy ngủ theo thời gian chờ trong Cài đặt). TV vẫn luôn sáng.
- 1.9:
  - Cứ 30 giây hỏi trang một lần; 3 phút không trả lời → dựng lại trình hiển thị (Android 10+ còn tự phát hiện trang đứng khi bấm quá 30 giây).
  - TV: 4:30–5:00 sáng, nếu không có bài đang hát và trình hiển thị đã chạy ≥20 giờ → dựng lại cho sạch RAM (trang tự nhớ phòng). Trang TV vốn cũng tự tải lại 4–5 giờ sáng.
  - Bộ nhớ đệm web >150 MB → tự dọn; máy báo thiếu RAM → bỏ đệm trong RAM. Menu nhân viên có nút "Dọn bộ nhớ đệm (giữ phòng đã gán)".
  - Trình hiển thị hỏng liên tục (>3 lần / 2 phút) → nghỉ 30 giây rồi thử lại, tránh vòng lặp.
  - App văng: TV tự mở lại sau 3 giây (tối đa 3 lần / 10 phút; Android 10+ cần quyền "Hiển thị trên ứng dụng khác" hoặc BMBPlayer là màn hình chính).
  - Máy tính bảng tắt màn ≥10 phút rồi bật lại → nạp lại trang.
  - Menu nhân viên có dòng "Tự phục hồi": đếm số lần treo / hiển thị hỏng / văng / làm mới đêm / dọn đệm và lần gần nhất — xem khi thử máy.

## 2.0 — chế độ Quầy (nhận đơn gọi lễ tân, không cần Firebase)
- Mở `quay.html`. Đăng nhập tài khoản quầy/quản lý → trang xin "khoá máy" (`app.dangKy`) và giao cho app (`BMBNative.quayBat`).
- `QuayService` (dịch vụ nền, loại remoteMessaging) giữ WebSocket `/quay/ws` ("cái chuông" của chi nhánh). Có chuông → `app.sync` → tự hiện thông báo.
  Đơn mới: kênh "Đơn gọi lễ tân mới" — chuông riêng (`res/raw/chuong.wav`), rung, **nhắc lại mỗi 30 giây** tới khi có người Tiếp nhận; nút **✅ Tiếp nhận**.
  Đã xác nhận: thông báo im lặng có nút **🎉 Đã xong**. Xong/huỷ: tự gỡ. Nút gọi `push.act` bằng chữ ký Worker cấp (QuayActionReceiver).
- Chuông rớt: nối lại (2 giây → tối đa 60 giây), vẫn hỏi `app.sync` mỗi 2 phút. Bật máy: dịch vụ tự chạy (không mở màn hình).
- Trang quầy đang mở trên máy thì không kêu (trang đã kêu). Thanh trạng thái luôn có dòng "BMB Quầy đang nhận đơn" (Android bắt buộc).
- Lần đầu app hỏi quyền **Thông báo** (Android 13+) và **bỏ tối ưu pin** — nên cho phép. Bảng 🔔 trên trang quầy có nút mở lại 2 cài đặt này và "Gửi thử".
- Đăng xuất bằng nút trên trang, hoặc đổi sang chế độ khác: máy thôi nhận đơn (`app.huy`). Tài khoản bị khoá / đổi chi nhánh: máy tự thôi nhận.
