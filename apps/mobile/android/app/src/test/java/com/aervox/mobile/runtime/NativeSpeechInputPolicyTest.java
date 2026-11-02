package com.aervox.mobile.runtime;

import static org.junit.Assert.assertEquals;
import android.speech.SpeechRecognizer;
import org.junit.Test;

public final class NativeSpeechInputPolicyTest {

    @Test public void mapsEveryRecognizerErrorToAFixedCode() {
        assertEquals("NO_SPEECH", NativeSpeechInputService.codeForError(SpeechRecognizer.ERROR_NO_MATCH));
        assertEquals("SPEECH_INPUT_TIMEOUT", NativeSpeechInputService.codeForError(SpeechRecognizer.ERROR_SPEECH_TIMEOUT));
        assertEquals("RECORD_AUDIO_REQUIRED", NativeSpeechInputService.codeForError(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS));
        assertEquals("SPEECH_INPUT_BUSY", NativeSpeechInputService.codeForError(SpeechRecognizer.ERROR_RECOGNIZER_BUSY));
        assertEquals("SPEECH_INPUT_FAILED", NativeSpeechInputService.codeForError(SpeechRecognizer.ERROR_CLIENT));
        assertEquals("SPEECH_INPUT_FAILED", NativeSpeechInputService.codeForError(SpeechRecognizer.ERROR_NETWORK));
        assertEquals("SPEECH_INPUT_FAILED", NativeSpeechInputService.codeForError(SpeechRecognizer.ERROR_NETWORK_TIMEOUT));
        assertEquals("SPEECH_INPUT_FAILED", NativeSpeechInputService.codeForError(SpeechRecognizer.ERROR_AUDIO));
        assertEquals("SPEECH_INPUT_FAILED", NativeSpeechInputService.codeForError(SpeechRecognizer.ERROR_SERVER));
        assertEquals("SPEECH_INPUT_FAILED", NativeSpeechInputService.codeForError(Integer.MAX_VALUE));
    }

    @Test public void keepsTheListenBudgetBounded() {
        assertEquals(12_000L, NativeSpeechInputService.LISTEN_BUDGET_MS);
    }
}
