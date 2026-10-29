package com.aervox.mobile.runtime;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/** Pure policy/parser seam. Network destinations are selected only in native UI. */
final class NativeModelServicePolicy {
    static final int MAX_INPUT_BYTES = 256 * 1024;
    static final int MAX_STREAM_BYTES = 2 * 1024 * 1024;
    static final int MAX_EVENT_BYTES = 32 * 1024;
    static final int MAX_EVENTS = 8192;
    static final int CONNECT_TIMEOUT_MS = 15_000, IDLE_TIMEOUT_MS = 45_000;
    static final int DEADLINE_MS = 180_000;

    static final class Rejected extends Exception {
        final String code;
        Rejected(String value) { super(value); code = value; }
    }
    interface Consumer { boolean data(String value) throws Exception; }

    static String endpoint(String value) throws Rejected {
        if (value == null || value.length() > 2048 || !value.equals(value.trim())) throw new Rejected("INVALID_ENDPOINT");
        try {
            URI uri = new URI(value);
            String host = uri.getHost(), path = uri.getRawPath();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || host.isEmpty()
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || uri.getPort() == 0 || uri.getPort() > 65535 || uri.getPort() < -1
                    || host.equalsIgnoreCase("localhost") || host.toLowerCase(java.util.Locale.ROOT).endsWith(".localhost")
                    || host.indexOf(':') >= 0 || host.startsWith("[") || host.matches("[0-9.]+")
                    || path != null && (path.contains("%") || path.contains("\\") || path.contains("//"))) {
                throw new Rejected("INVALID_ENDPOINT");
            }
            if (!uri.normalize().equals(uri)) throw new Rejected("INVALID_ENDPOINT");
            String normalized = uri.toASCIIString();
            while (normalized.endsWith("/")) normalized = normalized.substring(0, normalized.length() - 1);
            if (normalized.endsWith("/chat/completions")) throw new Rejected("ENDPOINT_INCLUDES_COMPLETION_PATH");
            return normalized;
        } catch (URISyntaxException ignored) { throw new Rejected("INVALID_ENDPOINT"); }
    }

    static boolean model(String value) {
        return value != null && !value.isEmpty() && value.length() <= 128
            && value.equals(value.trim()) && value.matches("[A-Za-z0-9][A-Za-z0-9._:/@+-]*");
    }
    static boolean credential(char[] value) {
        if (value == null || value.length == 0 || value.length > 2048) return false;
        for (char c : value) if (c < 0x21 || c > 0x7e) return false;
        return true;
    }

    /** Byte/line/event limits apply before UTF-8 decoding or JSON allocation.
     * False from the consumer stops reading immediately (for [DONE]). */
    static void readSse(InputStream input, Consumer consumer) throws Exception {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        StringBuilder event = new StringBuilder();
        int total = 0, eventBytes = 0, events = 0;
        boolean firstLine = true, afterCr = false;
        byte[] buffer = new byte[2048];
        try {
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > MAX_STREAM_BYTES) throw new Rejected("RESPONSE_LIMIT");
                for (int offset = 0; offset < count; offset++) {
                    int value = buffer[offset] & 255;
                    if (afterCr && value == '\n') { afterCr = false; continue; }
                    afterCr = value == '\r';
                    if (value != '\r' && value != '\n') {
                        if (line.size() >= MAX_EVENT_BYTES) throw new Rejected("RESPONSE_LIMIT");
                        line.write(value); continue;
                    }
                    String text = utf8(line.toByteArray()); line.reset();
                    if (firstLine && text.startsWith("\ufeff")) text = text.substring(1);
                    firstLine = false;
                    if (text.isEmpty()) {
                        if (event.length() != 0) {
                            if (++events > MAX_EVENTS) throw new Rejected("RESPONSE_LIMIT");
                            if (!consumer.data(event.substring(0, event.length() - 1))) return;
                        }
                        event.setLength(0); eventBytes = 0;
                    } else if (text.equals("data") || text.startsWith("data:")) {
                        String data = text.equals("data") ? "" : text.substring(5);
                        if (data.startsWith(" ")) data = data.substring(1);
                        eventBytes += data.getBytes(StandardCharsets.UTF_8).length + 1;
                        if (eventBytes > MAX_EVENT_BYTES) throw new Rejected("RESPONSE_LIMIT");
                        event.append(data).append('\n');
                    }
                }
            }
            // SSE dispatch requires a blank line. A partial final frame is not success.
            if (line.size() != 0 || event.length() != 0) throw new Rejected("TRUNCATED_RESPONSE");
        } finally { java.util.Arrays.fill(buffer, (byte) 0); }
    }
    private static String utf8(byte[] value) throws Rejected {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(value)).toString();
        } catch (CharacterCodingException ignored) { throw new Rejected("INVALID_RESPONSE"); }
        finally { java.util.Arrays.fill(value, (byte) 0); }
    }
}
