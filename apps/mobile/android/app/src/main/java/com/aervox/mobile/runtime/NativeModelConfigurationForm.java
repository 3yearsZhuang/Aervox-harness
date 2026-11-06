package com.aervox.mobile.runtime;

import android.app.Activity;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.text.method.PasswordTransformationMethod;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.widget.NestedScrollView;
import com.aervox.mobile.R;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import com.google.android.material.shape.MaterialShapeDrawable;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;
import com.google.android.material.textview.MaterialTextView;

/** Native-only model form. Configuration validation and credential ownership
 * remain in NativeModelService; this view never receives a saved plaintext key. */
final class NativeModelConfigurationForm {
    private final Activity owner;
    private final Drawable dialogBackground;
    final AlertDialog dialog;
    final NestedScrollView scroll;
    final LinearLayout fields;
    final TextInputLayout endpointLayout, modelLayout, keyLayout;
    final TextInputEditText endpoint, model, key;
    final MaterialTextView description, status;
    final LinearProgressIndicator progress;

    NativeModelConfigurationForm(Activity owner, String address, String modelName, boolean priorKey, Runnable cancelled) {
        this.owner = owner;
        MaterialAlertDialogBuilder builder = new MaterialAlertDialogBuilder(owner);
        dialogBackground = builder.getBackground();
        Context theme = builder.getContext();
        fields = new LinearLayout(theme);
        fields.setId(R.id.native_model_fields);
        fields.setOrientation(LinearLayout.VERTICAL);
        fields.setPadding(dp(theme, 24), 0, dp(theme, 24), dp(theme, 16));
        protect(fields);
        description = new MaterialTextView(theme);
        description.setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodyMedium);
        description.setText(R.string.native_model_description);
        fields.addView(description);

        endpointLayout = field(theme, R.id.native_model_endpoint_layout, R.id.native_model_endpoint,
            R.string.native_model_endpoint_label, R.string.native_model_endpoint_support, false);
        endpoint = (TextInputEditText) endpointLayout.getEditText();
        endpoint.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        endpoint.setText(address);
        modelLayout = field(theme, R.id.native_model_name_layout, R.id.native_model_name,
            R.string.native_model_name_label, 0, false);
        model = (TextInputEditText) modelLayout.getEditText();
        model.setText(modelName);
        keyLayout = field(theme, R.id.native_model_key_layout, R.id.native_model_key,
            R.string.native_model_key_label,
            priorKey ? R.string.native_model_key_keep_support : R.string.native_model_key_support, true);
        key = (TextInputEditText) keyLayout.getEditText();
        key.setImeOptions(EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING | EditorInfo.IME_ACTION_DONE);

        status = new MaterialTextView(theme);
        status.setId(R.id.native_model_saving_status);
        status.setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodyMedium);
        status.setText(R.string.native_model_saving_status);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setVisibility(View.GONE);
        add(status, 16);
        progress = new LinearProgressIndicator(theme);
        progress.setId(R.id.native_model_saving_progress);
        progress.setIndeterminate(true);
        progress.setVisibility(View.GONE);
        add(progress, 8);

        scroll = new NestedScrollView(theme);
        scroll.setId(R.id.native_model_scroll);
        scroll.setFillViewport(false);
        protect(scroll);
        scroll.addView(fields, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dialog = builder.setTitle(R.string.native_model_title).setView(scroll)
            .setNegativeButton(R.string.native_model_cancel, (ignored, which) -> cancelled.run())
            .setPositiveButton(R.string.native_model_save, null).create();
        dialog.setOnCancelListener(ignored -> cancelled.run());
    }

    void show(View.OnClickListener save) {
        Window window = dialog.getWindow();
        if (window == null) throw new IllegalStateException("MODEL_UI_UNAVAILABLE");
        // Secure the window before first show, including its ancestors. The form
        // cannot enter autofill, content capture or the system view-state bundle.
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        protect(window.getDecorView());
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setMinHeight(dp(scroll.getContext(), 48));
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setMinHeight(dp(scroll.getContext(), 48));
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(save);
            key.setOnEditorActionListener((input, action, event) -> {
                if (action != EditorInfo.IME_ACTION_DONE) return false;
                if (dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled()) dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
                return true;
            });
            refreshAppearance();
        });
        dialog.show();
    }

    /** Configuration changes repaint the existing widgets so entered credentials,
     * focus, validation and transaction state never leave this secure window. */
    void refreshAppearance() {
        int primary = owner.getColor(R.color.runtime_primary);
        int onSurface = owner.getColor(R.color.runtime_on_surface);
        int variant = owner.getColor(R.color.runtime_on_surface_variant);
        int disabled = opacity(onSurface, 0.38f);
        int error = owner.getColor(R.color.runtime_error);
        if (dialogBackground instanceof MaterialShapeDrawable) {
            ((MaterialShapeDrawable) dialogBackground).setFillColor(ColorStateList.valueOf(
                owner.getColor(R.color.runtime_surface_container_high)));
        }
        TextView title = dialog.findViewById(androidx.appcompat.R.id.alertTitle);
        if (title != null) title.setTextColor(onSurface);
        description.setTextColor(variant);
        status.setTextColor(variant);
        ColorStateList text = enabledColor(disabled, onSurface);
        ColorStateList hint = enabledColor(disabled, variant);
        ColorStateList stroke = new ColorStateList(new int[][] {
            new int[] {-android.R.attr.state_enabled}, new int[] {android.R.attr.state_focused},
            new int[] {android.R.attr.state_hovered}, new int[0]
        }, new int[] {disabled, primary, onSurface, owner.getColor(R.color.runtime_outline)});
        for (TextInputLayout layout : new TextInputLayout[] {endpointLayout, modelLayout, keyLayout}) {
            layout.setDefaultHintTextColor(hint);
            layout.setHintTextColor(ColorStateList.valueOf(primary));
            layout.setBoxStrokeColorStateList(stroke);
            layout.setBoxStrokeErrorColor(ColorStateList.valueOf(error));
            layout.setErrorTextColor(ColorStateList.valueOf(error));
            layout.setErrorIconTintList(ColorStateList.valueOf(error));
            layout.setHelperTextColor(hint);
            layout.setCursorColor(ColorStateList.valueOf(primary));
            layout.setCursorErrorColor(ColorStateList.valueOf(error));
            TextInputEditText input = (TextInputEditText) layout.getEditText();
            input.setTextColor(text);
            input.setHintTextColor(hint);
            input.setHighlightColor(opacity(primary, 0.4f));
            if (Build.VERSION.SDK_INT >= 29) {
                tint(input.getTextSelectHandleLeft(), primary);
                tint(input.getTextSelectHandleRight(), primary);
                tint(input.getTextSelectHandle(), primary);
            }
        }
        for (int which : new int[] {AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE}) {
            TextView button = dialog.getButton(which);
            if (button == null) continue;
            button.setTextColor(enabledColor(disabled, primary));
            if (button instanceof MaterialButton) {
                MaterialButton material = (MaterialButton) button;
                material.setBackgroundTintList(ColorStateList.valueOf(Color.TRANSPARENT));
                material.setStrokeColor(ColorStateList.valueOf(Color.TRANSPARENT));
                material.setRippleColor(ColorStateList.valueOf(opacity(primary, 0.12f)));
            }
        }
        progress.setIndicatorColor(primary);
        progress.setTrackColor(owner.getColor(R.color.runtime_surface_container_highest));
        Window window = dialog.getWindow();
        if (window != null) {
            boolean light = owner.getResources().getBoolean(R.bool.runtime_light_system_bars);
            WindowCompat.getInsetsController(window, scroll).setAppearanceLightStatusBars(light);
            WindowCompat.getInsetsController(window, scroll).setAppearanceLightNavigationBars(light);
        }
    }

    private static ColorStateList enabledColor(int disabled, int enabled) {
        return new ColorStateList(new int[][] {new int[] {-android.R.attr.state_enabled}, new int[0]},
            new int[] {disabled, enabled});
    }
    private static int opacity(int color, float value) {
        return androidx.core.graphics.ColorUtils.setAlphaComponent(color, Math.round(255 * value));
    }
    private static void tint(Drawable drawable, int color) {
        if (drawable != null) drawable.mutate().setTint(color);
    }

    void clearErrors() {
        endpointLayout.setError(null);
        modelLayout.setError(null);
        keyLayout.setError(null);
    }

    void fieldError(TextInputLayout layout, TextInputEditText input, int message) {
        layout.setError(scroll.getContext().getString(message));
        input.requestFocus();
        layout.post(() -> layout.requestRectangleOnScreen(new Rect(0, 0, layout.getWidth(), layout.getHeight()), false));
    }

    void beginSaving() {
        clearErrors();
        clearKey();
        endpointLayout.setEnabled(false);
        modelLayout.setEnabled(false);
        keyLayout.setEnabled(false);
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setText(R.string.native_model_saving);
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(false);
        dialog.setCancelable(false);
        dialog.setCanceledOnTouchOutside(false);
        status.setVisibility(View.VISIBLE);
        progress.setVisibility(View.VISIBLE);
        Window window = dialog.getWindow();
        if (window != null) WindowCompat.getInsetsController(window, scroll).hide(WindowInsetsCompat.Type.ime());
        status.post(() -> status.requestRectangleOnScreen(new Rect(0, 0, status.getWidth(), status.getHeight()), false));
    }

    void clearKey() { key.setText(""); }

    private TextInputLayout field(Context theme, int layoutId, int inputId, int hint, int supporting, boolean secret) {
        TextInputLayout layout = new TextInputLayout(theme);
        layout.setId(layoutId);
        layout.setHint(theme.getString(hint));
        layout.setErrorEnabled(true);
        if (supporting != 0) layout.setHelperText(theme.getString(supporting));
        protect(layout);
        TextInputEditText input = new TextInputEditText(layout.getContext());
        input.setId(inputId);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : 0));
        input.setSingleLine(true);
        input.setMinHeight(dp(theme, 56));
        input.setImeOptions(EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING | EditorInfo.IME_ACTION_NEXT);
        input.setFreezesText(false);
        input.setLongClickable(!secret);
        if (secret) input.setTransformationMethod(PasswordTransformationMethod.getInstance());
        protect(input);
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) { layout.setError(null); }
            @Override public void afterTextChanged(Editable text) { }
        });
        layout.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        add(layout, 16);
        return layout;
    }

    private void add(View view, int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(fields.getContext(), topMargin);
        fields.addView(view, params);
    }

    private static void protect(View view) {
        view.setSaveEnabled(false);
        view.setSaveFromParentEnabled(false);
        if (Build.VERSION.SDK_INT >= 26) view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        if (Build.VERSION.SDK_INT >= 29) view.setImportantForContentCapture(View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS);
    }
    private static int dp(Context context, int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
}
