package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class NativeModelServiceTest {
    @Test public void nativeSummaryNeverReturnsTheCredentialAndSurvivesReopen() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        NativeCredentialStore store = isolated(context);
        byte[] record = config().toString().getBytes(StandardCharsets.UTF_8);
        store.put(NativeCredentialStore.Slot.PRIMARY_MODEL, record); Arrays.fill(record, (byte) 0);
        NativeModelService service = new NativeModelService(context, store);
        try {
            JSONObject summary = await(service.request(new JSONObject().put("op", "summary")));
            assertTrue(summary.getBoolean("hasCredential")); assertEquals("https://api.example.com/v1", summary.getString("endpoint"));
            assertEquals(4, summary.length()); assertFalse(summary.toString().contains("secret-native-only"));
            awaitVoid(service.close());
            NativeModelService reopened = new NativeModelService(context, store);
            try { assertEquals(summary.toString(), await(reopened.request(new JSONObject().put("op", "summary"))).toString()); }
            finally { awaitVoid(reopened.close()); }
        } finally { awaitVoid(service.close()); store.clear(NativeCredentialStore.Slot.PRIMARY_MODEL); }
    }
    @Test public void legacyOrInvalidEncryptedPayloadIsPreservedAndNeverSilentlyRepaired() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        NativeCredentialStore store = isolated(context);
        for (byte[] record : new byte[][]{"legacy-key".getBytes(StandardCharsets.UTF_8), config().put("version", 2).toString().getBytes(StandardCharsets.UTF_8)}) {
            store.put(NativeCredentialStore.Slot.PRIMARY_MODEL, record);
            NativeModelService service = new NativeModelService(context, store);
            try {
                rejected(service.request(new JSONObject().put("op", "summary")), "CREDENTIAL_RECOVERY_REQUIRED");
                assertArrayEquals(record, store.get(NativeCredentialStore.Slot.PRIMARY_MODEL));
            } finally { awaitVoid(service.close()); store.clear(NativeCredentialStore.Slot.PRIMARY_MODEL); }
        }
    }
    @Test public void rejectsWebSelectedDestinationsRolesAndCommandsWithoutStartingNetwork() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        NativeCredentialStore store = isolated(context);
        NativeModelService service = new NativeModelService(context, store);
        try {
            assertFalse(await(service.request(new JSONObject().put("op", "summary"))).getBoolean("hasCredential"));
            rejected(service.request(start()), "MODEL_NOT_CONFIGURED");
            rejected(service.request(start().put("endpoint", "https://evil.example")), "INVALID_REQUEST");
            rejected(service.request(start().put("headers", new JSONObject().put("Authorization", "stolen"))), "INVALID_REQUEST");
            rejected(service.request(start().put("messages", new JSONArray().put(new JSONObject().put("role", "tool").put("content", "x")))), "INVALID_REQUEST");
            rejected(service.request(start().put("maxTokens", 1.5)), "INVALID_REQUEST");
            rejected(service.request(new JSONObject().put("op", "exec").put("command", "id")), "INVALID_REQUEST");
            CompletableFuture<Void> drain = service.close(); awaitVoid(drain); assertSame(drain, service.close());
            rejected(service.request(new JSONObject().put("op", "summary")), "CLOSED");
        } finally { awaitVoid(service.close()); store.clear(NativeCredentialStore.Slot.PRIMARY_MODEL); }
    }
    @Test public void providerChunksDropMetadataAndRejectToolsAndDeepOrTruncatedShapes() throws Exception {
        boolean[] finished = {false};
        String clean = NativeModelService.filterChunk("{\"id\":\"provider-secret\",\"usage\":{\"secret\":1},\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\",\"reasoning_content\":\"think\",\"private\":\"secret\"},\"finish_reason\":null}]}", finished);
        assertFalse(clean.contains("provider-secret")); assertFalse(clean.contains("private")); assertFalse(clean.contains("usage"));
        assertEquals("hello", new JSONObject(clean).getJSONArray("choices").getJSONObject(0).getJSONObject("delta").getString("content"));
        try { NativeModelService.filterChunk("{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{}]}}]}", finished); fail(); }
        catch (NativeModelService.ServiceException error) { assertEquals("UNSUPPORTED_MODEL_TOOL", error.code); }
        try { NativeModelService.filterChunk("{\"choices\":[{\"index\":0}]}", finished); fail(); }
        catch (NativeModelService.ServiceException error) { assertEquals("INVALID_RESPONSE", error.code); }
        try { NativeModelService.filterChunk("{\"x\":".repeat(40) + "0" + "}".repeat(40), finished); fail(); }
        catch (NativeModelService.ServiceException error) { assertEquals("INVALID_RESPONSE", error.code); }
    }
    private static NativeCredentialStore isolated(Context context) throws Exception { return NativeCredentialStore.isolatedForTest(context, UUID.randomUUID().toString(), () -> {}); }
    private static JSONObject config() throws Exception { return new JSONObject().put("version", 1).put("endpoint", "https://api.example.com/v1").put("model", "test-model").put("key", "secret-native-only"); }
    private static JSONObject start() throws Exception {
        return new JSONObject().put("op", "start").put("requestId", UUID.randomUUID().toString())
            .put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", "hello")));
    }
    private static JSONObject await(CompletableFuture<JSONObject> future) throws Exception { return future.get(10, TimeUnit.SECONDS); }
    private static void awaitVoid(CompletableFuture<Void> future) throws Exception { future.get(10, TimeUnit.SECONDS); }
    private static void rejected(CompletableFuture<JSONObject> future, String code) throws Exception {
        try { await(future); fail(code); }
        catch (ExecutionException error) { assertTrue(error.getCause() instanceof NativeModelService.ServiceException); assertEquals(code, ((NativeModelService.ServiceException) error.getCause()).code); }
    }
}
