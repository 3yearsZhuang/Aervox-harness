package com.aervox.mobile.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import org.junit.Test;

public final class NativeShizukuShellTest {

    @Test public void isUnavailableWithoutTheShizukuService() {
        // The classpath here has no Shizuku binder: reflection must fail closed.
        assertFalse(NativeShizukuShell.available());
    }

    @Test public void refusesToRunWithoutAnAuthorizedService() throws Exception {
        NativeShizukuShell shell = new NativeShizukuShell();
        try {
            shell.run("id -u", 1_000);
            org.junit.Assert.fail("expected rejection");
        } catch (NativeShizukuShell.ShizukuException expected) {
            assertEquals("SHIZUKU_UNAVAILABLE", expected.code);
        }
    }
}
