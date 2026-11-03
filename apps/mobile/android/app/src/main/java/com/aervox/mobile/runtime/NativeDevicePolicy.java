package com.aervox.mobile.runtime;

import java.util.LinkedHashSet;
import java.util.Set;
import org.json.JSONObject;

/**
 * Pure policy seam for bounded device actions. It only accepts a fixed verb
 * list with typed parameters and produces a single shell line made of
 * pre-validated tokens, so a model-supplied string can never become shell
 * syntax, a new verb, a pipe or a path. Android/root execution lives in
 * {@link NativeDeviceService}.
 */
final class NativeDevicePolicy {
    static final int MAX_OUTPUT_BYTES = 4 * 1024;
    static final int MAX_TEXT_CHARS = 200;
    static final int MAX_COORDINATE = 20_000;
    static final int MIN_SWIPE_MS = 50, MAX_SWIPE_MS = 10_000, DEFAULT_SWIPE_MS = 300;
    // advanced: the user-granted research escape hatch. Raw shell lines are
    // only reachable through this capability, which stays off by default.
    static final String CAPABILITY_CONTROL = "control", CAPABILITY_APPS = "apps", CAPABILITY_ADVANCED = "advanced";
    static final int MAX_COMMAND_CHARS = 2_048;

    static final class Rejected extends Exception {
        final String code;
        Rejected(String value) { super(value); code = value; }
    }

    /** One accepted action: the capability it needs and the validated command line. */
    static final class Command {
        final String capability, line, description;
        Command(String needs, String shellLine, String receipt) { capability = needs; line = shellLine; description = receipt; }
    }

    static final Set<String> KEY_NAMES;
    static {
        Set<String> names = new LinkedHashSet<>();
        names.add("BACK"); names.add("HOME"); names.add("RECENTS"); names.add("ENTER");
        names.add("DEL"); names.add("TAB"); names.add("VOLUME_UP"); names.add("VOLUME_DOWN");
        KEY_NAMES = java.util.Collections.unmodifiableSet(names);
    }

    private NativeDevicePolicy() { }

    static Command parse(JSONObject input) throws Rejected {
        String action = input.optString("action", "");
        switch (action) {
            case "info":
                exact(input, "action");
                return info();
            case "tap": {
                exact(input, "action", "x", "y");
                return tap(integer(input, "x"), integer(input, "y"));
            }
            case "swipe": {
                exactOptional(input, new String[]{"action", "x1", "y1", "x2", "y2"}, "durationMs");
                return swipe(integer(input, "x1"), integer(input, "y1"), integer(input, "x2"), integer(input, "y2"),
                    input.has("durationMs") ? integer(input, "durationMs") : DEFAULT_SWIPE_MS);
            }
            case "key": {
                exact(input, "action", "key");
                return key(input.optString("key", ""));
            }
            case "text": {
                exact(input, "action", "value");
                return text(input.optString("value", ""));
            }
            case "launch": {
                exact(input, "action", "package");
                return launch(input.optString("package", ""));
            }
            case "command": {
                exact(input, "action", "line");
                return command(input.optString("line", ""));
            }
            default:
                throw new Rejected("UNSUPPORTED_DEVICE_ACTION");
        }
    }

    // Primitive builders keep every rule testable on a plain JVM (no org.json).

    static Command info() { return new Command(null, null, "device info"); }

    static Command tap(int x, int y) throws Rejected {
        coordinate(x); coordinate(y);
        return new Command(CAPABILITY_CONTROL, "input tap " + x + " " + y, "tap " + x + "," + y);
    }

    static Command swipe(int x1, int y1, int x2, int y2, int durationMs) throws Rejected {
        coordinate(x1); coordinate(y1); coordinate(x2); coordinate(y2);
        if (durationMs < MIN_SWIPE_MS || durationMs > MAX_SWIPE_MS) throw new Rejected("INVALID_ARGUMENT");
        return new Command(CAPABILITY_CONTROL, "input swipe " + x1 + " " + y1 + " " + x2 + " " + y2 + " " + durationMs,
            "swipe " + x1 + "," + y1 + " to " + x2 + "," + y2);
    }

    static Command key(String name) throws Rejected {
        if (name == null || !KEY_NAMES.contains(name)) throw new Rejected("INVALID_ARGUMENT");
        return new Command(CAPABILITY_CONTROL, "input keyevent KEYCODE_" + name, "key " + name);
    }

    static Command text(String value) throws Rejected {
        // `input text` injects ASCII reliably; other characters are refused
        // instead of silently typing something else.
        if (value == null || value.isEmpty() || value.length() > MAX_TEXT_CHARS) throw new Rejected("INVALID_ARGUMENT");
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character > 0x7e || character == '\'') throw new Rejected("INVALID_ARGUMENT");
        }
        return new Command(CAPABILITY_CONTROL, "input text '" + value + "'", "text " + value.length() + " chars");
    }

    /** Raw research command: the one intentional exception to the fixed verb
     * list. Length-bounded, capability-gated, never auto-issued. */
    static Command command(String line) throws Rejected {
        if (line == null || line.trim().isEmpty() || line.length() > MAX_COMMAND_CHARS) throw new Rejected("INVALID_ARGUMENT");
        return new Command(CAPABILITY_ADVANCED, line, "command " + line.length() + " chars");
    }

    static Command launch(String name) throws Rejected {
        if (!packageName(name)) throw new Rejected("INVALID_ARGUMENT");
        return new Command(CAPABILITY_APPS, "monkey -p " + name + " -c android.intent.category.LAUNCHER 1", "launch " + name);
    }

    static boolean packageName(String value) {
        return value != null && value.length() <= 150
            && value.matches("[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_]{1,64}){1,8}");
    }

    static boolean capability(String value) {
        return CAPABILITY_CONTROL.equals(value) || CAPABILITY_APPS.equals(value) || CAPABILITY_ADVANCED.equals(value);
    }

    static boolean rootUid(String output) {
        if (output == null) return false;
        String trimmed = output.trim();
        return trimmed.equals("0");
    }

    private static void coordinate(int value) throws Rejected {
        if (value < 0 || value > MAX_COORDINATE) throw new Rejected("INVALID_ARGUMENT");
    }

    private static int integer(JSONObject input, String field) throws Rejected {
        Object value = input.opt(field);
        if (!(value instanceof Integer)) throw new Rejected("INVALID_ARGUMENT");
        return ((Integer) value).intValue();
    }

    private static void exact(JSONObject input, String... fields) throws Rejected { exactOptional(input, fields); }

    private static void exactOptional(JSONObject input, String[] required, String... optional) throws Rejected {
        for (String field : required) if (!input.has(field)) throw new Rejected("INVALID_ARGUMENT");
        Set<String> allowed = new LinkedHashSet<>(java.util.Arrays.asList(required));
        allowed.addAll(java.util.Arrays.asList(optional));
        java.util.Iterator<String> keys = input.keys();
        while (keys.hasNext()) if (!allowed.contains(keys.next())) throw new Rejected("INVALID_ARGUMENT");
    }
}
