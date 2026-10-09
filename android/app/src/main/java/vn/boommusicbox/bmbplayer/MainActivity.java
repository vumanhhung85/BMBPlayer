package vn.boommusicbox.bmbplayer;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
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
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
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
 *  - Chế độ TV: mở https://bmbplayer.boommusicbox.vn/ (màn hình phát + QR khách).
 *    Chế độ máy tính bảng: mở .../remote.html (chọn bài + gọi phục vụ, có quét QR bằng camera).
 *  - Phát có tiếng ngay, không cần chạm (setMediaPlaybackRequiresUserGesture(false)).
 *  - Toàn màn hình, giữ màn hình sáng, tự mở khi bật máy, có thể chọn làm màn hình chính.
 *  - Mất mạng / máy chủ lỗi: màn hình "Đang chờ mạng", tự tải lại khi có mạng.
 *  - WebView hỏng (máy yếu hết RAM): tự dựng lại, không văng app.
 *  - Menu ẩn cho nhân viên: nút MENU trên điều khiển, bấm QUAY LẠI 3 lần, hoặc chạm 5 lần góc trên bên phải.
 */
public class MainActivity extends Activity {

    static final String PREFS = "bmbplayer";
    static final String K_MODE = "mode";                 // "tv" | "tablet" | "" (chưa chọn)
    static final String K_AUTOSTART = "autostart";
    static final String K_ASK_OVERLAY = "askOverlay";    // số lần đã hỏi quyền tự mở

    private static final String HOST = "bmbplayer.boommusicbox.vn";
    private static final String URL_TV = "https://" + HOST + "/";
    private static final String URL_TABLET = "https://" + HOST + "/remote.html";
    private static final int MIN_WEBVIEW = 86;           // trang dùng tính năng có từ Chrome/WebView 86
    private static final int REQ_CAMERA = 7;
    private static final String VERSION = "1.0";

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
    private int backCount = 0, cornerCount = 0;
    private long lastBack = 0, lastCorner = 0;
    private int chooserLeft = 0;
    private AlertDialog openDialog;

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
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setKeepScreenOn(true);
        setContentView(root);
        hideBars();
        listenNetwork();

        mode = prefs.getString(K_MODE, "");
        if (mode.isEmpty()) {   // lần đầu: tự nhận biết TV / máy tính bảng, không hỏi (đổi sau trong menu nhân viên)
            mode = looksLikeTv() ? "tv" : "tablet";
            prefs.edit().putString(K_MODE, mode).apply();
        }
        start();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        hideBars();
        if (web == null && !mode.isEmpty()) start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideBars();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
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
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(dp(24), dp(24), dp(24), dp(24));
        box.setBackgroundColor(Color.rgb(16, 10, 34));

        TextView t = text("BMBPlayer", 30, Color.rgb(255, 210, 26), true);
        TextView s = text("Máy này dùng để làm gì?", 18, Color.WHITE, false);
        s.setPadding(0, dp(6), 0, dp(18));
        Button bTv = bigButton("📺  TV trong phòng\n(phát bài, hiện mã QR cho khách)");
        Button bTab = bigButton("📱  Máy tính bảng trong phòng\n(chọn bài + gọi phục vụ)");
        final TextView count = text("", 14, Color.rgb(170, 160, 200), false);
        count.setPadding(0, dp(16), 0, 0);
        TextView note = text("Đổi lại sau: bấm MENU trên điều khiển, hoặc bấm QUAY LẠI 3 lần.", 13, Color.rgb(140, 130, 170), false);
        note.setPadding(0, dp(6), 0, 0);

        box.addView(t); box.addView(s); box.addView(bTv); box.addView(bTab); box.addView(count); box.addView(note);
        bTv.setOnClickListener(v -> chooseMode("tv"));
        bTab.setOnClickListener(v -> chooseMode("tablet"));
        chooser = box;
        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        (tv ? bTv : bTab).requestFocus();

        chooserLeft = 20;
        final String auto = tv ? "tv" : "tablet";
        ui.post(new Runnable() {
            @Override public void run() {
                if (chooser == null) return;
                if (chooserLeft < 0) { count.setText(""); return; }           // đã có người bấm: thôi đếm
                if (chooserLeft == 0) { chooseMode(auto); return; }
                count.setText("Tự chọn \"" + (tv ? "TV trong phòng" : "Máy tính bảng") + "\" sau " + chooserLeft + " giây");
                chooserLeft--;
                ui.postDelayed(this, 1000);
            }
        });
    }

    private void chooseMode(String m) {
        mode = m;
        prefs.edit().putString(K_MODE, m).apply();
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
    }

    private String home() { return "tablet".equals(mode) ? URL_TABLET : URL_TV; }

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
        web.setBackgroundColor(Color.BLACK);
        web.setKeepScreenOn(true);
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
        s.setUserAgentString(ua + " BMBPlayerApp/" + VERSION + " (" + mode + ")");
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
        return "https".equals(u.getScheme()) && h != null && (h.equals("boommusicbox.vn") || h.endsWith(".boommusicbox.vn"));
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
                destroyWeb();
                ui.postDelayed(() -> { if (createWeb()) { applyUserAgent(); loadHome(); } }, 800);
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
        if (backCount == 1 && "tablet".equals(mode) && web != null && web.canGoBack() && chooser == null) { web.goBack(); return; }
        if (backCount == 2) Toast.makeText(this, "Bấm Quay lại thêm 1 lần để mở menu BMBPlayer", Toast.LENGTH_SHORT).show();
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
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
        labels.add("tablet".equals(mode) ? "📺  Chuyển sang chế độ TV" : "📱  Chuyển sang chế độ máy tính bảng");
        acts.add(() -> confirm("Đổi chế độ?", "tablet".equals(mode) ? "Máy này sẽ thành TV phát bài." : "Máy này sẽ thành máy tính bảng chọn bài + gọi phục vụ.",
                () -> { mode = "tablet".equals(mode) ? "tv" : "tablet"; prefs.edit().putString(K_MODE, mode).apply(); applyUserAgent(); loadHome(); }));
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
        labels.add("🗑  Xoá dữ liệu trang (gán lại phòng)");
        acts.add(() -> confirm("Xoá dữ liệu trang?", "Máy sẽ quên phòng đã gán, phải gán lại ở quầy (tab TV & phòng).", this::clearData));
        labels.add("✕  Thoát BMBPlayer"); acts.add(() -> { if (Build.VERSION.SDK_INT >= 21) finishAndRemoveTask(); else finish(); });

        AlertDialog.Builder b = new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert);
        b.setTitle("BMBPlayer " + VERSION + " · " + ("tablet".equals(mode) ? "Máy tính bảng" : "TV") + " · WebView " + webViewMajor());
        b.setItems(labels.toArray(new String[0]), (d, which) -> acts.get(which).run());
        b.setNegativeButton("Đóng", null);
        openDialog = b.create();
        openDialog.setOnDismissListener(d -> hideBars());
        openDialog.show();
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
        if ("tablet".equals(mode)) return;   // máy tính bảng không cần tự mở
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
    // Tiện ích giao diện
    // ======================================================================
    private final Runnable hideBarsRun = this::hideBars;

    @SuppressWarnings("deprecation")
    private void hideBars() {
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

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }
}
