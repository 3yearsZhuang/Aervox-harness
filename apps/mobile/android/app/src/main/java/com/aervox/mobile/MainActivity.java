package com.aervox.mobile;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            private final MobileBackNavigation navigation = new MobileBackNavigation(new MobileBackNavigation.Target() {
                @Override public boolean isImeVisible() {
                    WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(getWindow().getDecorView());
                    return insets != null && insets.isVisible(WindowInsetsCompat.Type.ime());
                }
                @Override public void hideIme() {
                    View decor = getWindow().getDecorView();
                    WindowCompat.getInsetsController(getWindow(), decor).hide(WindowInsetsCompat.Type.ime());
                }
                @Override public boolean canGoBack() {
                    WebView view = getBridge() == null ? null : getBridge().getWebView();
                    return view != null && view.canGoBack();
                }
                @Override public void goBack() {
                    WebView view = getBridge() == null ? null : getBridge().getWebView();
                    if (view != null) view.goBack();
                }
                @Override public void systemBack() { dispatchSystemBack(); }
            });

            @Override public void handleOnBackPressed() { navigation.handleBack(); }

            private void dispatchSystemBack() {
                // Delegate to the platform/other callbacks without selecting ourselves again.
                setEnabled(false);
                try { getOnBackPressedDispatcher().onBackPressed(); }
                finally { setEnabled(true); }
            }
        });
    }
}
