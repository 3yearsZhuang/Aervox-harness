package com.aervox.mobile.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;
import org.junit.Test;

public final class NativeFilePolicyTest {

    @Test public void acceptsTextWithinTheBudget() throws Exception {
        byte[] small = "prompt,answer".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        assertEquals(small.length, NativeFileService.boundedBytes(small).length);
    }

    @Test public void refusesOversizedContentWithAFixedCode() {
        byte[] huge = new byte[NativeFileService.MAX_TEXT_BYTES + 1];
        try {
            NativeFileService.boundedBytes(huge);
            fail("expected rejection");
        } catch (NativeFileService.FileException expected) {
            assertEquals("FILE_TOO_LARGE", expected.code);
        }
    }

    @Test public void acceptsOnlyBoundedHttpsUrls() throws Exception {
        assertEquals("https://example.com/a.csv", NativeFileService.requireHttps("https://example.com/a.csv"));
        for (String bad : new String[] { "http://example.com/a.csv", "file:///etc/passwd", "javascript:alert(1)", "" }) {
            try {
                NativeFileService.requireHttps(bad);
                fail("expected rejection: " + bad);
            } catch (NativeFileService.FileException expected) {
                assertEquals("FILE_URL_INVALID", expected.code);
            }
        }
    }
}
