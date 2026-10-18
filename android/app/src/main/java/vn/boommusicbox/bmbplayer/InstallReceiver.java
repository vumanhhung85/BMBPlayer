package vn.boommusicbox.bmbplayer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/** Nhận kết quả phiên cài bản cập nhật. Android cần người dùng xác nhận → mở hộp "Cài đặt" của hệ thống.
 *  Cài xong, BootReceiver (MY_PACKAGE_REPLACED) tự mở lại BMBPlayer / bật lại dịch vụ quầy. */
public class InstallReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
        android.content.SharedPreferences sp = context.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try { context.startActivity(confirm); } catch (Exception e) { sp.edit().putString("upd_msg", "Không mở được hộp cài đặt: " + e.getMessage()).apply(); }
            }
            return;
        }
        String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        sp.edit().putString("upd_msg", status == PackageInstaller.STATUS_SUCCESS ? "Đã cài bản mới" : "Cài bản mới không thành công (" + status + (msg != null ? ": " + msg : "") + ")")
                .putLong("upd_at", System.currentTimeMillis()).apply();
    }
}
