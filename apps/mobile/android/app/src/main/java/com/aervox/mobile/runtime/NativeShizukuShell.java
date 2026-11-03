package com.aervox.mobile.runtime;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * Shell transport over Shizuku (adb-level service the user has installed and
 * authorized). Same bounded contract as the root shell: one fixed verb line,
 * a timeout and an output budget. No UserService, no arbitrary shell surface —
 * only the {@link NativeDevicePolicy} verb list reaches here.
 */
final class NativeShizukuShell implements NativeDeviceService.Shell {
    static final class ShizukuException extends Exception {
        final String code;
        ShizukuException(String value) { super(value); code = value; }
    }

    /** True when the Shizuku service is bound and this app holds its permission. */
    static boolean available() {
        try {
            Class<?> shizuku = Class.forName("rikka.shizuku.Shizuku");
            Boolean ping = (Boolean) shizuku.getMethod("pingBinder").invoke(null);
            if (ping == null || !ping) return false;
            Integer permission = (Integer) shizuku.getMethod("checkSelfPermission").invoke(null);
            // PackageManager.PERMISSION_GRANTED == 0
            return permission != null && permission == 0;
        } catch (Throwable unavailable) {
            return false;
        }
    }

    /** Runs one `sh -c` line through Shizuku with the root shell's budget. */
    @Override public String run(String line, int timeoutMs) throws Exception {
        if (!available()) throw new ShizukuException("SHIZUKU_UNAVAILABLE");
        try {
            Class<?> shizuku = Class.forName("rikka.shizuku.Shizuku");
            Object process = shizuku.getMethod("newProcess", String[].class, String[].class, String.class)
                .invoke(null, new String[] { "sh", "-c", line }, null, null);
            java.lang.Process p = (java.lang.Process) process;
            try {
                p.getOutputStream().close();
                ByteArrayOutputStream collected = new ByteArrayOutputStream();
                Thread reader = new Thread(() -> {
                    try (InputStream input = p.getInputStream()) {
                        byte[] buffer = new byte[512];
                        int read;
                        while ((read = input.read(buffer)) != -1 && collected.size() < NativeDevicePolicy.MAX_OUTPUT_BYTES) {
                            collected.write(buffer, 0, Math.min(read, NativeDevicePolicy.MAX_OUTPUT_BYTES - collected.size()));
                        }
                    } catch (Exception ignored) { }
                });
                reader.setDaemon(true); reader.start();
                if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
                    p.destroyForcibly();
                    throw new ShizukuException("COMMAND_TIMEOUT");
                }
                reader.join(500);
                String output = new String(collected.toByteArray(), StandardCharsets.UTF_8).trim();
                if (p.exitValue() != 0 && output.isEmpty()) throw new ShizukuException("COMMAND_FAILED");
                return output;
            } finally { if (p.isAlive()) p.destroyForcibly(); }
        } catch (ShizukuException error) {
            throw error;
        } catch (Throwable error) {
            Throwable cause = error.getCause();
            if (cause instanceof IllegalStateException) throw new ShizukuException("SHIZUKU_UNAUTHORIZED");
            throw new ShizukuException("SHIZUKU_UNAVAILABLE");
        }
    }
}
