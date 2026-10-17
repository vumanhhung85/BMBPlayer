package vn.vmh.vmhplayer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

/** Tự mở VMH Nhạc khi tivi khởi động (chỉ chế độ TV, và chỉ khi người dùng không tắt). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        try {
            SharedPreferences sp = c.getSharedPreferences("vmh", Context.MODE_PRIVATE);
            String mode = sp.getString("mode", MainActivity.guessMode(c));
            if (!"tv".equals(mode) || !sp.getBoolean("autostart", true)) return;
            Intent it = new Intent(c, MainActivity.class);
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(it);
        } catch (Throwable ignore) { }
    }
}
