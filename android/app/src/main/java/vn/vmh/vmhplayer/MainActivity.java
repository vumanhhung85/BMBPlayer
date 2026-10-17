package vn.vmh.vmhplayer;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.UiModeManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * VMH Nhạc 1.2 — vỏ WebView cho trang nhac.html.
 *  - Tivi (leanback / UiMode TV / không cảm ứng): mở màn hình phát nhạc nhac.html, tự bật tiếng (không cần chạm), tự mở khi bật tivi.
 *  - Máy tính bảng (>= 600dp) và điện thoại: mở chế độ điều khiển ?mode=remote.
 * Nhận diện thiết bị giống BMBPlayer; giữ chế độ tự nhận trừ khi người dùng đổi trong menu ẩn.
 */
public class MainActivity extends Activity {
    static final String BASE = "https://bmb.id.vn/nhac.html";
    static final String VER = "1.2";

    private WebView web;
    private FrameLayout root;
    private View offline;
    private SharedPreferences sp;
    private String mode;
    private final Handler h = new Handler(Looper.getMainLooper());
    private boolean loadedOk = false;
    private BroadcastReceiver volRx;
    private Runnable volPush;
    private long lastMenuKey = 0;

    /** tv | tablet | phone */
    static String guessMode(Context c) {
        try {
            UiModeManager um = (UiModeManager) c.getSystemService(Context.UI_MODE_SERVICE);
            if (um != null && um.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) return "tv";
        } catch (Throwable ignore) { }
        PackageManager pm = c.getPackageManager();
        if (pm.hasSystemFeature("android.software.leanback") || pm.hasSystemFeature("android.hardware.type.television")) return "tv";
        if (!pm.hasSystemFeature("android.hardware.touchscreen")) return "tv";
        int sw = c.getResources().getConfiguration().smallestScreenWidthDp;
        return sw >= 600 ? "tablet" : "phone";
    }

    private String urlFor(String m) {
        return "tv".equals(m) ? BASE : BASE + "?mode=remote";
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        sp = getSharedPreferences("vmh", MODE_PRIVATE);
        mode = sp.getString("mode", null);
        if (mode == null) mode = guessMode(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideBars();

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        buildWeb();
        buildOffline();
        registerVol();
        go(getIntent());
    }

    private void buildWeb() {
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // phát có tiếng không cần chạm — lý do chính của APK
        s.setLoadWithOverviewMode(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " VMHPlayerApp/" + VER + " (" + mode + ")");
        web.addJavascriptInterface(new Bridge(), "VMHNative");
        web.addJavascriptInterface(new Bridge(), "BMBNative");   // nhac.html cũng dò tên này
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(final PermissionRequest r) {
                runOnUiThread(() -> {
                    boolean cam = false;
                    for (String x : r.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(x)) cam = true;
                    if (cam && Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, 7);
                        r.deny();
                    } else r.grant(r.getResources());
                });
            }
            @Override public void onShowCustomView(View v, CustomViewCallback cb) { }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String host = u.getHost() == null ? "" : u.getHost();
                if ("https".equals(u.getScheme()) && (host.equals("bmb.id.vn") || host.endsWith(".bmb.id.vn")
                        || host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")
                        || host.endsWith("workers.dev") || host.endsWith("google.com") || host.endsWith("gstatic.com")))
                    return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Throwable ignore) { }
                return true;
            }
            @Override public void onPageStarted(WebView v, String u, Bitmap f) { loadedOk = true; }
            @Override public void onPageFinished(WebView v, String u) { if (loadedOk) offline.setVisibility(View.GONE); pushVol(); }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) { loadedOk = false; showOffline(); }
            }
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                root.removeView(web);
                try { web.destroy(); } catch (Throwable ignore) { }
                buildWeb();
                root.addView(web, 0);
                go(null);
                return true;
            }
        });
        root.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
    }

    private void buildOffline() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setGravity(Gravity.CENTER);
        l.setBackgroundColor(Color.rgb(16, 10, 34));
        TextView t = new TextView(this);
        t.setText("Không có kết nối mạng\nVMH Nhạc sẽ tự thử lại…");
        t.setTextColor(Color.WHITE); t.setTextSize(20); t.setGravity(Gravity.CENTER);
        l.addView(t);
        Button bt = new Button(this);
        bt.setText("Thử lại");
        bt.setOnClickListener(v -> go(null));
        l.addView(bt);
        offline = l;
        offline.setVisibility(View.GONE);
        root.addView(offline, new FrameLayout.LayoutParams(-1, -1));
    }

    private boolean online() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            NetworkInfo ni = cm.getActiveNetworkInfo();
            return ni != null && ni.isConnected();
        } catch (Throwable e) { return true; }
    }

    private void showOffline() {
        offline.setVisibility(View.VISIBLE);
        h.postDelayed(() -> { if (offline.getVisibility() == View.VISIBLE) go(null); }, 8000);
    }

    private void go(Intent it) {
        String url = urlFor(mode);
        if (it != null && it.getData() != null && "bmb.id.vn".equals(it.getData().getHost())) url = it.getData().toString();
        if (!online()) { showOffline(); return; }
        offline.setVisibility(View.GONE);
        web.loadUrl(url);
    }

    @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); setIntent(i); go(i); }

    // ---- Âm lượng hệ thống <-> trang web ----
    class Bridge {
        @JavascriptInterface public int getVolume() {
            AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
            int mx = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            return mx <= 0 ? 0 : Math.round(100f * am.getStreamVolume(AudioManager.STREAM_MUSIC) / mx);
        }
        @JavascriptInterface public void setVolume(int v) {
            AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
            int mx = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(0, Math.min(mx, Math.round(mx * v / 100f))), 0);
        }
        @JavascriptInterface public String getMode() { return mode; }
    }

    private void registerVol() {
        volRx = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                h.removeCallbacks(volPush);
                volPush = MainActivity.this::pushVol;
                h.postDelayed(volPush, 120);
            }
        };
        registerReceiver(volRx, new IntentFilter("android.media.VOLUME_CHANGED_ACTION"));
    }

    private void pushVol() {
        try {
            int v = new Bridge().getVolume();
            web.evaluateJavascript("window.bmbSysVol&&window.bmbSysVol(" + v + ")", null);
        } catch (Throwable ignore) { }
    }

    // ---- Menu ẩn: giữ MENU hoặc nhấn Back 2 lần nhanh ----
    @Override public boolean onKeyDown(int k, KeyEvent e) {
        if (k == KeyEvent.KEYCODE_MENU) { menu(); return true; }
        if (k == KeyEvent.KEYCODE_BACK) {
            long n = System.currentTimeMillis();
            if (n - lastMenuKey < 1500) { menu(); lastMenuKey = 0; return true; }
            lastMenuKey = n;
            if (web.canGoBack()) { web.goBack(); return true; }
            return true;
        }
        return super.onKeyDown(k, e);
    }

    private void menu() {
        final String[] items = {"Tự nhận diện (" + guessMode(this) + ")", "Chế độ TV (phát nhạc)", "Chế độ Điều khiển (máy tính bảng / điện thoại)",
                "Tải lại", sp.getBoolean("autostart", true) ? "Tắt tự mở khi bật tivi" : "Bật tự mở khi bật tivi", "Thoát"};
        new AlertDialog.Builder(this).setTitle("VMH Nhạc " + VER + " · " + mode).setItems(items, (d, w) -> {
            if (w == 0) sp.edit().remove("mode").apply();
            else if (w == 1) sp.edit().putString("mode", "tv").apply();
            else if (w == 2) sp.edit().putString("mode", "phone").apply();
            else if (w == 4) { sp.edit().putBoolean("autostart", !sp.getBoolean("autostart", true)).apply(); return; }
            else if (w == 5) { finish(); return; }
            else { go(null); return; }
            recreate();
        }).show();
    }

    // ---- Toàn màn hình ----
    private void hideBars() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override public void onWindowFocusChanged(boolean f) { super.onWindowFocusChanged(f); if (f) hideBars(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); pushVol(); }
    @Override protected void onPause() { super.onPause(); if (!"tv".equals(mode)) { /* điện thoại: giữ nhạc không cần, trang điều khiển không phát */ } }
    @Override protected void onDestroy() {
        try { unregisterReceiver(volRx); } catch (Throwable ignore) { }
        try { web.destroy(); } catch (Throwable ignore) { }
        super.onDestroy();
    }
}
