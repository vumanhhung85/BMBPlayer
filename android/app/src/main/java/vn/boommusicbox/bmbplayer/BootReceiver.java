package vn.boommusicbox.bmbplayer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Bật máy (hoặc vừa cập nhật app) → tự mở BMBPlayer.
 *  Android 4.x–9: luôn mở được. Android 10+: cần quyền "Hiển thị trên ứng dụng khác" (app tự hỏi lần đầu)
 *  hoặc chọn BMBPlayer làm màn hình chính. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        android.content.SharedPreferences sp = context.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        if (!sp.getBoolean(MainActivity.K_AUTOSTART, true)) return;
        if ("tablet".equals(sp.getString(MainActivity.K_MODE, ""))) return;   // máy tính bảng: không tự mở, nhân viên mở khi cần
        Intent open = new Intent(context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("boot", true);
        try {
            context.startActivity(open);
        } catch (Exception ignored) {
            // Máy chặn mở từ nền: người dùng mở bằng biểu tượng, hoặc chọn BMBPlayer làm màn hình chính
        }
    }
}
