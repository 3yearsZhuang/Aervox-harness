package com.aervox.mobile.runtime;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** One bounded file reader per Activity; provider and network I/O never runs on the UI thread. */
final class NativeFileService {
    static final int MAX_TEXT_BYTES = 2 * 1024 * 1024;
    static final long READ_BUDGET_MS = 12_000;

    static final class FileException extends Exception {
        final String code;
        FileException(String value) { super(value); code = value; }
    }

    interface ReadTask<T> { T read(ReadControl control) throws Exception; }

    /** Cancellation closes registered handles, including an in-progress provider open/query. */
    static final class ReadControl {
        private final List<Runnable> cleanup = new ArrayList<>();
        private volatile boolean cancelled;
        synchronized void onCancel(Runnable action) {
            if (cancelled) action.run();
            else cleanup.add(action);
        }
        void checkOpen() throws FileException {
            if (cancelled || Thread.currentThread().isInterrupted()) throw new FileException("FILE_READ_CANCELLED");
        }
        synchronized void cancel() {
            if (cancelled) return;
            cancelled = true;
            for (Runnable action : cleanup) {
                try { action.run(); } catch (Exception ignored) { /* Other handles still need cleanup. */ }
            }
            cleanup.clear();
        }
    }

    private final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "aervox-file-reader"); thread.setDaemon(true); return thread;
    });
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "aervox-file-deadline"); thread.setDaemon(true); return thread;
    });
    private final AtomicReference<ReadControl> active = new AtomicReference<>();
    private final AtomicReference<CompletableFuture<?>> pending = new AtomicReference<>();
    private final long budgetMs;
    private volatile boolean closed;

    NativeFileService() { this(READ_BUDGET_MS); }
    NativeFileService(long budget) { budgetMs = budget; }

    <T> CompletableFuture<T> submit(ReadTask<T> task) {
        CompletableFuture<T> result = new CompletableFuture<>();
        ReadControl control = new ReadControl();
        synchronized (this) {
            if (closed) { result.completeExceptionally(new FileException("CLOSED")); return result; }
            // Keep ownership until the actual reader exits, even after its deadline.
            // An uncooperative document provider cannot accumulate queued readers.
            if (!active.compareAndSet(null, control)) {
                result.completeExceptionally(new FileException("FILE_BUSY")); return result;
            }
            pending.set(result);
            java.util.concurrent.ScheduledFuture<?> deadline = deadlines.schedule(() -> {
                result.completeExceptionally(new FileException("FILE_READ_TIMEOUT"));
                control.cancel();
            }, budgetMs, TimeUnit.MILLISECONDS);
            worker.execute(() -> {
                try {
                    control.checkOpen();
                    result.complete(task.read(control));
                } catch (Exception error) {
                    result.completeExceptionally(error instanceof FileException ? error : new FileException("FILE_READ_FAILED"));
                } finally {
                    deadline.cancel(false);
                    control.cancel();
                    pending.compareAndSet(result, null);
                    active.compareAndSet(control, null);
                }
            });
        }
        return result;
    }

    CompletableFuture<JSONObject> readPicked(Context context, Uri uri) {
        return submit(control -> readPickedText(context, uri, control));
    }

    CompletableFuture<JSONObject> fetch(String url) {
        return submit(control -> fetchText(url, control));
    }

    synchronized void close() {
        if (closed) return;
        closed = true;
        CompletableFuture<?> result = pending.get();
        if (result != null) result.completeExceptionally(new FileException("CLOSED"));
        ReadControl control = active.get();
        // Provider cancellation/stream close may block; never run it on the Activity thread.
        if (control != null) deadlines.execute(control::cancel);
        worker.shutdownNow();
        deadlines.shutdown();
    }

    /** Pure size policy shared with JVM tests. */
    static byte[] boundedBytes(byte[] source) throws FileException {
        if (source.length > MAX_TEXT_BYTES) throw new FileException("FILE_TOO_LARGE");
        return source;
    }

    static byte[] readBytes(InputStream stream, ReadControl control) throws Exception {
        control.onCancel(() -> { try { stream.close(); } catch (Exception ignored) { } });
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[16 * 1024];
        int read;
        long total = 0;
        while (true) {
            control.checkOpen();
            read = stream.read(chunk);
            if (read == -1) break;
            total += read;
            if (total > MAX_TEXT_BYTES) throw new FileException("FILE_TOO_LARGE");
            buffer.write(chunk, 0, read);
        }
        control.checkOpen();
        return buffer.toByteArray();
    }

    private static JSONObject readPickedText(Context context, Uri uri, ReadControl control) throws Exception {
        CancellationSignal cancellation = new CancellationSignal();
        control.onCancel(cancellation::cancel);
        String name = displayName(context, uri, cancellation);
        control.checkOpen();
        try (ParcelFileDescriptor descriptor = context.getContentResolver().openFileDescriptor(uri, "r", cancellation)) {
            if (descriptor == null) throw new FileException("FILE_READ_FAILED");
            try (InputStream stream = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
                byte[] bytes = readBytes(stream, control);
                return fileResult(name, new String(bytes, StandardCharsets.UTF_8));
            }
        }
    }

    /** JSON escaping can expand a small file beyond the bridge's response budget. */
    static JSONObject fileResult(String name, String text) throws Exception {
        JSONObject result = new JSONObject().put("kind", "file_result").put("name", name).put("text", text);
        if (!NativeMessagePolicy.withinUtf8Budget(result.toString(), NativeMessagePolicy.MAX_RESPONSE_BYTES - 256)) {
            throw new FileException("FILE_TOO_LARGE");
        }
        return result;
    }

    /** Pure URL policy shared with JVM tests: https only. */
    static String requireHttps(String url) throws FileException {
        if (url == null || !url.startsWith("https://") || url.length() > 2048) throw new FileException("FILE_URL_INVALID");
        return url;
    }

    private static JSONObject fetchText(String url, ReadControl control) throws Exception {
        requireHttps(url);
        java.net.HttpURLConnection connection = null;
        try {
            connection = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            java.net.HttpURLConnection owned = connection;
            control.onCancel(owned::disconnect);
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);
            connection.setInstanceFollowRedirects(false);
            control.checkOpen();
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new FileException("FILE_FETCH_FAILED");
            try (InputStream stream = connection.getInputStream()) {
                byte[] bytes = readBytes(stream, control);
                String name = connection.getURL().getPath();
                name = name == null || name.isEmpty() || name.endsWith("/") ? "downloaded.txt" : name.substring(name.lastIndexOf('/') + 1);
                return fileResult(name, new String(bytes, StandardCharsets.UTF_8));
            }
        } catch (FileException error) {
            throw error;
        } catch (Exception error) {
            throw new FileException("FILE_FETCH_FAILED");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String displayName(Context context, Uri uri, CancellationSignal cancellation) {
        try (Cursor cursor = context.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null, cancellation)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) { /* The name is cosmetic; cancellation is checked before opening. */ }
        String last = uri.getLastPathSegment();
        return last == null ? "picked.txt" : last;
    }
}
