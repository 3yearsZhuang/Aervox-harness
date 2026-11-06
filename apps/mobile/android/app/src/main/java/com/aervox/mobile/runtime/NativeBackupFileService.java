package com.aervox.mobile.runtime;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

/** Fixed backup export only: private cache, ordered chunks and one temporary read grant. */
final class NativeBackupFileService implements AutoCloseable {
    static final int MAX_BYTES = 16 * 1024 * 1024, MAX_CHUNK_CHARS = 32 * 1024;
    static final long SHARED_CACHE_MS = TimeUnit.HOURS.toMillis(1), MAX_CACHE_BYTES = 4L * MAX_BYTES;
    interface ShareTarget { void share(File file, CompletableFuture<JSONObject> receipt) throws Exception; }
    private final File directory;
    private final ShareTarget shareTarget;
    private final BooleanSupplier foreground;
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(1), runnable -> { Thread thread = new Thread(runnable, "aervox-backup-file"); thread.setDaemon(true); return thread; });
    private final Set<CompletableFuture<JSONObject>> pending = ConcurrentHashMap.newKeySet();
    private volatile boolean closed, finishing;
    // Only the worker owns these fields.
    private String exportId;
    private File file;
    private FileOutputStream output;
    private int sequence, size;

    NativeBackupFileService(Activity owner, BooleanSupplier isForeground) {
        this(new File(owner.getCacheDir(), "aervox-backup-exports"), isForeground, (shared, result) -> owner.runOnUiThread(() -> {
            try {
                if (result.isDone() || !isForeground.getAsBoolean()) throw failure("NOT_FOREGROUND");
                Uri uri = FileProvider.getUriForFile(owner, owner.getPackageName() + ".fileprovider", shared);
                Intent intent = new Intent(Intent.ACTION_SEND).setType("application/json")
                    .putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_SUBJECT, "Aervox 备份")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.setClipData(ClipData.newRawUri("Aervox 备份", uri));
                owner.startActivity(Intent.createChooser(intent, "保存 Aervox 备份"));
                result.complete(new JSONObject().put("kind", "backup_file_shared").put("ok", true));
            } catch (Exception error) { result.completeExceptionally(failure("BACKUP_FILE_SHARE_FAILED")); }
        }));
    }

    /** Isolated filesystem/share port for device regressions; no user database or chooser is touched. */
    NativeBackupFileService(File cacheDirectory, BooleanSupplier isForeground, ShareTarget target) {
        directory = cacheDirectory; foreground = isForeground; shareTarget = target;
    }

    static int nextSize(int current, String text) throws NativeFileService.FileException {
        if (text == null || text.length() > MAX_CHUNK_CHARS) throw failure("BACKUP_FILE_CHUNK_INVALID");
        int next = current + text.getBytes(StandardCharsets.UTF_8).length;
        if (next > MAX_BYTES) throw failure("BACKUP_FILE_TOO_LARGE");
        return next;
    }

    synchronized CompletableFuture<JSONObject> request(JSONObject request) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        if (closed) { result.completeExceptionally(failure("CLOSED")); return result; }
        pending.add(result);
        result.whenComplete((value, error) -> pending.remove(result));
        try { worker.execute(() -> {
            try {
                if (closed) throw failure("CLOSED");
                String operation = request.optString("operation");
                if (!operation.equals("abort") && !foreground.getAsBoolean()) throw failure("NOT_FOREGROUND");
                if (operation.equals("begin")) {
                    if (output != null || finishing) throw failure("BACKUP_FILE_BUSY");
                    if (!directory.isDirectory() && !directory.mkdirs()) throw failure("BACKUP_FILE_FAILED");
                    // A recipient may read the granted URI after its chooser closes.
                    // Keep recent completed exports instead of deleting the last share on begin.
                    long retained = 0, cutoff = System.currentTimeMillis() - SHARED_CACHE_MS;
                    File[] old = directory.listFiles();
                    if (old == null) throw failure("BACKUP_FILE_FAILED");
                    for (File item : old) {
                        if (item.lastModified() < cutoff && item.delete()) continue;
                        retained += item.length();
                    }
                    if (retained > MAX_CACHE_BYTES - MAX_BYTES) throw failure("BACKUP_FILE_CACHE_FULL");
                    exportId = UUID.randomUUID().toString();
                    file = new File(directory, "aervox-backup-" + exportId + ".json");
                    output = new FileOutputStream(file); sequence = 1; size = 0;
                    result.complete(receipt().put("exportId", exportId));
                    return;
                }
                if (output == null || !exportId.equals(request.optString("exportId"))) throw failure("BACKUP_FILE_NOT_PENDING");
                if (operation.equals("abort")) {
                    discard(); result.complete(receipt()); return;
                }
                if (operation.equals("append")) {
                    Object next = request.opt("sequence");
                    if (!(next instanceof Integer) || ((Integer) next) != sequence) throw failure("BACKUP_FILE_SEQUENCE_INVALID");
                    Object text = request.opt("text");
                    if (!(text instanceof String)) throw failure("BACKUP_FILE_CHUNK_INVALID");
                    int nextBytes = nextSize(size, (String) text);
                    output.write(((String) text).getBytes(StandardCharsets.UTF_8));
                    size = nextBytes;
                    result.complete(receipt().put("exportId", exportId).put("sequence", sequence++));
                    return;
                }
                if (!operation.equals("finish")) throw failure("INVALID_REQUEST");
                Object last = request.opt("sequence");
                if (!(last instanceof Integer) || ((Integer) last) != sequence - 1) throw failure("BACKUP_FILE_SEQUENCE_INVALID");
                output.close(); output = null;
                final File shared = file; file = null; exportId = null; finishing = true;
                result.whenComplete((value, error) -> {
                    if (error != null) shared.delete();
                    finishing = false;
                });
                if (closed || result.isDone()) throw failure("CLOSED");
                shareTarget.share(shared, result);
            } catch (Exception error) {
                if (error instanceof java.io.IOException) discard();
                result.completeExceptionally(error);
            }
        }); } catch (RuntimeException rejected) { result.completeExceptionally(failure("BACKUP_FILE_BUSY")); }
        return result;
    }

    private static JSONObject receipt() throws Exception { return new JSONObject().put("kind", "backup_file"); }
    private static NativeFileService.FileException failure(String code) { return new NativeFileService.FileException(code); }
    private void discard() {
        if (output != null) { try { output.close(); } catch (Exception ignored) { } }
        if (file != null) file.delete();
        output = null; file = null; exportId = null;
    }
    void awaitClosedForTest() throws InterruptedException {
        if (!worker.awaitTermination(5, TimeUnit.SECONDS)) throw new IllegalStateException("BACKUP_FILE_DRAIN_TIMEOUT");
    }
    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        for (CompletableFuture<JSONObject> result : pending) result.completeExceptionally(failure("CLOSED"));
        // Admission and queue mutation share the same lock. Queued requests have
        // no side effects yet, and their receipts are already closed above.
        worker.getQueue().clear();
        // Reserve the emptied slot for cleanup after the current writer exits.
        worker.execute(this::discard);
        worker.shutdown();
    }
}
