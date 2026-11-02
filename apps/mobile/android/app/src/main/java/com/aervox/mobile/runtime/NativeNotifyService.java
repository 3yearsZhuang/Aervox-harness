package com.aervox.mobile.runtime;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import java.util.Calendar;
import java.util.concurrent.CompletableFuture;
import org.json.JSONObject;

/**
 * Local review reminder: one daily, inexact notification posted by an alarm.
 *
 * POST_NOTIFICATIONS is requested for this feature alone when the user turns
 * the reminder on. The alarm is inexact on purpose (the OS batches it under
 * Doze); an exact promise is not one this app can keep. The preference is
 * re-armed whenever the app opens, so a reboot only costs an app launch.
 */
final class NativeNotifyService {
    static final String CHANNEL_ID = "aervox-review";
    static final String PREF = "aervox-review-reminder";
    static final int REMINDER_HOUR = 9;

    private final android.app.Activity owner;

    static final class NotifyException extends Exception {
        final String code;
        NotifyException(String value) { super(value); code = value; }
    }

    NativeNotifyService(android.app.Activity activity) {
        owner = activity;
        ensureChannel();
        if (isEnabled()) schedule();
    }

    /** Pure trigger math shared with JVM tests. */
    static long nextTriggerAt(long now, int hour) {
        Calendar next = Calendar.getInstance();
        next.setTimeInMillis(now);
        next.set(Calendar.HOUR_OF_DAY, hour);
        next.set(Calendar.MINUTE, 0);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (next.getTimeInMillis() <= now) next.add(Calendar.DAY_OF_YEAR, 1);
        return next.getTimeInMillis();
    }

    private boolean isEnabled() {
        return owner.getSharedPreferences(PREF, Context.MODE_PRIVATE).getBoolean("enabled", false);
    }

    private void setEnabled(boolean value) {
        owner.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().putBoolean("enabled", value).apply();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = owner.getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.createNotificationChannel(new NotificationChannel(
            CHANNEL_ID, "学习提醒", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private void schedule() {
        AlarmManager alarms = (AlarmManager) owner.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        alarms.setInexactRepeating(AlarmManager.RTC_WAKEUP,
            nextTriggerAt(System.currentTimeMillis(), REMINDER_HOUR),
            AlarmManager.INTERVAL_DAY, reminderIntent());
    }

    private void unschedule() {
        AlarmManager alarms = (AlarmManager) owner.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        alarms.cancel(reminderIntent());
    }

    private PendingIntent reminderIntent() {
        Intent intent = new Intent(owner, DailyReviewReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(owner, 4102, intent, flags);
    }

    CompletableFuture<JSONObject> request(JSONObject command) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        try {
            String operation = command.optString("operation", "");
            if ("status".equals(operation)) {
                boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                    || owner.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
                result.complete(new JSONObject().put("kind", "notify_status")
                    .put("enabled", isEnabled()).put("permission", granted ? "granted" : "denied"));
            } else if ("enable".equals(operation)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && owner.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    // Request for this feature only; the reminder posts once granted.
                    owner.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4102);
                }
                ensureChannel();
                setEnabled(true);
                schedule();
                result.complete(new JSONObject().put("kind", "notify_result").put("ok", true).put("enabled", true));
            } else if ("disable".equals(operation)) {
                setEnabled(false);
                unschedule();
                result.complete(new JSONObject().put("kind", "notify_result").put("ok", true).put("enabled", false));
            } else {
                result.completeExceptionally(new NotifyException("INVALID_REQUEST"));
            }
        } catch (Exception error) {
            result.completeExceptionally(error instanceof NotifyException ? error : new NotifyException("NOTIFY_FAILED"));
        }
        return result;
    }
}
