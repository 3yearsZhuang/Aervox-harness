package com.aervox.mobile.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import org.junit.Test;

public final class NativeDevicePolicyTest {
    interface Action { void run() throws Exception; }

    private static void rejected(Action action) {
        try { action.run(); fail("expected rejection"); }
        catch (NativeDevicePolicy.Rejected expected) { assertEquals("INVALID_ARGUMENT", expected.code); }
        catch (Exception other) { fail(other.toString()); }
    }

    @Test public void buildsOnlyFixedVerbs() throws Exception {
        assertEquals("input tap 12 34", NativeDevicePolicy.tap(12, 34).line);
        assertEquals("input swipe 1 2 3 4 300", NativeDevicePolicy.swipe(1, 2, 3, 4, 300).line);
        assertEquals("input keyevent KEYCODE_BACK", NativeDevicePolicy.key("BACK").line);
        assertEquals("input text 'hello world'", NativeDevicePolicy.text("hello world").line);
        assertEquals("monkey -p com.android.settings -c android.intent.category.LAUNCHER 1",
            NativeDevicePolicy.launch("com.android.settings").line);
        assertEquals(NativeDevicePolicy.CAPABILITY_CONTROL, NativeDevicePolicy.tap(1, 1).capability);
        assertEquals(NativeDevicePolicy.CAPABILITY_APPS, NativeDevicePolicy.launch("com.example.app").capability);
    }

    @Test public void refusesCoordinatesOutsideTheDisplayBound() {
        rejected(() -> NativeDevicePolicy.tap(-1, 0));
        rejected(() -> NativeDevicePolicy.tap(0, NativeDevicePolicy.MAX_COORDINATE + 1));
        rejected(() -> NativeDevicePolicy.swipe(0, 0, 0, 0, NativeDevicePolicy.MIN_SWIPE_MS - 1));
        rejected(() -> NativeDevicePolicy.swipe(0, 0, 0, 0, NativeDevicePolicy.MAX_SWIPE_MS + 1));
    }

    @Test public void refusesKeysAndTextThatCouldBecomeShellSyntax() {
        rejected(() -> NativeDevicePolicy.key("BACK; rm -rf /"));
        rejected(() -> NativeDevicePolicy.key("KEYCODE_HOME"));
        rejected(() -> NativeDevicePolicy.text(""));
        rejected(() -> NativeDevicePolicy.text("x".repeat(NativeDevicePolicy.MAX_TEXT_CHARS + 1)));
        // Non-ASCII input would be silently mistyped by `input text`.
        rejected(() -> NativeDevicePolicy.text("中文"));
        // A single quote would terminate the quoted argument.
        rejected(() -> NativeDevicePolicy.text("it's"));
        rejected(() -> NativeDevicePolicy.text("line\nbreak"));
    }

    @Test public void keepsShellMetacharactersLiteralInsideQuotedText() throws Exception {
        String line = NativeDevicePolicy.text("a; rm -rf /; echo $(id)").line;
        assertEquals("input text 'a; rm -rf /; echo $(id)'", line);
        // Exactly the two wrapping quotes: the payload cannot terminate the argument.
        assertEquals(2, line.chars().filter(character -> character == '\'').count());
        assertTrue(line.endsWith("'"));
    }

    @Test public void refusesPackageNamesThatCouldEscapeTheVerb() {
        rejected(() -> NativeDevicePolicy.launch("com.example; reboot"));
        rejected(() -> NativeDevicePolicy.launch("com/example"));
        rejected(() -> NativeDevicePolicy.launch("a"));
        rejected(() -> NativeDevicePolicy.launch("com..example"));
        rejected(() -> NativeDevicePolicy.launch("com.example." + "a".repeat(70)));
        assertTrue(NativeDevicePolicy.packageName("com.android.settings"));
        assertTrue(NativeDevicePolicy.packageName("com.example.app_debug2"));
    }

    @Test public void treatsOnlyUidZeroAsRoot() {
        assertTrue(NativeDevicePolicy.rootUid("0"));
        assertTrue(NativeDevicePolicy.rootUid("0\n"));
        assertFalse(NativeDevicePolicy.rootUid("2000"));
        assertFalse(NativeDevicePolicy.rootUid("uid=0(root)"));
        assertFalse(NativeDevicePolicy.rootUid(""));
        assertFalse(NativeDevicePolicy.rootUid(null));
    }

    @Test public void acceptsOnlyTheImplementedCapabilities() {
        assertTrue(NativeDevicePolicy.capability(NativeDevicePolicy.CAPABILITY_CONTROL));
        assertTrue(NativeDevicePolicy.capability(NativeDevicePolicy.CAPABILITY_APPS));
        assertFalse(NativeDevicePolicy.capability(NativeDevicePolicy.CAPABILITY_ADVANCED));
        assertFalse(NativeDevicePolicy.capability("shell"));
        assertFalse(NativeDevicePolicy.capability(""));
    }

    @Test public void rejectsRawCommandsEvenForPreviouslyGrantedAdvancedCapability() {
        for (String line : new String[] {"dumpsys battery", "rm -rf /", "", "x".repeat(2049)}) {
            try { NativeDevicePolicy.command(line); fail("expected rejection"); }
            catch (NativeDevicePolicy.Rejected expected) { assertEquals("UNSUPPORTED_DEVICE_ACTION", expected.code); }
        }
    }
}
