package com.aervox.mobile.runtime;

import android.net.Uri;
import android.os.Looper;
import android.util.JsonReader;
import android.util.JsonToken;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.io.IOException;
import java.io.StringReader;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Unregistered primitive for one owned WebView lifetime. No SQL, credential,
 * model, Capacitor plugin or MainActivity entry is exposed by this class.
 *
 * The owner must close AND destroy/recreate the WebView on document replacement;
 * sourceOrigin does not identify a document epoch. A fixed origin does not prove
 * APK asset provenance or isolate same-origin script/XSS. The future M0 host must
 * establish fixed assets and exclude untrusted scripts before installing this.
 * No fallback interface or script-evaluation response path exists here.
 */
public final class NativeMessageChannel implements AutoCloseable {
    public static final String OBJECT_NAME = "AervoxM0Native";
    public enum Status { READY, UNSUPPORTED, REGISTRATION_FAILED, ALREADY_INSTALLED, DISPOSED }
    private enum Failure { INVALID_REQUEST, BUSY, NATIVE_FAILURE, INVALID_RESULT }
    /** Called on UI thread: return promptly; perform I/O using an independently
     * bounded host executor. Completion contains a serialized JSON object. The
     * channel bounds its own ingress, pending count and reply, not host execution.
     * Closing revokes delivery; it does not cancel or undo accepted native work.
     */
    public interface RequestHandler { CompletionStage<String> handle(JSONObject body); }
    interface Transport {
        boolean supported();
        void add(WebView view, WebViewCompat.WebMessageListener listener);
        void remove(WebView view);
    }
    // Retired views cannot be reinstalled: an old JS object must never acquire a
    // new owner's listener. Weak references retain neither Activity nor WebView.
    private static final List<WeakReference<WebView>> OWNED_VIEWS = new ArrayList<>();
    private static final Transport WEBKIT = new Transport() {
        public boolean supported() { return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER); }
        public void add(WebView view, WebViewCompat.WebMessageListener listener) {
            WebViewCompat.addWebMessageListener(view, OBJECT_NAME, Collections.singleton("https://localhost"), listener);
        }
        public void remove(WebView view) { WebViewCompat.removeWebMessageListener(view, OBJECT_NAME); }
    };
    private final WebView view;
    private final RequestHandler handler;
    private final Transport transport;
    private final android.os.Handler ui = new android.os.Handler(Looper.getMainLooper());
    private final NativeMessagePolicy policy = new NativeMessagePolicy();
    private Status status = Status.REGISTRATION_FAILED;
    private boolean registrationAttempted;

    /** UI thread, before the owner's first loadUrl/loadData call. No registration
     * occurs in this repository until a fixed-assets host explicitly calls this.
     */
    public static NativeMessageChannel install(WebView view, RequestHandler handler) {
        return install(view, handler, WEBKIT);
    }
    static NativeMessageChannel install(WebView view, RequestHandler handler, Transport transport) {
        requireUi();
        if (view == null || handler == null || transport == null) throw new IllegalArgumentException("INVALID_CHANNEL_INPUT");
        NativeMessageChannel channel = new NativeMessageChannel(view, handler, transport);
        for (Iterator<WeakReference<WebView>> entries = OWNED_VIEWS.iterator(); entries.hasNext();) {
            WebView previous = entries.next().get();
            if (previous == null) entries.remove();
            else if (previous == view) { channel.status = Status.ALREADY_INSTALLED; channel.policy.close(); return channel; }
        }
        try {
            if (!transport.supported()) { channel.status = Status.UNSUPPORTED; channel.policy.close(); return channel; }
            OWNED_VIEWS.add(new WeakReference<>(view));
            channel.registrationAttempted = true;
            transport.add(view, channel::receive);
            channel.status = Status.READY;
        } catch (RuntimeException failure) {
            channel.policy.close();
            channel.removeRegistration();
            channel.status = Status.REGISTRATION_FAILED;
        }
        return channel;
    }
    private NativeMessageChannel(WebView view, RequestHandler handler, Transport transport) {
        this.view = view; this.handler = handler; this.transport = transport;
    }
    public Status status() { requireUi(); return status; }

    private void receive(WebView sourceView, WebMessageCompat message, Uri origin, boolean mainFrame, JavaScriptReplyProxy reply) {
        requireUi();
        if (status != Status.READY || origin == null || !NativeMessagePolicy.acceptsSource(sourceView == view, mainFrame,
                origin.getScheme(), origin.getHost(), origin.getPort(), !origin.isHierarchical() || origin.getEncodedUserInfo() != null
                    || origin.getEncodedQuery() != null || origin.getEncodedFragment() != null
                    || origin.getEncodedPath() != null && !origin.getEncodedPath().isEmpty())) return;
        if (message == null || message.getType() != WebMessageCompat.TYPE_STRING) {
            sendFailure(reply, null, Failure.INVALID_REQUEST); return;
        }
        JSONObject request;
        String id;
        try {
            request = parseObject(message.getData(), NativeMessagePolicy.MAX_REQUEST_BYTES);
            Object version = request.get("version"), requestId = request.get("id");
            if (request.length() != 3 || !(version instanceof Integer) || ((Integer) version) != 1
                    || !(requestId instanceof String) || !NativeMessagePolicy.validId((String) requestId)
                    || !(request.get("body") instanceof JSONObject)) throw new JSONException("INVALID_REQUEST");
            id = (String) requestId;
        } catch (JSONException | RuntimeException failure) {
            sendFailure(reply, null, Failure.INVALID_REQUEST); return;
        }
        NativeMessagePolicy.Ticket ticket = policy.start(id);
        if (ticket == null) { sendFailure(reply, id, Failure.BUSY); return; }
        // The ticket captures this owner's active generation before host code runs.
        try {
            CompletionStage<String> work = handler.handle(request.getJSONObject("body"));
            if (work == null) throw new IllegalStateException("INVALID_HANDLER_RESULT");
            work.whenComplete((value, failure) -> ui.post(() -> complete(ticket, reply, value, failure != null)));
        } catch (JSONException | RuntimeException failure) {
            complete(ticket, reply, null, true);
        }
    }
    private void complete(NativeMessagePolicy.Ticket ticket, JavaScriptReplyProxy reply, String value, boolean failed) {
        requireUi();
        if (!policy.mayReply(ticket)) return;
        try {
            if (failed) { sendFailure(reply, ticket.id, Failure.NATIVE_FAILURE); return; }
            JSONObject result = parseObject(value, NativeMessagePolicy.MAX_RESPONSE_BYTES - 256);
            String response = envelope(ticket.id).put("result", result).toString();
            if (!NativeMessagePolicy.withinUtf8Budget(response, NativeMessagePolicy.MAX_RESPONSE_BYTES)) {
                sendFailure(reply, ticket.id, Failure.INVALID_RESULT); return;
            }
            if (policy.mayReply(ticket)) post(reply, response);
        } catch (JSONException | RuntimeException failure) {
            if (policy.mayReply(ticket)) sendFailure(reply, ticket.id, Failure.INVALID_RESULT);
        } finally { policy.finish(ticket); }
    }
    private static JSONObject parseObject(String value, int budget) throws JSONException {
        if (!NativeMessagePolicy.withinUtf8Budget(value, budget) || !NativeMessagePolicy.withinJsonDepth(value)) {
            throw new JSONException("INVALID_JSON");
        }
        // Android JSONTokener accepts extensions. A strict iterative reader must
        // validate depth and the entire document BEFORE JSONObject recurses.
        validateJson(value);
        JSONTokener parser = new JSONTokener(value);
        Object parsed = parser.nextValue();
        if (!(parsed instanceof JSONObject) || parser.nextClean() != 0) throw new JSONException("INVALID_JSON");
        return (JSONObject) parsed;
    }
    private static void validateJson(String value) throws JSONException {
        try (JsonReader reader = new JsonReader(new StringReader(value))) {
            reader.setLenient(false);
            if (reader.peek() != JsonToken.BEGIN_OBJECT) throw new IOException("INVALID_JSON");
            int depth = 0;
            boolean started = false;
            while (true) {
                switch (reader.peek()) {
                    case BEGIN_OBJECT:
                        if (++depth > NativeMessagePolicy.MAX_JSON_DEPTH) throw new IOException("INVALID_JSON");
                        reader.beginObject(); started = true; break;
                    case BEGIN_ARRAY:
                        if (++depth > NativeMessagePolicy.MAX_JSON_DEPTH) throw new IOException("INVALID_JSON");
                        reader.beginArray(); break;
                    case END_OBJECT: reader.endObject(); depth--; break;
                    case END_ARRAY: reader.endArray(); depth--; break;
                    case NAME: reader.nextName(); break;
                    case STRING: case NUMBER: reader.nextString(); break;
                    case BOOLEAN: reader.nextBoolean(); break;
                    case NULL: reader.nextNull(); break;
                    case END_DOCUMENT:
                        if (!started || depth != 0) throw new IOException("INVALID_JSON");
                        return;
                    default: throw new IOException("INVALID_JSON");
                }
            }
        } catch (IOException | IllegalStateException failure) { throw new JSONException("INVALID_JSON"); }
    }
    private static JSONObject envelope(String id) throws JSONException {
        return new JSONObject().put("version", 1).put("id", id == null ? JSONObject.NULL : id);
    }
    private void sendFailure(JavaScriptReplyProxy reply, String id, Failure failure) {
        if (status != Status.READY) return;
        try { post(reply, envelope(id).put("error", new JSONObject().put("code", failure.name())).toString()); }
        catch (JSONException ignored) { /* Fixed fields only; no raw exception or input logging. */ }
    }
    private static void post(JavaScriptReplyProxy reply, String value) {
        if (reply == null) return;
        try { reply.postMessage(value); }
        catch (RuntimeException ignored) { /* Delivery loss does not undo or replay native work. */ }
    }
    /** UI thread. Revoke first even if removal fails; queued completions recheck
     * the ticket. Native work remains the host's responsibility until settled.
     */
    @Override public void close() {
        requireUi();
        if (status == Status.DISPOSED) return;
        policy.close(); status = Status.DISPOSED;
        removeRegistration();
    }
    private void removeRegistration() {
        if (!registrationAttempted) return;
        try { transport.remove(view); }
        catch (RuntimeException ignored) { /* Revoked policy remains closed; no fallback. */ }
        registrationAttempted = false;
    }
    private static void requireUi() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("CHANNEL_REQUIRES_UI_THREAD");
    }
}
