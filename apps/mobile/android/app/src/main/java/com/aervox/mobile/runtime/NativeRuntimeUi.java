package com.aervox.mobile.runtime;

import android.app.Activity;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.aervox.mobile.R;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.textview.MaterialTextView;

/** Shared native recovery surface, using the same Material roles as the Web UI. */
final class NativeRuntimeUi {
    private NativeRuntimeUi() { }

    static View unavailable(Activity owner, String message, Runnable close) {
        FrameLayout surface = new FrameLayout(owner);
        surface.setBackgroundColor(owner.getColor(R.color.runtime_surface));
        ScrollView scroll = new ScrollView(owner);
        scroll.setFillViewport(true);
        surface.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        FrameLayout center = new FrameLayout(owner);
        scroll.addView(center, new ScrollView.LayoutParams(-1, -1));
        LinearLayout content = new LinearLayout(owner);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        int padding = dp(owner, 24);
        content.setPadding(padding, dp(owner, 40), padding, dp(owner, 40));
        FrameLayout.LayoutParams bounded = new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER);
        center.addView(content, bounded);
        center.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            int width = Math.min(right - left, dp(owner, 480));
            if (width > 0 && content.getLayoutParams().width != width) {
                content.getLayoutParams().width = width;
                content.requestLayout();
            }
        });

        ImageView mark = new ImageView(owner);
        mark.setImageResource(R.drawable.aervox_startup_mark);
        mark.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        content.addView(mark, new LinearLayout.LayoutParams(dp(owner, 144), dp(owner, 144)));

        MaterialTextView title = new MaterialTextView(owner);
        title.setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_TitleLarge);
        title.setText(R.string.runtime_unavailable_title);
        title.setTextColor(owner.getColor(R.color.runtime_on_surface));
        title.setGravity(Gravity.CENTER);
        ViewCompat.setAccessibilityHeading(title, true);
        content.addView(title, spaced(owner, 16));

        MaterialTextView description = new MaterialTextView(owner);
        description.setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodyLarge);
        description.setText(message);
        description.setTextColor(owner.getColor(R.color.runtime_on_surface_variant));
        description.setGravity(Gravity.CENTER);
        description.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        content.addView(description, spaced(owner, 12));

        MaterialButton button = new MaterialButton(owner);
        button.setText(R.string.runtime_close_app);
        button.setOnClickListener(ignored -> close.run());
        LinearLayout.LayoutParams action = new LinearLayout.LayoutParams(-2, -2);
        action.topMargin = dp(owner, 28);
        content.addView(button, action);

        ViewCompat.setOnApplyWindowInsetsListener(surface, (view, insets) -> {
            androidx.core.graphics.Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        surface.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) ViewCompat.requestApplyInsets(view);
        });
        return surface;
    }

    private static LinearLayout.LayoutParams spaced(Activity owner, int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, -2);
        params.topMargin = dp(owner, top);
        return params;
    }

    private static int dp(Activity owner, int value) {
        return Math.round(value * owner.getResources().getDisplayMetrics().density);
    }
}
