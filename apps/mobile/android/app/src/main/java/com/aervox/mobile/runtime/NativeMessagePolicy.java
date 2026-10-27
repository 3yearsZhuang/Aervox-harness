package com.aervox.mobile.runtime;

import java.util.HashMap;
import java.util.Map;

/** Transport budgets and lifecycle bookkeeping, independent of Android/WebView.
 * A generation represents this owner's explicit lifetime, not a document identity
 * supplied or proved by WebView. Request ids only correlate in-flight responses.
 */
final class NativeMessagePolicy {
    static final int MAX_REQUEST_BYTES = 1024 * 1024, MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
    static final int MAX_JSON_DEPTH = 32, MAX_IN_FLIGHT = 8, MAX_ID_CHARS = 64;
    static final class Ticket {
        final String id;
        final long generation;
        Ticket(String value, long epoch) { id = value; generation = epoch; }
    }
    private final Map<String, Ticket> pending = new HashMap<>();
    private long generation = 1;
    private boolean active = true;

    static boolean acceptsSource(boolean ownedView, boolean mainFrame, String scheme, String host,
            int port, boolean decoratedOrOpaque) {
        return ownedView && mainFrame && !decoratedOrOpaque && "https".equals(scheme)
            && "localhost".equals(host) && (port == -1 || port == 443);
    }
    static boolean validId(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_ID_CHARS) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-')) return false;
        }
        return true;
    }
    /** Counts before allocating bytes or parsing JSON. Raw unpaired UTF-16 is
     * rejected; JSON.stringify's escaped surrogate sequences remain ordinary ASCII.
     */
    static boolean withinUtf8Budget(String value, int limit) {
        if (value == null || value.length() > limit) return false;
        int size = 0;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x80) size++;
            else if (c < 0x800) size += 2;
            else if (Character.isHighSurrogate(c)) {
                if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) return false;
                size += 4;
            } else if (Character.isLowSurrogate(c)) return false;
            else size += 3;
            if (size > limit) return false;
        }
        return true;
    }
    /** Fast lexical/depth precheck only. It is not a full JSON grammar validator
     * or an authoritative depth proof for Android's lenient JSONTokener. The
     * channel also validates with strict iterative JsonReader before recursion.
     */
    static boolean withinJsonDepth(String value) {
        int depth = 0;
        boolean string = false, escaped = false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (string) {
                if (escaped) escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"') string = false;
            } else if (c == '"') string = true;
            else if (c == '{' || c == '[') { if (++depth > MAX_JSON_DEPTH) return false; }
            else if (c == '}' || c == ']') { if (--depth < 0) return false; }
            else if (!(c >= '0' && c <= '9' || c == ':' || c == ',' || c == '.' || c == '-' || c == '+'
                    || c == 'e' || c == 'E' || c == 't' || c == 'r' || c == 'u' || c == 'f' || c == 'a'
                    || c == 'l' || c == 's' || c == 'n' || c == ' ' || c == '\t' || c == '\r' || c == '\n')) return false;
        }
        return depth == 0 && !string;
    }
    Ticket start(String id) {
        if (!active || !validId(id) || pending.size() >= MAX_IN_FLIGHT || pending.containsKey(id)) return null;
        Ticket ticket = new Ticket(id, generation);
        pending.put(id, ticket);
        return ticket;
    }
    boolean mayReply(Ticket ticket) {
        return active && ticket != null && ticket.generation == generation && pending.get(ticket.id) == ticket;
    }
    void finish(Ticket ticket) {
        if (ticket != null && pending.get(ticket.id) == ticket) pending.remove(ticket.id);
    }
    void close() { active = false; generation++; pending.clear(); }
}
