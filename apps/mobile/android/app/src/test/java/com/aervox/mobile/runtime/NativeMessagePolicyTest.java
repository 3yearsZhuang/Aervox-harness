package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

/** Pure JVM policy tests; these do not assert real WebView injection behavior. */
public final class NativeMessagePolicyTest {
    private static boolean source(boolean owner, boolean main, String scheme, String host, int port, boolean decorated) {
        return NativeMessagePolicy.acceptsSource(owner, main, scheme, host, port, decorated);
    }
    @Test public void permitsOnlyTheOwnedMainFrameAndFixedHttpsOrigin() {
        assertTrue(source(true, true, "https", "localhost", -1, false));
        assertTrue(source(true, true, "https", "localhost", 443, false));
        assertFalse(source(false, true, "https", "localhost", -1, false));
        assertFalse(source(true, false, "https", "localhost", -1, false));
        assertFalse(source(true, true, "http", "localhost", 80, false));
        assertFalse(source(true, true, "https", "localhost", 8443, false));
        assertFalse(source(true, true, "https", "localhost.evil", -1, false));
        assertFalse(source(true, true, "https", "sub.localhost", -1, false));
        assertFalse(source(true, true, "https", "127.0.0.1", -1, false));
        assertFalse(source(true, true, "https", "localhost", -1, true));
        assertFalse(source(true, true, "file", null, -1, true));
        assertFalse(source(true, true, null, null, -1, true));
    }
    @Test public void idsAreBoundedCorrelationIdentifiers() {
        assertTrue(NativeMessagePolicy.validId("request_1-X"));
        assertTrue(NativeMessagePolicy.validId("x".repeat(64)));
        for (String id : new String[]{null, "", "x".repeat(65), "中文", "line\n", "a/b", "x\0"}) assertFalse(NativeMessagePolicy.validId(id));
    }
    @Test public void utf8BudgetIsExactForValidUnicodeWithoutByteAllocation() {
        for (String value : new String[]{"", "ascii", "\0", "é", "中文", "😀", "中😀尾"}) {
            int size = value.getBytes(StandardCharsets.UTF_8).length;
            assertTrue(NativeMessagePolicy.withinUtf8Budget(value, size));
            if (size != 0) assertFalse(NativeMessagePolicy.withinUtf8Budget(value, size - 1));
        }
        assertFalse(NativeMessagePolicy.withinUtf8Budget(null, 100));
        assertFalse(NativeMessagePolicy.withinUtf8Budget("\ud800", 100));
        assertFalse(NativeMessagePolicy.withinUtf8Budget("\udc00", 100));
        assertFalse(NativeMessagePolicy.withinUtf8Budget("\ud800x", 100));
        assertTrue(NativeMessagePolicy.withinUtf8Budget("\\ud800", 6));
        assertTrue(NativeMessagePolicy.withinUtf8Budget("x".repeat(65536), 65536));
        assertFalse(NativeMessagePolicy.withinUtf8Budget("中".repeat(21846), 65536));
    }
    @Test public void depthBoundIgnoresDelimitersInsideStringsAndEscapes() {
        assertTrue(NativeMessagePolicy.withinJsonDepth("[".repeat(32) + "0" + "]".repeat(32)));
        assertFalse(NativeMessagePolicy.withinJsonDepth("[".repeat(33) + "0" + "]".repeat(33)));
        assertTrue(NativeMessagePolicy.withinJsonDepth("{\"x\":\"[[[\\\"\\\\\"}"));
        assertFalse(NativeMessagePolicy.withinJsonDepth("{\"x\":\"unterminated}"));
        assertFalse(NativeMessagePolicy.withinJsonDepth("}{"));
        assertFalse(NativeMessagePolicy.withinJsonDepth("[0"));
    }
    @Test public void lenientParserLexicalExtensionsCannotBypassTheDepthScanner() {
        String nested = "[".repeat(33) + "0" + "]".repeat(33);
        assertFalse(NativeMessagePolicy.withinJsonDepth("/*\"*/" + nested + "/*\"*/"));
        for (String value : new String[]{"{'x':1}", "{x=1}", "[1;2]", "#comment\n{}", "//comment\n{}", "[0x1]", "[NaN]", "[Infinity]"}) {
            assertFalse(value, NativeMessagePolicy.withinJsonDepth(value));
        }
        assertTrue(NativeMessagePolicy.withinJsonDepth("{\"value\":\"/*\\\"*/#'\",\"n\":-1.2e+3,\"b\":true,\"empty\":null}"));
    }
    @Test public void fastPrecheckDoesNotReplaceStrictStreamingValidation() {
        // JSONTokener can treat true" as an unquoted literal. The precheck's
        // string context differs, so only the channel's strict reader can reject
        // this input before any recursive parsing of its nested arrays.
        String nested = "[".repeat(33) + "0" + "]".repeat(33);
        assertTrue(NativeMessagePolicy.withinJsonDepth("{\"x\":true\",\"n\":" + nested + ",\"t\":true\"}"));
    }
    @Test public void capsPendingRequestsAndRejectsInFlightDuplicateIds() {
        NativeMessagePolicy policy = new NativeMessagePolicy();
        NativeMessagePolicy.Ticket first = policy.start("r0");
        assertNotNull(first); assertNull(policy.start("r0"));
        for (int i = 1; i < NativeMessagePolicy.MAX_IN_FLIGHT; i++) assertNotNull(policy.start("r" + i));
        assertNull(policy.start("over"));
        policy.finish(first); assertNotNull(policy.start("next"));
    }
    @Test public void completedTicketCannotReplyOrReleaseANewerRequestWithSameId() {
        NativeMessagePolicy policy = new NativeMessagePolicy();
        NativeMessagePolicy.Ticket first = policy.start("id");
        assertTrue(policy.mayReply(first)); policy.finish(first); assertFalse(policy.mayReply(first));
        NativeMessagePolicy.Ticket second = policy.start("id");
        policy.finish(first); assertTrue(policy.mayReply(second));
        assertFalse(policy.mayReply(new NativeMessagePolicy.Ticket("id", second.generation)));
    }
    @Test public void closeRevokesCapturedGenerationAndCannotBeReopened() {
        NativeMessagePolicy policy = new NativeMessagePolicy();
        NativeMessagePolicy.Ticket ticket = policy.start("id");
        assertTrue(policy.mayReply(ticket)); policy.close();
        assertFalse(policy.mayReply(ticket)); assertNull(policy.start("new"));
        policy.finish(ticket); policy.close(); assertFalse(policy.mayReply(ticket));
    }
}
