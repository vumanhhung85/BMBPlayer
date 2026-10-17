package vn.boommusicbox.bmbplayer;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONObject;

/** Bấm "Tiếp nhận" / "Đã xong" ngay trên thông báo của chế độ Quầy → gọi push.act (chữ ký Worker cấp qua app.sync). */
public class QuayActionReceiver extends BroadcastReceiver {
    static final String ACT = "vn.boommusicbox.bmbplayer.QUAY_ACT";

    static PendingIntent pending(Context c, String id, String act, JSONObject a) {
        Intent i = new Intent(c, QuayActionReceiver.class).setAction(ACT)
                .putExtra("id", id).putExtra("act", act)
                .putExtra("u", a.optString("u")).putExtra("cn", a.optString("cn"))
                .putExtra("exp", a.optLong("exp")).putExtra("sig", a.optString("sig"));
        int req = (id + act).hashCode();
        return PendingIntent.getBroadcast(c, req, i, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
    }

    @Override
    public void onReceive(final Context c, Intent in) {
        if (in == null || !ACT.equals(in.getAction())) return;
        final String id = in.getStringExtra("id"), act = in.getStringExtra("act");
        if (id == null || act == null) return;
        final PendingResult pr = goAsync();
        final SharedPreferences p = QuayService.prefs(c);
        final String api = p.getString(QuayService.K_API, QuayService.DEFAULT_API);
        final NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        final int nid = QuayService.nid(id);
        // phản hồi ngay: thôi kêu, hiện "Đang gửi…"
        nm.notify(nid, QuayService.base(c, QuayService.CH_CAPNHAT, false)
                .setContentTitle("nhan".equals(act) ? "Đang tiếp nhận…" : "Đang báo đã xong…")
                .setContentIntent(QuayService.openApp(c)).build());
        new Thread(() -> {
            String title, text;
            try {
                JSONObject body = new JSONObject().put("action", "push.act").put("orderId", id).put("act", act)
                        .put("u", in.getStringExtra("u")).put("cn", in.getStringExtra("cn"))
                        .put("exp", in.getLongExtra("exp", 0)).put("sig", in.getStringExtra("sig"));
                JSONObject r = QuayService.postJson(api, body);
                if (r.optBoolean("ok")) { title = "nhan".equals(act) ? "✅ Đã tiếp nhận" : "🎉 Đã xong"; text = "Đang cập nhật…"; }
                else { title = "⚠️ Chưa xử lý được"; text = r.optString("msg", "Mở màn quầy để xử lý."); }
            } catch (Exception e) { title = "⚠️ Không kết nối được"; text = "Mở màn quầy để xử lý."; }
            try {
                nm.notify(nid, QuayService.base(c, QuayService.CH_CAPNHAT, false).setContentTitle(title).setContentText(text)
                        .setContentIntent(QuayService.openApp(c)).setAutoCancel(true).build());
            } catch (Exception ignored) {}
            QuayService s = QuayService.self;
            if (s != null) s.forget(id);
            pr.finish();
        }).start();
    }
}
