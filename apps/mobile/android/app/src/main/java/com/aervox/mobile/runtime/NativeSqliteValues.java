package com.aervox.mobile.runtime;

import org.json.JSONException;
import org.json.JSONObject;

/** Internal M0 value codec only: no connection, SQL execution or JavaScript
 * registration. INTEGER uses canonical decimal text, BLOB uses lowercase hex,
 * and REAL uses explicit markers where JSON numbers cannot retain its value.
 * Input binding remains finite; SQLite result REAL may also be infinite.
 */
final class NativeSqliteValues {
    private NativeSqliteValues() {}

    static final class ValueException extends IllegalArgumentException {
        private ValueException() { super("INVALID_SQLITE_VALUE"); }
    }

    /** Returns exactly a native bindable null, String, Double, Long or byte[].
     * It never coerces an untagged or wrongly typed value to one of those types.
     */
    static Object decodeBinding(Object input) {
        if (!(input instanceof JSONObject)) throw invalid();
        JSONObject value = (JSONObject) input;
        try {
            Object rawType = value.get("type");
            if (!(rawType instanceof String)) throw invalid();
            String type = (String) rawType;
            if (type.equals("null")) {
                exactFields(value, false);
                return null;
            }
            exactFields(value, true);
            Object payload = value.get("value");
            switch (type) {
                case "text":
                    if (!(payload instanceof String)) throw invalid();
                    return payload;
                case "float":
                    if (payload instanceof String && payload.equals("-0")) return -0.0d;
                    // These are the numeric types emitted by Android's JSON
                    // parser. Arbitrary Number subclasses are not JSON numbers.
                    if (!(payload instanceof Integer || payload instanceof Long || payload instanceof Double)) throw invalid();
                    double real = ((Number) payload).doubleValue();
                    if (!Double.isFinite(real)) throw invalid();
                    return real;
                case "int64":
                    return parseInt64(payload);
                case "blob":
                    return parseBlob(payload);
                default:
                    throw invalid();
            }
        } catch (JSONException ignored) {
            throw invalid();
        }
    }

    /** Encodes only actual SQLite result types. Callers must distinguish native
     * INTEGER (Long) from REAL (Double), even when the latter is integral.
     * SQLite represents NaN as NULL; this method rejects an unexpected NaN.
     */
    static JSONObject encodeResultValue(Object value) {
        try {
            JSONObject result = new JSONObject();
            if (value == null) return result.put("type", "null");
            if (value instanceof String) return result.put("type", "text").put("value", value);
            if (value instanceof Long) return result.put("type", "int64").put("value", value.toString());
            if (value instanceof Double) {
                double real = (Double) value;
                if (Double.isNaN(real)) throw invalid();
                Object payload = Double.doubleToRawLongBits(real) == Long.MIN_VALUE ? "-0"
                    : real == Double.POSITIVE_INFINITY ? "Infinity"
                    : real == Double.NEGATIVE_INFINITY ? "-Infinity" : real;
                return result.put("type", "float").put("value", payload);
            }
            if (value instanceof byte[]) return result.put("type", "blob").put("value", hex((byte[]) value));
            throw invalid();
        } catch (JSONException ignored) {
            throw invalid();
        }
    }

    private static void exactFields(JSONObject value, boolean payload) {
        if (value.length() != (payload ? 2 : 1) || !value.has("type") || (payload && !value.has("value"))) throw invalid();
    }

    private static Long parseInt64(Object input) {
        if (!(input instanceof String)) throw invalid();
        String value = (String) input;
        if (value.length() > 20 || !value.matches("(?:0|-?[1-9][0-9]*)")) throw invalid();
        try { return Long.valueOf(value); }
        catch (NumberFormatException ignored) { throw invalid(); }
    }

    private static byte[] parseBlob(Object input) {
        if (!(input instanceof String)) throw invalid();
        String value = (String) input;
        if (value.length() % 2 != 0) throw invalid();
        byte[] bytes = new byte[value.length() / 2];
        for (int index = 0; index < bytes.length; index++) {
            int high = hexDigit(value.charAt(index * 2)), low = hexDigit(value.charAt(index * 2 + 1));
            bytes[index] = (byte) ((high << 4) | low);
        }
        return bytes;
    }

    private static int hexDigit(char value) {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        throw invalid();
    }

    private static String hex(byte[] bytes) {
        char[] result = new char[bytes.length * 2];
        String digits = "0123456789abcdef";
        for (int index = 0; index < bytes.length; index++) {
            int value = bytes[index] & 0xff;
            result[index * 2] = digits.charAt(value >>> 4);
            result[index * 2 + 1] = digits.charAt(value & 15);
        }
        return new String(result);
    }

    private static ValueException invalid() { return new ValueException(); }
}
