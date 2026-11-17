package com.aervox.mobile.runtime;

import android.os.Bundle;
import android.content.res.Configuration;
import android.widget.FrameLayout;
import androidx.appcompat.app.AppCompatActivity;

/** Debug-only window for isolated native form tests, without business runtime. */
public final class NativeModelConfigurationTestActivity extends AppCompatActivity {
    Runnable appearanceChanged;
    int appearanceChangeCount;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(new FrameLayout(this));
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        appearanceChangeCount++;
        if (appearanceChanged != null) appearanceChanged.run();
    }
}
