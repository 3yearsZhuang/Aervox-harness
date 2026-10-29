package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import org.junit.Test;

public final class NativeModelServicePolicyTest {
    @Test public void requiresANativeSelectedHttpsBaseEndpoint() throws Exception {
        assertEquals("https://api.example.com/v1", NativeModelServicePolicy.endpoint("https://api.example.com/v1/"));
        for (String endpoint : new String[]{"http://api.example.com/v1", "https://user:key@api.example.com/v1",
            "https://api.example.com/v1?key=secret", "https://api.example.com/v1#secret", "https://localhost/v1",
            "https://127.0.0.1/v1", "https://[::1]/v1",
            " https://api.example.com/v1", "https://api.example.com/a/../v1", "https://api.example.com/%76%31",
            "https://api.example.com//v1", "https://api.example.com:0/v1"}) rejectedEndpoint(endpoint);
    }
    @Test public void distinguishesACompletionUrlFromTheRequiredBaseAddress() throws Exception {
        for (String address : new String[]{"https://api.example.com/v1/chat/completions", "https://api.example.com/v1/chat/completions/"}) {
            try { NativeModelServicePolicy.endpoint(address); fail(address); }
            catch (NativeModelServicePolicy.Rejected error) { assertEquals("ENDPOINT_INCLUDES_COMPLETION_PATH", error.code); }
        }
    }
    @Test public void restrictsModelAndHeaderCredential() {
        assertTrue(NativeModelServicePolicy.model("provider/model-v1.2:latest"));
        assertFalse(NativeModelServicePolicy.model("model\nHeader: value"));
        assertFalse(NativeModelServicePolicy.model(""));
        assertTrue(NativeModelServicePolicy.credential("sk-example".toCharArray()));
        assertFalse(NativeModelServicePolicy.credential("sk-example\r\nInjected: x".toCharArray()));
        assertFalse(NativeModelServicePolicy.credential("with space".toCharArray()));
        assertFalse(NativeModelServicePolicy.credential(new char[2049]));
    }
    @Test public void parsesBomMultilineCrLfAndUtf8BeforeDispatch() throws Exception {
        ArrayList<String> values = new ArrayList<>();
        String source = "\ufeff: ping\r\ndata: 中文\r\ndata: two\r\n\r\ndata: [DONE]\r\n\r\n";
        NativeModelServicePolicy.readSse(bytes(source), value -> { values.add(value); return true; });
        assertEquals(java.util.Arrays.asList("中文\ntwo", "[DONE]"), values);
    }
    @Test public void stopsWithoutConsumingAnythingAfterDone() throws Exception {
        final byte[] body = "data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8);
        InputStream stream = new InputStream() {
            int cursor;
            @Override public int read() { if (cursor == body.length) throw new AssertionError("read after done"); return body[cursor++]; }
            @Override public int read(byte[] output) { output[0] = (byte) read(); return 1; }
        };
        NativeModelServicePolicy.readSse(stream, value -> { assertEquals("[DONE]", value); return false; });
    }
    @Test public void rejectsTruncationAndMalformedUtf8() throws Exception {
        rejectedStream(bytes("data: never dispatched\n"), "TRUNCATED_RESPONSE");
        rejectedStream(bytes("data: never dispatched"), "TRUNCATED_RESPONSE");
        rejectedStream(new ByteArrayInputStream(new byte[]{'d', 'a', 't', 'a', ':', ' ', (byte) 0xc3, '\n', '\n'}), "INVALID_RESPONSE");
    }
    @Test public void boundsLinesEventsAndTotalBytesBeforeAllocation() throws Exception {
        rejectedStream(bytes("data: " + "x".repeat(NativeModelServicePolicy.MAX_EVENT_BYTES) + "\n\n"), "RESPONSE_LIMIT");
        rejectedStream(bytes(("data: x\n\n").repeat(NativeModelServicePolicy.MAX_EVENTS + 1)), "RESPONSE_LIMIT");
        rejectedStream(bytes((":" + "x".repeat(16384) + "\n\n").repeat(129)), "RESPONSE_LIMIT");
    }
    @Test public void bodyBudgetCountsJsonEscapesAndUtf8Scalars() throws Exception {
        NativeModelServicePolicy.BodyBudget budget = new NativeModelServicePolicy.BodyBudget();
        assertTrue(budget.accept("\"\\\b\f\n\r\t\0\u001f"));
        assertEquals(26, budget.usedBytes()); // Seven short escapes, two six-byte escapes.
        assertTrue(budget.accept("é界😀"));
        assertEquals(35, budget.usedBytes());
        assertTrue(budget.accept("\ud800x\udc00"));
        assertEquals(48, budget.usedBytes()); // Unpaired surrogates are escaped separately.
    }
    @Test public void bodyBudgetAdmitsTheExactLimitAndRefusesTheNextChunkAtomically() throws Exception {
        NativeModelServicePolicy.BodyBudget budget = new NativeModelServicePolicy.BodyBudget();
        assertTrue(budget.accept("a".repeat(48 * 1024 - 1)));
        assertFalse(budget.accept("xy"));
        assertEquals(48 * 1024 - 1, budget.usedBytes());
        assertTrue(budget.accept("z"));
        assertEquals(48 * 1024, budget.usedBytes());
        assertTrue(budget.accept(""));
        assertFalse(budget.accept("\0"));
    }
    @Test public void bodyBudgetAccumulatesAcrossChunksAndKeepsNewRunsIndependent() throws Exception {
        NativeModelServicePolicy.BodyBudget budget = new NativeModelServicePolicy.BodyBudget();
        assertTrue(budget.accept("\0".repeat(4096)));
        assertTrue(budget.accept("\0".repeat(4096)));
        assertEquals(48 * 1024, budget.usedBytes());
        assertFalse(budget.accept("界"));
        NativeModelServicePolicy.BodyBudget next = new NativeModelServicePolicy.BodyBudget();
        assertTrue(next.accept("界".repeat(16 * 1024)));
        assertEquals(48 * 1024, next.usedBytes());
        assertFalse(next.accept("😀"));
    }
    private static InputStream bytes(String value) { return new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8)); }
    private static void rejectedEndpoint(String value) throws Exception {
        try { NativeModelServicePolicy.endpoint(value); fail(value); }
        catch (NativeModelServicePolicy.Rejected error) { assertEquals("INVALID_ENDPOINT", error.code); }
    }
    private static void rejectedStream(InputStream stream, String code) throws Exception {
        try { NativeModelServicePolicy.readSse(stream, value -> true); fail(code); }
        catch (NativeModelServicePolicy.Rejected error) { assertEquals(code, error.code); }
    }
}
