package com.aervox.mobile;

/** UI navigation only. Back never calls business cancellation or requests a permission. */
final class MobileBackNavigation {
    interface Target {
        boolean isImeVisible();
        void hideIme();
        boolean canGoBack();
        void goBack();
        void systemBack();
    }

    private final Target target;
    private boolean handling;

    MobileBackNavigation(Target target) { this.target = target; }

    void handleBack() {
        if (handling) return;
        handling = true;
        try {
            if (target.isImeVisible()) target.hideIme();
            else if (target.canGoBack()) target.goBack();
            else target.systemBack();
        } finally { handling = false; }
    }
}
