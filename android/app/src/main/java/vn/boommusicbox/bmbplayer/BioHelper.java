package vn.boommusicbox.bmbplayer;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 2.2 — Vân tay cho trang admin.html trong app (WebView không có WebAuthn như Chrome).
 * Mật khẩu đã nhớ được mã hoá bằng khoá AES nằm trong Android Keystore, khoá chỉ dùng được SAU KHI quét vân tay
 * (setUserAuthenticationRequired) và tự mất hiệu lực nếu máy thêm/xoá vân tay. Cần Android 9 (API 28) trở lên.
 */
final class BioHelper {
    private static final String ALIAS = "bmb_admin_bio_v1";
    private static final String PREF = "bio_blob";

    interface Cb { void done(boolean ok, String payload); }

    private BioHelper() { }

    static boolean available(Context c) {
        if (Build.VERSION.SDK_INT < 28) return false;
        try {
            KeyguardManager km = (KeyguardManager) c.getSystemService(Context.KEYGUARD_SERVICE);
            if (km == null || !km.isDeviceSecure()) return false;
            if (Build.VERSION.SDK_INT >= 30) {
                BiometricManager bm = c.getSystemService(BiometricManager.class);
                return bm != null && bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS;
            }
            if (Build.VERSION.SDK_INT >= 29) {
                BiometricManager bm = c.getSystemService(BiometricManager.class);
                return bm != null && bm.canAuthenticate() == BiometricManager.BIOMETRIC_SUCCESS;
            }
            return c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_FINGERPRINT);
        } catch (Throwable t) { return false; }
    }

    static boolean has(SharedPreferences p) { return p.getString(PREF, null) != null; }

    static void clear(SharedPreferences p) {
        p.edit().remove(PREF).apply();
        try { KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null); ks.deleteEntry(ALIAS); } catch (Throwable ignored) { }
    }

    private static SecretKey newKey() throws Exception {
        try { KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null); ks.deleteEntry(ALIAS); } catch (Throwable ignored) { }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= 30) b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        else b.setUserAuthenticationValidityDurationSeconds(-1);
        kg.init(b.build());
        return kg.generateKey();
    }

    private static void prompt(final Activity a, final String title, final Cipher cipher, final BiometricPrompt.AuthenticationCallback cb, final Cb fail) {
        BiometricPrompt.Builder b = new BiometricPrompt.Builder(a).setTitle(title).setSubtitle("Boom Music Box — quản lý")
                .setNegativeButton("Huỷ", a.getMainExecutor(), (d, w) -> fail.done(false, "cancel"));
        if (Build.VERSION.SDK_INT >= 29) b.setConfirmationRequired(false);
        if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        b.build().authenticate(new BiometricPrompt.CryptoObject(cipher), new CancellationSignal(), a.getMainExecutor(), cb);
    }

    /** Mã hoá `secret` sau khi quét vân tay, cất trong prefs. cb.done(true,"") khi xong. */
    static void save(final Activity a, final SharedPreferences p, final String secret, final Cb cb) {
        try {
            SecretKey key = newKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            prompt(a, "Xác nhận để bật vân tay", cipher, new BiometricPrompt.AuthenticationCallback() {
                @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                    try {
                        Cipher c = r.getCryptoObject().getCipher();
                        byte[] ct = c.doFinal(secret.getBytes(StandardCharsets.UTF_8));
                        p.edit().putString(PREF, Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)).apply();
                        cb.done(true, "");
                    } catch (Throwable t) { cb.done(false, "enc"); }
                }
                @Override public void onAuthenticationError(int code, CharSequence msg) { cb.done(false, "err:" + msg); }
            }, cb);
        } catch (Throwable t) { cb.done(false, "init"); }
    }

    /** Quét vân tay rồi trả mật khẩu đã nhớ. */
    static void unlock(final Activity a, final SharedPreferences p, final Cb cb) {
        String blob = p.getString(PREF, null);
        if (blob == null || !blob.contains(":")) { cb.done(false, "none"); return; }
        try {
            String[] parts = blob.split(":", 2);
            final byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP), ct = Base64.decode(parts[1], Base64.NO_WRAP);
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
            SecretKey key = (SecretKey) ks.getKey(ALIAS, null);
            if (key == null) { clear(p); cb.done(false, "invalid"); return; }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            prompt(a, "Đăng nhập bằng vân tay", cipher, new BiometricPrompt.AuthenticationCallback() {
                @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                    try { cb.done(true, new String(r.getCryptoObject().getCipher().doFinal(ct), StandardCharsets.UTF_8)); }
                    catch (Throwable t) { cb.done(false, "dec"); }
                }
                @Override public void onAuthenticationError(int code, CharSequence msg) { cb.done(false, "err:" + msg); }
            }, cb);
        } catch (KeyPermanentlyInvalidatedException e) { clear(p); cb.done(false, "invalid"); }
        catch (Throwable t) { clear(p); cb.done(false, "init"); }
    }
}
