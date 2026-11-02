package com.aervox.mobile.runtime;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import org.json.JSONObject;

/**
 * One-shot voice input through the system speech recognizer.
 *
 * The WebView never supplies a locale, model or free-text command: a tap starts
 * a single bounded recognition (foreground only) and resolves with the final
 * transcript or a fixed code. RECORD_AUDIO is requested for this feature alone
 * when it is missing; a denial degrades to RECORD_AUDIO_REQUIRED instead of a
 * silent empty result.
 */
final class NativeSpeechInputService {
    static final long LISTEN_BUDGET_MS = 12_000;

    private final Activity owner;
    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private CompletableFuture<JSONObject> pending;
    private boolean closed, listening;
    // One stable Runnable identity: method references cannot be removed from the queue.
    private final Runnable budgetExpired = this::onBudgetExpired;

    static final class SpeechInputException extends Exception {
        final String code;
        SpeechInputException(String value) { super(value); code = value; }
    }

    NativeSpeechInputService(Activity activity) {
        owner = activity;
    }

    /** Pure error mapping so JVM tests can pin every degradation path. */
    static String codeForError(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH: return "NO_SPEECH";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "SPEECH_INPUT_TIMEOUT";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "RECORD_AUDIO_REQUIRED";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "SPEECH_INPUT_BUSY";
            case SpeechRecognizer.ERROR_CLIENT: return "SPEECH_INPUT_FAILED";
            default: return "SPEECH_INPUT_FAILED";
        }
    }

    CompletableFuture<JSONObject> request(JSONObject command) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        try {
            String operation = command.optString("operation", "");
            if ("listen".equals(operation)) {
                listen(result);
            } else if ("cancel".equals(operation)) {
                main.post(() -> {
                    stopListening();
                    try {
                        result.complete(new JSONObject().put("kind", "speech_input_result").put("ok", true));
                    } catch (Exception error) {
                        result.completeExceptionally(new SpeechInputException("SPEECH_INPUT_FAILED"));
                    }
                });
            } else {
                result.completeExceptionally(new SpeechInputException("INVALID_REQUEST"));
            }
        } catch (Exception error) {
            result.completeExceptionally(error instanceof SpeechInputException ? error : new SpeechInputException("SPEECH_INPUT_FAILED"));
        }
        return result;
    }

    private void listen(CompletableFuture<JSONObject> result) {
        if (closed) { result.completeExceptionally(new SpeechInputException("CLOSED")); return; }
        if (owner.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            // Request this permission for this feature only; the next tap retries.
            owner.requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, 4101);
            result.completeExceptionally(new SpeechInputException("RECORD_AUDIO_REQUIRED"));
            return;
        }
        main.post(() -> {
            if (closed) { result.completeExceptionally(new SpeechInputException("CLOSED")); return; }
            if (listening) { result.completeExceptionally(new SpeechInputException("SPEECH_INPUT_BUSY")); return; }
            if (!SpeechRecognizer.isRecognitionAvailable(owner)) {
                result.completeExceptionally(new SpeechInputException("SPEECH_INPUT_UNAVAILABLE"));
                return;
            }
            listening = true;
            pending = result;
            try {
                if (recognizer == null) recognizer = SpeechRecognizer.createSpeechRecognizer(owner);
                recognizer.setRecognitionListener(listener());
                android.content.Intent intent = new android.content.Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault());
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                recognizer.startListening(intent);
                main.postDelayed(budgetExpired, LISTEN_BUDGET_MS);
            } catch (Exception error) {
                settleExceptionally("SPEECH_INPUT_UNAVAILABLE");
            }
        });
    }

    /** The recognizer can return nothing well before the budget; never hang the bridge. */
    private void onBudgetExpired() {
        if (!listening || pending == null) return;
        stopListening();
        settleExceptionally("SPEECH_INPUT_TIMEOUT");
    }

    private RecognitionListener listener() {
        return new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onResults(Bundle results) {
                java.util.ArrayList<String> matches =
                    results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                String text = matches == null || matches.isEmpty() ? "" : String.valueOf(matches.get(0)).trim();
                stopListening();
                if (text.isEmpty()) settleExceptionally("NO_SPEECH");
                else settleResult(text);
            }
            @Override public void onPartialResults(Bundle partialResults) { }
            @Override public void onEvent(int eventType, Bundle params) { }
            @Override public void onError(int error) {
                String code = codeForError(error);
                stopListening();
                settleExceptionally(code);
            }
        };
    }

    private void settleResult(String text) {
        CompletableFuture<JSONObject> target = pending;
        pending = null;
        if (target == null) return;
        try {
            target.complete(new JSONObject().put("kind", "speech_input_result").put("text", text));
        } catch (Exception error) {
            target.completeExceptionally(new SpeechInputException("SPEECH_INPUT_FAILED"));
        }
    }

    private void settleExceptionally(String code) {
        CompletableFuture<JSONObject> target = pending;
        pending = null;
        if (target != null) target.completeExceptionally(new SpeechInputException(code));
    }

    private void stopListening() {
        listening = false;
        main.removeCallbacks(budgetExpired);
        if (recognizer != null) {
            try { recognizer.cancel(); } catch (Exception ignored) { /* Teardown is best effort. */ }
            try { recognizer.destroy(); } catch (Exception ignored) { /* Teardown is best effort. */ }
            recognizer = null;
        }
    }

    void close() {
        closed = true;
        main.post(() -> {
            settleExceptionally("CLOSED");
            stopListening();
        });
    }
}
