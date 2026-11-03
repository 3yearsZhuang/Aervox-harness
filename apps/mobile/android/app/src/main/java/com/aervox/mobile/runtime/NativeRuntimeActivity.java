package com.aervox.mobile.runtime;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/** Fixed first-party asset composition. No Capacitor plugins, remote navigation,
 * JS credentials, shell commands or fallback loopback service are registered. */
public class NativeRuntimeActivity extends AppCompatActivity {
    private NativeBusinessDatabase owner;
    private NativeSqliteSession sqlite;
    private NativeModelService model;
    private NativeDeviceService device;
    private NativeSpeechService speech;
    private NativeSpeechInputService speechInput;
    private NativeNotifyService notify;
    private final java.util.concurrent.CompletableFuture<org.json.JSONObject>[] pendingPick =
        new java.util.concurrent.CompletableFuture[1];
    private androidx.activity.result.ActivityResultLauncher<String[]> pickLauncher;
    private NativePreferences preferences;
    private NativeAssetWebViewHost host;
    private String epoch;
    private final AtomicBoolean closing = new AtomicBoolean();
    private volatile boolean foreground;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        TextView loading = new TextView(this);
        loading.setText("正在打开本地会话…"); loading.setTextSize(18);
        loading.setGravity(android.view.Gravity.CENTER);
        setContentView(loading);
        model = new NativeModelService(this);
        device = new NativeDeviceService(this);
        speech = new NativeSpeechService(this);
        speechInput = new NativeSpeechInputService(this);
        notify = new NativeNotifyService(this);
        pickLauncher = registerForActivityResult(new androidx.activity.result.contract.ActivityResultContracts.OpenDocument(), uri -> {
            java.util.concurrent.CompletableFuture<org.json.JSONObject> pending = pendingPick[0];
            pendingPick[0] = null;
            if (pending == null) return;
            if (uri == null) {
                pending.completeExceptionally(new NativeFileService.FileException("FILE_PICK_CANCELLED"));
                return;
            }
            try {
                pending.complete(NativeFileService.readPickedText(this, uri));
            } catch (Exception error) {
                pending.completeExceptionally(error instanceof NativeFileService.FileException
                    ? error : new NativeFileService.FileException("FILE_READ_FAILED"));
            }
        });
        preferences = new NativePreferences(this);
        owner = new NativeBusinessDatabase(this);
        sqlite = new NativeSqliteSession(owner::open);
        try { owner.bindSession(sqlite); }
        catch (NativeBusinessDatabase.DatabaseException error) { unavailable("本地运行初始化失败。"); return; }
        sqlite.ready().whenComplete((connection, failure) -> runOnUiThread(() -> {
            if (closing.get()) return;
            if (failure != null) { unavailable("本地数据库暂不可用。原有数据已保留，请关闭后重试。"); return; }
            epoch = connection;
            host = NativeAssetWebViewHost.create(this, this::handle);
            WebView view = host.view();
            if (view == null) { unavailable("当前 WebView 不支持独立运行，请更新系统 WebView 后重试。"); return; }
            host.onRetired(() -> {
                shutdownNative();
                unavailable("界面已停止，本机数据已保留。请关闭应用后重新打开。");
            });
            // Insets belong to the native surface; Web CSS can use its full safe
            // viewport without duplicating status/navigation/IME offsets.
            // WebView padding does not resize the CSS viewport. Inset its
            // container so fixed-position UI and 100dvh also stay inside bars/IME.
            FrameLayout surface = new FrameLayout(this);
            // Full-screen adaptation: the inset padding would otherwise expose the
            // window background at the edges; paint it with the theme's page color.
            boolean night = (getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
            surface.setBackgroundColor(night ? 0xFF101318 : 0xFFFBFBFA);
            surface.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            ViewCompat.setOnApplyWindowInsetsListener(surface, (target, insets) -> {
                androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                androidx.core.graphics.Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
                // Rounded corners need explicit clearance: system bar insets do
                // not include the display radius at the left/right in landscape.
                int cornerPadding = roundedCornerPadding(insets);
                target.setPadding(
                    Math.max(bars.left, cornerPadding),
                    Math.max(bars.top, cornerPadding),
                    Math.max(bars.right, cornerPadding),
                    Math.max(Math.max(bars.bottom, keyboard.bottom), cornerPadding));
                return WindowInsetsCompat.CONSUMED;
            });
            // Window resizes (split screen, freeform, rotation) must re-dispatch
            // insets; relying on the listener alone leaves stale padding after
            // some resize paths.
            surface.addOnLayoutChangeListener((changed, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
                if (changed.getWidth() != oldRight - oldLeft || changed.getHeight() != oldBottom - oldTop) {
                    ViewCompat.requestApplyInsets(changed);
                }
            });
            setContentView(surface, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            ViewCompat.requestApplyInsets(surface);
        }));
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                View decor = getWindow().getDecorView();
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
                WebView view = host == null ? null : host.view();
                if (insets != null && insets.isVisible(WindowInsetsCompat.Type.ime())) {
                    WindowCompat.getInsetsController(getWindow(), decor).hide(WindowInsetsCompat.Type.ime());
                } else if (view != null && view.canGoBack()) view.goBack();
                else {
                    setEnabled(false);
                    try { getOnBackPressedDispatcher().onBackPressed(); }
                    finally { setEnabled(true); }
                }
            }
        });
    }
    private CompletableFuture<String> handle(JSONObject input) {
        if (closing.get()) return CompletableFuture.completedFuture(failure("CLOSED").toString());
        try {
            String operation = input.getString("op");
            JSONObject command = new JSONObject(input.toString()); command.remove("op");
            CompletableFuture<JSONObject> result;
            switch (operation) {
                case "runtime":
                    if (input.length() != 1 || epoch == null) throw new IllegalArgumentException();
                    result = CompletableFuture.completedFuture(sqlite == null || sqlite.isClosed() || sqlite.isDrained()
                        ? failure("DATABASE_UNAVAILABLE") : new JSONObject().put("kind", "runtime")
                        .put("connectionEpoch", epoch).put("sqlite", "ready").put("mode", "foreground"));
                    break;
                case "sqlite": {
                    final String requestTx = command.has("transactionId") && !command.isNull("transactionId")
                        ? command.optString("transactionId", null) : null;
                    result = sqlite.request(command).handle((value, error) -> {
                        if (error == null) return value;
                        Throwable cause = error;
                        while ((cause instanceof java.util.concurrent.CompletionException
                            || cause instanceof java.util.concurrent.ExecutionException) && cause.getCause() != null) cause = cause.getCause();
                        if (cause instanceof NativeSqliteSession.SessionException) {
                            return sqlite.rejection((NativeSqliteSession.SessionException) cause, requestTx);
                        }
                        throw new java.util.concurrent.CompletionException(cause);
                    });
                    break;
                }
                case "preferences": result = preferences.request(command); break;
                case "dispose":
                    if (input.length() != 2) throw new IllegalArgumentException();
                    result = sqlite.dispose(command.getString("connectionEpoch")); break;
                case "model":
                    if ("start".equals(command.optString("operation")) || "test".equals(command.optString("operation"))) {
                        if (!foreground) throw new IllegalStateException("NOT_FOREGROUND");
                    }
                    command.put("op", command.getString("operation")); command.remove("operation");
                    result = model.request(command).thenApply(receipt -> {
                        if ("started".equals(receipt.optString("kind")) && !foreground) model.cancelCurrent();
                        return receipt;
                    }); break;
                case "device":
                    // Device actions are foreground-only: a background tap has no
                    // visible owner and no way for the user to interrupt it.
                    if ("perform".equals(command.optString("operation")) && !foreground) {
                        throw new IllegalStateException("NOT_FOREGROUND");
                    }
                    result = device == null ? failed(new NativeDeviceService.DeviceException("CLOSED")) : device.request(command); break;
                case "speech": {
                    String speechOperation = command.optString("operation");
                    // Speaking is audible nearby and dictation has no visible owner in
                    // the background; both stay foreground-only.
                    if (("speak".equals(speechOperation) || "listen".equals(speechOperation)) && !foreground) {
                        throw new IllegalStateException("NOT_FOREGROUND");
                    }
                    if ("listen".equals(speechOperation) || "cancel".equals(speechOperation)) {
                        result = speechInput == null
                            ? failed(new NativeSpeechInputService.SpeechInputException("CLOSED"))
                            : speechInput.request(command);
                    } else {
                        result = speech == null ? failed(new NativeSpeechService.SpeechException("CLOSED")) : speech.request(command);
                    }
                    break;
                }
                case "file": {
                    if (!foreground) {
                        throw new IllegalArgumentException();
                    }
                    if ("fetchText".equals(command.optString("operation"))) {
                        String url = command.optString("url", "");
                        result = java.util.concurrent.CompletableFuture.completedFuture(NativeFileService.fetchText(url));
                        break;
                    }
                    if (!"pickText".equals(command.optString("operation"))) {
                        throw new IllegalArgumentException();
                    }
                    java.util.concurrent.CompletableFuture<org.json.JSONObject> pick = new java.util.concurrent.CompletableFuture<>();
                    pendingPick[0] = pick;
                    // The WebView bridge calls back off the main thread; launching
                    // the SAF picker requires the UI thread or it throws silently.
                    runOnUiThread(() -> {
                        try {
                            pickLauncher.launch(new String[] { "text/*", "application/json", "text/csv", "application/csv" });
                        } catch (Exception error) {
                            pendingPick[0] = null;
                            pick.completeExceptionally(new NativeFileService.FileException("FILE_PICK_UNAVAILABLE"));
                        }
                    });
                    result = pick;
                    break;
                }
                case "notification":
                    result = notify == null
                        ? failed(new NativeNotifyService.NotifyException("CLOSED"))
                        : notify.request(command);
                    break;
                case "share": {
                    // Handing text to the OS share sheet is user-visible and needs
                    // the foreground activity; nothing is written to app storage.
                    if (!"text".equals(command.optString("operation")) || !foreground) throw new IllegalArgumentException();
                    String text = command.getString("text");
                    String subject = command.optString("subject", "");
                    if (text.isEmpty() || text.length() > 300_000 || subject.length() > 120) throw new IllegalArgumentException();
                    android.content.Intent send = new android.content.Intent(android.content.Intent.ACTION_SEND)
                        .setType("text/plain").putExtra(android.content.Intent.EXTRA_TEXT, text);
                    if (!subject.isEmpty()) send.putExtra(android.content.Intent.EXTRA_SUBJECT, subject);
                    startActivity(android.content.Intent.createChooser(send, "分享会话"));
                    result = CompletableFuture.completedFuture(new JSONObject().put("kind", "share_result").put("ok", true));
                    break;
                }
                default: throw new IllegalArgumentException();
            }
            return result.handle((value, error) -> error == null ? value.toString() : failure(code(error)).toString());
        } catch (Exception error) { return CompletableFuture.completedFuture(failure("INVALID_REQUEST").toString()); }
    }
    private static String code(Throwable error) {
        while ((error instanceof CompletionException || error instanceof java.util.concurrent.ExecutionException) && error.getCause() != null) error = error.getCause();
        if (error instanceof NativeModelService.ServiceException) return ((NativeModelService.ServiceException) error).code;
        if (error instanceof NativeDeviceService.DeviceException) return ((NativeDeviceService.DeviceException) error).code;
        if (error instanceof NativeSpeechService.SpeechException) return ((NativeSpeechService.SpeechException) error).code;
        if (error instanceof NativeSpeechInputService.SpeechInputException) return ((NativeSpeechInputService.SpeechInputException) error).code;
        if (error instanceof NativeFileService.FileException) return ((NativeFileService.FileException) error).code;
        if (error instanceof NativeNotifyService.NotifyException) return ((NativeNotifyService.NotifyException) error).code;
        if (error instanceof NativeSqliteSession.SessionException) return ((NativeSqliteSession.SessionException) error).code.name();
        return "NATIVE_FAILURE";
    }
    private static CompletableFuture<JSONObject> failed(Throwable error) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        result.completeExceptionally(error);
        return result;
    }
    private static JSONObject failure(String code) {
        JSONObject result = new JSONObject();
        try { result.put("kind", "failure").put("code", code); } catch (Exception ignored) { }
        return result;
    }
    private void unavailable(String message) {
        TextView text = new TextView(this); text.setText(message); text.setTextSize(18);
        text.setPadding(64, 96, 64, 64); setContentView(text);
    }
    @Override protected void onStart() { super.onStart(); foreground = true; }
    @Override protected void onStop() {
        foreground = false;
        // M0 is foreground-only. Native cancellation also applies if JavaScript
        // is suspended before receiving visibilitychange; no background service.
        if (model != null) model.cancelCurrent();
        super.onStop();
    }
    @Override protected void onDestroy() {
        shutdownNative();
        super.onDestroy();
    }
    /**
     * Corner safety is a nudge, not a bar: the full display radius applied to
     * every side shrank the usable width by ~70px and broke the layout. Cap it
     * at a token few pixels so corners stay clear without reflowing the page.
     */
    private static int roundedCornerPadding(androidx.core.view.WindowInsetsCompat insets) {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S) return 0;
        android.view.WindowInsets platform = insets.toWindowInsets();
        if (platform == null) return 0;
        int radius = 0;
        for (int position : new int[] {
                android.view.RoundedCorner.POSITION_TOP_LEFT,
                android.view.RoundedCorner.POSITION_TOP_RIGHT,
                android.view.RoundedCorner.POSITION_BOTTOM_LEFT,
                android.view.RoundedCorner.POSITION_BOTTOM_RIGHT }) {
            android.view.RoundedCorner corner = platform.getRoundedCorner(position);
            if (corner != null) radius = Math.max(radius, corner.getRadius());
        }
        return Math.min(radius, 24);
    }

    private void shutdownNative() {
        if (!closing.compareAndSet(false, true)) return;
        if (host != null) host.close();
        if (device != null) device.close();
        if (speech != null) speech.close();
        if (speechInput != null) speechInput.close();
        if (preferences != null) preferences.close();
        CompletableFuture<Void> modelDrain = model == null ? CompletableFuture.completedFuture(null) : model.close();
        if (sqlite != null) {
            sqlite.drain().whenComplete((ignored, error) -> {
                // Never release the cross-owner lock on an unconfirmed drain.
                if (sqlite.isDrained() && owner != null) releaseOwner();
            });
        } else if (owner != null) releaseOwner();
        // Observe cleanup failure without logging credentials, SQL or content.
        modelDrain.exceptionally(error -> null);
    }
    private void releaseOwner() {
        try { owner.close(); }
        catch (NativeBusinessDatabase.DatabaseException ignored) { /* Keep failed ownership fenced. */ }
    }
}
