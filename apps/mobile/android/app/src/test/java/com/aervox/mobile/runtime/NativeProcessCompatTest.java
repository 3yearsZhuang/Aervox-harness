package com.aervox.mobile.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;

public final class NativeProcessCompatTest {
    /** Fails if an API 26 method is accidentally used by the legacy path. */
    private static final class LegacyProcess extends Process {
        final CountDownLatch observed = new CountDownLatch(1);
        volatile Integer exitCode;
        int destroyCount;
        LegacyProcess(Integer completed) { exitCode = completed; }
        @Override public OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(new byte[0]); }
        @Override public InputStream getErrorStream() { return new ByteArrayInputStream(new byte[0]); }
        @Override public int waitFor() { throw new AssertionError("unbounded wait"); }
        @Override public boolean waitFor(long timeout, TimeUnit unit) { throw new AssertionError("API 26 timed wait"); }
        @Override public boolean isAlive() { throw new AssertionError("API 26 isAlive"); }
        @Override public Process destroyForcibly() { throw new AssertionError("API 26 force destroy"); }
        @Override public int exitValue() {
            observed.countDown();
            Integer code = exitCode;
            if (code == null) throw new IllegalThreadStateException("running");
            return code;
        }
        @Override public void destroy() { destroyCount++; exitCode = 143; }
    }

    @Test public void alreadyCompletedProcessPreservesExitStatusWithoutDestruction() throws Exception {
        LegacyProcess process = new LegacyProcess(7);
        assertTrue(NativeProcessCompat.waitForLegacy(process, 0));
        assertFalse(NativeProcessCompat.isAlive(process));
        NativeProcessCompat.destroyIfAlive(process);
        assertEquals(7, process.exitValue());
        assertEquals(0, process.destroyCount);
    }

    @Test(timeout = 2000) public void runningProcessCanCompleteInsideTheBoundedLegacyWait() throws Exception {
        LegacyProcess process = new LegacyProcess(null);
        Thread completion = new Thread(() -> {
            try { process.observed.await(); process.exitCode = 3; }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        });
        completion.start();
        try {
            assertTrue(NativeProcessCompat.waitForLegacy(process, 1000));
            assertEquals(3, process.exitValue());
            assertEquals(0, process.destroyCount);
        } finally { completion.join(1000); NativeProcessCompat.destroyIfAlive(process); }
    }

    @Test(timeout = 2000) public void timeoutReturnsFailureAndFinallyDestroysTheLegacyProcess() throws Exception {
        LegacyProcess process = new LegacyProcess(null);
        try { assertFalse(NativeProcessCompat.waitFor(process, 20)); }
        finally { NativeProcessCompat.destroyIfAlive(process); }
        assertEquals(1, process.destroyCount);
        assertFalse(NativeProcessCompat.isAlive(process));
    }

    @Test public void zeroOrNegativeTimeoutDoesNotStartAnUnboundedWait() throws Exception {
        for (int budget : new int[] { 0, -1 }) {
            LegacyProcess process = new LegacyProcess(null);
            assertFalse(NativeProcessCompat.waitForLegacy(process, budget));
            NativeProcessCompat.destroyIfAlive(process);
            assertEquals(1, process.destroyCount);
        }
    }

    @Test(timeout = 2000) public void interruptionStopsTheWaitAndDestroysTheProcess() throws Exception {
        LegacyProcess process = new LegacyProcess(null);
        AtomicBoolean cancelled = new AtomicBoolean();
        Thread worker = new Thread(() -> {
            try { NativeProcessCompat.waitForLegacy(process, 8000); }
            catch (InterruptedException expected) { cancelled.set(true); }
            finally { NativeProcessCompat.destroyIfAlive(process); }
        });
        worker.start();
        try {
            assertTrue(process.observed.await(1, TimeUnit.SECONDS));
            worker.interrupt();
            worker.join(1000);
            assertFalse(worker.isAlive());
            assertTrue(cancelled.get());
            assertEquals(1, process.destroyCount);
        } finally { worker.interrupt(); worker.join(1000); }
    }
}
