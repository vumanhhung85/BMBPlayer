package vn.boommusicbox.bmbplayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Chế độ QUẦY (APK 2.0): dịch vụ nền giữ một WebSocket tới Worker bmbplayer (/quay/ws — "cái chuông" của chi nhánh).
 * Có chuông → gọi app.sync lấy các đơn đang mở → tự hiện thông báo: đơn mới kêu chuông riêng (nhắc lại mỗi 30 giây
 * tới khi có người Tiếp nhận), có nút "Tiếp nhận" / "Đã xong" (QuayActionReceiver gọi push.act bằng chữ ký Worker cấp).
 * Không cần Google Play Services / Firebase. Chuông rớt thì vẫn tự hỏi app.sync mỗi 2 phút, nối lại với thời gian chờ tăng dần.
 * Khoá máy (dk) do quay.html xin bằng app.dangKy sau khi đăng nhập, rồi giao cho app qua BMBNative.quayBat.
 */
public class QuayService extends Service {
    static final String K_DK = "q_dk", K_API = "q_api", K_BRANCH = "q_branch", K_USER = "q_user", K_DV = "q_dv", K_TBSAU = "q_tbsau";
    static final String CH_DON = "quay_don_v1", CH_CAPNHAT = "quay_capnhat_v1", CH_NEN = "quay_nen_v1", CH_VIEC = "quay_viec_v1";
    static final int ID_NEN = 77;
    static final String DEFAULT_API = "https://bmbplayer.vumanhhung85.workers.dev/api";
    static final String ORIGIN = "https://bmb.id.vn";
    private static final long SYNC_MS = 120_000L, REMIND_MS = 30_000L, PING_MS = 25_000L, DEAD_MS = 70_000L;

    /** MainActivity đang hiện trang quầy → không kêu (trang đã kêu chuông) */
    static volatile boolean uiVisible = false;
    static volatile boolean connected = false;
    static volatile long lastSyncAt = 0;
    static volatile QuayService self;
    /** MainActivity đặt để báo trang quầy cập nhật nút 🔔 */
    static volatile Runnable onChange;

    private final Handler h = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private OkHttpClient http;
    private WebSocket ws;
    private long retryMs = 2000, lastMsg = 0;
    private boolean stopping = false;
    private ConnectivityManager.NetworkCallback netCb;
    /** id đơn → trạng thái đang hiện trên thanh thông báo */
    private final Map<String, String> shown = new HashMap<>();
    private final Map<String, JSONObject> moi = new HashMap<>();
    private String branch = "", user = "";

    // ------------------------------------------------------------------ bật / tắt
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE); }

    static String deviceId(Context c) {
        SharedPreferences p = prefs(c);
        String v = p.getString(K_DV, "");
        if (v == null || v.length() < 16) {
            byte[] b = new byte[12];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder("a");
            for (byte x : b) sb.append(String.format("%02x", x & 0xff));
            v = sb.toString();
            p.edit().putString(K_DV, v).apply();
        }
        return v;
    }

    static boolean hasKey(Context c) { String dk = prefs(c).getString(K_DK, ""); return dk != null && dk.startsWith("dk."); }

    static void start(Context c) {
        if (!hasKey(c)) return;
        Intent i = new Intent(c, QuayService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        } catch (Exception ignored) { /* Android chặn mở dịch vụ từ nền: lần mở app sau sẽ bật lại */ }
    }

    static void stop(Context c) {
        try { c.stopService(new Intent(c, QuayService.class)); } catch (Exception ignored) {}
        connected = false;
    }

    /** Đăng xuất / đổi chế độ: báo Worker gỡ máy (app.huy), xoá khoá, dừng dịch vụ, gỡ thông báo đơn */
    static void logout(final Context c) {
        final SharedPreferences p = prefs(c);
        final String dk = p.getString(K_DK, ""), api = p.getString(K_API, DEFAULT_API);
        p.edit().remove(K_DK).apply();
        stop(c);
        try { ((NotificationManager) c.getSystemService(NOTIFICATION_SERVICE)).cancelAll(); } catch (Exception ignored) {}
        if (dk != null && !dk.isEmpty()) new Thread(() -> {
            try { postJson(api, new JSONObject().put("action", "app.huy").put("dk", dk)); } catch (Exception ignored) {}
        }).start();
        fireChange();
    }

    static void fireChange() { Runnable r = onChange; if (r != null) try { r.run(); } catch (Exception ignored) {} }

    // ------------------------------------------------------------------ vòng đời
    @Override
    public void onCreate() {
        super.onCreate();
        self = this;
        makeChannels(this);
        startForeground(ID_NEN, nenNotif());
        http = new OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build();
        listenNetwork();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences p = prefs(this);
        branch = p.getString(K_BRANCH, ""); user = p.getString(K_USER, "");
        if (!hasKey(this)) { stopSelf(); return START_NOT_STICKY; }
        stopping = false;
        updateNen();
        if (ws == null) connect(); else syncSoon(0);
        h.removeCallbacks(periodic); h.postDelayed(periodic, SYNC_MS);
        h.removeCallbacks(keepAlive); h.postDelayed(keepAlive, PING_MS);
        return START_STICKY;                          // bị hệ thống tắt thì tự bật lại
    }

    /** Khoá máy vừa đổi (đăng nhập tài khoản khác / chi nhánh khác): nối lại bằng khoá mới */
    void reconnect() {
        h.post(() -> {
            if (ws != null) { try { ws.cancel(); } catch (Exception ignored) {} ws = null; }
            shownClear();
            retryMs = 2000;
            connect();
        });
    }

    @Override
    public void onDestroy() {
        stopping = true;
        self = null;
        connected = false;
        h.removeCallbacksAndMessages(null);
        if (ws != null) { try { ws.close(1000, "stop"); } catch (Exception ignored) {} ws = null; }
        if (netCb != null) {
            try { ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(netCb); } catch (Exception ignored) {}
        }
        io.shutdownNow();
        fireChange();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ------------------------------------------------------------------ WebSocket "cái chuông"
    private String wsUrl() {
        String api = prefs(this).getString(K_API, DEFAULT_API);
        String base = api.replaceAll("/api/?$", "");
        return base.replaceFirst("^http", "ws") + "/quay/ws?dv=app";
    }

    private void connect() {
        if (stopping || ws != null || !hasKey(this)) return;
        String dk = prefs(this).getString(K_DK, "");
        Request req;
        try {
            req = new Request.Builder().url(wsUrl())
                    .header("Origin", ORIGIN)
                    .header("Sec-WebSocket-Protocol", "bmbq.v1, " + dk)
                    .build();
        } catch (Exception e) { scheduleReconnect(); return; }
        ws = http.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket s, Response r) {
                h.post(() -> {
                    if (s != ws) return;
                    connected = true; retryMs = 2000; lastMsg = SystemClock.elapsedRealtime();
                    updateNen(); fireChange(); syncSoon(0);
                });
            }
            @Override public void onMessage(WebSocket s, String text) {
                h.post(() -> {
                    if (s != ws) return;
                    lastMsg = SystemClock.elapsedRealtime();
                    if ("pong".equals(text)) return;
                    if (text.contains("\"rev\"")) syncSoon(150);
                });
            }
            @Override public void onClosed(WebSocket s, int code, String reason) { h.post(() -> lost(s, 0)); }
            @Override public void onFailure(WebSocket s, Throwable t, Response r) {
                final int code = r != null ? r.code() : 0;
                h.post(() -> lost(s, code));
            }
        });
    }

    private void lost(WebSocket s, int code) {
        if (s != ws) return;
        ws = null; connected = false;
        updateNen(); fireChange();
        if (code == 403) syncSoon(0);                 // có thể khoá máy đã bị thu hồi: app.sync sẽ báo 403 rõ ràng
        scheduleReconnect();
    }

    private final Runnable reconnectRun = this::connect;
    private void scheduleReconnect() {
        if (stopping) return;
        h.removeCallbacks(reconnectRun);
        h.postDelayed(reconnectRun, retryMs);
        retryMs = Math.min(retryMs * 2, 60_000L);
    }

    private final Runnable keepAlive = new Runnable() {
        @Override public void run() {
            if (stopping) return;
            if (ws != null && connected) {
                if (SystemClock.elapsedRealtime() - lastMsg > DEAD_MS) { WebSocket s = ws; try { s.cancel(); } catch (Exception ignored) {} lost(s, 0); }
                else try { ws.send("ping"); } catch (Exception ignored) {}
            } else if (ws == null) { retryMs = 2000; connect(); }
            h.postDelayed(this, PING_MS);
        }
    };

    private final Runnable periodic = new Runnable() {
        @Override public void run() { if (stopping) return; syncSoon(0); h.postDelayed(this, SYNC_MS); }
    };

    private void listenNetwork() {
        if (Build.VERSION.SDK_INT < 24) return;
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            netCb = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network n) {
                    h.postDelayed(() -> { if (ws == null) { retryMs = 2000; h.removeCallbacks(reconnectRun); connect(); } else syncSoon(0); }, 1200);
                }
            };
            cm.registerNetworkCallback(new NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), netCb);
        } catch (Exception e) { netCb = null; }
    }

    // ------------------------------------------------------------------ đồng bộ đơn
    private final Runnable syncRun = this::syncNow;
    void syncSoon(long ms) { h.removeCallbacks(syncRun); h.postDelayed(syncRun, ms); }

    private void syncNow() {
        final SharedPreferences p = prefs(this);
        final String dk = p.getString(K_DK, ""), api = p.getString(K_API, DEFAULT_API);
        if (dk == null || dk.isEmpty()) return;
        try {
            io.execute(() -> {
                try {
                    JSONObject r = postJson(api, new JSONObject().put("action", "app.sync").put("dk", dk).put("tbSau", p.getLong(K_TBSAU, -1)));
                    h.post(() -> {
                        if (r.optInt("_status") == 403 || "may_het_han".equals(r.optString("error"))) { revoked(); return; }
                        if (!r.optBoolean("ok")) return;
                        lastSyncAt = System.currentTimeMillis();
                        apply(r.optJSONArray("orders"));
                        applyQl(r.optJSONObject("ql"));
                    });
                } catch (Exception ignored) { /* mất mạng: lượt sau thử lại */ }
            });
        } catch (Exception ignored) {}
    }

    private void revoked() {
        prefs(this).edit().remove(K_DK).apply();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        shownClear();
        nm.notify(ID_NEN + 1, base(CH_CAPNHAT, false)
                .setContentTitle("BMB Quầy: máy đã thôi nhận đơn")
                .setContentText("Tài khoản đã đăng xuất / bị khoá / đổi chi nhánh. Mở app và đăng nhập lại.")
                .setContentIntent(openApp(this)).setAutoCancel(true).build());
        stopSelf();
    }

    private void apply(JSONArray list) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Set<String> seen = new HashSet<>();
        moi.clear();
        if (list != null) for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id"), st = o.optString("st");
            if (id.isEmpty()) continue;
            seen.add(id);
            String prev = shown.get(id);
            if ("MOI".equals(st) || "NHAN".equals(st)) {
                if ("MOI".equals(st)) moi.put(id, o);
                if (st.equals(prev)) continue;                   // không đổi: để yên (không kêu lại ở đây)
                boolean alert = "MOI".equals(st) && !uiVisible;
                nm.notify(nid(id), orderNotif(o, alert));
                shown.put(id, st);
            } else if (prev != null) {                           // xong / huỷ: gỡ thông báo
                nm.cancel(nid(id));
                shown.remove(id);
            }
        }
        for (Iterator<String> it = shown.keySet().iterator(); it.hasNext(); ) {
            String id = it.next();
            if (!seen.contains(id)) { nm.cancel(nid(id)); it.remove(); }
        }
        updateNen();
        h.removeCallbacks(remind);
        if (!moi.isEmpty()) h.postDelayed(remind, REMIND_MS);
    }

    /** 2.1 — quản lý chi nhánh: thông báo sự cố / đặt phòng (đúng các tin Telegram riêng gửi quản lý), kênh riêng.
     *  im = trong giờ yên lặng (hiện nhưng không kêu; sự cố Khẩn cấp Worker đã để im=false). Bấm → mở admin.html đúng chỗ. */
    private void applyQl(JSONObject ql) {
        if (ql == null) return;
        SharedPreferences p = prefs(this);
        long moc = ql.optLong("moc", -1);
        JSONArray tb = ql.optJSONArray("tb");
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (tb != null) for (int i = 0; i < tb.length(); i++) {
            JSONObject o = tb.optJSONObject(i);
            if (o == null) continue;
            String loai = o.optString("loai"), ma = o.optString("ma");
            String key = "ql:" + loai + ":" + (ma.isEmpty() ? String.valueOf(o.optLong("id")) : ma);
            boolean im = o.optBoolean("im");
            Notification.Builder b = base(im ? CH_CAPNHAT : CH_VIEC, !im)
                    .setContentTitle(o.optString("title"))
                    .setContentText(o.optString("body"))
                    .setStyle(new Notification.BigTextStyle().bigText(o.optString("body")))
                    .setWhen(o.optLong("at", System.currentTimeMillis()))
                    .setContentIntent(openAdmin(this, nid(key), "datphong".equals(loai) ? "datphong" : "suco", ma))
                    .setCategory(Notification.CATEGORY_EVENT)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setAutoCancel(true);
            if (Build.VERSION.SDK_INT < 26 && !im) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
            nm.notify(nid(key), b.build());
        }
        if (moc >= 0 && moc != p.getLong(K_TBSAU, -1)) p.edit().putLong(K_TBSAU, moc).apply();
    }

    static PendingIntent openAdmin(Context c, int req, String kind, String ma) {
        Intent i = new Intent(c, MainActivity.class).setAction("vn.boommusicbox.bmbplayer.MO_ADMIN." + req)
                .putExtra("mo", kind).putExtra("ma", ma == null ? "" : ma)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, req, i, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
    }

    /** Còn đơn chờ tiếp nhận: 30 giây kêu lại một lần (đơn cũ nhất), tới khi có người Tiếp nhận */
    private final Runnable remind = new Runnable() {
        @Override public void run() {
            if (stopping || moi.isEmpty()) return;
            if (!uiVisible) {
                JSONObject oldest = null;
                for (JSONObject o : moi.values()) if (oldest == null || o.optLong("at") < oldest.optLong("at")) oldest = o;
                if (oldest != null) {
                    ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(nid(oldest.optString("id")), orderNotif(oldest, true));
                }
            }
            syncSoon(0);                                     // đồng thời hỏi lại (phòng khi lỡ chuông)
            h.postDelayed(this, REMIND_MS);
        }
    };

    /** Vừa bấm nút trên thông báo: quên trạng thái đang hiện để lượt đồng bộ sau vẽ lại đúng (vd "đã xác nhận" + nút Đã xong) */
    void forget(final String id) {
        h.post(() -> { shown.remove(id); moi.remove(id); syncSoon(400); });
    }

    private void shownClear() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        for (String id : shown.keySet()) nm.cancel(nid(id));
        shown.clear(); moi.clear();
        h.removeCallbacks(remind);
    }

    static int nid(String id) { return 1000 + (id.hashCode() & 0x0fffffff); }

    // ------------------------------------------------------------------ thông báo
    static void makeChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel don = new NotificationChannel(CH_DON, "Đơn gọi lễ tân mới", NotificationManager.IMPORTANCE_HIGH);
        don.setDescription("Khách gọi lễ tân — kêu chuông, nhắc lại mỗi 30 giây tới khi có người Tiếp nhận");
        don.setSound(soundUri(c), new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        don.enableVibration(true);
        don.setVibrationPattern(new long[]{0, 300, 150, 300, 150, 500});
        don.enableLights(true); don.setLightColor(Color.YELLOW);
        don.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationChannel cap = new NotificationChannel(CH_CAPNHAT, "Cập nhật đơn (im lặng)", NotificationManager.IMPORTANCE_LOW);
        cap.setDescription("Đơn đã xác nhận / kết quả bấm nút");
        cap.setShowBadge(false);
        NotificationChannel viec = new NotificationChannel(CH_VIEC, "Sự cố & đặt phòng (quản lý)", NotificationManager.IMPORTANCE_HIGH);
        viec.setDescription("Sự cố mới / đã tiếp nhận / kỹ thuật nhận việc / báo xong, đơn giữ phòng mới — cho quản lý chi nhánh");
        viec.enableVibration(true);
        viec.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(viec);
        NotificationChannel nen = new NotificationChannel(CH_NEN, "Dịch vụ nhận đơn (nền)", NotificationManager.IMPORTANCE_MIN);
        nen.setDescription("Dòng \"BMB Quầy đang nhận đơn\" — Android bắt buộc có khi app nhận đơn ở nền");
        nen.setShowBadge(false);
        nm.createNotificationChannel(don); nm.createNotificationChannel(cap); nm.createNotificationChannel(nen);
    }

    static Uri soundUri(Context c) { return Uri.parse("android.resource://" + c.getPackageName() + "/" + R.raw.chuong); }

    @SuppressWarnings("deprecation")
    private Notification.Builder base(String ch, boolean alert) { return base(this, ch, alert); }

    @SuppressWarnings("deprecation")
    static Notification.Builder base(Context c, String ch, boolean alert) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, ch) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_stat_quay).setColor(Color.rgb(139, 47, 190)).setShowWhen(true);
        if (Build.VERSION.SDK_INT < 26) {
            if (CH_DON.equals(ch) && alert) {
                b.setPriority(Notification.PRIORITY_MAX).setSound(soundUri(c)).setVibrate(new long[]{0, 300, 150, 300, 150, 500});
            } else b.setPriority(CH_NEN.equals(ch) ? Notification.PRIORITY_MIN : Notification.PRIORITY_LOW);
        }
        return b;
    }

    static PendingIntent openApp(Context c) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
    }

    @SuppressWarnings("deprecation")
    private Notification orderNotif(JSONObject o, boolean alert) {
        String st = o.optString("st"), id = o.optString("id");
        boolean moiDon = "MOI".equals(st);
        Notification.Builder b = base(moiDon && alert ? CH_DON : CH_CAPNHAT, alert)
                .setContentTitle(o.optString("title"))
                .setContentText(o.optString("body"))
                .setStyle(new Notification.BigTextStyle().bigText(o.optString("body")))
                .setWhen(o.optLong("at", System.currentTimeMillis()))
                .setContentIntent(openApp(this))
                .setOnlyAlertOnce(!alert)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setAutoCancel(false);
        JSONObject act = o.optJSONObject("act");
        if (act != null) {
            String a = moiDon ? "nhan" : "xong";
            String label = moiDon ? "✅ Tiếp nhận" : "🎉 Đã xong";
            b.addAction(new Notification.Action.Builder(R.drawable.ic_stat_quay, label, QuayActionReceiver.pending(this, id, a, act)).build());
        }
        return b.build();
    }

    private Notification nenNotif() {
        String t = connected ? "BMB Quầy đang nhận đơn" : "BMB Quầy đang kết nối…";
        String d = (branch.isEmpty() ? "" : branch + " · ") + (moi.isEmpty() ? "không có đơn chờ" : moi.size() + " đơn chờ tiếp nhận");
        return base(CH_NEN, false).setContentTitle(t).setContentText(d).setOngoing(true).setContentIntent(openApp(this)).build();
    }

    private void updateNen() {
        try { ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(ID_NEN, nenNotif()); } catch (Exception ignored) {}
    }

    /** Thông báo thử (nút "Gửi thử" trên quay.html) */
    static void test(Context c) {
        makeChannels(c);
        ((NotificationManager) c.getSystemService(NOTIFICATION_SERVICE)).notify(ID_NEN + 2, base(c, CH_DON, true)
                .setContentTitle("🔔 BMB Quầy · thử thông báo").setContentText("Đơn mới sẽ kêu chuông như thế này.")
                .setContentIntent(openApp(c)).setAutoCancel(true).build());
    }

    static boolean batteryOk(Context c) {
        if (Build.VERSION.SDK_INT < 23) return true;
        try { return ((PowerManager) c.getSystemService(POWER_SERVICE)).isIgnoringBatteryOptimizations(c.getPackageName()); }
        catch (Exception e) { return true; }
    }

    static boolean notifOk(Context c) {
        try { return ((NotificationManager) c.getSystemService(NOTIFICATION_SERVICE)).areNotificationsEnabled(); }
        catch (Exception e) { return true; }
    }

    // ------------------------------------------------------------------ HTTP
    /** POST JSON tới API Worker. Trả JSON kết quả, thêm "_status" = mã HTTP */
    static JSONObject postJson(String api, JSONObject body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(api).openConnection();
        try {
            c.setConnectTimeout(15000); c.setReadTimeout(20000);
            c.setRequestMethod("POST"); c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Origin", ORIGIN);
            byte[] data = body.toString().getBytes("UTF-8");
            try (OutputStream os = c.getOutputStream()) { os.write(data); }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String txt = "";
            if (in != null) {
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[4096]; int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                in.close();
                txt = bo.toString("UTF-8");
            }
            JSONObject r;
            try { r = new JSONObject(txt); } catch (Exception e) { r = new JSONObject(); }
            r.put("_status", code);
            return r;
        } finally { c.disconnect(); }
    }

    /** Trạng thái cho trang quầy (BMBNative.quayInfo) */
    static JSONObject info(Context c) {
        JSONObject o = new JSONObject();
        try {
            SharedPreferences p = prefs(c);
            o.put("dv", deviceId(c));
            o.put("on", hasKey(c) && self != null);
            o.put("key", hasKey(c));
            o.put("connected", connected);
            o.put("lastSync", lastSyncAt);
            o.put("branch", p.getString(K_BRANCH, ""));
            o.put("user", p.getString(K_USER, ""));
            o.put("notif", notifOk(c) ? "granted" : "denied");
            o.put("battery", batteryOk(c));
        } catch (Exception ignored) {}
        return o;
    }

}
