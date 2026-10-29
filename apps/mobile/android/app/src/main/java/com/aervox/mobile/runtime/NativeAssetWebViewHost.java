package com.aervox.mobile.runtime;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Build;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Unregistered first-party M0 owner, independent of Capacitor's default profile.
 * Only APK m0/ assets can load; there is no URL/path/server-base configuration.
 * A fresh named profile prevents a prior same-origin service worker controlling
 * the first document. Missing MULTI_PROFILE or message support is unavailable.
 *
 * Closing revokes the channel and destroys this view, not accepted host work.
 * The caller must separately drain SQL/model work. Profile deletion may be
 * asynchronous or forbidden while loaded; cleanup state never claims disk wipe.
 */
final class NativeAssetWebViewHost implements AutoCloseable {
    enum Status { READY, UNSUPPORTED, ASSETS_UNAVAILABLE, PROFILE_LIMIT, PROFILE_STATE_INVALID,
        SETUP_FAILED, RETIRED_NAVIGATION, RETIRED_RENDERER, RETIRED_LOAD_FAILURE, RETIRED_DESTROY_FAILURE, CLOSED }
    enum ProfileCleanup { NONE, RETAINED, DELETION_REQUESTED }
    private static final String REGISTRY = "aervox_m0_owned_web_profiles", KEY = "owned";
    private static final String PREFIX = "aervox_m0_";
    private static final int MAX_PROFILES = 8;
    // UI-thread bookkeeping. Loaded profiles may be undeletable until process
    // restart, so retain their exact ownership receipts and cap new creation.
    private static final Set<String> LOADED = new HashSet<>();
    private final AssetManager assets;
    private final SharedPreferences registry;
    private volatile boolean active;
    private volatile Status status = Status.SETUP_FAILED;
    private ProfileCleanup profileCleanup = ProfileCleanup.NONE;
    private ProfileStore store;
    private String profileName;
    private WebView view;
    private NativeMessageChannel channel;
    private boolean documentStarted;
    private Runnable retirementListener;
    void onRetired(Runnable listener) { requireUi(); retirementListener = listener; }

    static NativeAssetWebViewHost create(Context context, NativeMessageChannel.RequestHandler handler) {
        requireUi();
        if (context == null || handler == null) throw new IllegalArgumentException("INVALID_ASSET_HOST_INPUT");
        NativeAssetWebViewHost host = new NativeAssetWebViewHost(context);
        host.prepare(context, handler);
        return host;
    }
    private NativeAssetWebViewHost(Context context) {
        assets = context.getAssets();
        registry = context.getSharedPreferences(REGISTRY, Context.MODE_PRIVATE);
    }
    Status status() { requireUi(); return status; }
    ProfileCleanup profileCleanup() { requireUi(); return profileCleanup; }
    WebView view() { requireUi(); return active ? view : null; }
    String profileName() { requireUi(); return profileName; }

    private void prepare(Context context, NativeMessageChannel.RequestHandler handler) {
        try {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                status = Status.UNSUPPORTED; return;
            }
            try (InputStream entry = assets.open("m0/index.html", AssetManager.ACCESS_STREAMING)) { entry.read(); }
            catch (IOException missing) { status = Status.ASSETS_UNAVAILABLE; return; }
            store = ProfileStore.getInstance();
            if (!reserveFreshProfile()) return;
            view = new WebView(context);
            LOADED.add(profileName);
            WebViewCompat.setProfile(view, profileName); // Before channel and first load.
            Profile profile = WebViewCompat.getProfile(view);
            if (!profileName.equals(profile.getName())) throw new IllegalStateException("WRONG_PROFILE");
            profile.getCookieManager().setAcceptCookie(false);
            ServiceWorkerController workers = profile.getServiceWorkerController();
            workers.getServiceWorkerWebSettings().setBlockNetworkLoads(true);
            workers.getServiceWorkerWebSettings().setAllowContentAccess(false);
            workers.getServiceWorkerWebSettings().setAllowFileAccess(false);
            workers.getServiceWorkerWebSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
            workers.setServiceWorkerClient(new ServiceWorkerClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) { return blocked(); }
            });
            WebSettings settings = view.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
            settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
            settings.setBlockNetworkLoads(true); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setDomStorageEnabled(false); settings.setDatabaseEnabled(false);
            settings.setSaveFormData(false); settings.setSavePassword(false);
            settings.setGeolocationEnabled(false); settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setSupportMultipleWindows(false); settings.setMediaPlaybackRequiresUserGesture(true);
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            if (Build.VERSION.SDK_INT >= 26) view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
            view.setWebChromeClient(new WebChromeClient() {
                @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
                @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                    callback.invoke(origin, false, false);
                }
            });
            view.setDownloadListener((url, agent, disposition, mime, length) -> retire(Status.RETIRED_NAVIGATION));
            view.setWebViewClient(new Client());
            channel = NativeMessageChannel.install(view, handler);
            if (channel.status() != NativeMessageChannel.Status.READY) { retire(Status.UNSUPPORTED); return; }
            active = true; status = Status.READY;
            view.loadUrl(NativeAssetPolicy.ENTRY);
        } catch (RuntimeException failure) { retire(Status.SETUP_FAILED); }
    }

    private boolean reserveFreshProfile() {
        Set<String> owned;
        try { owned = new HashSet<>(registry.getStringSet(KEY, new HashSet<>())); }
        catch (RuntimeException invalid) { status = Status.PROFILE_STATE_INVALID; return false; }
        if (owned.size() > MAX_PROFILES || owned.stream().anyMatch(name -> !validProfileName(name))) {
            status = Status.PROFILE_STATE_INVALID; return false;
        }
        // Only exact names durably recorded by this owner are eligible. Never
        // touch the default profile, unrecorded names, or currently loaded views.
        for (String name : new HashSet<>(owned)) {
            if (LOADED.contains(name)) continue;
            try {
                if (store.getAllProfileNames().contains(name)) store.deleteProfile(name);
                owned.remove(name);
            } catch (RuntimeException retained) { /* Preserve ownership for a future process. */ }
        }
        if (!registry.edit().putStringSet(KEY, owned).commit()) { status = Status.PROFILE_STATE_INVALID; return false; }
        if (owned.size() >= MAX_PROFILES) { status = Status.PROFILE_LIMIT; return false; }
        String fresh = PREFIX + UUID.randomUUID();
        if (store.getAllProfileNames().contains(fresh)) { status = Status.SETUP_FAILED; return false; }
        owned.add(fresh);
        if (!registry.edit().putStringSet(KEY, owned).commit()) { status = Status.PROFILE_STATE_INVALID; return false; }
        profileName = fresh; profileCleanup = ProfileCleanup.RETAINED;
        return true;
    }
    private static boolean validProfileName(String name) {
        return name != null && name.matches("aervox_m0_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    }

    private final class Client extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView source, WebResourceRequest request) {
            if (!active || source != view || !"GET".equals(request.getMethod())) return blocked();
            String path = NativeAssetPolicy.assetPath(request.getUrl().toString());
            if (path == null || request.isForMainFrame() && !"m0/index.html".equals(path)) return blocked();
            try {
                return response(200, "OK", NativeAssetPolicy.mime(path), assets.open(path, AssetManager.ACCESS_STREAMING));
            } catch (IOException missing) { return response(404, "Not Found", "text/plain", new ByteArrayInputStream(new byte[0])); }
        }
        @Override public WebResourceResponse shouldInterceptRequest(WebView source, String url) { return blocked(); }
        @Override public boolean shouldOverrideUrlLoading(WebView source, WebResourceRequest request) {
            if (request.isForMainFrame()) retire(Status.RETIRED_NAVIGATION);
            return true;
        }
        @Override public boolean shouldOverrideUrlLoading(WebView source, String url) { retire(Status.RETIRED_NAVIGATION); return true; }
        @Override public void onPageStarted(WebView source, String url, Bitmap icon) {
            if (!active || source != view) return;
            if (documentStarted || !NativeAssetPolicy.ENTRY.equals(url)) { retire(Status.RETIRED_NAVIGATION); return; }
            documentStarted = true;
        }
        @Override public void onReceivedSslError(WebView source, SslErrorHandler handler, SslError error) {
            handler.cancel(); retire(Status.RETIRED_LOAD_FAILURE);
        }
        @Override public void onReceivedError(WebView source, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) retire(Status.RETIRED_LOAD_FAILURE);
        }
        @Override public boolean onRenderProcessGone(WebView source, RenderProcessGoneDetail detail) {
            retire(Status.RETIRED_RENDERER); return true;
        }
    }
    private static WebResourceResponse blocked() {
        return response(403, "Forbidden", "text/plain", new ByteArrayInputStream(new byte[0]));
    }
    private static WebResourceResponse response(int status, String reason, String mime, InputStream stream) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Security-Policy", NativeAssetPolicy.CSP);
        headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Referrer-Policy", "no-referrer");
        return new WebResourceResponse(mime, mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml")
            ? "UTF-8" : null, status, reason, headers, stream);
    }

    /** UI thread. Native permission is revoked synchronously; destroying a view
     * and requesting profile deletion do not prove native-work drain/disk wipe. */
    @Override public void close() { requireUi(); retire(Status.CLOSED); }
    private void retire(Status reason) {
        requireUi();
        if (view == null && channel == null) {
            if (status == Status.READY) status = reason;
            cleanupProfile(); return;
        }
        active = false; status = reason;
        if (channel != null) { channel.close(); channel = null; }
        WebView retired = view; view = null;
        if (retired != null) {
            try { retired.stopLoading(); }
            catch (RuntimeException ignored) { /* Permission is already revoked. */ }
            try {
                if (retired.getParent() instanceof ViewGroup) ((ViewGroup) retired.getParent()).removeView(retired);
                retired.destroy();
            } catch (RuntimeException failed) { status = Status.RETIRED_DESTROY_FAILURE; }
        }
        cleanupProfile();
        Runnable listener = retirementListener; retirementListener = null;
        if (listener != null) listener.run();
    }
    private void cleanupProfile() {
        if (profileName == null || store == null) return;
        try {
            if (store.getAllProfileNames().contains(profileName)) store.deleteProfile(profileName);
            Set<String> owned = new HashSet<>(registry.getStringSet(KEY, new HashSet<>()));
            owned.remove(profileName);
            if (registry.edit().putStringSet(KEY, owned).commit()) {
                profileCleanup = ProfileCleanup.DELETION_REQUESTED; LOADED.remove(profileName);
            }
        } catch (RuntimeException retained) { profileCleanup = ProfileCleanup.RETAINED; }
    }
    private static void requireUi() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("ASSET_HOST_REQUIRES_UI_THREAD");
    }
}
