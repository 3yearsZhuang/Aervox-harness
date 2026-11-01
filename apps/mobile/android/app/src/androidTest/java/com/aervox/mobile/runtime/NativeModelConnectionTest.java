package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the real native request/parser/lifecycle against a native-only HTTPS
 * seam. No external service, user conversation or production credential is used. */
@RunWith(AndroidJUnit4.class)
public final class NativeModelConnectionTest {
    private static final String SUCCESS = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":null}]}\n\n"
        + "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

    @Test public void fixedDiagnosticUsesNativeConfigAndReturnsOnlyHealthAndLatency() throws Exception {
        try (Fixture fixture = new Fixture(true, 200, SUCCESS, false)) {
            JSONObject result = await(fixture.service.request(test()));
            assertEquals("connection_test", result.getString("kind"));
            assertTrue(result.getBoolean("ok")); assertTrue(result.getLong("latencyMs") >= 0);
            assertEquals(3, result.length()); assertFalse(result.toString().contains("OK"));
            FakeConnection connection = fixture.connections.get(0);
            assertEquals("https://api.example.com/v1/chat/completions", connection.getURL().toString());
            assertEquals("Bearer diagnostic-secret", connection.getRequestProperty("Authorization"));
            assertFalse(connection.getInstanceFollowRedirects());
            assertEquals(10_000, connection.getConnectTimeout()); assertEquals(10_000, connection.getReadTimeout());
            JSONObject sent = new JSONObject(connection.body.toString("UTF-8"));
            assertEquals("test-model", sent.getString("model")); assertEquals(32, sent.getInt("max_tokens"));
            assertTrue(sent.getBoolean("stream")); assertEquals(1, sent.getJSONArray("messages").length());
            assertEquals("Reply with OK.", sent.getJSONArray("messages").getJSONObject(0).getString("content"));
            assertTrue(connection.disconnected);
        }
    }

    @Test public void missingCredentialsAndWebChosenInputsNeverReachNetwork() throws Exception {
        try (Fixture fixture = new Fixture(false, 200, SUCCESS, false)) {
            rejected(fixture.service.request(test()), "MODEL_NOT_CONFIGURED");
            rejected(fixture.service.request(test().put("endpoint", "https://untrusted.example")), "INVALID_REQUEST");
            rejected(fixture.service.request(test().put("messages", new JSONArray())), "INVALID_REQUEST");
            rejected(fixture.service.request(test().put("requestId", "chosen")), "INVALID_REQUEST");
            rejected(fixture.service.request(test().put("headers", new JSONObject())), "INVALID_REQUEST");
            assertTrue(fixture.connections.isEmpty());
        }
    }

    @Test public void diagnosticBlocksCompetingWorkAndCancelsOnNativeLifecycle() throws Exception {
        try (Fixture fixture = new Fixture(true, 200, SUCCESS, true)) {
            CompletableFuture<JSONObject> result = fixture.service.request(test());
            assertTrue(fixture.opened.await(5, TimeUnit.SECONDS));
            rejected(fixture.service.request(test()), "BUSY");
            rejected(fixture.service.request(start("business")), "BUSY");
            rejected(fixture.service.request(new JSONObject().put("op", "configure")), "BUSY");
            fixture.service.cancelCurrent().get(5, TimeUnit.SECONDS);
            rejected(result, "CONNECTION_TEST_CANCELLED");
            assertTrue(fixture.connections.get(0).disconnected);
            assertTrue(await(fixture.service.request(new JSONObject().put("op", "summary"))).getBoolean("hasCredential"));
        }
    }

    @Test public void closeDrainsAnInFlightDiagnostic() throws Exception {
        try (Fixture fixture = new Fixture(true, 200, SUCCESS, true)) {
            CompletableFuture<JSONObject> result = fixture.service.request(test());
            assertTrue(fixture.opened.await(5, TimeUnit.SECONDS));
            fixture.service.close().get(5, TimeUnit.SECONDS);
            rejected(result, "CONNECTION_TEST_CANCELLED");
            assertTrue(fixture.connections.get(0).disconnected);
            rejected(fixture.service.request(test()), "CLOSED");
        }
    }

    @Test public void diagnosticsRetainThePreviousBusinessReceiptAndIdempotency() throws Exception {
        try (Fixture fixture = new Fixture(true, 200, SUCCESS, false)) {
            JSONObject request = start("preserved-business");
            await(fixture.service.request(request));
            JSONObject before = pollUntilDone(fixture.service, "preserved-business");
            // Summary of completion can precede final worker cleanup; the test
            // requests admission until the previous owner has actually drained.
            JSONObject result = testAfterDrain(fixture.service);
            assertTrue(result.getBoolean("ok"));
            JSONObject after = await(fixture.service.request(poll("preserved-business")));
            assertEquals(before.toString(), after.toString());
            assertEquals("started", await(fixture.service.request(request)).getString("kind"));
            assertEquals(2, fixture.connections.size());
        }
    }

    @Test public void providerFailuresAreFixedCodesWithoutBodiesOrFalseSuccess() throws Exception {
        for (int status : new int[]{401, 429, 302, 500}) {
            String code = status == 401 ? "PROVIDER_AUTH_REJECTED" : status == 429 ? "PROVIDER_RATE_LIMITED"
                : status == 302 ? "REDIRECT_REJECTED" : "PROVIDER_REQUEST_FAILED";
            try (Fixture fixture = new Fixture(true, status, "provider-private-body", false)) {
                rejected(fixture.service.request(test()), code);
            }
        }
        try (Fixture fixture = new Fixture(true, 200, "data: [DONE]\n\n", false)) {
            rejected(fixture.service.request(test()), "TRUNCATED_RESPONSE");
        }
        String empty = "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n";
        try (Fixture fixture = new Fixture(true, 200, empty, false)) {
            rejected(fixture.service.request(test()), "EMPTY_MODEL_RESPONSE");
        }
    }

    @Test public void bodyLimitPreservesTheAcceptedPrefixAndPublishesLengthBeforeUnreadInvalidFrames() throws Exception {
        // Reasoning remains progress and does not consume the durable body budget.
        assertBodyLimit("界".repeat(4096), 4, "推理".repeat(2048));
    }

    @Test public void bodyLimitCountsNulAsSixJsonBytesInsteadOfOneRawByte() throws Exception {
        assertBodyLimit("\0".repeat(4096), 2, null);
    }

    @Test public void diagnosticBodyLimitNeverAcceptsOnlyWhitespaceAsProviderHealth() throws Exception {
        String response = frame(new JSONObject().put("content", " ".repeat(4096))).repeat(13)
            + "data: provider-private-unread-tail\n\n";
        try (Fixture fixture = new Fixture(true, 200, response, false)) {
            rejected(fixture.service.request(test()), "EMPTY_MODEL_RESPONSE");
            assertEquals(1, fixture.connections.size());
            assertTrue(fixture.connections.get(0).disconnected);
        }
    }

    @Test public void cancellationOwnsTheTerminalBeforeBodyLimitFramesCanArrive() throws Exception {
        String response = frame(new JSONObject().put("content", "界".repeat(4096))).repeat(5);
        try (Fixture fixture = new Fixture(true, 200, response, true)) {
            await(fixture.service.request(start("cancel-before-limit")));
            assertTrue(fixture.opened.await(5, TimeUnit.SECONDS));
            fixture.service.cancelCurrent().get(5, TimeUnit.SECONDS);
            JSONObject result = pollUntilDone(fixture.service, "cancel-before-limit");
            assertEquals("cancelled", result.getString("status"));
            assertEquals(1, result.getJSONArray("events").length());
            assertEquals("done", result.getJSONArray("events").getJSONObject(0).getString("type"));
            fixture.service.close().get(5, TimeUnit.SECONDS);
            assertEquals(1, fixture.connections.size());
            assertTrue(fixture.connections.get(0).disconnected);
        }
    }

    private static void assertBodyLimit(String content, int accepted, String reasoning) throws Exception {
        StringBuilder response = new StringBuilder();
        if (reasoning != null) response.append(frame(new JSONObject().put("reasoning_content", reasoning)));
        for (int index = 0; index <= accepted; index++) response.append(frame(new JSONObject().put("content", content)));
        // This is deliberately not valid JSON. A capped producer must not inspect it.
        response.append("data: provider-private-unread-tail\n\n");
        try (Fixture fixture = new Fixture(true, 200, response.toString(), false)) {
            JSONObject request = start("bounded-body");
            await(fixture.service.request(request));
            JSONObject result = pollUntilDone(fixture.service, "bounded-body");
            assertEquals("completed", result.getString("status"));
            JSONArray events = result.getJSONArray("events");
            int prefix = reasoning == null ? 0 : 1;
            assertEquals(prefix + accepted + 2, events.length());
            if (reasoning != null) assertEquals(reasoning, chunk(events, 0).getJSONObject("delta").getString("reasoning_content"));
            for (int index = 0; index < accepted; index++) {
                assertEquals(content, chunk(events, prefix + index).getJSONObject("delta").getString("content"));
            }
            JSONObject terminal = chunk(events, prefix + accepted);
            assertEquals("length", terminal.getString("finish_reason"));
            assertEquals(0, terminal.getJSONObject("delta").length());
            assertEquals("done", events.getJSONObject(events.length() - 1).getString("type"));
            assertEquals(events.length(), result.getInt("nextSequence"));
            assertEquals("started", await(fixture.service.request(request)).getString("kind"));
            fixture.service.close().get(5, TimeUnit.SECONDS);
            assertEquals(1, fixture.connections.size());
            assertTrue(fixture.connections.get(0).disconnected);
        }
    }
    private static String frame(JSONObject delta) throws Exception {
        return "data: " + new JSONObject().put("choices", new JSONArray().put(new JSONObject()
            .put("index", 0).put("delta", delta).put("finish_reason", JSONObject.NULL))).toString() + "\n\n";
    }
    private static JSONObject chunk(JSONArray events, int index) throws Exception {
        JSONObject event = events.getJSONObject(index);
        assertEquals("data", event.getString("type"));
        return new JSONObject(event.getString("data")).getJSONArray("choices").getJSONObject(0);
    }

    private static JSONObject test() throws Exception { return new JSONObject().put("op", "test"); }
    private static JSONObject start(String id) throws Exception {
        return new JSONObject().put("op", "start").put("requestId", id)
            .put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", "private business input")));
    }
    private static JSONObject poll(String id) throws Exception { return new JSONObject().put("op", "poll").put("requestId", id).put("afterSequence", 0); }
    private static JSONObject pollUntilDone(NativeModelService service, String id) throws Exception {
        for (int i = 0; i < 100; i++) {
            JSONObject result = await(service.request(poll(id)));
            if (!result.getString("status").equals("running")) return result;
            Thread.sleep(10);
        }
        throw new AssertionError("business request did not complete");
    }
    private static JSONObject testAfterDrain(NativeModelService service) throws Exception {
        for (int i = 0; i < 100; i++) {
            try { return await(service.request(test())); }
            catch (ExecutionException error) {
                if (!(error.getCause() instanceof NativeModelService.ServiceException)
                    || !((NativeModelService.ServiceException) error.getCause()).code.equals("BUSY")) throw error;
                Thread.sleep(10);
            }
        }
        throw new AssertionError("previous request did not drain");
    }
    private static JSONObject await(CompletableFuture<JSONObject> future) throws Exception { return future.get(5, TimeUnit.SECONDS); }
    private static void rejected(CompletableFuture<JSONObject> future, String code) throws Exception {
        try { await(future); fail(code); }
        catch (ExecutionException error) {
            assertTrue(error.getCause() instanceof NativeModelService.ServiceException);
            assertEquals(code, ((NativeModelService.ServiceException) error.getCause()).code);
            assertEquals(code, error.getCause().getMessage());
        }
    }
    private static final class Fixture implements AutoCloseable {
        final NativeCredentialStore store;
        final NativeModelService service;
        final ArrayList<FakeConnection> connections = new ArrayList<>();
        final CountDownLatch opened = new CountDownLatch(1);
        Fixture(boolean configured, int status, String response, boolean blocking) throws Exception {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            store = NativeCredentialStore.isolatedForTest(context, UUID.randomUUID().toString(), () -> {});
            if (configured) store.put(NativeCredentialStore.Slot.PRIMARY_MODEL, new JSONObject().put("version", 1)
                .put("endpoint", "https://api.example.com/v1").put("model", "test-model").put("key", "diagnostic-secret")
                .toString().getBytes(StandardCharsets.UTF_8));
            service = new NativeModelService(context, store, endpoint -> {
                FakeConnection connection = new FakeConnection(endpoint, status, response, blocking);
                connections.add(connection); opened.countDown(); return connection;
            });
        }
        @Override public void close() throws Exception { service.close().get(5, TimeUnit.SECONDS); store.clear(NativeCredentialStore.Slot.PRIMARY_MODEL); }
    }
    private static final class FakeConnection extends HttpsURLConnection {
        final int responseStatus;
        final String response;
        final CountDownLatch release;
        final ByteArrayOutputStream body = new ByteArrayOutputStream();
        volatile boolean disconnected;
        FakeConnection(URL endpoint, int status, String text, boolean blocking) {
            super(endpoint); responseStatus = status; response = text; release = new CountDownLatch(blocking ? 1 : 0);
        }
        @Override public OutputStream getOutputStream() { return body; }
        @Override public int getResponseCode() throws java.io.IOException {
            try { if (!release.await(5, TimeUnit.SECONDS)) throw new java.io.IOException("test read did not release"); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new java.io.IOException("interrupted"); }
            return responseStatus;
        }
        @Override public String getContentType() { return "text/event-stream; charset=utf-8"; }
        @Override public String getContentEncoding() { return "identity"; }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8)); }
        @Override public void disconnect() { disconnected = true; release.countDown(); }
        @Override public void connect() { }
        @Override public boolean usingProxy() { return false; }
        @Override public String getCipherSuite() { return "fixture"; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() { return new Certificate[0]; }
        @Override public Principal getPeerPrincipal() { return null; }
        @Override public Principal getLocalPrincipal() { return null; }
    }
}
