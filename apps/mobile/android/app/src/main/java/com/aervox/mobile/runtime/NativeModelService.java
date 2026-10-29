package com.aervox.mobile.runtime;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Build;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.util.JsonReader;
import android.util.JsonToken;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.InputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.StringReader;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONException;
import org.json.JSONTokener;

/** Foreground, native-owned text model transport. A WebView can select only the
 * operations below: it cannot read a key or choose a destination/header. Closing
 * revokes admission immediately; completion additionally proves worker drain.
 */
public final class NativeModelService {
    public static final class ServiceException extends Exception {
        public final String code;
        ServiceException(String value) { super(value); code = value; }
    }
    private static final int MAX_REQUESTS = 8, MAX_MESSAGES = 128;
    private static final int MAX_OWNED_IDS = 128, MAX_POLL_BYTES = 512 * 1024;
    private static final int CONNECTION_TEST_TIMEOUT_MS = 10_000;
    interface ConnectionFactory { HttpsURLConnection open(URL endpoint) throws IOException; }
    private final ConnectionFactory connections;
    private final Object gate = new Object();
    private final Context context;
    private volatile Activity activity;
    private final NativeCredentialStore testStore;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor controls = new ThreadPoolExecutor(1, 1, 0,
        TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(MAX_REQUESTS), task -> new Thread(task, "aervox-model-control"));
    private final ExecutorService network = Executors.newSingleThreadExecutor(task -> new Thread(task, "aervox-model-stream"));
    private final ScheduledThreadPoolExecutor deadlines = new ScheduledThreadPoolExecutor(1);
    private final Set<String> ownedIds = new HashSet<>();
    private int pending;
    private boolean closed, configuring, networkBusy;
    private Run current, diagnostic;
    private AlertDialog dialog;
    private CompletableFuture<JSONObject> configuration;
    private CompletableFuture<Void> closure;

    public NativeModelService(Activity owner) {
        if (owner == null) throw new IllegalArgumentException("INVALID_OWNER");
        activity = owner; context = owner.getApplicationContext(); testStore = null;
        connections = endpoint -> (HttpsURLConnection) endpoint.openConnection();
        deadlines.setRemoveOnCancelPolicy(true);
    }
    /** Package-only tests use an isolated credential namespace and no native UI. */
    NativeModelService(Context owner, NativeCredentialStore store) {
        this(owner, store, endpoint -> (HttpsURLConnection) endpoint.openConnection());
    }
    /** The connection seam is native-only; the WebView cannot select it. */
    NativeModelService(Context owner, NativeCredentialStore store, ConnectionFactory factory) {
        context = owner.getApplicationContext(); testStore = store; connections = factory;
        deadlines.setRemoveOnCancelPolicy(true);
    }

    public CompletableFuture<JSONObject> request(JSONObject body) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        final JSONObject request;
        try {
            if (body == null || bytes(body.toString()) > NativeModelServicePolicy.MAX_INPUT_BYTES) throw failure("INVALID_REQUEST");
            request = parseObject(body.toString(), NativeModelServicePolicy.MAX_INPUT_BYTES);
        } catch (Exception ignored) { result.completeExceptionally(failure("INVALID_REQUEST")); return result; }
        synchronized (gate) {
            if (closed) { result.completeExceptionally(failure("CLOSED")); return result; }
            if (pending >= MAX_REQUESTS) { result.completeExceptionally(failure("QUEUE_FULL")); return result; }
            pending++;
        }
        result.whenComplete((value, error) -> { synchronized (gate) { pending--; } });
        submit(() -> {
            try {
                checkOpen();
                String op = string(request, "op");
                switch (op) {
                    case "summary": exact(request, "op"); result.complete(summary()); break;
                    case "configure": exact(request, "op"); configure(result); break;
                    case "start": result.complete(start(request)); break;
                    case "test": exact(request, "op"); testConnection(result); break;
                    case "poll": result.complete(poll(request)); break;
                    case "cancel": result.complete(cancel(request)); break;
                    default: throw failure("INVALID_REQUEST");
                }
            } catch (Exception error) { result.completeExceptionally(safe(error)); }
        }, result);
        return result;
    }

    private NativeCredentialStore store() throws Exception {
        return testStore == null ? new NativeCredentialStore(context) : testStore;
    }
    private Config load() throws Exception {
        byte[] record;
        try { record = store().get(NativeCredentialStore.Slot.PRIMARY_MODEL); }
        catch (NativeCredentialStore.CredentialException ignored) { throw failure("CREDENTIAL_RECOVERY_REQUIRED"); }
        if (record == null) return null;
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(record)).toString();
            JSONObject object = parseObject(text, 8192);
            exact(object, "version", "endpoint", "model", "key");
            if (!(object.get("version") instanceof Integer) || object.getInt("version") != 1) throw failure("CREDENTIAL_RECOVERY_REQUIRED");
            String endpoint = string(object, "endpoint"), model = string(object, "model"), key = string(object, "key");
            char[] checkedKey = key.toCharArray();
            try {
                if (!endpoint.equals(NativeModelServicePolicy.endpoint(endpoint)) || !NativeModelServicePolicy.model(model)
                    || !NativeModelServicePolicy.credential(checkedKey)) throw failure("CREDENTIAL_RECOVERY_REQUIRED");
            } finally { Arrays.fill(checkedKey, '\0'); }
            return new Config(endpoint, model, key.getBytes(StandardCharsets.US_ASCII));
        } catch (Exception ignored) { throw failure("CREDENTIAL_RECOVERY_REQUIRED"); }
        finally { Arrays.fill(record, (byte) 0); }
    }
    private static final class Config implements AutoCloseable {
        final String endpoint, model;
        final byte[] key;
        Config(String address, String name, byte[] secret) { endpoint = address; model = name; key = secret; }
        public void close() { Arrays.fill(key, (byte) 0); }
    }
    private JSONObject summary() throws Exception {
        Config config = load();
        try {
            JSONObject value = new JSONObject().put("kind", "summary").put("hasCredential", config != null);
            if (config != null) value.put("endpoint", config.endpoint).put("model", config.model);
            return value;
        } finally { if (config != null) config.close(); }
    }

    private void configure(CompletableFuture<JSONObject> result) throws Exception {
        final Config prior;
        synchronized (gate) {
            if (configuring || networkBusy) throw failure("BUSY");
            if (activity == null) throw failure("UI_UNAVAILABLE");
            configuring = true; configuration = result;
        }
        try { prior = load(); }
        catch (Exception error) { synchronized (gate) { configuring = false; configuration = null; } throw error; }
        result.whenComplete((value, error) -> {
            if (prior != null) prior.close();
            synchronized (gate) { if (configuration == result) { configuring = false; configuration = null; } }
        });
        main.post(() -> showConfiguration(prior, result));
    }
    private void showConfiguration(Config prior, CompletableFuture<JSONObject> result) {
        Activity owner = activity;
        synchronized (gate) {
            if (closed || owner == null || owner.isFinishing() || owner.isDestroyed()) {
                finishConfiguration(result, null, failure("UI_UNAVAILABLE")); return;
            }
        }
        try {
            LinearLayout fields = new LinearLayout(owner); fields.setOrientation(LinearLayout.VERTICAL);
            int inset = dp(owner, 24); fields.setPadding(inset, dp(owner, 8), inset, dp(owner, 8));
            TextView description = new TextView(owner);
            description.setText("模型请求由手机直接发送。密钥仅保存在 Android 加密存储中。\n填写兼容 OpenAI 的 HTTPS 基础地址，例如 https://api.openai.com/v1。");
            description.setTextSize(14); fields.addView(description);
            EditText endpoint = field(owner, fields, "HTTPS 基础地址", false);
            endpoint.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
            endpoint.setText(prior == null ? "https://api.openai.com/v1" : prior.endpoint);
            EditText model = field(owner, fields, "模型名称", false);
            model.setText(prior == null ? "" : prior.model);
            EditText key = field(owner, fields, prior == null ? "API 密钥" : "API 密钥（留空沿用）", true);
            ScrollView scroll = new ScrollView(owner); scroll.addView(fields);
            AlertDialog created = new AlertDialog.Builder(owner).setTitle("手机模型配置").setView(scroll)
                .setNegativeButton("取消", (ignored, which) -> finishConfiguration(result, cancelledSummary(), null))
                .setPositiveButton("保存", null).create();
            created.setOnCancelListener(ignored -> finishConfiguration(result, cancelledSummary(), null));
            created.setOnDismissListener(ignored -> {
                // System dismissal or owner destruction is cancellation too.
                if (!result.isDone()) finishConfiguration(result, cancelledSummary(), null);
                key.setText("");
                synchronized (gate) { if (dialog == created) dialog = null; }
            });
            created.setOnShowListener(ignored -> {
                created.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                GradientDrawable surface = new GradientDrawable(); surface.setColor(themeColor(owner, android.R.attr.colorBackground, Color.WHITE));
                surface.setCornerRadius(dp(owner, 28)); created.getWindow().setBackgroundDrawable(surface);
                created.getButton(AlertDialog.BUTTON_POSITIVE).setMinHeight(dp(owner, 48));
                created.getButton(AlertDialog.BUTTON_NEGATIVE).setMinHeight(dp(owner, 48));
                created.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                    byte[] secret = null;
                    try {
                        String address = NativeModelServicePolicy.endpoint(endpoint.getText().toString().trim());
                        String name = model.getText().toString().trim();
                        if (!NativeModelServicePolicy.model(name)) { model.setError("请输入有效模型名称"); return; }
                        char[] entered = new char[key.length()]; key.getText().getChars(0, key.length(), entered, 0);
                        try {
                            if (entered.length == 0 && prior != null && address.equals(prior.endpoint)) secret = Arrays.copyOf(prior.key, prior.key.length);
                            else {
                                if (!NativeModelServicePolicy.credential(entered)) { key.setError("请输入密钥；更换地址时需重新输入"); return; }
                                secret = new String(entered).getBytes(StandardCharsets.US_ASCII);
                            }
                        } finally { Arrays.fill(entered, '\0'); }
                        final Config replacement = new Config(address, name, secret); secret = null;
                        created.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
                        created.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(false);
                        created.setCancelable(false); key.setText("");
                        if (!submit(() -> saveConfiguration(replacement, result, created), result)) {
                            replacement.close(); created.dismiss();
                        }
                    } catch (NativeModelServicePolicy.Rejected error) {
                        endpoint.setError(error.code.equals("ENDPOINT_INCLUDES_COMPLETION_PATH")
                            ? "这里只填写基础地址，请去掉末尾的 /chat/completions" : "请输入有效的 HTTPS 基础地址");
                    }
                    catch (Exception ignoredError) { finishConfiguration(result, null, failure("CONFIGURATION_FAILED")); created.dismiss(); }
                    finally { if (secret != null) Arrays.fill(secret, (byte) 0); }
                });
            });
            synchronized (gate) {
                if (closed) { finishConfiguration(result, null, failure("CLOSED")); return; }
                dialog = created;
            }
            created.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            created.show();
        } catch (Exception ignored) { finishConfiguration(result, null, failure("UI_UNAVAILABLE")); }
    }
    private void saveConfiguration(Config replacement, CompletableFuture<JSONObject> result, AlertDialog created) {
        byte[] record = null;
        try {
            checkOpen();
            // load() validates the application payload as well as the encrypted envelope.
            Config evidence = load(); if (evidence != null) evidence.close();
            record = new JSONObject().put("version", 1).put("endpoint", replacement.endpoint).put("model", replacement.model)
                .put("key", new String(replacement.key, StandardCharsets.US_ASCII)).toString().getBytes(StandardCharsets.UTF_8);
            store().put(NativeCredentialStore.Slot.PRIMARY_MODEL, record);
            finishConfiguration(result, summary(), null);
        } catch (Exception error) { finishConfiguration(result, null, safe(error)); }
        finally {
            if (record != null) Arrays.fill(record, (byte) 0); replacement.close();
            main.post(created::dismiss);
        }
    }
    private static JSONObject cancelledSummary() {
        try { return new JSONObject().put("kind", "configuration_cancelled"); }
        catch (Exception ignored) { throw new IllegalStateException("JSON_UNAVAILABLE"); }
    }
    private void finishConfiguration(CompletableFuture<JSONObject> result, JSONObject value, Exception error) {
        synchronized (gate) { if (configuration == result) { configuration = null; configuring = false; } }
        if (error != null) result.completeExceptionally(error); else result.complete(value);
    }
    private static EditText field(Activity owner, LinearLayout parent, String hint, boolean secret) {
        EditText input = new EditText(owner); input.setSingleLine(true); input.setHint(hint); input.setTextSize(16);
        input.setMinHeight(dp(owner, 56)); input.setPadding(dp(owner, 16), dp(owner, 12), dp(owner, 16), dp(owner, 12));
        input.setInputType(InputType.TYPE_CLASS_TEXT | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS));
        input.setImeOptions(EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING | EditorInfo.IME_ACTION_NEXT);
        if (Build.VERSION.SDK_INT >= 26) input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        input.setSaveEnabled(false); input.setLongClickable(!secret);
        GradientDrawable shape = new GradientDrawable(); shape.setColor(Color.TRANSPARENT); shape.setCornerRadius(dp(owner, 16));
        shape.setStroke(dp(owner, 1), themeColor(owner, android.R.attr.textColorSecondary, Color.GRAY)); input.setBackground(shape);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(owner, 16); parent.addView(input, params);
        return input;
    }
    private static int dp(Context owner, int value) { return Math.round(value * owner.getResources().getDisplayMetrics().density); }
    private static int themeColor(Context owner, int attribute, int fallback) {
        TypedValue value = new TypedValue();
        if (!owner.getTheme().resolveAttribute(attribute, value, true)) return fallback;
        if (value.type >= TypedValue.TYPE_FIRST_COLOR_INT && value.type <= TypedValue.TYPE_LAST_COLOR_INT) return value.data;
        try { return owner.getColor(value.resourceId); } catch (Exception ignored) { return fallback; }
    }

    private static final class Event {
        final int sequence;
        final String type, data, code;
        Event(int order, String kind, String text, String reason) { sequence = order; type = kind; data = text; code = reason; }
        JSONObject json() throws Exception {
            JSONObject value = new JSONObject().put("sequence", sequence).put("type", type);
            if (data != null) value.put("data", data); if (code != null) value.put("code", code); return value;
        }
    }
    private static final class Run {
        final String id, digest;
        final ArrayList<Event> events = new ArrayList<>();
        String status = "running";
        volatile HttpsURLConnection connection;
        final CompletableFuture<JSONObject> diagnosticResult;
        final long startedNanos = System.nanoTime();
        String terminalCode;
        boolean observedContent;
        int eventBytes;
        Run(String identity, String hash) { this(identity, hash, null); }
        Run(String identity, String hash, CompletableFuture<JSONObject> result) { id = identity; digest = hash; diagnosticResult = result; }
        boolean running() { return status.equals("running"); }
    }
    private JSONObject start(JSONObject request) throws Exception {
        exactOptional(request, new String[]{"op", "requestId", "messages"}, "temperature", "maxTokens");
        String id = identity(request);
        JSONArray messages = messages(request.get("messages"));
        JSONObject payload = new JSONObject().put("messages", messages).put("stream", true);
        if (request.has("temperature")) {
            Object number = request.get("temperature");
            if (!(number instanceof Number) || !Double.isFinite(((Number) number).doubleValue())
                || ((Number) number).doubleValue() < 0 || ((Number) number).doubleValue() > 2) throw failure("INVALID_REQUEST");
            payload.put("temperature", number);
        }
        if (request.has("maxTokens")) {
            long value = integer(request, "maxTokens"); if (value < 1 || value > 32768) throw failure("INVALID_REQUEST");
            payload.put("max_tokens", value);
        }
        String digest = hex(MessageDigest.getInstance("SHA-256").digest(payload.toString().getBytes(StandardCharsets.UTF_8)));
        synchronized (gate) {
            if (configuring) throw failure("BUSY");
            if (current != null && current.id.equals(id)) {
                if (!current.digest.equals(digest)) throw failure("REQUEST_CONFLICT");
                return started(id);
            }
            if (ownedIds.contains(id)) throw failure("REQUEST_EXPIRED");
            if (networkBusy) throw failure("BUSY");
            if (ownedIds.size() >= MAX_OWNED_IDS) throw failure("OWNER_LIMIT");
        }
        Config config = load(); if (config == null) throw failure("MODEL_NOT_CONFIGURED");
        byte[] body = null;
        try {
            payload.put("model", config.model); body = payload.toString().getBytes(StandardCharsets.UTF_8);
            if (body.length > NativeModelServicePolicy.MAX_INPUT_BYTES) throw failure("INVALID_REQUEST");
            Run run = new Run(id, digest);
            synchronized (gate) { if (closed) throw failure("CLOSED"); current = run; ownedIds.add(id); networkBusy = true; }
            final byte[] ownedBody = body;
            network.execute(() -> stream(run, config, ownedBody)); body = null;
            return started(id);
        } catch (Exception error) {
            synchronized (gate) { networkBusy = false; if (current != null && current.id.equals(id)) terminal(current, "failed", "CLOSED"); }
            config.close(); if (body != null) Arrays.fill(body, (byte) 0); throw error;
        }
    }
    /** A diagnostic owns no conversation/request receipt and accepts no content. */
    private void testConnection(CompletableFuture<JSONObject> result) throws Exception {
        synchronized (gate) { if (configuring || networkBusy) throw failure("BUSY"); }
        Config config = load(); if (config == null) throw failure("MODEL_NOT_CONFIGURED");
        byte[] body = null;
        try {
            body = new JSONObject().put("model", config.model).put("stream", true).put("max_tokens", 32)
                .put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", "Reply with OK.")))
                .toString().getBytes(StandardCharsets.UTF_8);
            Run run = new Run("connection-test", "", result);
            synchronized (gate) { if (closed) throw failure("CLOSED"); diagnostic = run; networkBusy = true; }
            final byte[] ownedBody = body;
            network.execute(() -> stream(run, config, ownedBody)); body = null;
        } catch (Exception error) {
            synchronized (gate) { diagnostic = null; networkBusy = false; }
            config.close(); if (body != null) Arrays.fill(body, (byte) 0); throw error;
        }
    }
    private static JSONObject started(String id) throws Exception { return new JSONObject().put("kind", "started").put("requestId", id); }
    private JSONObject poll(JSONObject request) throws Exception {
        exact(request, "op", "requestId", "afterSequence"); String id = identity(request);
        long cursor = integer(request, "afterSequence");
        synchronized (gate) {
            Run run = requireRun(id); if (cursor < 0 || cursor > run.events.size()) throw failure("INVALID_CURSOR");
            JSONArray events = new JSONArray(); int budget = 0, next = (int) cursor;
            for (int i = next; i < run.events.size() && events.length() < 64; i++) {
                JSONObject value = run.events.get(i).json(); int size = bytes(value.toString());
                if (events.length() != 0 && budget + size > MAX_POLL_BYTES) break;
                events.put(value); budget += size; next = i + 1;
            }
            return new JSONObject().put("kind", "chunks").put("requestId", id).put("events", events)
                .put("nextSequence", next).put("status", run.status);
        }
    }
    private JSONObject cancel(JSONObject request) throws Exception {
        exact(request, "op", "requestId"); String id = identity(request); final Run run;
        synchronized (gate) { run = requireRun(id); terminal(run, "cancelled", null); }
        disconnect(run);
        return new JSONObject().put("kind", "cancelled").put("requestId", id).put("status", run.status);
    }
    private Run requireRun(String id) throws Exception { if (current == null || !current.id.equals(id)) throw failure("REQUEST_EXPIRED"); return current; }
    private void stream(Run run, Config config, byte[] body) {
        ScheduledFuture<?> timeout = null;
        try {
            int deadline = run.diagnosticResult == null ? NativeModelServicePolicy.DEADLINE_MS : CONNECTION_TEST_TIMEOUT_MS;
            timeout = deadlines.schedule(() -> { synchronized (gate) { terminal(run, "failed", "DEADLINE_EXCEEDED"); } disconnect(run); },
                deadline, TimeUnit.MILLISECONDS);
            HttpsURLConnection connection = connections.open(new URL(config.endpoint + "/chat/completions"));
            run.connection = connection;
            synchronized (gate) { if (!run.running()) return; }
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(Math.min(deadline, NativeModelServicePolicy.CONNECT_TIMEOUT_MS));
            connection.setReadTimeout(Math.min(deadline, NativeModelServicePolicy.IDLE_TIMEOUT_MS)); connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "text/event-stream"); connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Authorization", "Bearer " + new String(config.key, StandardCharsets.US_ASCII));
            connection.setUseCaches(false); connection.setDoOutput(true); connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw failure("REDIRECT_REJECTED");
            if (status != 200) throw failure(status == 401 || status == 403 ? "PROVIDER_AUTH_REJECTED" : status == 429 ? "PROVIDER_RATE_LIMITED" : "PROVIDER_REQUEST_FAILED");
            String type = connection.getContentType();
            if (type == null || !type.split(";", 2)[0].trim().equalsIgnoreCase("text/event-stream")) throw failure("INVALID_RESPONSE");
            String encoding = connection.getContentEncoding();
            if (encoding != null && !encoding.equalsIgnoreCase("identity")) throw failure("INVALID_RESPONSE");
            final boolean[] finished = {false}, done = {false};
            try (InputStream input = connection.getInputStream()) {
                NativeModelServicePolicy.readSse(input, data -> {
                    synchronized (gate) { if (!run.running()) return false; }
                    if (data.equals("[DONE]")) {
                        if (!finished[0]) throw failure("TRUNCATED_RESPONSE");
                        if (run.diagnosticResult != null && !run.observedContent) throw failure("EMPTY_MODEL_RESPONSE");
                        done[0] = true; synchronized (gate) { terminal(run, "completed", null); } return false;
                    }
                    String filtered = filterChunk(data, finished);
                    if (filtered != null) synchronized (gate) { append(run, "data", filtered, null); }
                    return true;
                });
            }
            synchronized (gate) { if (run.running() && !done[0]) throw failure("TRUNCATED_RESPONSE"); }
        } catch (Exception error) {
            String code = error instanceof java.net.SocketTimeoutException ? "NETWORK_TIMEOUT" : safe(error).code;
            if (code.equals("INVALID_REQUEST")) code = "INVALID_RESPONSE";
            if (code.equals("SERVICE_FAILED")) code = "NETWORK_UNAVAILABLE";
            synchronized (gate) { terminal(run, "failed", code); }
        } finally {
            if (timeout != null) timeout.cancel(false); disconnect(run); run.connection = null;
            Arrays.fill(body, (byte) 0); config.close();
            synchronized (gate) {
                networkBusy = false;
                if (diagnostic == run) diagnostic = null;
            }
            if (run.diagnosticResult != null) {
                try {
                    if (run.status.equals("completed")) run.diagnosticResult.complete(new JSONObject().put("kind", "connection_test")
                        .put("ok", true).put("latencyMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - run.startedNanos)));
                    else run.diagnosticResult.completeExceptionally(failure(run.terminalCode == null ? "CONNECTION_TEST_CANCELLED" : run.terminalCode));
                } catch (JSONException ignored) { run.diagnosticResult.completeExceptionally(failure("SERVICE_FAILED")); }
            }
        }
    }
    static String filterChunk(String text, boolean[] finished) throws Exception {
        final JSONObject raw;
        try { raw = parseObject(text, NativeModelServicePolicy.MAX_EVENT_BYTES); } catch (Exception ignored) { throw failure("INVALID_RESPONSE"); }
        if (raw.has("error")) throw failure("PROVIDER_REQUEST_FAILED");
        JSONArray choices = raw.optJSONArray("choices");
        if (choices == null || choices.length() > 1) throw failure("INVALID_RESPONSE");
        if (choices.length() == 0) return null; // Usage-only chunk, deliberately not exposed.
        JSONObject choice = choices.optJSONObject(0);
        if (choice == null) throw failure("INVALID_RESPONSE");
        try { if (integer(choice, "index") != 0) throw failure("INVALID_RESPONSE"); }
        catch (Exception ignored) { throw failure("INVALID_RESPONSE"); }
        JSONObject delta = choice.optJSONObject("delta");
        if (delta == null) throw failure("INVALID_RESPONSE");
        JSONArray tools = delta.optJSONArray("tool_calls");
        if (tools != null && tools.length() != 0 || delta.has("function_call") && !delta.isNull("function_call")) throw failure("UNSUPPORTED_MODEL_TOOL");
        JSONObject cleanDelta = new JSONObject();
        for (String field : new String[]{"content", "reasoning_content"}) {
            if (!delta.has(field) || delta.isNull(field)) continue;
            Object value = delta.get(field); if (!(value instanceof String)) throw failure("INVALID_RESPONSE");
            cleanDelta.put(field, value);
        }
        JSONObject clean = new JSONObject().put("index", 0).put("delta", cleanDelta);
        if (choice.has("finish_reason") && !choice.isNull("finish_reason")) {
            String reason = string(choice, "finish_reason");
            if (!reason.equals("stop") && !reason.equals("length") && !reason.equals("content_filter")) throw failure("UNSUPPORTED_MODEL_TOOL");
            if (finished[0]) throw failure("INVALID_RESPONSE");
            finished[0] = true; clean.put("finish_reason", reason);
        } else {
            if (finished[0] && cleanDelta.length() > 0) throw failure("INVALID_RESPONSE");
            clean.put("finish_reason", JSONObject.NULL);
        }
        if (cleanDelta.length() == 0 && !finished[0]) return null;
        return new JSONObject().put("choices", new JSONArray().put(clean)).toString();
    }
    private void append(Run run, String type, String data, String code) throws Exception {
        if (!run.running()) return;
        int count = data == null ? 0 : bytes(data);
        // Reserve two terminal slots; terminal errors always remain observable.
        if (run.events.size() >= NativeModelServicePolicy.MAX_EVENTS - 2
            || run.eventBytes + count > NativeModelServicePolicy.MAX_STREAM_BYTES) throw failure("RESPONSE_LIMIT");
        run.eventBytes += count;
        if (run.diagnosticResult != null) {
            if (data != null) {
                JSONObject delta = new JSONObject(data).getJSONArray("choices").getJSONObject(0).getJSONObject("delta");
                if (!delta.optString("content").trim().isEmpty()) run.observedContent = true;
            }
        } else run.events.add(new Event(run.events.size() + 1, type, data, code));
    }
    private void terminal(Run run, String status, String code) {
        if (!run.running()) return;
        run.status = status; run.terminalCode = code;
        if (run.diagnosticResult != null) return;
        if (code != null) run.events.add(new Event(run.events.size() + 1, "error", null, code));
        run.events.add(new Event(run.events.size() + 1, "done", null, null));
    }
    private static void disconnect(Run run) {
        HttpsURLConnection connection = run.connection;
        if (connection != null) try { connection.disconnect(); }
        catch (RuntimeException ignored) { /* Native read/deadline budgets still apply; drain remains unconfirmed until the worker exits. */ }
    }

    /** Native lifecycle only. Queue after accepted start/configuration commands
     * and cancel the actual owner, never a request id supplied by JavaScript. */
    public CompletableFuture<Void> cancelCurrent() {
        CompletableFuture<Void> result = new CompletableFuture<>();
        synchronized (gate) {
            if (closed) { result.completeExceptionally(failure("CLOSED")); return result; }
        }
        submit(() -> {
            final Run run, test;
            synchronized (gate) {
                run = current; test = diagnostic;
                if (run != null) terminal(run, "cancelled", null);
                if (test != null) terminal(test, "cancelled", null);
            }
            if (run != null) disconnect(run);
            if (test != null) disconnect(test);
            result.complete(null);
        }, result);
        return result;
    }

    public CompletableFuture<Void> close() {
        final Run run, test; final AlertDialog opened; final CompletableFuture<JSONObject> configuringResult;
        synchronized (gate) {
            if (closure != null) return closure;
            closure = new CompletableFuture<>(); closed = true; run = current; test = diagnostic; opened = dialog; configuringResult = configuration;
            if (run != null) terminal(run, "cancelled", null);
            if (test != null) terminal(test, "cancelled", null);
        }
        if (configuringResult != null) finishConfiguration(configuringResult, null, failure("CLOSED"));
        CompletableFuture<Void> uiClosed = new CompletableFuture<>();
        main.post(() -> {
            try { if (opened != null) opened.dismiss(); activity = null; uiClosed.complete(null); }
            catch (Exception ignored) { uiClosed.completeExceptionally(failure("DRAIN_UNCONFIRMED")); }
        });
        if (run != null) disconnect(run);
        if (test != null) disconnect(test);
        controls.shutdown(); network.shutdown(); deadlines.shutdownNow();
        Thread drain = new Thread(() -> {
            try {
                while (!controls.awaitTermination(1, TimeUnit.SECONDS)) { /* prove drain, do not claim a timeout is closed */ }
                while (!network.awaitTermination(1, TimeUnit.SECONDS)) { }
                while (!deadlines.awaitTermination(1, TimeUnit.SECONDS)) { }
                uiClosed.join();
                closure.complete(null);
            } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); closure.completeExceptionally(failure("DRAIN_UNCONFIRMED")); }
            catch (Exception ignored) { closure.completeExceptionally(failure("DRAIN_UNCONFIRMED")); }
        }, "aervox-model-drain"); drain.start();
        return closure;
    }
    private boolean submit(Runnable operation, CompletableFuture<?> result) {
        try { controls.execute(operation); return true; }
        catch (RejectedExecutionException ignored) { result.completeExceptionally(failure("CLOSED")); return false; }
    }
    private void checkOpen() throws Exception { synchronized (gate) { if (closed) throw failure("CLOSED"); } }
    private static ServiceException failure(String code) { return new ServiceException(code); }
    private static ServiceException safe(Exception error) {
        if (error instanceof ServiceException) return (ServiceException) error;
        if (error instanceof NativeModelServicePolicy.Rejected) return failure(((NativeModelServicePolicy.Rejected) error).code);
        if (error instanceof NativeCredentialStore.CredentialException) return failure("CREDENTIAL_STORAGE_FAILED");
        if (error instanceof JSONException) return failure("INVALID_REQUEST");
        return failure("SERVICE_FAILED");
    }
    private static String identity(JSONObject request) throws Exception {
        String id = string(request, "requestId"); if (!id.matches("[A-Za-z0-9_.:-]{1,128}")) throw failure("INVALID_REQUEST"); return id;
    }
    private static String string(JSONObject object, String key) throws Exception {
        Object value = object.get(key); if (!(value instanceof String)) throw failure("INVALID_REQUEST"); return (String) value;
    }
    private static long integer(JSONObject object, String key) throws Exception {
        Object value = object.get(key);
        if (!(value instanceof Integer) && !(value instanceof Long)) throw failure("INVALID_REQUEST"); return ((Number) value).longValue();
    }
    private static JSONArray messages(Object value) throws Exception {
        if (!(value instanceof JSONArray)) throw failure("INVALID_REQUEST"); JSONArray input = (JSONArray) value, output = new JSONArray();
        if (input.length() == 0 || input.length() > MAX_MESSAGES) throw failure("INVALID_REQUEST");
        for (int i = 0; i < input.length(); i++) {
            JSONObject item = input.optJSONObject(i); if (item == null) throw failure("INVALID_REQUEST"); exact(item, "role", "content");
            String role = string(item, "role"), content = string(item, "content");
            if (!role.equals("system") && !role.equals("user") && !role.equals("assistant")) throw failure("INVALID_REQUEST");
            if (content.isEmpty()) throw failure("INVALID_REQUEST");
            output.put(new JSONObject().put("role", role).put("content", content));
        }
        return output;
    }
    private static void exact(JSONObject object, String... fields) throws Exception { exactOptional(object, fields); }
    private static void exactOptional(JSONObject object, String[] required, String... optional) throws Exception {
        for (String field : required) if (!object.has(field)) throw failure("INVALID_REQUEST");
        Set<String> allowed = new HashSet<>(Arrays.asList(required)); allowed.addAll(Arrays.asList(optional));
        Iterator<String> keys = object.keys(); while (keys.hasNext()) if (!allowed.contains(keys.next())) throw failure("INVALID_REQUEST");
    }
    private static int bytes(String value) { return value.getBytes(StandardCharsets.UTF_8).length; }
    private static JSONObject parseObject(String value, int budget) throws Exception {
        if (!NativeMessagePolicy.withinUtf8Budget(value, budget) || !NativeMessagePolicy.withinJsonDepth(value)) throw failure("INVALID_REQUEST");
        try (JsonReader reader = new JsonReader(new StringReader(value))) {
            reader.setLenient(false);
            if (reader.peek() != JsonToken.BEGIN_OBJECT) throw failure("INVALID_REQUEST");
            int depth = 0;
            while (reader.peek() != JsonToken.END_DOCUMENT) {
                switch (reader.peek()) {
                    case BEGIN_OBJECT: if (++depth > 32) throw failure("INVALID_REQUEST"); reader.beginObject(); break;
                    case BEGIN_ARRAY: if (++depth > 32) throw failure("INVALID_REQUEST"); reader.beginArray(); break;
                    case END_OBJECT: reader.endObject(); depth--; break;
                    case END_ARRAY: reader.endArray(); depth--; break;
                    case NAME: reader.nextName(); break;
                    case STRING: case NUMBER: reader.nextString(); break;
                    case BOOLEAN: reader.nextBoolean(); break;
                    case NULL: reader.nextNull(); break;
                    default: throw new IOException("INVALID_JSON");
                }
            }
            if (depth != 0) throw failure("INVALID_REQUEST");
        }
        JSONTokener parser = new JSONTokener(value); Object parsed = parser.nextValue();
        if (!(parsed instanceof JSONObject) || parser.nextClean() != 0) throw failure("INVALID_REQUEST");
        return (JSONObject) parsed;
    }
    private static String hex(byte[] value) { StringBuilder output = new StringBuilder(); for (byte b : value) output.append(String.format(Locale.ROOT, "%02x", b & 255)); return output.toString(); }
}
