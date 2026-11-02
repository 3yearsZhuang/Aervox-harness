package com.aervox.mobile.runtime;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Posts the daily review reminder; the tap target is always the app itself. */
public final class DailyReviewReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        Intent open = new Intent(context, NativeRuntimeActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent content = PendingIntent.getActivity(context, 4103, open, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, NativeNotifyService.CHANNEL_ID)
            : new Notification.Builder(context);
        Notification notification = builder
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle("今日复习提醒")
            .setContentText("今天还有复习任务，打开思隅继续。")
            .setContentIntent(content)
            .setAutoCancel(true)
            .build();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(4103, notification);
    }
}
