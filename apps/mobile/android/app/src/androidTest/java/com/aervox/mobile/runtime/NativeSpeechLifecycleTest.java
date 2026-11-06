package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import android.speech.RecognitionListener;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Does not bind a recognizer, request microphone permission or touch user data. */
@RunWith(AndroidJUnit4.class)
public final class NativeSpeechLifecycleTest {
    private static void setPending(NativeSpeechInputService service, CompletableFuture<JSONObject> result) throws Exception {
        Field pending = NativeSpeechInputService.class.getDeclaredField("pending"); pending.setAccessible(true); pending.set(service, result);
        Field listening = NativeSpeechInputService.class.getDeclaredField("listening"); listening.setAccessible(true); listening.setBoolean(service, true);
    }
    private static String failure(CompletableFuture<JSONObject> result) throws Exception {
        try { result.get(2, TimeUnit.SECONDS); fail("expected cancellation"); return ""; }
        catch (ExecutionException error) { return error.getCause().getMessage(); }
    }

    @Test public void explicitCancelSettlesTheOutstandingListenInsteadOfOnlyStoppingItsTimer() throws Exception {
        NativeSpeechInputService service = new NativeSpeechInputService(null);
        CompletableFuture<JSONObject> listen = new CompletableFuture<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try { setPending(service, listen); } catch (Exception error) { throw new AssertionError(error); }
        });
        try {
            assertTrue(service.request(new JSONObject().put("operation", "cancel")).get(2, TimeUnit.SECONDS).getBoolean("ok"));
            assertEquals("SPEECH_INPUT_CANCELLED", failure(listen));
        } finally { service.close(); }
    }

    @Test public void foregroundStopSettlesTheListenAndIgnoresAnOlderRecognizersLateCallback() throws Exception {
        NativeSpeechInputService service = new NativeSpeechInputService(null);
        CompletableFuture<JSONObject> old = new CompletableFuture<>(), current = new CompletableFuture<>();
        Method factory = NativeSpeechInputService.class.getDeclaredMethod("listener", CompletableFuture.class); factory.setAccessible(true);
        RecognitionListener listener = (RecognitionListener) factory.invoke(service, old);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try { setPending(service, current); } catch (Exception error) { throw new AssertionError(error); }
            listener.onError(android.speech.SpeechRecognizer.ERROR_CLIENT);
        });
        assertFalse(current.isDone());
        service.stop();
        assertEquals("SPEECH_INPUT_CANCELLED", failure(current));
        service.close();
    }
}
