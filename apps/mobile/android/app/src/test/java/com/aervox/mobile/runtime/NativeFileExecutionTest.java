package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

/** Tests real executor ownership and deadlines without an Android document provider. */
public final class NativeFileExecutionTest {
    private static String failureCode(CompletableFuture<?> result) throws Exception {
        try { result.get(2, TimeUnit.SECONDS); fail("expected rejection"); return ""; }
        catch (ExecutionException error) {
            assertTrue(error.getCause() instanceof NativeFileService.FileException);
            return ((NativeFileService.FileException) error.getCause()).code;
        }
    }

    @Test public void readsOnItsOwnedWorkerAndPreservesByteLimits() throws Exception {
        NativeFileService service = new NativeFileService();
        Thread caller = Thread.currentThread();
        try {
            String value = service.submit(control -> {
                assertNotSame(caller, Thread.currentThread());
                return new String(NativeFileService.readBytes(new ByteArrayInputStream(new byte[] { 65, 66 }), control), java.nio.charset.StandardCharsets.UTF_8);
            }).get(2, TimeUnit.SECONDS);
            assertEquals("AB", value);
        } finally { service.close(); }
    }

    @Test public void deadlineRejectsButDoesNotAdmitMoreWorkUntilTheReaderActuallyExits() throws Exception {
        NativeFileService service = new NativeFileService(100);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), cleaned = new CountDownLatch(1);
        try {
            CompletableFuture<String> first = service.submit(control -> {
                control.onCancel(cleaned::countDown);
                entered.countDown();
                release.await();
                return "late";
            });
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            assertEquals("FILE_READ_TIMEOUT", failureCode(first));
            assertTrue(cleaned.await(2, TimeUnit.SECONDS));
            assertEquals("FILE_BUSY", failureCode(service.submit(control -> "must not queue")));
            release.countDown();
        } finally { release.countDown(); service.close(); }
    }

    @Test public void activityCloseRejectsPendingAndNewWorkAndCancelsOwnedResources() throws Exception {
        NativeFileService service = new NativeFileService();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), cleaned = new CountDownLatch(1);
        CompletableFuture<String> first = service.submit(control -> {
            control.onCancel(cleaned::countDown);
            entered.countDown();
            release.await();
            return "late";
        });
        assertTrue(entered.await(2, TimeUnit.SECONDS));
        service.close();
        release.countDown();
        assertEquals("CLOSED", failureCode(first));
        assertEquals("CLOSED", failureCode(service.submit(control -> "must not start")));
        assertTrue(cleaned.await(2, TimeUnit.SECONDS));
    }
}
