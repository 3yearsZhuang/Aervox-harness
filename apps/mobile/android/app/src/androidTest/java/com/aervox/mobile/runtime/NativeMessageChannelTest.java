package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;
import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Isolated WebViews only: no MainActivity, files, credentials, SQL or network.
 * Policy/transport seam checks do not substitute for the real injection case.
 */
@RunWith(AndroidJUnit4.class)
public final class NativeMessageChannelTest {
    private WebView view;
    private NativeMessageChannel channel;
    private final AtomicInteger calls = new AtomicInteger();
    private final FakeTransport transport = new FakeTransport();
    private final FakeReply reply = new FakeReply();
    @Before public void prepare() {
        runMain(() -> {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            view = new WebView(context); view.getSettings().setJavaScriptEnabled(true);
        });
    }
    @After public void clean() {
        runMain(() -> { if (channel != null) channel.close(); if (view != null) view.destroy(); });
    }
    @Test public void unsupportedFeatureNeverRegistersAnAlternative() {
        runMain(() -> {
            transport.supported = false;
            channel = NativeMessageChannel.install(view, body -> { calls.incrementAndGet(); return CompletableFuture.completedFuture("{}"); }, transport);
            assertEquals(NativeMessageChannel.Status.UNSUPPORTED, channel.status());
            assertEquals(0, transport.adds); assertEquals(0, transport.removes);
        });
        assertEquals(0, calls.get());
    }
    @Test public void registrationFailureRevokesEvenAPartiallyRetainedListener() {
        runMain(() -> {
            transport.failRegistration = true;
            channel = NativeMessageChannel.install(view, body -> { calls.incrementAndGet(); return CompletableFuture.completedFuture("{}"); }, transport);
            assertEquals(NativeMessageChannel.Status.REGISTRATION_FAILED, channel.status());
            assertEquals(1, transport.removes);
            deliver(view, "https://localhost", true, request("r"));
            assertEquals(0, calls.get()); assertTrue(reply.messages.isEmpty());
        });
    }
    @Test public void checksTheActualViewFrameAndOriginBeforeDispatch() {
        runMain(() -> {
            echo();
            for (String origin : new String[]{"http://localhost", "https://localhost:444", "https://localhost.evil",
                    "https://sub.localhost", "https://localhost/path", "https://user@localhost", "https://localhost?q=1",
                    "https://localhost#x", "file:///x", "content://x", "null"}) deliver(view, origin, true, request("r"));
            deliver(view, "https://localhost", false, request("r"));
            WebView other = new WebView(view.getContext());
            try { deliver(other, "https://localhost", true, request("r")); } finally { other.destroy(); }
            assertEquals(0, calls.get()); assertTrue(reply.messages.isEmpty());
            deliver(view, "https://localhost:443", true, request("r"));
        });
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        assertEquals(1, calls.get()); assertEquals(1, reply.messages.size());
    }
    @Test public void rejectsMalformedOversizedAndDeepMessagesWithFixedErrors() throws Exception {
        runMain(() -> {
            echo();
            for (String message : new String[]{"PRIVATE_PAYLOAD_CANARY", request("bad/id"), request("r") + " {}",
                    "{\"version\":1,\"id\":\"r\",\"body\":{\"x\":true\"}}",
                    "{\"version\":1,\"id\":\"r\",\"body\":{true:false}}",
                    "{\"version\":1,\"id\":\"r\",\"body\":{\"x\":/*comment*/1}}",
                    "{\"version\":1,\"id\":\"r\",\"body\":{\"x\":true\",\"n\":" + repeated('[', 33) + "0" + repeated(']', 33) + ",\"t\":true\"}}",
                    "{\"version\":1,\"id\":\"r\",\"body\":{\"x\":\"" + repeated('中', 349526) + "\"}}",
                    "/*\"*/" + repeated('[', 33) + "0" + repeated(']', 33) + "/*\"*/",
                    "{\"version\":1,\"id\":\"r\",\"body\":{\"x\":" + repeated('[', 33) + "0" + repeated(']', 33) + "}}"}) {
                deliver(view, "https://localhost", true, message);
            }
            transport.listener.onPostMessage(view, new WebMessageCompat(new byte[]{1}), Uri.parse("https://localhost"), true, reply);
            assertEquals(0, calls.get()); assertEquals(11, reply.messages.size());
        });
        for (String message : reply.messages) {
            JSONObject response = new JSONObject(message);
            assertTrue(response.isNull("id"));
            assertEquals("INVALID_REQUEST", response.getJSONObject("error").getString("code"));
            assertFalse(message.contains("PRIVATE_PAYLOAD_CANARY"));
        }
    }
    @Test public void pendingBudgetAndDuplicateIdsDoNotStartAdditionalNativeWork() throws Exception {
        runMain(() -> {
            channel = NativeMessageChannel.install(view, body -> { calls.incrementAndGet(); return new CompletableFuture<>(); }, transport);
            for (int i = 0; i < 8; i++) deliver(view, "https://localhost", true, request("r" + i));
            deliver(view, "https://localhost", true, request("r0"));
            deliver(view, "https://localhost", true, request("over"));
            assertEquals(8, calls.get()); assertEquals(2, reply.messages.size());
        });
        for (String message : reply.messages) assertEquals("BUSY", new JSONObject(message).getJSONObject("error").getString("code"));
    }
    @Test public void disposeRevokesPendingRepliesAndRetiresTheViewWithoutCancellingWork() {
        CompletableFuture<String> work = new CompletableFuture<>();
        runMain(() -> {
            channel = NativeMessageChannel.install(view, body -> { calls.incrementAndGet(); return work; }, transport);
            deliver(view, "https://localhost", true, request("pending"));
            channel.close(); channel.close(); assertEquals(1, transport.removes);
            assertEquals(NativeMessageChannel.Status.DISPOSED, channel.status());
            assertFalse(work.isCancelled());
            deliver(view, "https://localhost", true, request("late"));
            NativeMessageChannel duplicate = NativeMessageChannel.install(view, body -> CompletableFuture.completedFuture("{}"), transport);
            assertEquals(NativeMessageChannel.Status.ALREADY_INSTALLED, duplicate.status()); duplicate.close();
            assertEquals(1, transport.adds); assertEquals(1, transport.removes);
        });
        work.complete("{\"PRIVATE_RESULT_CANARY\":true}");
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        assertEquals(1, calls.get()); assertTrue(reply.messages.isEmpty());
    }
    @Test public void nativeFailureAndInvalidResultDoNotExposeRawMessages() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        runMain(() -> {
            channel = NativeMessageChannel.install(view, body -> {
                if (requests.getAndIncrement() == 0) throw new IllegalArgumentException("PRIVATE_FAILURE_CANARY");
                return CompletableFuture.completedFuture("[\"PRIVATE_RESULT_CANARY\"]");
            }, transport);
            deliver(view, "https://localhost", true, request("throws"));
            deliver(view, "https://localhost", true, request("invalid"));
        });
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        assertEquals(2, reply.messages.size());
        assertEquals("NATIVE_FAILURE", new JSONObject(reply.messages.get(0)).getJSONObject("error").getString("code"));
        assertEquals("INVALID_RESULT", new JSONObject(reply.messages.get(1)).getJSONObject("error").getString("code"));
        for (String message : reply.messages) assertFalse(message.contains("PRIVATE_"));
    }
    @Test public void realWebViewInjectsOnlyMatchingOriginsAndRejectsDirectSubframeCalls() throws Exception {
        AtomicReference<Boolean> supported = new AtomicReference<>();
        runMain(() -> supported.set(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)));
        assumeTrue("Device WebView lacks WEB_MESSAGE_LISTENER", supported.get());
        runMain(() -> {
            channel = NativeMessageChannel.install(view, body -> { calls.incrementAndGet(); return CompletableFuture.completedFuture(body.toString()); });
            assertEquals(NativeMessageChannel.Status.READY, channel.status());
            view.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView source, WebResourceRequest request) {
                    String html = request.getUrl().getPath().equals("/index.html") ? mainPage() : childPage(request.getUrl().getHost());
                    return new WebResourceResponse("text/html", "UTF-8", new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
                }
            });
            view.loadUrl("https://localhost/index.html");
        });
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        while (!"true".equals(js("Boolean(window.replies && replies.length===1 && window.frameResults && frameResults.length===2)"))) {
            if (System.nanoTime() > deadline) fail("WEBVIEW_MESSAGES_TIMEOUT");
            Thread.sleep(50);
        }
        assertEquals(1, calls.get());
        assertEquals("true", js("frameResults.some(x=>x.host==='localhost'&&x.objectType==='object') && frameResults.some(x=>x.host==='remote.invalid'&&x.objectType==='undefined')"));
        assertEquals("true", js("replies[0].id==='main' && replies[0].result.echo==='ok'"));
        runMain(() -> channel.close());
        js("AervoxM0Native.postMessage(JSON.stringify({version:1,id:'after_close',body:{}})); true");
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        assertEquals(1, calls.get());
    }
    private void echo() {
        channel = NativeMessageChannel.install(view, body -> { calls.incrementAndGet(); return CompletableFuture.completedFuture(body.toString()); }, transport);
        assertEquals(NativeMessageChannel.Status.READY, channel.status());
    }
    private void deliver(WebView source, String origin, boolean main, String data) {
        transport.listener.onPostMessage(source, new WebMessageCompat(data), Uri.parse(origin), main, reply);
    }
    private static String request(String id) { return "{\"version\":1,\"id\":\"" + id + "\",\"body\":{}}"; }
    private static String repeated(char c, int count) { StringBuilder value = new StringBuilder(count); for (int i = 0; i < count; i++) value.append(c); return value.toString(); }
    private static void runMain(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
    private String js(String expression) throws Exception {
        AtomicReference<String> result = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
        runMain(() -> view.evaluateJavascript(expression, value -> { result.set(value); done.countDown(); }));
        assertTrue("WEBVIEW_SCRIPT_TIMEOUT", done.await(5, TimeUnit.SECONDS)); return result.get();
    }
    private static String mainPage() {
        return "<!doctype html><script>window.replies=[];window.frameResults=[];AervoxM0Native.onmessage=e=>replies.push(JSON.parse(e.data));"
            + "addEventListener('message',e=>{if(e.data&&e.data.channelTest)frameResults.push(e.data)});"
            + "AervoxM0Native.postMessage(JSON.stringify({version:1,id:'main',body:{echo:'ok'}}));</script>"
            + "<iframe src='https://localhost/child.html'></iframe><iframe src='https://remote.invalid/child.html'></iframe>";
    }
    private static String childPage(String host) {
        return "<!doctype html><script>let objectType=typeof AervoxM0Native;if(objectType==='object')"
            + "AervoxM0Native.postMessage(JSON.stringify({version:1,id:'child',body:{}}));"
            + "parent.postMessage({channelTest:true,host:'" + host + "',objectType},'*');</script>";
    }
    private static final class FakeTransport implements NativeMessageChannel.Transport {
        boolean supported = true, failRegistration;
        int adds, removes;
        WebViewCompat.WebMessageListener listener;
        public boolean supported() { return supported; }
        public void add(WebView view, WebViewCompat.WebMessageListener listener) {
            adds++; this.listener = listener;
            if (failRegistration) throw new IllegalStateException("PRIVATE_REGISTRATION_CANARY");
        }
        public void remove(WebView view) { removes++; }
    }
    private static final class FakeReply extends JavaScriptReplyProxy {
        final List<String> messages = new ArrayList<>();
        public void postMessage(String value) { messages.add(value); }
        public void postMessage(byte[] value) { throw new AssertionError("UNEXPECTED_BINARY_REPLY"); }
    }
}
