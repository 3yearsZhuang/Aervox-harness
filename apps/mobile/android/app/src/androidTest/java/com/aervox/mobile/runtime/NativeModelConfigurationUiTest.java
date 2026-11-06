package com.aervox.mobile.runtime;

import static org.junit.Assert.*;

import android.content.Context;
import android.app.UiModeManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.InsetDrawable;
import android.os.Build;
import android.os.Parcelable;
import android.os.ParcelFileDescriptor;
import android.text.InputType;
import android.text.method.PasswordTransformationMethod;
import android.util.SparseArray;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import androidx.appcompat.app.AlertDialog;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.aervox.mobile.R;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.shape.MaterialShapeDrawable;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;
import java.io.File;
import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.UUID;
import java.time.LocalTime;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Material windows and service receipts in a debug-only empty Activity.
 * Every credential store uses its own test directory and Keystore namespace;
 * no MainActivity, business database, production slot or network is accessed.
 */
@RunWith(AndroidJUnit4.class)
public final class NativeModelConfigurationUiTest {
    private static final String BASE = "https://api.example.com/v1";
    private static final String KEY = "isolated-native-form-key";
    private Context context;
    private ActivityScenario<NativeModelConfigurationTestActivity> scenario;
    private NativeModelService service;
    private NativeModelConfigurationForm directForm;
    private NativeCredentialStore store;
    private String namespace, alias;
    private File directory;
    private NativeModelConfigurationTestActivity activity;
    private final AtomicBoolean rejectCommit = new AtomicBoolean();

    @Before public void prepare() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        namespace = UUID.randomUUID().toString();
        alias = "com.aervox.mobile.credential-tests.v1." + namespace + ".primary-model";
        directory = new File(new File(context.getNoBackupFilesDir(), "aervox-credential-tests"), namespace);
        store = NativeCredentialStore.isolatedForTest(context, namespace, () -> {
            if (rejectCommit.get()) throw new IOException("isolated commit rejection");
        });
        scenario = ActivityScenario.launch(NativeModelConfigurationTestActivity.class);
        scenario.onActivity(owner -> {
            activity = owner;
            service = new NativeModelService(owner, store);
            owner.appearanceChanged = service::refreshAppearance;
        });
    }

    @After public void clean() throws Exception {
        if (directForm != null) main(() -> { directForm.clearKey(); directForm.dialog.dismiss(); });
        if (service != null) service.close().get(10, TimeUnit.SECONDS);
        if (scenario != null) scenario.close();
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
        keys.load(null); keys.deleteEntry(alias);
        if (directory.isDirectory()) {
            File[] files = directory.listFiles();
            if (files != null) for (File file : files) assertTrue("test file cleanup", file.delete());
            assertTrue("test namespace cleanup", directory.delete());
        }
    }

    @Test public void firstAttachmentIsSecureAndNoFormHierarchyCanPersistOrAutofillTheKey() throws Exception {
        AtomicBoolean secureAtAttach = new AtomicBoolean();
        CountDownLatch firstAttachment = new CountDownLatch(1);
        scenario.onActivity(owner -> {
            directForm = new NativeModelConfigurationForm(owner, BASE, "test-model", false, () -> {});
            directForm.scroll.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
                @Override public void onViewAttachedToWindow(View view) {
                    if (firstAttachment.getCount() == 0) return;
                    secureAtAttach.set((directForm.dialog.getWindow().getAttributes().flags
                        & WindowManager.LayoutParams.FLAG_SECURE) != 0);
                    firstAttachment.countDown();
                }
                @Override public void onViewDetachedFromWindow(View view) { }
            });
            directForm.show(view -> {});
            directForm.key.setText(KEY);
        });
        assertTrue("the first form view actually attached", firstAttachment.await(10, TimeUnit.SECONDS));
        assertTrue("FLAG_SECURE at the actual first form attachment", secureAtAttach.get());
        main(() -> {
            for (View view : new View[] { directForm.scroll, directForm.fields,
                    directForm.endpointLayout, directForm.modelLayout, directForm.keyLayout,
                    directForm.endpoint, directForm.model, directForm.key }) {
                assertFalse("no hierarchy state", view.isSaveEnabled());
                assertFalse("no ancestor saving", view.isSaveFromParentEnabled());
                if (Build.VERSION.SDK_INT >= 26) {
                    assertEquals(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS, view.getImportantForAutofill());
                }
                if (Build.VERSION.SDK_INT >= 30) {
                    assertEquals(View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS, view.getImportantForContentCapture());
                }
            }
            for (TextInputEditText input : new TextInputEditText[] { directForm.endpoint, directForm.model, directForm.key }) {
                assertTrue((input.getImeOptions() & EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING) != 0);
                assertTrue((input.getImeOptions() & EditorInfo.IME_FLAG_NO_EXTRACT_UI) != 0);
            }
            assertEquals(InputType.TYPE_TEXT_VARIATION_PASSWORD, directForm.key.getInputType() & InputType.TYPE_MASK_VARIATION);
            assertTrue(directForm.key.getTransformationMethod() instanceof PasswordTransformationMethod);
            assertFalse(directForm.key.isLongClickable());
            SparseArray<Parcelable> saved = new SparseArray<>();
            directForm.scroll.saveHierarchyState(saved);
            assertEquals("no editable field state escaped through ancestors", 0, saved.size());
        });
    }

    @Test public void savingHasReadableFeedbackAndLocksInputsWhileErasingTheEnteredKey() throws Exception {
        AtomicInteger cancelled = new AtomicInteger();
        scenario.onActivity(owner -> {
            directForm = new NativeModelConfigurationForm(owner, BASE, "test-model", false, cancelled::incrementAndGet);
            directForm.show(view -> {});
            directForm.key.setText(KEY);
            directForm.beginSaving();
            assertEquals(0, directForm.key.length());
            assertEquals(View.VISIBLE, directForm.status.getVisibility());
            assertEquals(owner.getString(R.string.native_model_saving_status), directForm.status.getText().toString());
            assertEquals(View.ACCESSIBILITY_LIVE_REGION_POLITE, directForm.status.getAccessibilityLiveRegion());
            assertEquals(View.VISIBLE, directForm.progress.getVisibility());
            assertTrue(directForm.progress.isIndeterminate());
            assertFalse(directForm.dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled());
            assertFalse(directForm.dialog.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled());
            assertEquals(owner.getString(R.string.native_model_saving), directForm.dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString());
            for (TextInputEditText input : new TextInputEditText[] { directForm.endpoint, directForm.model, directForm.key }) assertFalse(input.isEnabled());
            assertEquals(0, cancelled.get());
        });
    }

    @Test public void invalidFieldsShowSupportingErrorsAndKeepTheDialogAndRequestOpen() throws Exception {
        CompletableFuture<JSONObject> result = service.request(configure());
        AlertDialog dialog = awaitDialog();
        main(() -> {
            TextInputEditText endpoint = endpoint(dialog), model = model(dialog), key = key(dialog);
            model.setText("");
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            assertFieldError(dialog, R.id.native_model_name_layout, model, R.string.native_model_error_name);
            model.setText("test-model");
            endpoint.setText(BASE + "/chat/completions");
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            assertFieldError(dialog, R.id.native_model_endpoint_layout, endpoint, R.string.native_model_error_completion_endpoint);
            endpoint.setText("http://api.example.com/v1");
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            assertFieldError(dialog, R.id.native_model_endpoint_layout, endpoint, R.string.native_model_error_endpoint);
            endpoint.setText(BASE);
            key.setText("");
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            assertFieldError(dialog, R.id.native_model_key_layout, key, R.string.native_model_error_key);
            assertTrue(dialog.isShowing());
            assertFalse(result.isDone());
        });
        assertNull(store.get(NativeCredentialStore.Slot.PRIMARY_MODEL));
    }

    @Test public void cancellationButtonProgrammaticCancellationAndDismissalAllEraseTheKeyWithoutSaving() throws Exception {
        for (int action = 0; action < 3; action++) {
            CompletableFuture<JSONObject> result = service.request(configure());
            AlertDialog dialog = awaitDialog();
            final int currentAction = action;
            TextInputEditText entered = key(dialog);
            main(() -> {
                entered.setText(KEY);
                if (currentAction == 0) dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick();
                else if (currentAction == 1) dialog.cancel();
                else dialog.dismiss();
            });
            assertEquals("configuration_cancelled", result.get(10, TimeUnit.SECONDS).getString("kind"));
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            main(() -> assertEquals(0, entered.length()));
            assertNull(store.get(NativeCredentialStore.Slot.PRIMARY_MODEL));
        }
    }

    @Test public void changingTheEndpointRequiresANewKeyAndSameEndpointCanReuseTheExistingKey() throws Exception {
        writeConfig(BASE, "old-model", KEY);
        CompletableFuture<JSONObject> result = service.request(configure());
        AlertDialog dialog = awaitDialog();
        main(() -> {
            assertEquals(0, key(dialog).length());
            endpoint(dialog).setText("https://other.example.com/v1");
            model(dialog).setText("new-model");
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            assertFieldError(dialog, R.id.native_model_key_layout, key(dialog), R.string.native_model_error_key);
            assertFalse(result.isDone());
        });
        assertEquals("old-model", readConfig().getString("model"));
        main(() -> {
            endpoint(dialog).setText(BASE);
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        });
        JSONObject receipt = result.get(10, TimeUnit.SECONDS);
        assertEquals("summary", receipt.getString("kind"));
        assertTrue(receipt.getBoolean("hasCredential"));
        assertEquals(BASE, receipt.getString("endpoint"));
        assertEquals("new-model", receipt.getString("model"));
        assertFalse(receipt.has("key"));
        assertFalse(receipt.toString().contains(KEY));
        JSONObject stored = readConfig();
        assertEquals(BASE, stored.getString("endpoint"));
        assertEquals("new-model", stored.getString("model"));
        assertEquals(KEY, stored.getString("key"));
    }

    @Test public void firstSaveStoresOneCompleteConfigurationAndReturnsOnlyItsPublicSummary() throws Exception {
        CompletableFuture<JSONObject> result = service.request(configure());
        AlertDialog dialog = awaitDialog();
        TextInputEditText entered = key(dialog);
        main(() -> {
            endpoint(dialog).setText(BASE);
            model(dialog).setText("first-model");
            entered.setText(KEY);
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        });
        JSONObject receipt = result.get(10, TimeUnit.SECONDS);
        assertEquals("summary", receipt.getString("kind"));
        assertTrue(receipt.getBoolean("hasCredential"));
        assertEquals(BASE, receipt.getString("endpoint"));
        assertEquals("first-model", receipt.getString("model"));
        assertFalse(receipt.has("key"));
        assertFalse(receipt.toString().contains(KEY));
        JSONObject stored = readConfig();
        assertEquals(4, stored.length());
        assertEquals(1, stored.getInt("version"));
        assertEquals(BASE, stored.getString("endpoint"));
        assertEquals("first-model", stored.getString("model"));
        assertEquals(KEY, stored.getString("key"));
        awaitCondition(() -> !onMain(dialog::isShowing));
        main(() -> assertEquals(0, entered.length()));
    }

    @Test public void failedAtomicSaveKeepsThePriorConfigurationAndDismissalErasesTheNewKey() throws Exception {
        writeConfig(BASE, "old-model", KEY);
        CompletableFuture<JSONObject> result = service.request(configure());
        AlertDialog dialog = awaitDialog();
        TextInputEditText entered = key(dialog);
        rejectCommit.set(true);
        main(() -> {
            model(dialog).setText("replacement-model");
            entered.setText("isolated-replacement-key");
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        });
        rejected(result, "CREDENTIAL_STORAGE_FAILED");
        awaitCondition(() -> !onMain(dialog::isShowing));
        main(() -> assertEquals(0, entered.length()));
        JSONObject stored = readConfig();
        assertEquals("old-model", stored.getString("model"));
        assertEquals(KEY, stored.getString("key"));
    }

    @Test public void closingTheServiceCancelsTheOwnedDialogAndErasesItsKey() throws Exception {
        CompletableFuture<JSONObject> result = service.request(configure());
        AlertDialog dialog = awaitDialog();
        TextInputEditText entered = key(dialog);
        main(() -> entered.setText(KEY));
        service.close().get(10, TimeUnit.SECONDS);
        rejected(result, "CLOSED");
        awaitCondition(() -> !onMain(dialog::isShowing));
        main(() -> { assertFalse(dialog.isShowing()); assertEquals(0, entered.length()); });
        assertNull(store.get(NativeCredentialStore.Slot.PRIMARY_MODEL));
    }

    @Test public void aFocusedFieldErrorCanScrollWithinAShortDialogViewport() throws Exception {
        scenario.onActivity(owner -> {
            directForm = new NativeModelConfigurationForm(owner, BASE, "test-model", false, () -> {});
            directForm.show(view -> {});
            directForm.dialog.getWindow().setLayout(dp(320), dp(300));
        });
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        main(() -> {
            assertEquals(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE,
                directForm.dialog.getWindow().getAttributes().softInputMode & WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST);
            directForm.fieldError(directForm.keyLayout, directForm.key, R.string.native_model_error_key);
        });
        // A positive offset is only the first frame of a smooth scroll. Wait for
        // the focused input to actually enter the resized visible viewport.
        awaitCondition(() -> onMain(() -> {
            Rect viewport = new Rect(), input = new Rect();
            return directForm.scroll.getScrollY() > 0
                && directForm.scroll.getGlobalVisibleRect(viewport)
                && directForm.key.getGlobalVisibleRect(input)
                && Rect.intersects(viewport, input);
        }));
        main(() -> {
            assertTrue(directForm.key.isFocused());
            Rect scroll = new Rect(), key = new Rect();
            assertTrue(directForm.scroll.getGlobalVisibleRect(scroll));
            assertTrue(directForm.key.getGlobalVisibleRect(key));
            assertTrue("focused input stays within the resized scroll viewport", Rect.intersects(scroll, key));
        });
    }

    @Test public void systemLightDarkLightChangesRepaintTheSameSecureServiceFormWithoutLosingInputOrErrors() throws Exception {
        requireSystemThemeEmulator();
        NightMode original = captureNightMode();
        try {
            setSystemNight("no");
            CompletableFuture<JSONObject> result = service.request(configure());
            AlertDialog dialog = awaitDialog();
            NativeModelConfigurationForm form = serviceForm();
            AtomicReference<FormState> state = new AtomicReference<>();
            main(() -> {
                form.key.setText(KEY);
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
                assertEquals(context.getString(R.string.native_model_error_name), String.valueOf(form.modelLayout.getError()));
                form.key.requestFocus();
                form.key.setSelection(3, 10);
                state.set(new FormState(form));
                assertNightColors(form, false, false);
            });
            setSystemNight("yes");
            main(() -> { assertSameState(state.get()); assertNightColors(form, true, false); });
            setSystemNight("no");
            main(() -> { assertSameState(state.get()); assertNightColors(form, false, false); });
            assertFalse("appearance changes do not finish configuration", result.isDone());
            assertNull(store.get(NativeCredentialStore.Slot.PRIMARY_MODEL));
        } finally { restoreNightMode(original); }
    }

    @Test public void systemThemeChangesKeepTheExistingServiceFormInItsSavingState() throws Exception {
        requireSystemThemeEmulator();
        NightMode original = captureNightMode();
        try {
            setSystemNight("no");
            CompletableFuture<JSONObject> result = service.request(configure());
            awaitDialog();
            NativeModelConfigurationForm form = serviceForm();
            AtomicReference<FormState> state = new AtomicReference<>();
            main(() -> {
                form.key.setText(KEY);
                // Deterministic visual saving state, without blocking credential I/O.
                form.beginSaving();
                state.set(new FormState(form));
                assertNightColors(form, false, true);
            });
            setSystemNight("yes");
            main(() -> { assertSameState(state.get()); assertNightColors(form, true, true); });
            setSystemNight("no");
            main(() -> { assertSameState(state.get()); assertNightColors(form, false, true); });
            assertFalse(result.isDone());
            assertNull(store.get(NativeCredentialStore.Slot.PRIMARY_MODEL));
        } finally { restoreNightMode(original); }
    }

    private void assertNightColors(NativeModelConfigurationForm form, boolean dark, boolean saving) {
        int foreground = dark ? 0xFFE3E2E9 : 0xFF1A1B21;
        int primary = dark ? 0xFFB5C4FF : 0xFF4B5C92;
        int disabled = dark ? 0x61E3E2E9 : 0x611A1B21;
        int variant = activity.getColor(R.color.runtime_on_surface_variant);
        int outline = activity.getColor(R.color.runtime_outline);
        int error = activity.getColor(R.color.runtime_error);
        assertEquals(foreground, activity.getColor(R.color.runtime_on_surface));
        assertEquals(primary, activity.getColor(R.color.runtime_primary));
        assertEquals(dark ? 0xFF292A2F : 0xFFE9E7EF, backgroundShape(form.dialog.getWindow().getDecorView().getBackground()).getFillColor().getDefaultColor());
        assertEquals(variant, form.description.getCurrentTextColor());
        assertEquals(variant, form.status.getCurrentTextColor());
        for (TextInputLayout layout : new TextInputLayout[] { form.endpointLayout, form.modelLayout, form.keyLayout }) {
            TextInputEditText input = (TextInputEditText) layout.getEditText();
            assertEquals(saving ? disabled : foreground, input.getCurrentTextColor());
            assertEquals(variant, layout.getDefaultHintTextColor().getDefaultColor());
            assertEquals(disabled, layout.getDefaultHintTextColor().getColorForState(new int[] {-android.R.attr.state_enabled}, Color.MAGENTA));
            assertEquals(primary, layout.getHintTextColor().getDefaultColor());
            assertEquals(primary, layout.getBoxStrokeColor());
            assertEquals(error, layout.getBoxStrokeErrorColor().getDefaultColor());
            assertEquals(error, layout.getErrorCurrentTextColors());
        }
        assertEquals(saving ? disabled : outline, boxShape(form.endpointLayout).getStrokeColor().getDefaultColor());
        if (!saving) {
            assertEquals(primary, boxShape(form.keyLayout).getStrokeColor().getDefaultColor());
            assertEquals(error, boxShape(form.modelLayout).getStrokeColor().getDefaultColor());
        }
        for (int which : new int[] {AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE}) {
            assertTrue("official Material dialog button", form.dialog.getButton(which) instanceof MaterialButton);
            MaterialButton button = (MaterialButton) form.dialog.getButton(which);
            assertEquals(saving ? disabled : primary, button.getCurrentTextColor());
            assertNotNull(button.getBackgroundTintList());
            assertEquals(Color.TRANSPARENT, button.getBackgroundTintList().getDefaultColor());
            assertEquals(Color.TRANSPARENT, button.getStrokeColor().getDefaultColor());
            assertEquals(dark ? 0x1FB5C4FF : 0x1F4B5C92, button.getRippleColor().getDefaultColor());
        }
        assertArrayEquals(new int[] {primary}, form.progress.getIndicatorColor());
        assertEquals(activity.getColor(R.color.runtime_surface_container_highest), form.progress.getTrackColor());
    }

    private void assertSameState(FormState state) {
        assertSame(state.form, serviceForm());
        assertSame(state.dialog, serviceForm().dialog);
        assertTrue(state.dialog.isShowing());
        assertSame(state.focus, state.dialog.getCurrentFocus());
        assertEquals(state.key, state.form.key.getText().toString());
        assertEquals(state.selectionStart, state.form.key.getSelectionStart());
        assertEquals(state.selectionEnd, state.form.key.getSelectionEnd());
        assertEquals(state.modelError, state.form.modelLayout.getError());
        assertEquals(state.endpointError, state.form.endpointLayout.getError());
        assertEquals(state.keyError, state.form.keyLayout.getError());
        assertEquals(state.progressVisible, state.form.progress.getVisibility());
        assertEquals(state.statusVisible, state.form.status.getVisibility());
        assertEquals(state.indeterminate, state.form.progress.isIndeterminate());
        assertEquals(state.positiveEnabled, state.dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled());
        assertEquals(state.negativeEnabled, state.dialog.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled());
        assertEquals(state.positiveText, state.dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString());
        assertTrue((state.dialog.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0);
        assertTrue(state.form.key.getTransformationMethod() instanceof PasswordTransformationMethod);
    }

    private static final class FormState {
        final NativeModelConfigurationForm form;
        final AlertDialog dialog;
        final View focus;
        final String key, positiveText;
        final CharSequence endpointError, modelError, keyError;
        final int selectionStart, selectionEnd, progressVisible, statusVisible;
        final boolean indeterminate, positiveEnabled, negativeEnabled;
        FormState(NativeModelConfigurationForm form) {
            this.form = form; dialog = form.dialog; focus = dialog.getCurrentFocus();
            key = form.key.getText().toString(); selectionStart = form.key.getSelectionStart(); selectionEnd = form.key.getSelectionEnd();
            endpointError = form.endpointLayout.getError(); modelError = form.modelLayout.getError(); keyError = form.keyLayout.getError();
            progressVisible = form.progress.getVisibility(); statusVisible = form.status.getVisibility(); indeterminate = form.progress.isIndeterminate();
            positiveEnabled = dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled(); negativeEnabled = dialog.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled();
            positiveText = dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString();
        }
    }

    private NativeModelConfigurationForm serviceForm() {
        try {
            Field field = NativeModelService.class.getDeclaredField("configurationForm");
            field.setAccessible(true);
            NativeModelConfigurationForm form = (NativeModelConfigurationForm) field.get(service);
            assertNotNull("service retains its owned configuration form", form);
            return form;
        } catch (ReflectiveOperationException error) { throw new AssertionError(error); }
    }

    private static MaterialShapeDrawable backgroundShape(Drawable background) {
        while (background instanceof InsetDrawable) background = ((InsetDrawable) background).getDrawable();
        assertTrue("Material dialog surface drawable", background instanceof MaterialShapeDrawable);
        return (MaterialShapeDrawable) background;
    }

    /** Test-only access to the drawn outlined box in the pinned Material 1.13.0. */
    private static MaterialShapeDrawable boxShape(TextInputLayout layout) {
        try {
            Field field = TextInputLayout.class.getDeclaredField("boxBackground");
            field.setAccessible(true);
            Object background = field.get(layout);
            assertTrue("Material outlined field drawable", background instanceof MaterialShapeDrawable);
            return (MaterialShapeDrawable) background;
        } catch (ReflectiveOperationException error) { throw new AssertionError(error); }
    }

    private void requireSystemThemeEmulator() {
        assertTrue("system appearance test requires Android API 32 or newer", Build.VERSION.SDK_INT >= 32);
        assertTrue("system appearance test runs only on an isolated Android emulator",
            "ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE));
    }

    private static final class NightMode {
        final int value;
        final String token;
        final LocalTime start, end;
        NightMode(int value, String token, LocalTime start, LocalTime end) { this.value = value; this.token = token; this.start = start; this.end = end; }
    }

    private NightMode captureNightMode() throws Exception {
        UiModeManager manager = context.getSystemService(UiModeManager.class);
        assertNotNull(manager);
        int value = manager.getNightMode();
        return new NightMode(value, nightToken(shellNight(null)),
            value == UiModeManager.MODE_NIGHT_CUSTOM ? manager.getCustomNightModeStart() : null,
            value == UiModeManager.MODE_NIGHT_CUSTOM ? manager.getCustomNightModeEnd() : null);
    }

    private void setSystemNight(String token) throws Exception {
        int desired = "yes".equals(token) ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO;
        AtomicInteger previous = new AtomicInteger(), count = new AtomicInteger();
        main(() -> {
            previous.set(activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK);
            count.set(activity.appearanceChangeCount);
        });
        assertEquals(token, nightToken(shellNight(token)));
        awaitCondition(() -> onMain(() -> !activity.isDestroyed()
            && (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == desired
            && (previous.get() == desired || activity.appearanceChangeCount > count.get())));
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        scenario.onActivity(owner -> assertSame("configuration changes keep the same Activity", activity, owner));
    }

    private void restoreNightMode(NightMode original) throws Exception {
        assertEquals(original.token, nightToken(shellNight(original.token)));
        UiModeManager manager = context.getSystemService(UiModeManager.class);
        awaitCondition(() -> manager.getNightMode() == original.value);
        assertEquals(original.token, nightToken(shellNight(null)));
        if (original.value == UiModeManager.MODE_NIGHT_CUSTOM) {
            assertEquals(original.start, manager.getCustomNightModeStart());
            assertEquals(original.end, manager.getCustomNightModeEnd());
        }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    }

    private static String nightToken(String output) {
        String token = output.trim().replaceFirst("^Night mode: ", "");
        assertTrue("recognized system night-mode receipt: " + output,
            token.equals("no") || token.equals("yes") || token.equals("auto")
                || token.equals("custom_schedule") || token.equals("custom_bedtime"));
        return token;
    }

    private static String shellNight(String token) throws IOException {
        if (token != null && !token.equals("no") && !token.equals("yes") && !token.equals("auto")
                && !token.equals("custom_schedule") && !token.equals("custom_bedtime")) throw new IllegalArgumentException("invalid night-mode token");
        ParcelFileDescriptor descriptor = InstrumentationRegistry.getInstrumentation().getUiAutomation()
            .executeShellCommand(token == null ? "cmd uimode night" : "cmd uimode night " + token);
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
                ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] bytes = new byte[1024];
            int count;
            while ((count = input.read(bytes)) != -1) {
                if (output.size() + count > 16 * 1024) throw new IOException("oversized night-mode shell receipt");
                output.write(bytes, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private AlertDialog awaitDialog() throws Exception {
        AtomicReference<AlertDialog> found = new AtomicReference<>();
        Field field = NativeModelService.class.getDeclaredField("dialog");
        field.setAccessible(true);
        awaitCondition(() -> onMain(() -> {
            try {
                AlertDialog candidate = (AlertDialog) field.get(service);
                if (candidate == null || !candidate.isShowing()) return false;
                found.set(candidate); return true;
            } catch (IllegalAccessException error) { throw new AssertionError(error); }
        }));
        return found.get();
    }
    private void assertFieldError(AlertDialog dialog, int layoutId, TextInputEditText input, int message) {
        TextInputLayout layout = dialog.findViewById(layoutId);
        assertEquals(context.getString(message), String.valueOf(layout.getError()));
        assertTrue("error field is focused", input.isFocused());
        assertNull("platform error popup is not used", input.getError());
    }
    private TextInputEditText endpoint(AlertDialog dialog) { return dialog.findViewById(R.id.native_model_endpoint); }
    private TextInputEditText model(AlertDialog dialog) { return dialog.findViewById(R.id.native_model_name); }
    private TextInputEditText key(AlertDialog dialog) { return dialog.findViewById(R.id.native_model_key); }
    private static JSONObject configure() throws Exception { return new JSONObject().put("op", "configure"); }
    private void writeConfig(String endpoint, String model, String key) throws Exception {
        byte[] record = new JSONObject().put("version", 1).put("endpoint", endpoint).put("model", model)
            .put("key", key).toString().getBytes(StandardCharsets.UTF_8);
        try { store.put(NativeCredentialStore.Slot.PRIMARY_MODEL, record); }
        finally { Arrays.fill(record, (byte) 0); }
    }
    private JSONObject readConfig() throws Exception {
        byte[] record = store.get(NativeCredentialStore.Slot.PRIMARY_MODEL);
        try { assertNotNull(record); return new JSONObject(new String(record, StandardCharsets.UTF_8)); }
        finally { if (record != null) Arrays.fill(record, (byte) 0); }
    }
    private static void rejected(CompletableFuture<JSONObject> result, String code) throws Exception {
        try { result.get(10, TimeUnit.SECONDS); fail("expected " + code); }
        catch (ExecutionException error) {
            assertTrue(error.getCause() instanceof NativeModelService.ServiceException);
            assertEquals(code, ((NativeModelService.ServiceException) error.getCause()).code);
        }
    }
    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    private static void awaitCondition(BooleanSupplier condition) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > end) fail("isolated form condition timed out");
            Thread.sleep(10);
        }
    }
    private static boolean onMain(BooleanSupplier condition) {
        AtomicBoolean result = new AtomicBoolean();
        main(() -> result.set(condition.getAsBoolean()));
        return result.get();
    }
    private static void main(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
}
