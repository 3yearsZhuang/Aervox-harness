package com.aervox.mobile.runtime;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Conservative M0 statement admission, not an SQL parser or authorizer.
 * Only the fixed first-party repository's positional data statements are in
 * scope. Unsupported or ambiguous valid SQLite syntax is deliberately rejected.
 * The trusted initializer must not register extensions or custom I/O functions.
 */
final class NativeSqliteStatementPolicy {
    static final int MAX_SQL_BYTES = 32768, MAX_ARGUMENTS = 256, MAX_DEPTH = 64;
    private static final Set<String> ROOTS = words("SELECT", "INSERT", "UPDATE", "DELETE");
    private static final Set<String> BLOCKED = words("ATTACH", "DETACH", "PRAGMA", "CREATE", "ALTER", "DROP",
        "VACUUM", "ANALYZE", "REINDEX", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "EXPLAIN",
        "REPLACE", "FAIL", "RAISE", "LOAD_EXTENSION", "READFILE", "WRITEFILE", "EDIT", "EVAL", "FTS3_TOKENIZER");
    private NativeSqliteStatementPolicy() {}

    static int validate(String sql) {
        bytes(sql);
        List<Token> tokens = new ArrayList<>();
        int arguments = 0, depth = 0;
        boolean ended = false;
        for (int i = 0; i < sql.length();) {
            char c = sql.charAt(i);
            if (space(c)) { i++; continue; }
            if (c == '-' && i + 1 < sql.length() && sql.charAt(i + 1) == '-') {
                i += 2; while (i < sql.length() && sql.charAt(i) != '\n' && sql.charAt(i) != '\r') i++;
                continue;
            }
            if (c == '/' && i + 1 < sql.length() && sql.charAt(i + 1) == '*') {
                int end = sql.indexOf("*/", i + 2); if (end < 0) throw invalid();
                i = end + 2; continue;
            }
            if (ended) throw invalid();
            if (c == ';') { ended = true; i++; continue; }
            if (c == '\'' || c == '"' || c == '`' || c == '[') {
                char close = c == '[' ? ']' : c;
                boolean identifier = c != '\'';
                StringBuilder value = new StringBuilder();
                int next = i + 1; boolean closed = false;
                while (next < sql.length()) {
                    char part = sql.charAt(next++);
                    if (part == close) {
                        if (c != '[' && next < sql.length() && sql.charAt(next) == close) { value.append(close); next++; }
                        else { closed = true; break; }
                    } else value.append(part);
                }
                if (!closed) throw invalid();
                if (identifier) { forbidden(value.toString()); tokens.add(new Token('I', value.toString())); }
                else tokens.add(new Token('S', value.toString()));
                i = next; continue;
            }
            if (c == ':' || c == '@' || c == '$') throw invalid();
            if (c == '?') {
                if (++arguments > MAX_ARGUMENTS || i + 1 < sql.length() && identifierPart(sql.charAt(i + 1))) throw invalid();
                tokens.add(new Token('P', "?")); i++; continue;
            }
            if (identifierStart(c)) {
                int end = i + 1; while (end < sql.length() && identifierPart(sql.charAt(end))) end++;
                String value = sql.substring(i, end).toUpperCase(Locale.ROOT);
                forbidden(value); tokens.add(new Token('W', value)); i = end; continue;
            }
            if (c == '(') { if (++depth > MAX_DEPTH) throw invalid(); }
            else if (c == ')') { if (--depth < 0) throw invalid(); }
            tokens.add(new Token(c, String.valueOf(c))); i++;
        }
        if (depth != 0 || tokens.isEmpty()) throw invalid();
        for (int i = 0; i + 1 < tokens.size(); i++) {
            if (tokens.get(i).kind == 'S' && tokens.get(i + 1).kind == '(') forbidden(tokens.get(i).value);
        }
        Token first = tokens.get(0);
        if (first.kind != 'W') throw invalid();
        if (first.value.equals("WITH")) validateWith(tokens);
        else if (!ROOTS.contains(first.value)) throw invalid();
        return arguments;
    }

    private static void validateWith(List<Token> tokens) {
        int next = 1;
        if (word(tokens, next, "RECURSIVE")) next++;
        while (true) {
            if (next >= tokens.size() || tokens.get(next).kind != 'W' && tokens.get(next).kind != 'I') throw invalid();
            next++;
            if (kind(tokens, next, '(')) next = afterGroup(tokens, next);
            if (!word(tokens, next++, "AS")) throw invalid();
            if (word(tokens, next, "NOT")) { next++; if (!word(tokens, next++, "MATERIALIZED")) throw invalid(); }
            else if (word(tokens, next, "MATERIALIZED")) next++;
            if (!kind(tokens, next, '(')) throw invalid();
            if (!word(tokens, next + 1, "SELECT") && !word(tokens, next + 1, "VALUES") && !word(tokens, next + 1, "WITH")) throw invalid();
            next = afterGroup(tokens, next);
            if (!kind(tokens, next, ',')) break;
            next++;
        }
        if (next >= tokens.size() || tokens.get(next).kind != 'W' || !ROOTS.contains(tokens.get(next).value)) throw invalid();
    }
    private static int afterGroup(List<Token> tokens, int start) {
        int depth = 0;
        for (int next = start; next < tokens.size(); next++) {
            if (tokens.get(next).kind == '(') depth++;
            else if (tokens.get(next).kind == ')' && --depth == 0) return next + 1;
        }
        throw invalid();
    }
    private static boolean kind(List<Token> tokens, int index, char kind) { return index < tokens.size() && tokens.get(index).kind == kind; }
    private static boolean word(List<Token> tokens, int index, String value) { return index < tokens.size() && tokens.get(index).kind == 'W' && tokens.get(index).value.equals(value); }
    private static void forbidden(String name) {
        String upper = name.toUpperCase(Locale.ROOT);
        if (BLOCKED.contains(upper) || upper.startsWith("PRAGMA_") || upper.startsWith("SQLITE_") && !upper.equals("SQLITE_VERSION")) throw invalid();
    }
    private static void bytes(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_SQL_BYTES) throw invalid();
        int bytes = 0;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == 0) throw invalid();
            if (c < 0x80) bytes++;
            else if (c < 0x800) bytes += 2;
            else if (Character.isHighSurrogate(c)) {
                if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) throw invalid();
                bytes += 4;
            } else if (Character.isLowSurrogate(c)) throw invalid();
            else bytes += 3;
            if (bytes > MAX_SQL_BYTES) throw invalid();
        }
    }
    private static boolean space(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f'; }
    private static boolean identifierStart(char c) { return c == '_' || Character.isLetter(c) || c >= 0x80; }
    private static boolean identifierPart(char c) { return identifierStart(c) || c >= '0' && c <= '9'; }
    private static Set<String> words(String... values) { return new HashSet<>(Arrays.asList(values)); }
    private static final class Token {
        final char kind; final String value;
        Token(char type, String text) { kind = type; value = text; }
    }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("UNSUPPORTED_SQL"); }
}
