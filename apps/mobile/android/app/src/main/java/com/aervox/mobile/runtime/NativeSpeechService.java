package com.aervox.mobile.runtime;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import org.json.JSONObject;

/**
 * Read-aloud for the current reply through the system TTS engine.
 *
 * The WebView never supplies a locale, engine or file path: only bounded text
 * is accepted, always replayed with QUEUE_FLUSH so a new request cannot stack
 * behind an old one, and a missing/failed engine degrades to a fixed code
 * instead of a silent no-op.
 */
final class NativeSpeechService {
    static final int MAX_TEXT_CHARS = 4_000;
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech engine;
    private volatile boolean ready, failed, closed, speaking;

    static final class SpeechException extends Exception {
        final String code;
        SpeechException(String value) { super(value); code = value; }
    }

    NativeSpeechService(Context owner) {
        context = owner.getApplicationContext();
        // Construction is asynchronous; failures surface on the main thread.
        main.post(this::initialize);
    }

    private void initialize() {
        if (closed || engine != null) return;
        engine = new TextToSpeech(context, status -> main.post(() -> {
            if (closed) { shutdown(); return; }
            if (status != TextToSpeech.SUCCESS) { failed = true; return; }
            Locale chinese = Locale.SIMPLIFIED_CHINESE;
            if (engine == null || engine.isLanguageAvailable(chinese) < TextToSpeech.LANG_AVAILABLE) {
                // Keep the device default rather than forcing a locale it lacks.
                engine.setLanguage(Locale.getDefault());
            } else {
                engine.setLanguage(chinese);
            }
            engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) { speaking = true; }
                @Override public void onDone(String utteranceId) { speaking = false; }
                @Override public void onError(String utteranceId) { speaking = false; }
            });
            ready = true;
        }));
    }

    CompletableFuture<JSONObject> request(JSONObject command) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        try {
            String operation = command.optString("operation", "");
            if ("status".equals(operation)) {
                result.complete(new JSONObject().put("kind", "speech_status").put("available", ready)
                    .put("speaking", speaking).put("failed", failed));
            } else if ("speak".equals(operation)) {
                speak(command, result);
            } else if ("stop".equals(operation)) {
                if (engine != null && ready) engine.stop();
                speaking = false;
                result.complete(new JSONObject().put("kind", "speech_result").put("ok", true));
            } else {
                result.completeExceptionally(new SpeechException("INVALID_REQUEST"));
            }
        } catch (Exception error) {
            result.completeExceptionally(error instanceof SpeechException ? error : new SpeechException("SPEECH_FAILED"));
        }
        return result;
    }

    private void speak(JSONObject command, CompletableFuture<JSONObject> result) throws Exception {
        if (closed) throw new SpeechException("CLOSED");
        String text = command.optString("text", "");
        if (text.isEmpty() || text.length() > MAX_TEXT_CHARS) throw new SpeechException("INVALID_REQUEST");
        main.post(() -> {
            initialize();
            if (closed) { result.completeExceptionally(new SpeechException("CLOSED")); return; }
            if (failed || !ready || engine == null) { result.completeExceptionally(new SpeechException("SPEECH_UNAVAILABLE")); return; }
            int status = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "aervox-reply");
            if (status != TextToSpeech.SUCCESS) { result.completeExceptionally(new SpeechException("SPEECH_FAILED")); return; }
            try { result.complete(new JSONObject().put("kind", "speech_result").put("ok", true)); }
            catch (Exception ignored) { result.completeExceptionally(new SpeechException("SPEECH_FAILED")); }
        });
    }

    void close() {
        closed = true;
        speaking = false;
        main.post(this::shutdown);
    }

    private void shutdown() {
        if (engine == null) return;
        try { engine.stop(); engine.shutdown(); }
        catch (Exception ignored) { /* Engine teardown is best effort. */ }
        engine = null; ready = false;
    }
}
