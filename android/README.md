# BMBPlayer — ứng dụng Android (vỏ WebView)

Ứng dụng chỉ là "khung" toàn màn hình mở trang `https://bmbplayer.boommusicbox.vn`. Sửa trang web là mọi máy tự cập nhật, **không phải cài lại APK**.

- Android 5.0 trở lên (cần WebView/Chrome bản 86 trở lên — app tự báo nếu cũ). TV box, Android TV, máy tính bảng, điện thoại.
- Phát có tiếng ngay, không cần chạm. Toàn màn hình, giữ màn hình sáng.
- Lần đầu mở: chọn **TV trong phòng** hoặc **Máy tính bảng** (không ai bấm thì 20 giây sau tự chọn theo loại máy).
- Tự mở khi bật máy (chỉ chế độ TV; **máy tính bảng không tự mở**). Android 10+: bấm "Cho phép" khi app hỏi, hoặc chọn BMBPlayer làm màn hình chính (Home).
- Mất mạng / máy chủ lỗi: màn hình "Đang chờ mạng", có mạng là tự mở lại. WebView bị tắt vì thiếu RAM: tự dựng lại.
- **Menu nhân viên**: nút MENU trên điều khiển, hoặc bấm QUAY LẠI 3 lần, hoặc chạm 5 lần góc trên bên phải. Có: tải lại, đổi chế độ, mở ứng dụng khác, Wi-Fi, Cài đặt, chọn màn hình chính, bật/tắt tự mở, xoá dữ liệu trang (gán lại phòng), thoát.
- Trang web nhận biết đang chạy trong app qua User-Agent có chữ `BMBPlayerApp/<phiên bản> (tv|tablet)`.

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
