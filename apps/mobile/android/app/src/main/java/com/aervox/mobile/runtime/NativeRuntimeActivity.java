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
            surface.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            ViewCompat.setOnApplyWindowInsetsListener(surface, (target, insets) -> {
                androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                androidx.core.graphics.Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
                target.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                return WindowInsetsCompat.CONSUMED;
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
                case "sqlite": result = sqlite.request(command); break;
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
                default: throw new IllegalArgumentException();
            }
            return result.handle((value, error) -> error == null ? value.toString() : failure(code(error)).toString());
        } catch (Exception error) { return CompletableFuture.completedFuture(failure("INVALID_REQUEST").toString()); }
    }
    private static String code(Throwable error) {
        while ((error instanceof CompletionException || error instanceof java.util.concurrent.ExecutionException) && error.getCause() != null) error = error.getCause();
        if (error instanceof NativeModelService.ServiceException) return ((NativeModelService.ServiceException) error).code;
        if (error instanceof NativeSqliteSession.SessionException) return ((NativeSqliteSession.SessionException) error).code.name();
        return "NATIVE_FAILURE";
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
    private void shutdownNative() {
        if (!closing.compareAndSet(false, true)) return;
        if (host != null) host.close();
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
