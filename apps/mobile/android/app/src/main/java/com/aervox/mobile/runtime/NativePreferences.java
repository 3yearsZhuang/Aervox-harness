package com.aervox.mobile.runtime;

import android.content.Context;
import android.content.SharedPreferences;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** UI selection/unsubmitted drafts only, never business or credential truth. */
final class NativePreferences {
    private final SharedPreferences storage;
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(8), work -> new Thread(work, "aervox-ui-preferences"));
    NativePreferences(Context context) { storage = context.getSharedPreferences("aervox_mobile_ui", Context.MODE_PRIVATE); }
    CompletableFuture<JSONObject> request(JSONObject input) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        try {
            String command = input.toString();
            worker.execute(() -> {
                try {
                    JSONObject request = new JSONObject(command);
                    String operation = request.getString("operation");
                    JSONObject values;
                    if (operation.equals("read") && request.length() == 1) {
                        values = new JSONObject();
                        for (Map.Entry<String, ?> entry : storage.getAll().entrySet()) values.put(entry.getKey(), entry.getValue());
                    } else if (operation.equals("write") && request.length() == 2) {
                        values = request.getJSONObject("values"); validate(values);
                        SharedPreferences.Editor editor = storage.edit().clear();
                        for (Iterator<String> keys = values.keys(); keys.hasNext();) {
                            String key = keys.next(); editor.putString(key, values.getString(key));
                        }
                        if (!editor.commit()) throw new IllegalStateException();
                    } else throw new IllegalArgumentException();
                    validate(values);
                    result.complete(new JSONObject().put("kind", "preferences").put("values", values));
                } catch (Exception ignored) { result.completeExceptionally(new IllegalStateException("UI_PREFERENCES_UNAVAILABLE")); }
            });
        } catch (RuntimeException ignored) { result.completeExceptionally(new IllegalStateException("UI_PREFERENCES_UNAVAILABLE")); }
        return result;
    }
    private static void validate(JSONObject values) throws Exception {
        if (values.length() > 64 || values.toString().getBytes(StandardCharsets.UTF_8).length > 256 * 1024) throw new IllegalArgumentException();
        for (Iterator<String> keys = values.keys(); keys.hasNext();) {
            String key = keys.next(); Object value = values.get(key);
            if (!(key.equals("aervox_active_session_id") || key.matches("aervox-mobile-draft:[A-Za-z0-9_%.'!~*()-]{1,512}"))
                || !(value instanceof String) || ((String) value).getBytes(StandardCharsets.UTF_8).length > 32768) throw new IllegalArgumentException();
        }
    }
    void close() { worker.shutdown(); }
}
