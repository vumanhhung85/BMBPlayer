package vn.boommusicbox.bmbplayer;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * BMBPlayer — vỏ WebView toàn màn hình cho TV / Android box / máy tính bảng trong phòng karaoke.
 *
 *  - Chế độ TV: mở https://bmb.id.vn/ (màn hình phát + QR khách).
 *    Chế độ máy tính bảng: mở .../remote.html (chọn bài + gọi phục vụ, có quét QR bằng camera).
 *  - Phát có tiếng ngay, không cần chạm (setMediaPlaybackRequiresUserGesture(false)).
 *  - Toàn màn hình, giữ màn hình sáng, tự mở khi bật máy, có thể chọn làm màn hình chính.
 *  - Mất mạng / máy chủ lỗi: màn hình "Đang chờ mạng", tự tải lại khi có mạng.
 *  - WebView hỏng (máy yếu hết RAM): tự dựng lại, không văng app.
 *  - Chạy lâu dài (1.9): canh trang treo (30 giây hỏi một lần, 3 phút không trả lời → dựng lại), TV dựng lại
 *    trình hiển thị lúc 4:30–5:00 sáng khi rảnh, dọn bộ nhớ đệm khi quá lớn / máy báo thiếu RAM,
 *    TV tự mở lại khi app văng, máy tính bảng nạp lại trang khi bật lại sau ≥10 phút tắt màn.
 *  - Menu ẩn cho nhân viên: nút MENU trên điều khiển, bấm QUAY LẠI 3 lần, hoặc chạm 5 lần góc trên bên phải.
 *  - 2.0 chế độ QUẦY (điện thoại tự nhận là quầy): mở quay.html; sau đăng nhập trang giao "khoá máy" cho QuayService —
 *    dịch vụ nền giữ "cái chuông" với máy chủ, đơn mới kêu chuông riêng + nút Tiếp nhận / Đã xong ngay trên thông báo.
 */
public class MainActivity extends Activity {

    static final String PREFS = "bmbplayer";
    static final String K_MODE = "mode";                 // "tv" | "tablet" | "quay" | "" (chưa chọn)
    static final String K_AUTOSTART = "autostart";
    static final String K_ASK_OVERLAY = "askOverlay";    // số lần đã hỏi quyền tự mở

    private static final String HOST = "bmb.id.vn";
    private static final String URL_TV = "https://" + HOST + "/";
    private static final String URL_TABLET = "https://" + HOST + "/remote.html";
    private static final String URL_QUAY = "https://" + HOST + "/quay.html";      // 2.0: điện thoại / máy của quầy nhận đơn
    private static final int REQ_NOTIF = 8;
    private static final int MIN_WEBVIEW = 86;           // trang dùng tính năng có từ Chrome/WebView 86
    private static final int REQ_CAMERA = 7;
    private String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Exception e) { return "?"; }
    }

    private final Handler ui = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView web;
    private View offline, chooser;
    private TextView offlineDetail;
    private String mode = "";
    private boolean loadFailed = false;
    private PermissionRequest pendingPermission;
    private ConnectivityManager.NetworkCallback netCallback;
    private BroadcastReceiver volReceiver;
    private int lastVolPct = -1;
    private int backCount = 0, cornerCount = 0;
    private long lastBack = 0, lastCorner = 0;
    private int chooserLeft = 0;
    private AlertDialog openDialog;

    // ---- 2.4 Tự cập nhật: hỏi /api/app/ver (Worker bmbplayer), tải /app.apk (R2) rồi giao cho trình cài đặt Android ----
    private static final String VER_URL = "https://" + HOST + "/api/app/ver";
    private static final String APK_URL = "https://" + HOST + "/app.apk";
    private static final long UPD_FIRST_MS = 90_000L;
    private static final long UPD_EVERY_MS = 6 * 3600_000L;
    private boolean updBusy = false;
    private int updWaitVc = 0;                                  // đang chờ người dùng bật "cài ứng dụng không rõ nguồn"

    // ---- Chạy lâu dài ----
    private static final long WD_PING_MS = 30_000L;            // hỏi trang mỗi 30 giây
    private static final long WD_STALL_MS = 3 * 60_000L;       // 3 phút không trả lời = treo
    private static final long TABLET_WAKE_RELOAD_MS = 10 * 60_000L;
    private static final long CACHE_MAX_BYTES = 150L * 1024 * 1024;
    private static boolean crashHandlerSet = false;
    private boolean resumed = false, selfKill = false;
    private long lastPong = 0, webBornAt = 0, pausedAt = 0, unrespSince = 0, goneWindow = 0;
    private int goneCount = 0;

    private final Runnable retry = new Runnable() {
        @Override public void run() {
            if (offline == null || offline.getVisibility() != View.VISIBLE) return;
            if (isOnline()) loadHome(); else ui.postDelayed(this, 5000);
        }
    };

    // ======================================================================
    // Vòng đời
    // ======================================================================
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        installCrashRestart();
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        hideBars();
        listenNetwork();
        listenVolume();

        mode = prefs.getString(K_MODE, "");
        boolean ask = false;
        if (mode.isEmpty()) {
            if (looksLikeTv()) {   // lần đầu: TV / box không cảm ứng → tự chọn TV (không ai cầm máy để hỏi)
                mode = "tv";
                prefs.edit().putString(K_MODE, mode).apply();
            } else {               // 2.7: máy cảm ứng (điện thoại, máy tính bảng 7–10 inch…) → hỏi một lần, không tự đoán sai
                ask = true;
            }
        }
        if (ask) {
            showChooser();         // chọn xong chooseMode() sẽ chạy start()
        } else {
            applyScreenPolicy();
            start();
        }
        handleOpenIntent(getIntent());
        ui.postDelayed(updCheck, UPD_FIRST_MS);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        hideBars();
        if (web == null && !mode.isEmpty()) start();
        setIntent(intent);
        handleOpenIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideBars();
        applyScreenPolicy();
        if (web != null) web.onResume();
        resumed = true;
        updateUiVisible();
        if ("quay".equals(mode)) {
            QuayService.onChange = () -> ui.post(() -> { if (web != null) web.evaluateJavascript("window.bmbQuayTrangThai&&bmbQuayTrangThai()", null); });
            if (QuayService.self == null) QuayService.start(this);
        }
        long now = SystemClock.elapsedRealtime();
        // Máy tính bảng tắt màn lâu rồi bật lại: nạp lại trang cho chắc dữ liệu mới, kết nối mới
        if ("tablet".equals(mode) && pausedAt > 0 && now - pausedAt >= TABLET_WAKE_RELOAD_MS && web != null && chooser == null) loadHome();
        pausedAt = 0;
        lastPong = now;
        ui.removeCallbacks(watchdog);
        ui.postDelayed(watchdog, WD_PING_MS);
        // Vừa bật "cho phép cài ứng dụng" trong cài đặt rồi quay lại: tải bản mới luôn
        if (updWaitVc > 0 && canInstall()) { int vc = updWaitVc; updWaitVc = 0; downloadAndInstall(vc); }
    }

    // Màn hình: TV luôn sáng; máy tính bảng KHÔNG giữ sáng — không chạm quá 3 phút thì tắt (tiết kiệm pin khi khách đã trả phòng)
    private static final long TABLET_IDLE_MS = 3 * 60 * 1000L;
    private final Runnable tabletIdle = () -> {
        try {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_OFF;   // tắt đèn nền; hệ thống ngủ theo thời gian chờ của máy
            getWindow().setAttributes(lp);
        } catch (Throwable ignored) {}
    };

    private void applyScreenPolicy() {
        ui.removeCallbacks(tabletIdle);
        boolean tab = "tablet".equals(mode), keepOn = "tv".equals(mode);
        Window w = getWindow();
        try {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
            w.setAttributes(lp);
        } catch (Throwable ignored) {}
        if (!keepOn) w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (root != null) root.setKeepScreenOn(keepOn);
        if (web != null) web.setKeepScreenOn(keepOn);
        applyWindowMode();
        if (tab) ui.postDelayed(tabletIdle, TABLET_IDLE_MS);
    }

    @Override
    protected void onPause() {
        resumed = false;
        QuayService.uiVisible = false;
        pausedAt = SystemClock.elapsedRealtime();
        ui.removeCallbacks(watchdog);
        ui.removeCallbacks(tabletIdle);
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (volReceiver != null) { try { unregisterReceiver(volReceiver); } catch (Exception ignored) {} volReceiver = null; }
        if (netCallback != null) {
            try { ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(netCallback); } catch (Exception ignored) {}
        }
        destroyWeb();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Bàn phím hiện/ẩn làm cửa sổ mất rồi lấy lại focus: nếu ẩn thanh hệ thống ngay lúc đó thì
        // kết nối bàn phím với ô nhập bị ngắt (bấm ô tìm lần đầu gõ không ăn). Chờ bàn phím ổn định rồi mới ẩn.
        ui.removeCallbacks(hideBarsRun);
        if (hasFocus) ui.postDelayed(hideBarsRun, 500);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        hideBars();
    }

    // ======================================================================
    // Màn hình chọn chế độ (lần đầu cài) — tự chọn sau 20 giây nếu không ai bấm
    // ======================================================================
    /** Lần đầu cài: TV/box → TV; màn hình rộng (cạnh ngắn ≥ 600dp) → máy tính bảng; điện thoại → Quầy (khách không cài APK) */
    private String guessMode() {
        if (looksLikeTv()) return "tv";
        int sw = getResources().getConfiguration().smallestScreenWidthDp;
        return sw >= 480 ? "tablet" : "quay";      // chỉ để GỢI Ý nút nào sáng sẵn trên màn chọn (máy 7 inch ~533–600dp trước đây bị đoán nhầm là quầy)
    }

    static String modeName(String m) { return "quay".equals(m) ? "Nhân viên quầy" : "tablet".equals(m) ? "Máy chọn bài" : "TV"; }

    private boolean looksLikeTv() {
        try {
            UiModeManager um = (UiModeManager) getSystemService(UI_MODE_SERVICE);
            if (um != null && um.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) return true;
        } catch (Exception ignored) {}
        PackageManager pm = getPackageManager();
        return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                || !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);
    }

    private void showChooser() {
        final boolean tv = looksLikeTv();
        final String suggest = guessMode();                    // nút được gợi ý (sáng sẵn): không tự chọn thay người dùng
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        sv.setBackgroundColor(Color.rgb(16, 10, 34));
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(dp(24), dp(24), dp(24), dp(24));
        sv.addView(box, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView t = text("BMBPlayer", 30, Color.rgb(255, 210, 26), true);
        TextView s = text("Máy này dùng để làm gì?", 20, Color.WHITE, false);
        s.setPadding(0, dp(6), 0, dp(18));
        Button bTv = bigButton("📺  TV trong phòng\n(phát bài, hiện mã QR cho khách)");
        Button bTab = bigButton("🎤  Máy chọn bài (đặt trong phòng)\n(khách chọn bài + gọi phục vụ)");
        Button bQuay = bigButton("👤  Nhân viên quầy\n(nhận đơn gọi lễ tân, có chuông báo)");
        TextView note = text("Chọn một lần. Đổi lại sau: bấm QUAY LẠI 3 lần liên tiếp (hoặc chạm 5 lần góc trên bên phải), chọn \"Đổi chế độ\".", 13, Color.rgb(140, 130, 170), false);
        note.setPadding(0, dp(18), 0, 0);

        box.addView(t); box.addView(s);
        if (tv) box.addView(bTv);
        box.addView(bTab); box.addView(bQuay); box.addView(note);
        bTv.setOnClickListener(v -> chooseMode("tv"));
        bTab.setOnClickListener(v -> chooseMode("tablet"));
        bQuay.setOnClickListener(v -> chooseMode("quay"));
        chooser = sv;
        root.addView(sv, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        (tv ? bTv : "quay".equals(suggest) ? bQuay : bTab).requestFocus();
        chooserLeft = -1;                                      // không đếm ngược, không tự chọn
    }

    private void chooseMode(String m) {
        mode = m;
        prefs.edit().putString(K_MODE, m).apply();
        applyScreenPolicy();
        if (chooser != null) { root.removeView(chooser); chooser = null; }
        start();
    }

    // ======================================================================
    // WebView
    // ======================================================================
    private void start() {
        if (web == null && !createWeb()) return;
        applyUserAgent();
        loadHome();
        ui.postDelayed(this::checkWebViewVersion, 1500);
        ui.postDelayed(this::maybeAskAutostart, 4000);
        ui.postDelayed(() -> trimDiskCache(false), 60_000);
    }

    private String home() { return "quay".equals(mode) ? URL_QUAY : "tablet".equals(mode) ? URL_TABLET : URL_TV; }

    private void loadHome() {
        if (web == null) { if (!createWeb()) return; applyUserAgent(); }
        loadFailed = false;
        web.loadUrl(home());
    }

    private boolean createWeb() {
        try {
            web = new WebView(this);
        } catch (Exception e) {
            // Máy đang cập nhật / thiếu "Android System WebView"
            web = null;
            showOffline("Máy chưa sẵn sàng trình hiển thị web (Android System WebView).\nĐang thử lại…");
            ui.postDelayed(() -> { if (web == null && createWeb()) { applyUserAgent(); loadHome(); } }, 10000);
            return false;
        }
        webBornAt = lastPong = SystemClock.elapsedRealtime();
        unrespSince = 0;
        if (Build.VERSION.SDK_INT >= 29) watchRenderer(web);
        web.setBackgroundColor(Color.BLACK);
        web.setKeepScreenOn("tv".equals(mode));
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                       // TV nhớ phòng đã gán, máy tính bảng nhớ phòng
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);       // phát có tiếng không cần chạm
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setTextZoom(100);                                 // không phóng chữ theo cỡ chữ hệ thống
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);           // khung YouTube cần cookie bên thứ ba
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.addJavascriptInterface(new NativeBridge(), "BMBNative");   // trang TV đọc/đặt âm lượng hệ thống
        root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.requestFocus();
        return true;
    }

    private void applyUserAgent() {
        if (web == null) return;
        WebSettings s = web.getSettings();
        String ua = s.getUserAgentString();
        int i = ua.indexOf(" BMBPlayerApp/");
        if (i >= 0) ua = ua.substring(0, i);
        s.setUserAgentString(ua + " BMBPlayerApp/" + versionName() + " (" + mode + ")");
    }

    private void destroyWeb() {
        if (web == null) return;
        try {
            root.removeView(web);
            web.stopLoading();
            web.setWebChromeClient(null);
            web.destroy();
        } catch (Exception ignored) {}
        web = null;
    }

    private static boolean allowed(Uri u) {
        if (u == null) return false;
        String h = u.getHost();
        return "https".equals(u.getScheme()) && h != null && (h.equals("bmb.id.vn") || h.endsWith(".bmb.id.vn") || h.equals("vmh.io.vn") || h.endsWith(".vmh.io.vn") || h.equals("boommusicbox.vn") || h.endsWith(".boommusicbox.vn"));
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            if (!req.isForMainFrame()) return false;
            return !allowed(req.getUrl());                  // chặn mở trang ngoài (vd bấm logo YouTube)
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return !allowed(Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            loadFailed = false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!loadFailed) hideOffline();
            updateUiVisible();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (Build.VERSION.SDK_INT >= 23 && req.isForMainFrame()) {
                failed("Lỗi mạng: " + err.getDescription());
            }
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onReceivedError(WebView view, int code, String description, String failingUrl) {
            if (Build.VERSION.SDK_INT < 23) failed("Lỗi mạng: " + description);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse resp) {
            if (req.isForMainFrame() && resp.getStatusCode() >= 400) failed("Máy chủ trả lỗi " + resp.getStatusCode());
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // Trình hiển thị bị hệ thống tắt (thường do thiếu RAM): dựng lại, không để app văng
            if (view == web) {
                long now = SystemClock.elapsedRealtime();
                if (now - goneWindow > 120_000L) { goneWindow = now; goneCount = 0; }
                goneCount++;
                if (!selfKill) record("n_gone", detail != null && detail.didCrash() ? "trình hiển thị lỗi" : "trình hiển thị bị tắt (thiếu RAM)");
                selfKill = false;
                destroyWeb();
                boolean storm = goneCount > 3;                       // hỏng liên tục: nghỉ 30 giây, tránh vòng lặp
                if (storm) showOffline("Trình hiển thị lỗi nhiều lần, thử lại sau 30 giây…");
                ui.postDelayed(() -> { if (web == null && createWeb()) { applyUserAgent(); loadHome(); } }, storm ? 30_000 : 800);
            }
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            // Chỉ cho trang của mình dùng camera (quét mã QR trên TV để gán máy tính bảng)
            boolean wantsCamera = false;
            for (String r : request.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsCamera = true;
            if (!wantsCamera || !allowed(request.getOrigin())) { request.deny(); return; }
            if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                if (pendingPermission != null) pendingPermission.deny();
                pendingPermission = request;
                requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
                return;
            }
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        }

        @Override
        public Bitmap getDefaultVideoPoster() {
            // Bỏ biểu tượng "play" xám mặc định của WebView trước khi video chạy
            Bitmap b = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            b.eraseColor(Color.TRANSPARENT);
            return b;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_NOTIF) { QuayService.fireChange(); return; }
        if (requestCode != REQ_CAMERA || pendingPermission == null) return;
        boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (ok) pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        else pendingPermission.deny();
        pendingPermission = null;
    }

    // ======================================================================
    // Mất mạng / lỗi tải trang
    // ======================================================================
    private void failed(String why) {
        loadFailed = true;
        showOffline(why);
        ui.removeCallbacks(retry);
        ui.postDelayed(retry, 5000);
    }

    private void showOffline(String detail) {
        if (offline == null) {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setGravity(Gravity.CENTER);
            box.setBackgroundColor(Color.rgb(16, 10, 34));
            box.setPadding(dp(24), dp(24), dp(24), dp(24));
            box.addView(text("BMBPlayer", 28, Color.rgb(255, 210, 26), true));
            TextView m = text("Đang chờ mạng…\nMáy sẽ tự mở lại khi có Internet.", 20, Color.WHITE, false);
            m.setPadding(0, dp(12), 0, dp(10));
            box.addView(m);
            offlineDetail = text("", 14, Color.rgb(170, 160, 200), false);
            box.addView(offlineDetail);
            Button b = bigButton("Thử lại ngay");
            b.setOnClickListener(v -> loadHome());
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = dp(18);
            box.addView(b, lp);
            offline = box;
            root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        offlineDetail.setText(detail == null ? "" : detail);
        offline.setVisibility(View.VISIBLE);
        offline.bringToFront();
    }

    private void hideOffline() {
        ui.removeCallbacks(retry);
        if (offline != null) offline.setVisibility(View.GONE);
        if (web != null) web.requestFocus();
    }

    @SuppressWarnings("deprecation")
    private boolean isOnline() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (Build.VERSION.SDK_INT >= 23) {
                Network n = cm.getActiveNetwork();
                if (n == null) return false;
                NetworkCapabilities c = cm.getNetworkCapabilities(n);
                return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            }
            NetworkInfo ni = cm.getActiveNetworkInfo();
            return ni != null && ni.isConnected();
        } catch (Exception e) {
            return true;
        }
    }

    private void listenNetwork() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            netCallback = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network network) {
                    ui.postDelayed(() -> {
                        if (offline != null && offline.getVisibility() == View.VISIBLE) loadHome();
                    }, 1500);
                }
            };
            cm.registerNetworkCallback(new NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), netCallback);
        } catch (Exception ignored) {
            netCallback = null;
        }
    }

    // ======================================================================
    // Phím / chạm mở menu ẩn
    // ======================================================================
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if ("tablet".equals(mode) && e.getAction() == KeyEvent.ACTION_DOWN) applyScreenPolicy();
        if (chooser != null && e.getAction() == KeyEvent.ACTION_DOWN) chooserLeft = -1;   // có người bấm: thôi tự chọn
        int k = e.getKeyCode();
        if (k == KeyEvent.KEYCODE_MENU || k == KeyEvent.KEYCODE_SETTINGS) {
            if (e.getAction() == KeyEvent.ACTION_UP) showMenu();
            return true;
        }
        if (k == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP && !e.isCanceled()) onBackKey();
            return true;                                    // không bao giờ thoát app bằng nút Quay lại
        }
        return super.dispatchKeyEvent(e);
    }

    private void onBackKey() {
        long now = System.currentTimeMillis();
        if (now - lastBack > 2500) backCount = 0;
        lastBack = now;
        backCount++;
        if (backCount >= 3) { backCount = 0; showMenu(); return; }
        if (backCount == 1 && !"tv".equals(mode) && web != null && web.canGoBack() && chooser == null) { web.goBack(); return; }
        if (backCount == 2) Toast.makeText(this, "Bấm Quay lại thêm 1 lần để mở menu BMBPlayer", Toast.LENGTH_SHORT).show();
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if ("tablet".equals(mode) && ev.getActionMasked() == MotionEvent.ACTION_DOWN) applyScreenPolicy();
        if (ev.getActionMasked() == MotionEvent.ACTION_DOWN) {
            if (chooser != null) chooserLeft = -1;
            int corner = dp(72);
            if (ev.getX() > root.getWidth() - corner && ev.getY() < corner) {
                long now = System.currentTimeMillis();
                if (now - lastCorner > 3000) cornerCount = 0;
                lastCorner = now;
                if (++cornerCount >= 5) { cornerCount = 0; showMenu(); }
            }
        }
        return super.dispatchTouchEvent(ev);
    }

    // ======================================================================
    // Menu nhân viên
    // ======================================================================
    private void showMenu() {
        if (openDialog != null && openDialog.isShowing()) return;
        final List<String> labels = new ArrayList<>();
        final List<Runnable> acts = new ArrayList<>();
        labels.add("⟳  Tải lại trang"); acts.add(this::loadHome);
        labels.add("⬆  Kiểm tra bản cập nhật"); acts.add(() -> checkUpdate(true));
        labels.add("⇄  Đổi chế độ (đang: " + modeName(mode) + ")"); acts.add(this::showModeMenu);
        labels.add("▦  Mở ứng dụng khác…"); acts.add(this::showApps);
        labels.add("📶  Cài đặt Wi-Fi"); acts.add(() -> openSettings(Settings.ACTION_WIFI_SETTINGS));
        labels.add("⚙  Cài đặt Android"); acts.add(() -> openSettings(Settings.ACTION_SETTINGS));
        labels.add("⌂  Chọn ứng dụng màn hình chính (Home)"); acts.add(() -> openSettings(Settings.ACTION_HOME_SETTINGS));
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
            labels.add("⏻  Cho phép tự mở khi bật máy"); acts.add(this::openOverlaySettings);
        }
        final boolean auto = prefs.getBoolean(K_AUTOSTART, true);
        labels.add(auto ? "☑  Tự mở khi bật máy: BẬT (bấm để tắt)" : "☐  Tự mở khi bật máy: TẮT (bấm để bật)");
        acts.add(() -> { prefs.edit().putBoolean(K_AUTOSTART, !auto).apply(); toast(auto ? "Đã tắt tự mở khi bật máy" : "Đã bật tự mở khi bật máy"); });
        labels.add("🧹  Dọn bộ nhớ đệm (giữ phòng đã gán)"); acts.add(() -> trimDiskCache(true));
        labels.add("ℹ  Tự phục hồi: " + statsLine()); acts.add(() -> {});
        labels.add("🗑  Xoá dữ liệu trang (gán lại phòng)");
        acts.add(() -> confirm("Xoá dữ liệu trang?", "Máy sẽ quên phòng đã gán, phải gán lại ở quầy (tab TV & phòng).", this::clearData));
        labels.add("✕  Thoát BMBPlayer"); acts.add(() -> { if (Build.VERSION.SDK_INT >= 21) finishAndRemoveTask(); else finish(); });

        AlertDialog.Builder b = new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert);
        b.setTitle("BMBPlayer " + versionName() + " · " + modeName(mode) + " · WebView " + webViewMajor());
        b.setItems(labels.toArray(new String[0]), (d, which) -> acts.get(which).run());
        b.setNegativeButton("Đóng", null);
        openDialog = b.create();
        openDialog.setOnDismissListener(d -> hideBars());
        openDialog.show();
    }

    /** Chuông đơn trong app không kêu khi trang QUẦY đang hiện trên màn hình (trang đã tự kêu); đang xem Bảo trì / Đặt phòng thì vẫn kêu */
    private void updateUiVisible() {
        String u = web != null ? web.getUrl() : null;
        QuayService.uiVisible = "quay".equals(mode) && resumed && (u == null || u.contains("/quay.html"));
    }

    /** 2.1 — quản lý chi nhánh: mở admin.html (Bảo trì / Đặt phòng) đã đăng nhập sẵn bằng vé 1 lần do Worker cấp.
     *  kind: baotri | datphong | suco (ma = mã sự cố) */
    private void moAdmin(final String kind, final String ma) {
        if (!"quay".equals(mode)) return;
        final String dk = prefs.getString(QuayService.K_DK, ""), api = prefs.getString(QuayService.K_API, QuayService.DEFAULT_API);
        if (dk == null || dk.isEmpty()) { toast("Đăng nhập màn quầy trước đã."); return; }
        new Thread(() -> {
            String url = null, err = null;
            try {
                org.json.JSONObject r = QuayService.postJson(api, new org.json.JSONObject().put("action", "app.veAdmin").put("dk", dk));
                if (r.optBoolean("ok") && r.optString("ve").length() > 10) {
                    String q = "datphong".equals(kind) ? "?tab=dat-phong" : ("suco".equals(kind) && ma != null && !ma.isEmpty() ? "?ticket=" + Uri.encode(ma) : "");
                    url = r.optString("url", "https://boommusicbox.vn/admin.html") + q + "#ve=" + r.optString("ve");
                } else err = r.optString("msg", "Không mở được Bảo trì / Đặt phòng.");
            } catch (Exception e) { err = "Không kết nối được máy chủ."; }
            final String fu = url, fe = err;
            ui.post(() -> {
                if (fu != null) { if (web == null && createWeb()) applyUserAgent(); if (web != null) web.loadUrl(fu); }
                else toast(fe);
            });
        }).start();
    }

    /** Bấm thông báo sự cố / đặt phòng → mở đúng chỗ */
    private void handleOpenIntent(Intent i) {
        if (i == null || !i.hasExtra("mo")) return;
        String kind = i.getStringExtra("mo"), ma = i.getStringExtra("ma");
        i.removeExtra("mo");
        ui.postDelayed(() -> moAdmin(kind, ma), web == null ? 1200 : 0);
    }

    private void showModeMenu() {
        final String[] keys = {"tv", "tablet", "quay"};
        final String[] names = {"📺  TV trong phòng (phát bài, hiện QR khách)", "🎤  Máy chọn bài (đặt trong phòng: chọn bài + gọi phục vụ)", "👤  Nhân viên quầy (nhận đơn gọi lễ tân, có chuông báo)"};
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Máy này dùng làm gì? (đang: " + modeName(mode) + ")")
                .setItems(names, (d, w) -> { if (!keys[w].equals(mode)) setMode(keys[w]); })
                .setNegativeButton("Đóng", null)
                .setOnDismissListener(d -> hideBars())
                .show();
    }

    private void setMode(String m) {
        if ("quay".equals(mode) && !"quay".equals(m)) QuayService.logout(this);   // thôi làm quầy: gỡ máy khỏi danh sách nhận đơn
        mode = m;
        prefs.edit().putString(K_MODE, mode).apply();
        updateUiVisible();
        applyScreenPolicy(); applyUserAgent(); loadHome();
        toast("Đã chuyển sang chế độ " + modeName(mode));
    }

    /** Quầy là điện thoại của nhân viên: hiện thanh trạng thái (xem thông báo), không mở khi máy đang khoá */
    private void applyWindowMode() {
        Window w = getWindow();
        int f = WindowManager.LayoutParams.FLAG_FULLSCREEN | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON;
        if ("quay".equals(mode)) {
            w.clearFlags(f);
            View d = w.getDecorView();
            if (d.getSystemUiVisibility() != 0) d.setSystemUiVisibility(0);
        } else w.addFlags(f);
    }

    private void confirm(String title, String msg, final Runnable yes) {
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle(title).setMessage(msg)
                .setPositiveButton("Đồng ý", (d, w) -> yes.run())
                .setNegativeButton("Huỷ", null)
                .setOnDismissListener(d -> hideBars())
                .show();
    }

    private void clearData() {
        try { WebStorage.getInstance().deleteAllData(); } catch (Exception ignored) {}
        try { CookieManager.getInstance().removeAllCookies(null); CookieManager.getInstance().flush(); } catch (Exception ignored) {}
        if (web != null) { web.clearCache(true); web.clearHistory(); }
        toast("Đã xoá dữ liệu trang");
        loadHome();
    }

    private void showApps() {
        PackageManager pm = getPackageManager();
        Set<String> seen = new HashSet<>();
        final List<Intent> launch = new ArrayList<>();
        final List<String> names = new ArrayList<>();
        String[] cats = {Intent.CATEGORY_LAUNCHER, Intent.CATEGORY_LEANBACK_LAUNCHER};
        List<String[]> rows = new ArrayList<>();
        for (String cat : cats) {
            Intent q = new Intent(Intent.ACTION_MAIN).addCategory(cat);
            List<ResolveInfo> list;
            try { list = pm.queryIntentActivities(q, 0); } catch (Exception e) { continue; }
            for (ResolveInfo ri : list) {
                String pkg = ri.activityInfo.packageName;
                if (pkg.equals(getPackageName()) || !seen.add(pkg)) continue;
                rows.add(new String[]{String.valueOf(ri.loadLabel(pm)), pkg, ri.activityInfo.name, cat});
            }
        }
        Collections.sort(rows, (a, c) -> a[0].toLowerCase(Locale.ROOT).compareTo(c[0].toLowerCase(Locale.ROOT)));
        for (String[] r : rows) {
            names.add(r[0]);
            Intent i = new Intent(Intent.ACTION_MAIN).addCategory(r[3]);
            i.setClassName(r[1], r[2]);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            launch.add(i);
        }
        if (names.isEmpty()) { toast("Không tìm thấy ứng dụng nào khác"); return; }
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Mở ứng dụng khác")
                .setItems(names.toArray(new String[0]), (d, w) -> {
                    try { startActivity(launch.get(w)); } catch (Exception e) { toast("Không mở được ứng dụng này"); }
                })
                .setNegativeButton("Đóng", null)
                .setOnDismissListener(d -> hideBars())
                .show();
    }

    private void openSettings(String action) {
        try {
            startActivity(new Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            try { startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
            catch (Exception e2) { toast("Máy này không mở được trang cài đặt"); }
        } catch (Exception e) {
            toast("Máy này không mở được trang cài đặt");
        }
    }

    // ======================================================================
    // Tự mở khi bật máy (Android 10+ cần quyền "Hiển thị trên ứng dụng khác")
    // ======================================================================
    private boolean isDefaultHome() {
        try {
            ResolveInfo ri = getPackageManager().resolveActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY);
            return ri != null && ri.activityInfo != null && getPackageName().equals(ri.activityInfo.packageName);
        } catch (Exception e) {
            return false;
        }
    }

    private void maybeAskAutostart() {
        if (Build.VERSION.SDK_INT < 29 || isFinishing()) return;
        if (!"tv".equals(mode)) return;      // máy tính bảng / quầy không cần tự mở màn hình (quầy: dịch vụ nền tự bật)
        if (!prefs.getBoolean(K_AUTOSTART, true) || Settings.canDrawOverlays(this) || isDefaultHome()) return;
        int asked = prefs.getInt(K_ASK_OVERLAY, 0);
        if (asked >= 3 || (openDialog != null && openDialog.isShowing())) return;
        prefs.edit().putInt(K_ASK_OVERLAY, asked + 1).apply();
        openDialog = new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Tự mở BMBPlayer khi bật máy?")
                .setMessage("Android đời mới chỉ cho tự mở khi bật máy nếu BMBPlayer được phép \"Hiển thị trên ứng dụng khác\".\n\n"
                        + "Bấm \"Cho phép\" → bật công tắc của BMBPlayer → bấm Quay lại.")
                .setPositiveButton("Cho phép", (d, w) -> { prefs.edit().putInt(K_ASK_OVERLAY, 9).apply(); openOverlaySettings(); })
                .setNegativeButton("Để sau", (d, w) -> prefs.edit().putInt(K_ASK_OVERLAY, 9).apply())
                .setOnDismissListener(d -> hideBars())
                .create();
        openDialog.show();
        final AlertDialog shown = openDialog;
        ui.postDelayed(() -> { if (shown.isShowing()) shown.dismiss(); }, 30000);   // TV không ai bấm: tự đóng, lần sau hỏi lại
    }

    private void openOverlaySettings() {
        if (Build.VERSION.SDK_INT < 23) return;
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e2) {
                try {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception e3) {
                    toast("Máy này không có mục cấp quyền. Hãy chọn BMBPlayer làm màn hình chính (Home).");
                }
            }
        }
    }

    // ======================================================================
    // WebView quá cũ → hướng dẫn cập nhật
    // ======================================================================
    private int webViewMajor() {
        try {
            Matcher m = Pattern.compile("Chrome/(\\d+)").matcher(WebSettings.getDefaultUserAgent(this));
            if (m.find()) return Integer.parseInt(m.group(1));
        } catch (Exception ignored) {}
        return 0;
    }

    private void checkWebViewVersion() {
        final int v = webViewMajor();
        if (v == 0 || v >= MIN_WEBVIEW || isFinishing()) return;
        String pkg = "com.google.android.webview";
        if (Build.VERSION.SDK_INT >= 26) {
            try { android.content.pm.PackageInfo pi = WebView.getCurrentWebViewPackage(); if (pi != null) pkg = pi.packageName; } catch (Exception ignored) {}
        } else if (Build.VERSION.SDK_INT >= 24) {
            pkg = "com.android.chrome";                     // Android 7–9: Chrome đảm nhận WebView
        }
        final String target = pkg;
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Cần cập nhật trình hiển thị web")
                .setMessage("Máy đang dùng WebView bản " + v + ", BMBPlayer cần bản " + MIN_WEBVIEW + " trở lên.\n\n"
                        + "Vào CH Play cập nhật \"" + ("com.android.chrome".equals(target) ? "Google Chrome" : "Android System WebView") + "\", rồi mở lại BMBPlayer.")
                .setPositiveButton("Mở CH Play", (d, w) -> {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + target)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
                    catch (Exception e) {
                        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + target)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
                        catch (Exception e2) { toast("Máy không có CH Play — cần cài bản WebView mới bằng file APK."); }
                    }
                })
                .setNegativeButton("Để sau", null)
                .setOnDismissListener(d -> hideBars())
                .show();
    }

    // ======================================================================
    // Chạy lâu dài: canh treo, dựng lại hằng đêm, dọn bộ nhớ, tự mở lại khi văng
    // ======================================================================
    /** Hỏi trang: còn trả lời không, TV đang rảnh không (không bài nào đang hát). */
    private static final String PROBE = "(function(){try{return (typeof cur==='number'&&cur<0&&!(typeof player!=='undefined'&&player&&player.getPlayerState&&player.getPlayerState()===1))?'idle':'busy'}catch(e){return 'busy'}})()";

    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            ui.removeCallbacks(this);
            ui.postDelayed(this, WD_PING_MS);
            if (!resumed || web == null || chooser != null) return;
            long now = SystemClock.elapsedRealtime();
            if (offline != null && offline.getVisibility() == View.VISIBLE) { lastPong = now; return; }   // đang chờ mạng: việc của màn hình chờ
            if (now - lastPong > WD_STALL_MS) {
                lastPong = now;
                record("n_hang", "trang không phản hồi");
                restartRenderer();
                return;
            }
            final WebView w = web;
            try {
                w.evaluateJavascript(PROBE, v -> {
                    if (w != web) return;
                    lastPong = SystemClock.elapsedRealtime();
                    maybeNightly(v);
                });
            } catch (Throwable ignored) {}
        }
    };

    /** TV: 4:30–5:00 sáng, trình hiển thị đã chạy ≥20 giờ và đang rảnh → dựng lại cho sạch bộ nhớ (trang tự nhớ phòng). */
    private void maybeNightly(String probe) {
        if (!"tv".equals(mode) || !"\"idle\"".equals(probe)) return;
        Calendar c = Calendar.getInstance();
        if (c.get(Calendar.HOUR_OF_DAY) != 4 || c.get(Calendar.MINUTE) < 30) return;
        if (SystemClock.elapsedRealtime() - webBornAt < 20 * 3600_000L) return;
        record("n_night", "làm mới hằng đêm");
        trimDiskCache(false);
        restartRenderer();
    }

    /** Dựng lại trình hiển thị: Android 10+ tắt hẳn tiến trình hiển thị (giải phóng hết RAM), máy cũ thì tạo WebView mới. */
    private void restartRenderer() {
        if (web == null) return;
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                android.webkit.WebViewRenderProcess p = web.getWebViewRenderProcess();
                if (p != null) { selfKill = true; if (p.terminate()) return; selfKill = false; }   // onRenderProcessGone dựng lại
            } catch (Throwable ignored) { selfKill = false; }
        }
        destroyWeb();
        ui.postDelayed(() -> { if (web == null && createWeb()) { applyUserAgent(); loadHome(); } }, 800);
    }

    /** Android 10+: trang không phản hồi thao tác liên tục 30 giây → tắt tiến trình hiển thị để dựng lại. */
    private void watchRenderer(WebView w) {
        try {
            w.setWebViewRenderProcessClient(new android.webkit.WebViewRenderProcessClient() {
                @Override
                public void onRenderProcessUnresponsive(WebView v, android.webkit.WebViewRenderProcess r) {
                    if (v != web) return;
                    long now = SystemClock.elapsedRealtime();
                    if (unrespSince == 0) { unrespSince = now; return; }
                    if (now - unrespSince < 30_000L || r == null) return;
                    unrespSince = 0;
                    record("n_hang", "trang đứng khi bấm");
                    selfKill = true;
                    try { if (!r.terminate()) { selfKill = false; restartRenderer(); } } catch (Throwable t) { selfKill = false; restartRenderer(); }
                }

                @Override
                public void onRenderProcessResponsive(WebView v, android.webkit.WebViewRenderProcess r) {
                    unrespSince = 0;
                }
            });
        } catch (Throwable ignored) {}
    }

    /** Bộ nhớ đệm web (ảnh, file trang) quá lớn → xoá. Không đụng dữ liệu trang (phòng đã gán, đăng nhập). */
    private void trimDiskCache(final boolean manual) {
        final File dir = getCacheDir();
        new Thread(() -> {
            final long before = dirSize(dir, 0);
            if (!manual && before < CACHE_MAX_BYTES) return;
            ui.post(() -> {
                try { if (web != null) web.clearCache(true); } catch (Throwable ignored) {}
                if (manual) {
                    new Thread(() -> {
                        long after = dirSize(dir, 0);
                        long freed = Math.max(0, before - after) / (1024 * 1024);
                        ui.post(() -> { toast("Đã dọn bộ nhớ đệm (" + freed + " MB). Phòng đã gán vẫn giữ."); loadHome(); });
                    }).start();
                } else record("n_cache", "dọn bộ nhớ đệm " + (before / (1024 * 1024)) + " MB");
            });
        }).start();
    }

    private static long dirSize(File f, int depth) {
        if (f == null || depth > 12) return 0;
        if (f.isFile()) return f.length();
        File[] kids = f.listFiles();
        if (kids == null) return 0;
        long n = 0;
        for (File k : kids) n += dirSize(k, depth + 1);
        return n;
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        // Máy báo sắp hết RAM khi đang chạy: bỏ bộ đệm trong RAM của WebView (không đụng ổ, không đụng dữ liệu trang)
        if (level == TRIM_MEMORY_RUNNING_CRITICAL && web != null) { try { web.clearCache(false); } catch (Throwable ignored) {} }
    }

    @Override
    public void onLowMemory() {
        super.onLowMemory();
        if (web != null) { try { web.clearCache(false); } catch (Throwable ignored) {} }
    }

    /** App văng (lỗi Java): TV tự mở lại sau 3 giây, tối đa 3 lần / 10 phút để không lặp vô hạn. */
    private void installCrashRestart() {
        if (crashHandlerSet) return;
        crashHandlerSet = true;
        final Context app = getApplicationContext();
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            boolean restart = false;
            try {
                SharedPreferences sp = app.getSharedPreferences(PREFS, MODE_PRIVATE);
                long now = System.currentTimeMillis();
                int n = now - sp.getLong("crashAt", 0) < 10 * 60_000L ? sp.getInt("crashN", 0) + 1 : 1;
                sp.edit().putLong("crashAt", now).putInt("crashN", n)
                        .putInt("n_crash", sp.getInt("n_crash", 0) + 1)
                        .putLong("t_last", now).putString("w_last", "app văng").commit();
                if ("tv".equals(sp.getString(K_MODE, "")) && sp.getBoolean(K_AUTOSTART, true) && n <= 3) {
                    Intent i = new Intent(app, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                    int fl = PendingIntent.FLAG_ONE_SHOT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
                    PendingIntent pi = PendingIntent.getActivity(app, 42, i, fl);
                    AlarmManager am = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
                    if (am != null) { am.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + 3000, pi); restart = true; }
                }
            } catch (Throwable ignored) {}
            if (restart || prev == null) {                     // tự mở lại: thoát êm, không hiện hộp "ứng dụng đã dừng" che TV
                android.os.Process.killProcess(android.os.Process.myPid());
                System.exit(10);
            } else prev.uncaughtException(t, e);
        });
    }

    private void record(String key, String what) {
        try {
            prefs.edit().putInt(key, prefs.getInt(key, 0) + 1)
                    .putLong("t_last", System.currentTimeMillis()).putString("w_last", what).apply();
        } catch (Throwable ignored) {}
    }

    private String statsLine() {
        int g = prefs.getInt("n_gone", 0), h = prefs.getInt("n_hang", 0), c = prefs.getInt("n_crash", 0),
            n = prefs.getInt("n_night", 0), k = prefs.getInt("n_cache", 0);
        long t = prefs.getLong("t_last", 0);
        String last = t == 0 ? "chưa lần nào" : prefs.getString("w_last", "") + " lúc "
                + new java.text.SimpleDateFormat("dd/MM HH:mm", Locale.ROOT).format(new java.util.Date(t));
        return "treo " + h + " · hiển thị " + g + " · văng " + c + " · đêm " + n + " · dọn " + k + " (cuối: " + last + ")";
    }

    // ======================================================================
    // Tiện ích giao diện
    // ======================================================================
    // ======================================================================
    // Âm lượng hệ thống dùng chung: remote / quầy / nút trên điều khiển TV
    // ======================================================================
    private int volPct() {
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (am == null) return -1;
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        if (max <= 0) return -1;
        return Math.round(am.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / max);
    }

    /** Chỉ trang admin.html của hệ thống mình mới được dùng vân tay (cầu nối này lộ cho mọi trang trong WebView) */
    private boolean adminPageNow() {
        try {
            String u = web != null ? web.getUrl() : null;
            Uri uri = u == null ? null : Uri.parse(u);
            return uri != null && allowed(uri) && uri.getPath() != null && (uri.getPath().contains("/admin") || uri.getPath().endsWith("/quay.html"));
        } catch (Exception e) { return false; }
    }

    private void bioReply(String id, boolean ok, String payload) {
        if (web == null) return;
        String js = "window.bmbBioDone&&window.bmbBioDone(" + org.json.JSONObject.quote(id == null ? "" : id) + "," + ok + "," + org.json.JSONObject.quote(payload == null ? "" : payload) + ")";
        web.evaluateJavascript(js, null);
    }

    /** Gọi từ trang web (window.BMBNative). Chỉ cho đọc/đặt âm lượng, không gì khác. */
    private class NativeBridge {
        @JavascriptInterface
        public int getVolume() { return volPct(); }

        @JavascriptInterface
        public void setVolume(int pct) {
            AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
            if (am == null) return;
            int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            if (max <= 0) return;
            int idx = Math.round(Math.max(0, Math.min(100, pct)) * max / 100f);
            if (pct > 0 && idx == 0) idx = 1;                       // kéo lên một chút thì phải có tiếng
            try { am.setStreamVolume(AudioManager.STREAM_MUSIC, idx, 0); } catch (Exception ignored) {}
        }

        // ---- 2.2 vân tay cho trang admin.html (WebView không có WebAuthn) ----
        @JavascriptInterface
        public boolean bioAvailable() { return BioHelper.available(MainActivity.this); }

        @JavascriptInterface
        public boolean bioHas() { return BioHelper.has(prefs); }

        @JavascriptInterface
        public void bioClear() { BioHelper.clear(prefs); }

        /** Lưu mật khẩu sau khi quét vân tay. Kết quả trả về window.bmbBioDone(id, ok, payload). */
        @JavascriptInterface
        public void bioSave(final String id, final String secret) {
            ui.post(() -> {
                if (!adminPageNow() || secret == null || secret.length() > 200) { bioReply(id, false, "denied"); return; }
                BioHelper.save(MainActivity.this, prefs, secret, (ok, payload) -> ui.post(() -> bioReply(id, ok, payload)));
            });
        }

        /** Quét vân tay rồi trả mật khẩu đã nhớ cho trang admin. */
        @JavascriptInterface
        public void bioUnlock(final String id) {
            ui.post(() -> {
                if (!adminPageNow()) { bioReply(id, false, "denied"); return; }
                BioHelper.unlock(MainActivity.this, prefs, (ok, payload) -> ui.post(() -> bioReply(id, ok, payload)));
            });
        }

        // ---- 2.0 chế độ Quầy (chỉ dùng khi máy đang ở chế độ Quầy) ----
        @JavascriptInterface
        public String quayInfo() { return QuayService.info(MainActivity.this).toString(); }

        /** Trang quầy vừa đăng nhập: nhận khoá máy (dk) do Worker cấp, bật dịch vụ nền nhận đơn */
        @JavascriptInterface
        public void quayBat(String dk, String api, String branch, String user) {
            if (!"quay".equals(mode) || dk == null || !dk.startsWith("dk.") || dk.length() > 600) return;
            String a = api != null && api.startsWith("https://") ? api : QuayService.DEFAULT_API;
            boolean doi = !dk.equals(prefs.getString(QuayService.K_DK, ""));
            prefs.edit().putString(QuayService.K_DK, dk).putString(QuayService.K_API, a)
                    .putString(QuayService.K_BRANCH, branch == null ? "" : branch).putString(QuayService.K_USER, user == null ? "" : user).apply();
            ui.post(() -> {
                askNotifPermission();
                QuayService s = QuayService.self;
                if (s == null) QuayService.start(MainActivity.this);
                else if (doi) s.reconnect();
                askBatteryOnce();
            });
        }

        /** Bấm Đăng xuất trên trang quầy: máy thôi nhận đơn */
        @JavascriptInterface
        public void quayTat() { ui.post(() -> QuayService.logout(MainActivity.this)); }

        @JavascriptInterface
        public void quayThu() { ui.post(() -> { askNotifPermission(); QuayService.test(MainActivity.this); }); }

        @JavascriptInterface
        public void quayCaiDat(String kind) { ui.post(() -> { if ("pin".equals(kind)) openBatterySettings(); else openNotifSettings(); }); }

        /** Quản lý chi nhánh bấm 🛠️ Bảo trì / 📋 Đặt phòng trên trang quầy */
        @JavascriptInterface
        public void quayMoAdmin(String kind) { ui.post(() -> moAdmin("datphong".equals(kind) ? "datphong" : "baotri", "")); }
    }

    private void askNotifPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            try { requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF); } catch (Exception ignored) {}
        }
    }

    /** Hỏi bỏ tối ưu pin một lần (Android hay tắt dịch vụ nền của app bị tối ưu pin); lần sau bấm nút trong bảng 🔔 */
    private void askBatteryOnce() {
        if (Build.VERSION.SDK_INT < 23 || QuayService.batteryOk(this) || prefs.getBoolean("q_ask_pin", false)) return;
        prefs.edit().putBoolean("q_ask_pin", true).apply();
        ui.postDelayed(this::openBatterySettings, 1500);
    }

    @android.annotation.SuppressLint("BatteryLife")
    private void openBatterySettings() {
        if (Build.VERSION.SDK_INT < 23) return;
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) { openSettings(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS); }
    }

    private void openNotifSettings() {
        try {
            Intent i = Build.VERSION.SDK_INT >= 26
                    ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                    : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
            startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) { openSettings(Settings.ACTION_SETTINGS); }
    }

    private final Runnable volPush = () -> {
        int v = volPct();
        if (v < 0 || v == lastVolPct || web == null) return;
        lastVolPct = v;
        web.evaluateJavascript("window.bmbSysVol&&window.bmbSysVol(" + v + ")", null);
    };

    private void listenVolume() {
        lastVolPct = volPct();
        volReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                int type = i.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", AudioManager.STREAM_MUSIC);
                if (type != AudioManager.STREAM_MUSIC) return;
                ui.removeCallbacks(volPush);
                ui.postDelayed(volPush, 120);                          // gộp các lần đổi liên tiếp khi giữ nút
            }
        };
        IntentFilter f = new IntentFilter("android.media.VOLUME_CHANGED_ACTION");
        try {
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(volReceiver, f, 0x2 /* RECEIVER_EXPORTED: phát từ hệ thống */);
            else registerReceiver(volReceiver, f);
        } catch (Exception e) { volReceiver = null; }
    }

    private final Runnable hideBarsRun = this::hideBars;

    @SuppressWarnings("deprecation")
    private void hideBars() {
        if ("quay".equals(mode)) return;                     // quầy: giữ thanh trạng thái để thấy thông báo
        View d = getWindow().getDecorView();
        int want = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
        if (d.getSystemUiVisibility() != want) d.setSystemUiVisibility(want);   // không đặt lại khi đã đúng
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        return t;
    }

    private Button bigButton(String s) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        b.setTextColor(Color.WHITE);
        b.setPadding(dp(22), dp(14), dp(22), dp(14));
        b.setMinWidth(dp(320));
        b.setFocusable(true);
        final GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(14));
        bg.setColor(Color.rgb(48, 30, 90));
        bg.setStroke(dp(2), Color.rgb(90, 70, 140));
        b.setBackground(bg);
        b.setOnFocusChangeListener((v, has) -> {                // điều khiển TV: ô đang chọn sáng viền vàng
            bg.setColor(has ? Color.rgb(124, 58, 237) : Color.rgb(48, 30, 90));
            bg.setStroke(dp(has ? 3 : 2), has ? Color.rgb(255, 210, 26) : Color.rgb(90, 70, 140));
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(10);
        b.setLayoutParams(lp);
        return b;
    }


    // ======================================================================
    // 2.4 Tự cập nhật: hỏi /api/app/ver → có bản mới → hỏi trên màn hình → tải → trình cài đặt Android
    // (Android vẫn bắt người dùng bấm "Cài đặt"; lần đầu cần bật "cho phép từ nguồn này")
    // ======================================================================
    private final Runnable updCheck = new Runnable() {
        @Override public void run() {
            ui.removeCallbacks(this);
            ui.postDelayed(this, UPD_EVERY_MS);
            checkUpdate(false);
        }
    };

    private int versionCode() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode; }
        catch (Exception e) { return 0; }
    }

    private boolean canInstall() {
        return Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls();
    }

    private static String readAll(java.io.InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) o.write(b, 0, n);
        return o.toString("UTF-8");
    }

    private void checkUpdate(final boolean manual) {
        if (updBusy) { if (manual) toast("Đang kiểm tra / tải bản mới…"); return; }
        updBusy = true;
        if (manual) toast("Đang kiểm tra bản mới…");
        new Thread(() -> {
            int vc = 0;
            String vn = "";
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(VER_URL + "?_=" + System.currentTimeMillis()).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(15000);
                c.setUseCaches(false);
                if (c.getResponseCode() == 200) {
                    org.json.JSONObject j = new org.json.JSONObject(readAll(c.getInputStream()));
                    vc = j.optInt("vc", 0);
                    vn = j.optString("vn", "");
                }
                c.disconnect();
            } catch (Exception ignored) {}
            final int fvc = vc;
            final String fvn = vn;
            ui.post(() -> {
                updBusy = false;
                if (fvc <= versionCode()) {
                    if (manual) toast(fvc == 0 ? "Chưa có bản mới được phát hành (hoặc mạng lỗi)" : "Đang dùng bản mới nhất (" + versionName() + ")");
                    return;
                }
                if (!manual && prefs.getInt("upd_skip_vc", 0) == fvc && prefs.getLong("upd_skip_until", 0) > System.currentTimeMillis()) return;
                askUpdate(fvc, fvn, manual);
            });
        }).start();
    }

    /** Trang TV / máy tính bảng ghi window.__bmbOpen = true/false (phòng đang mở hay đóng). Chưa có thì '?'. */
    private static final String PROBE_OPEN = "(function(){try{return typeof window.__bmbOpen==='boolean'?String(window.__bmbOpen):'?'}catch(e){return '?'}})()";

    /** TV / máy tính bảng trong phòng: chỉ hỏi khi PHÒNG ĐANG ĐÓNG (không để khách thấy hộp cài đặt của Android).
     *  Trang chưa báo được tình trạng phòng thì chỉ hỏi trong 9:00–12:00 (giờ nhân viên vào mở quán). Điện thoại / máy quầy hỏi ngay. */
    private void askUpdate(final int vc, final String vn, final boolean manual) {
        if (!manual && ("tv".equals(mode) || "tablet".equals(mode))) {
            if (web == null) { ui.postDelayed(() -> askUpdate(vc, vn, false), 10 * 60_000L); return; }
            web.evaluateJavascript(PROBE_OPEN, v -> {
                String s = v == null ? "" : v;
                int h = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY);
                boolean closed = s.contains("false");
                boolean unknownQuiet = s.contains("?") && h >= 9 && h < 12;
                if (closed || unknownQuiet) showUpdateDialog(vc, vn, false);
                else ui.postDelayed(() -> askUpdate(vc, vn, false), 10 * 60_000L);
            });
            return;
        }
        showUpdateDialog(vc, vn, manual);
    }

    private void showUpdateDialog(final int vc, final String vn, final boolean manual) {
        if (openDialog != null && openDialog.isShowing()) { if (!manual) ui.postDelayed(() -> askUpdate(vc, vn, false), 5 * 60_000L); return; }
        openDialog = new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Có bản BMBPlayer mới " + vn)
                .setMessage("Đang dùng bản " + versionName() + ". Cập nhật mất khoảng 1 phút, sau đó BMBPlayer tự mở lại.\n\nBấm \"Cập nhật ngay\", rồi bấm \"Cài đặt\" trên hộp của Android.")
                .setPositiveButton("Cập nhật ngay", (d, w) -> startUpdate(vc))
                .setNegativeButton("Để sau", (d, w) -> skipUpdate(vc))
                .setOnDismissListener(d -> hideBars())
                .create();
        openDialog.show();
        final AlertDialog shown = openDialog;
        ui.postDelayed(() -> { if (shown.isShowing()) { shown.dismiss(); skipUpdate(vc); } }, 180_000);   // 3 phút cho nhân viên kịp bấm; không ai bấm: hỏi lại sau
    }

    private void skipUpdate(int vc) {
        long wait = "quay".equals(mode) ? 12 * 3600_000L : 2 * 3600_000L;   // TV / máy tính bảng không ai bấm thì 2 giờ sau hỏi lại
        prefs.edit().putInt("upd_skip_vc", vc).putLong("upd_skip_until", System.currentTimeMillis() + wait).apply();
    }

    private void startUpdate(int vc) {
        if (!canInstall()) {
            updWaitVc = vc;
            toast("Bật \"Cho phép từ nguồn này\" cho BMBPlayer rồi bấm Quay lại — máy sẽ tự tải bản mới.");
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e) {
                openSettings(Settings.ACTION_SECURITY_SETTINGS);
            }
            return;
        }
        downloadAndInstall(vc);
    }

    private void downloadAndInstall(final int vc) {
        if (updBusy) return;
        updBusy = true;
        toast("Đang tải BMBPlayer bản mới…");
        new Thread(() -> {
            String err = null;
            android.content.pm.PackageInstaller.Session s = null;
            java.net.HttpURLConnection c = null;
            try {
                c = (java.net.HttpURLConnection) new java.net.URL(APK_URL + "?v=" + vc).openConnection();
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                c.setUseCaches(false);
                if (c.getResponseCode() != 200) throw new Exception("máy chủ trả " + c.getResponseCode());
                long len = c.getContentLength();
                android.content.pm.PackageInstaller pi = getPackageManager().getPackageInstaller();
                android.content.pm.PackageInstaller.SessionParams p = new android.content.pm.PackageInstaller.SessionParams(android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                p.setAppPackageName(getPackageName());
                if (len > 0) p.setSize(len);
                int id = pi.createSession(p);
                s = pi.openSession(id);
                java.io.InputStream in = c.getInputStream();
                java.io.OutputStream out = s.openWrite("bmbplayer.apk", 0, len > 0 ? len : -1);
                try {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    s.fsync(out);
                } finally {
                    try { out.close(); } catch (Exception ignored) {}
                    try { in.close(); } catch (Exception ignored) {}
                }
                Intent cb = new Intent(this, InstallReceiver.class);
                int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? 0x02000000 /* FLAG_MUTABLE: hệ thống gắn kết quả vào */ : 0);
                PendingIntent pend = PendingIntent.getBroadcast(this, id, cb, fl);
                s.commit(pend.getIntentSender());
                s.close();
                s = null;
                prefs.edit().putString("upd_msg", "Đã tải bản " + vc + ", chờ bấm Cài đặt").apply();
            } catch (Exception e) {
                err = e.getMessage();
                if (s != null) { try { s.abandon(); } catch (Exception ignored) {} }
            } finally {
                if (c != null) { try { c.disconnect(); } catch (Exception ignored) {} }
            }
            final String fe = err;
            ui.post(() -> { updBusy = false; if (fe != null) { toast("Tải bản mới lỗi: " + fe); prefs.edit().putString("upd_msg", "Tải bản mới lỗi: " + fe).apply(); } });
        }).start();
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }
}
