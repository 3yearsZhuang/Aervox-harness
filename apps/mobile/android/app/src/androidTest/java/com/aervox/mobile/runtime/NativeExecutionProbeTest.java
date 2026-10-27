package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual JNI/window/transaction/cancel evidence, not a bridge or user DB test.
 * No assumptions or skips turn unsupported native behavior into a success.
 */
@RunWith(AndroidJUnit4.class)
public final class NativeExecutionProbeTest {
    @Test public void fixedNativeExperimentCompletesAndDrainsItsDedicatedWorker() throws Exception {
        NativeExecutionProbe.Result result = NativeExecutionProbe.run(InstrumentationRegistry.getInstrumentation().getTargetContext());
        assertEquals("3.54.1", result.engineVersion);
        assertTrue(result.typedValues); assertTrue(result.returningOnce);
        assertTrue(result.overflowRejected); assertTrue(result.rollback);
        assertEquals(128, result.overflowRows);
        assertTrue(result.firstWindowRows > 0 && result.firstWindowRows < result.overflowRows);
        assertTrue(result.cancellationObserved); assertTrue(result.reopened); assertTrue(result.workerDrained);
    }
    @Test public void rejectsAnAccidentalUiThreadCallerBeforeOpeningAnyDatabase() {
        AtomicReference<NativeExecutionProbe.Failure> rejected = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try { NativeExecutionProbe.run(InstrumentationRegistry.getInstrumentation().getTargetContext()); fail("Expected caller rejection"); }
            catch (NativeExecutionProbe.ProbeException error) { rejected.set(error.code); assertNull(error.getCause()); }
        });
        assertEquals(NativeExecutionProbe.Failure.REQUIRES_BACKGROUND_CALLER, rejected.get());
    }
}
