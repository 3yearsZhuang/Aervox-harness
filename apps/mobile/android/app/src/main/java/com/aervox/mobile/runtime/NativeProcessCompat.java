package com.aervox.mobile.runtime;

import android.os.Build;
import java.util.concurrent.TimeUnit;

/** Process timed waits and forceful destruction were added in Android API 26. */
final class NativeProcessCompat {
    private static final long POLL_NANOS = TimeUnit.MILLISECONDS.toNanos(10);

    private NativeProcessCompat() { }

    static boolean waitFor(Process process, int timeoutMs) throws InterruptedException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return process.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
        }
        return waitForLegacy(process, timeoutMs);
    }

    /** exitValue is available at minSdk; wall-clock changes cannot extend the budget. */
    static boolean waitForLegacy(Process process, int timeoutMs) throws InterruptedException {
        long budget = TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        long started = System.nanoTime();
        while (isAlive(process)) {
            long remaining = budget - (System.nanoTime() - started);
            if (remaining <= 0) return false;
            TimeUnit.NANOSECONDS.sleep(Math.min(remaining, POLL_NANOS));
        }
        return true;
    }

    static boolean isAlive(Process process) {
        try { process.exitValue(); return false; }
        catch (IllegalThreadStateException running) { return true; }
    }

    static void destroyIfAlive(Process process) {
        if (!isAlive(process)) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) process.destroyForcibly();
        else process.destroy();
    }
}
