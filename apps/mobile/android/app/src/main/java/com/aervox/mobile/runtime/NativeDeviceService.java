package com.aervox.mobile.runtime;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/**
 * Bounded device actions for the first-party agent. Root (or an equivalent
 * `su` provider) is only a transport for a fixed verb list from
 * {@link NativeDevicePolicy}; there is no arbitrary shell, no path argument and
 * no way to run a verb the user has not enabled in settings.
 *
 * Grants are stored per capability, default off, and never unlocked by the
 * model itself. Every invocation is serialized so overlapping taps cannot
 * interleave, and every process is bounded by a timeout and an output budget.
 */
final class NativeDeviceService {
    static final int ROOT_TIMEOUT_MS = 4_000, COMMAND_TIMEOUT_MS = 8_000;
    private static final String STORE = "aervox-device";

    static final class DeviceException extends Exception {
        final String code;
        DeviceException(String value) { super(value); code = value; }
    }

    interface Shell {
        /** Runs one `su -c` line and returns combined stdout/stderr. */
        String run(String line, int timeoutMs) throws Exception;
    }

    private final Context context;
    private final SharedPreferences grants;
    private final ExecutorService work = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "aervox-device");
        thread.setDaemon(true);
        return thread;
    });
    private final Shell shell;
    private final AtomicBoolean busy = new AtomicBoolean();
    private volatile boolean closed;
    private volatile Boolean rootCached;

    NativeDeviceService(Context owner) { this(owner, NativeDeviceService::runRoot); }

    NativeDeviceService(Context owner, Shell runner) {
        context = owner.getApplicationContext();
        grants = context.getSharedPreferences(STORE, Context.MODE_PRIVATE);
        shell = runner;
    }

    CompletableFuture<JSONObject> request(JSONObject command) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        try {
            String op = command.optString("operation", "");
            if (op.equals("status")) { status(result); return result; }
            if (op.equals("grant")) { grant(command, result); return result; }
            if (op.equals("perform")) { perform(command, result); return result; }
            result.completeExceptionally(new DeviceException("INVALID_REQUEST"));
        } catch (Exception error) { result.completeExceptionally(error); }
        return result;
    }

    private void status(CompletableFuture<JSONObject> result) {
        if (closed) { result.completeExceptionally(new DeviceException("CLOSED")); return; }
        work.execute(() -> {
            try {
                boolean root = rootAvailable();
                result.complete(new JSONObject().put("kind", "device_status").put("root", root)
                    .put("capabilities", capabilities()).put("busy", busy.get())
                    .put("sdk", Build.VERSION.SDK_INT).put("device", bounded(Build.MODEL)));
            } catch (Exception error) { result.completeExceptionally(new DeviceException("DEVICE_UNAVAILABLE")); }
        });
    }

    private void grant(JSONObject command, CompletableFuture<JSONObject> result) throws Exception {
        String capability = command.optString("capability", "");
        if (!NativeDevicePolicy.capability(capability) || command.length() != 3
            || !command.has("enabled") || !(command.opt("enabled") instanceof Boolean)) {
            throw new DeviceException("INVALID_REQUEST");
        }
        boolean enabled = command.optBoolean("enabled");
        if (enabled) {
            // Granting control of the phone requires a working root provider first;
            // otherwise the toggle would claim a capability that cannot run.
            work.execute(() -> {
                try { boolean root = rootAvailable();
                    if (!root) { result.completeExceptionally(new DeviceException("ROOT_UNAVAILABLE")); return; }
                    grants.edit().putBoolean(capability, true).commit();
                    result.complete(new JSONObject().put("kind", "device_status").put("root", true).put("capabilities", capabilities()));
                } catch (Exception error) { result.completeExceptionally(new DeviceException("DEVICE_UNAVAILABLE")); }
            });
            return;
        }
        grants.edit().putBoolean(capability, false).commit();
        result.complete(new JSONObject().put("kind", "device_status").put("root", rootCached == null ? false : rootCached)
            .put("capabilities", capabilities()));
    }

    private void perform(JSONObject command, CompletableFuture<JSONObject> result) throws Exception {
        if (closed) throw new DeviceException("CLOSED");
        final NativeDevicePolicy.Command action;
        JSONObject payload = new JSONObject(command.toString());
        payload.remove("operation");
        try { action = NativeDevicePolicy.parse(payload); }
        catch (NativeDevicePolicy.Rejected rejected) { throw new DeviceException(rejected.code); }
        if (action.line == null) { result.complete(info()); return; }
        if (!grants.getBoolean(action.capability, false)) throw new DeviceException("DEVICE_CAPABILITY_DISABLED");
        if (!busy.compareAndSet(false, true)) throw new DeviceException("DEVICE_BUSY");
        work.execute(() -> {
            try {
                if (!rootAvailable()) throw new DeviceException("ROOT_UNAVAILABLE");
                String output = bounded(shell.run(action.line, COMMAND_TIMEOUT_MS));
                result.complete(new JSONObject().put("kind", "device_result").put("ok", true)
                    .put("action", action.description).put("output", output));
            } catch (DeviceException error) {
                result.completeExceptionally(error);
            } catch (Exception error) {
                result.completeExceptionally(new DeviceException("COMMAND_FAILED"));
            } finally { busy.set(false); }
        });
    }

    private JSONObject info() throws Exception {
        return new JSONObject().put("kind", "device_result").put("ok", true).put("action", "device info")
            .put("output", "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + "), "
                + bounded(Build.MANUFACTURER) + " " + bounded(Build.MODEL) + ", root " + (rootCached == null ? "unknown" : rootCached ? "ready" : "unavailable"));
    }

    private JSONObject capabilities() throws Exception {
        return new JSONObject()
            .put(NativeDevicePolicy.CAPABILITY_CONTROL, grants.getBoolean(NativeDevicePolicy.CAPABILITY_CONTROL, false))
            .put(NativeDevicePolicy.CAPABILITY_APPS, grants.getBoolean(NativeDevicePolicy.CAPABILITY_APPS, false));
    }

    private boolean rootAvailable() {
        Boolean cached = rootCached;
        if (cached != null) return cached;
        boolean available;
        try { available = NativeDevicePolicy.rootUid(shell.run("id -u", ROOT_TIMEOUT_MS)); }
        catch (Exception error) { available = false; }
        rootCached = available;
        return available;
    }

    /** Single bounded `su -c` invocation; no shell builtins or extra verbs. */
    static String runRoot(String line, int timeoutMs) throws Exception {
        Process process = new ProcessBuilder("su", "-c", line).redirectErrorStream(true).start();
        try {
            process.getOutputStream().close();
            ByteArrayOutputStream collected = new ByteArrayOutputStream();
            Thread reader = new Thread(() -> {
                try (InputStream input = process.getInputStream()) {
                    byte[] buffer = new byte[512];
                    int read;
                    while ((read = input.read(buffer)) != -1 && collected.size() < NativeDevicePolicy.MAX_OUTPUT_BYTES) {
                        collected.write(buffer, 0, Math.min(read, NativeDevicePolicy.MAX_OUTPUT_BYTES - collected.size()));
                    }
                } catch (Exception ignored) { }
            });
            reader.setDaemon(true); reader.start();
            if (!process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                throw new DeviceException("COMMAND_TIMEOUT");
            }
            reader.join(500);
            String output = new String(collected.toByteArray(), StandardCharsets.UTF_8).trim();
            if (process.exitValue() != 0 && output.isEmpty()) throw new DeviceException("COMMAND_FAILED");
            return output;
        } finally { if (process.isAlive()) process.destroyForcibly(); }
    }

    private static String bounded(String value) {
        if (value == null) return "";
        String safe = value.strip();
        return safe.length() > 240 ? safe.substring(0, 240) : safe;
    }

    void close() {
        closed = true;
        work.shutdownNow();
    }
}
