package com.aervox.mobile.runtime;

import android.database.Cursor;
import android.database.CursorWindow;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.sqlite.database.sqlite.SQLiteConstraintException;
import org.sqlite.database.sqlite.SQLiteCursor;
import org.sqlite.database.sqlite.SQLiteDatabase;
import org.sqlite.database.sqlite.SQLiteProgram;
import org.sqlite.database.sqlite.SQLiteStatement;

/** Internal M0 actor, not a registered SQL service. The Java-only initializer
 * transfers a fixed, schema-validated database to this one worker; it must not
 * retain/use the database, install I/O functions/extensions or accept JS paths.
 * Before returning it owns partial initialization cleanup if initialization fails.
 * API 28 is an experimental window requirement, not formal platform support.
 * SQL is a deliberately narrow lexical subset, not an authorizer or full libsql
 * implementation. Declared column types are unknown (empty strings).
 */
final class NativeSqliteSession implements AutoCloseable {
    static { System.loadLibrary("sqliteX"); }
    static final int MAX_PENDING = 8, MAX_ROWS = 512, MAX_COLUMNS = 128;
    static final int WINDOW_BYTES = 1024 * 1024, MAX_RESULT_BYTES = 3 * 1024 * 1024;
    static final int MAX_BIND_BYTES = 256 * 1024, MAX_TOTAL_BIND_BYTES = 1024 * 1024;
    static final long EXECUTION_DEADLINE_MS = 5000;
    enum Failure { INVALID_REQUEST, INVALID_IDENTITY, OWNER_MISMATCH, QUEUE_FULL, CLOSED,
        INITIALIZATION_FAILED, WINDOW_API_UNAVAILABLE, OUTCOME_UNKNOWN, CLEANUP_UNCONFIRMED }
    static final class SessionException extends Exception {
        final Failure code;
        SessionException(Failure value) { super(value.name()); code = value; }
    }
    private static final class ResultLimit extends Exception {}
    private static final class Command {
        final String operation, epoch, transactionId, sql;
        final Object[] args;
        Command(String op, String connection, String tx, String text, Object[] values) {
            operation = op; epoch = connection; transactionId = tx; sql = text; args = values;
        }
    }
    private final Object gate = new Object();
    private final String epoch = UUID.randomUUID().toString();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(task -> new Thread(task, "aervox-m0-sqlite"));
    private final ScheduledThreadPoolExecutor cancellation = new ScheduledThreadPoolExecutor(1);
    private final CompletableFuture<String> initialized = new CompletableFuture<>();
    private CompletableFuture<JSONObject> disposal;
    private int pending;
    private volatile boolean closing, poisoned, drained;
    private volatile CancellationSignal activeSignal;
    // Actor-owned state: these are never read as a native autocommit proof.
    private Thread actorThread;
    private SQLiteDatabase database;
    private String owner;

    NativeSqliteSession(Callable<SQLiteDatabase> initializer) {
        if (initializer == null) throw new IllegalArgumentException("INVALID_INITIALIZER");
        cancellation.setRemoveOnCancelPolicy(true);
        worker.execute(() -> {
            actorThread = Thread.currentThread();
            try {
                if (Build.VERSION.SDK_INT < 28) throw failure(Failure.WINDOW_API_UNAVAILABLE);
                database = initializer.call();
                if (database == null || !database.isOpen() || database.inTransaction()) throw failure(Failure.INITIALIZATION_FAILED);
                database.disableWriteAheadLogging();
                database.setForeignKeyConstraintsEnabled(true);
                initialized.complete(epoch);
            } catch (Throwable rejected) {
                poisoned = true;
                SessionException bounded = rejected instanceof SessionException ? (SessionException) rejected : failure(Failure.INITIALIZATION_FAILED);
                if (bounded != rejected) bounded.initCause(rejected);
                initialized.completeExceptionally(bounded);
            }
        });
    }
    CompletableFuture<String> ready() { return initialized; }
    boolean isClosed() { return closing || poisoned; }
    boolean isDrained() { return drained; }

    /** Copies primitive bindings before enqueueing; no caller can mutate an
     * accepted JSONObject or byte array into a different native command.
     */
    CompletableFuture<JSONObject> request(JSONObject input) {
        final Command command;
        try { command = parse(input); }
        catch (Exception rejected) { return failed(failure(Failure.INVALID_REQUEST)); }
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        synchronized (gate) {
            if (closing || poisoned) return failed(failure(Failure.CLOSED));
            if (pending >= MAX_PENDING) return failed(failure(Failure.QUEUE_FULL));
            pending++;
            worker.execute(() -> {
                try {
                    if (Thread.currentThread() != actorThread) throw quarantine();
                    if (closing || poisoned) throw failure(Failure.CLOSED);
                    if (database == null || !initialized.isDone()) throw failure(Failure.INITIALIZATION_FAILED);
                    result.complete(perform(command));
                } catch (Throwable rejected) {
                    result.completeExceptionally(rejected instanceof SessionException ? rejected : quarantine());
                } finally { synchronized (gate) { pending--; } }
            });
        }
        return result;
    }

    /** Stops admission now. The reserved cleanup job runs after every accepted
     * worker task has exited; it alone rolls back/closes the owned pool. A close
     * ACK says nothing about whether an earlier unknown commit took effect.
     */
    CompletableFuture<JSONObject> dispose(String connectionEpoch) {
        synchronized (gate) {
            if (!epoch.equals(connectionEpoch)) return failed(failure(Failure.INVALID_IDENTITY));
            if (disposal != null) return disposal;
            closing = true;
            disposal = new CompletableFuture<>();
            CancellationSignal signal = activeSignal;
            if (signal != null) cancellation.execute(signal::cancel);
            worker.execute(() -> {
                try {
                    // A replacement executor thread cannot inherit Android
                    // ThreadLocal transaction ownership or prove cleanup.
                    if (Thread.currentThread() != actorThread) throw failure(Failure.CLEANUP_UNCONFIRMED);
                    if (database != null) {
                        // inTransaction is only a Java-stack check to decide
                        // whether endTransaction is callable. Never proof that
                        // a failed terminal left SQLite outside a transaction.
                        try { if (database.inTransaction()) database.endTransaction(); }
                        catch (RuntimeException unknown) { poisoned = true; }
                        database.close(); // All cursors/statements already exited.
                        database = null;
                    }
                    owner = null; drained = true;
                    disposal.complete(json("kind", "disposed", "connectionEpoch", epoch));
                } catch (Throwable unknown) {
                    poisoned = true;
                    disposal.completeExceptionally(failure(Failure.CLEANUP_UNCONFIRMED));
                } finally { cancellation.shutdown(); }
            });
            worker.shutdown();
            return disposal;
        }
    }
    @Override public void close() { dispose(epoch).exceptionally(ignored -> null); }
    CompletableFuture<JSONObject> drain() { return dispose(epoch); }

    private JSONObject perform(Command command) throws Exception {
        if (!epoch.equals(command.epoch)) throw failure(Failure.INVALID_IDENTITY);
        if (command.operation.equals("begin")) {
            if (owner != null) throw failure(Failure.OWNER_MISMATCH);
            try { database.beginTransactionNonExclusive(); }
            catch (RuntimeException unknown) { throw quarantine(); }
            owner = UUID.randomUUID().toString();
            return json("kind", "begun", "connectionEpoch", epoch, "transactionId", owner);
        }
        if (!java.util.Objects.equals(owner, command.transactionId)) throw failure(Failure.OWNER_MISMATCH);
        if (command.operation.equals("execute")) return execute(command);
        if (owner == null) throw failure(Failure.OWNER_MISMATCH);
        String previous = owner;
        try {
            if (command.operation.equals("commit")) database.setTransactionSuccessful();
            database.endTransaction();
        } catch (RuntimeException unknown) { throw quarantine(); }
        owner = null;
        return json("kind", "terminal", "connectionEpoch", epoch, "transactionId", previous,
            "outcome", command.operation.equals("commit") ? "committed" : "rolledBack");
    }
    private JSONObject execute(Command command) throws Exception {
        boolean root = owner == null;
        if (root) {
            try { database.beginTransactionNonExclusive(); }
            catch (RuntimeException unknown) { throw quarantine(); }
        }
        final JSONObject result;
        try {
            result = executeOnce(command.sql, command.args);
        } catch (Exception rejected) {
            if (!root) throw quarantine(); // Unknown statement/owner transition.
            try { database.endTransaction(); }
            catch (RuntimeException unknown) { throw quarantine(); }
            String code = rejected instanceof ResultLimit || rejected instanceof OperationCanceledException ? "SQLITE_ABORT"
                : rejected instanceof SQLiteConstraintException ? "SQLITE_CONSTRAINT" : "SQLITE_ERROR";
            return json("kind", "rejected", "connectionEpoch", epoch, "transactionId", JSONObject.NULL, "state", "none", "code", code);
        }
        if (root) {
            try { database.setTransactionSuccessful(); database.endTransaction(); }
            catch (RuntimeException unknown) { throw quarantine(); }
        }
        return json("kind", "result", "connectionEpoch", epoch,
            "transactionId", command.transactionId == null ? JSONObject.NULL : command.transactionId, "result", result);
    }

    @android.annotation.TargetApi(28)
    private JSONObject executeOnce(String sql, Object[] args) throws Exception {
        CancellationSignal signal = new CancellationSignal(); activeSignal = signal;
        ScheduledFuture<?> deadline = cancellation.schedule(signal::cancel, EXECUTION_DEADLINE_MS, TimeUnit.MILLISECONDS);
        try (SQLiteCursor cursor = (SQLiteCursor) database.rawQueryWithFactory((db, driver, editTable, query) -> {
            for (int index = 0; index < args.length; index++) bind(query, index + 1, args[index]);
            return new SQLiteCursor(driver, editTable, query);
        }, sql, null, null, signal)) {
            String[] names = cursor.getColumnNames();
            if (names.length > MAX_COLUMNS) throw new ResultLimit();
            cursor.setWindow(new CursorWindow("aervox-m0-result", WINDOW_BYTES));
            int count = cursor.getCount(); // One fill only; never move/refill.
            CursorWindow window = cursor.getWindow();
            if (window == null || window.getStartPosition() != 0 || window.getNumRows() != count || count > MAX_ROWS) throw new ResultLimit();
            JSONArray columns = new JSONArray(), types = new JSONArray(), rows = new JSONArray();
            for (String name : names) { columns.put(name); types.put(""); }
            for (int row = 0; row < count; row++) {
                JSONArray values = new JSONArray();
                for (int column = 0; column < names.length; column++) {
                    Object value;
                    switch (window.getType(row, column)) {
                        case Cursor.FIELD_TYPE_NULL: value = null; break;
                        case Cursor.FIELD_TYPE_INTEGER: value = window.getLong(row, column); break;
                        case Cursor.FIELD_TYPE_FLOAT: value = window.getDouble(row, column); break;
                        case Cursor.FIELD_TYPE_STRING: value = window.getString(row, column); break;
                        case Cursor.FIELD_TYPE_BLOB: value = window.getBlob(row, column); break;
                        default: throw new ResultLimit();
                    }
                    values.put(NativeSqliteValues.encodeResultValue(value));
                }
                rows.put(values);
            }
            long affected = 0; Object rowid = JSONObject.NULL;
            if (names.length == 0) {
                // The explicit transaction pins both reads to this writer.
                try (SQLiteStatement changes = database.compileStatement("SELECT changes()")) { affected = changes.simpleQueryForLong(); }
                try (SQLiteStatement inserted = database.compileStatement("SELECT last_insert_rowid()")) { rowid = Long.toString(inserted.simpleQueryForLong()); }
                if (affected < 0 || affected > 9007199254740991L) throw new ResultLimit();
            }
            JSONObject result = json("columns", columns, "columnTypes", types, "rows", rows,
                "rowsAffected", affected, "lastInsertRowid", rowid);
            if (!NativeMessagePolicy.withinUtf8Budget(result.toString(), MAX_RESULT_BYTES)) throw new ResultLimit();
            return result;
        } finally {
            deadline.cancel(false);
            if (activeSignal == signal) activeSignal = null;
        }
    }

    private static Command parse(JSONObject input) throws Exception {
        if (input == null || !(input.get("operation") instanceof String)) throw failure(Failure.INVALID_REQUEST);
        String operation = (String) input.get("operation");
        String connection = string(input.get("connectionEpoch"));
        if (operation.equals("begin")) {
            exact(input, "operation", "connectionEpoch", "mode");
            if (!"write".equals(input.get("mode"))) throw failure(Failure.INVALID_REQUEST);
            return new Command(operation, connection, null, null, null);
        }
        Object rawOwner = input.get("transactionId");
        String transaction = rawOwner == JSONObject.NULL ? null : string(rawOwner);
        if (operation.equals("commit") || operation.equals("rollback")) {
            exact(input, "operation", "connectionEpoch", "transactionId");
            if (transaction == null) throw failure(Failure.INVALID_REQUEST);
            return new Command(operation, connection, transaction, null, null);
        }
        if (!operation.equals("execute")) throw failure(Failure.INVALID_REQUEST);
        exact(input, "operation", "connectionEpoch", "transactionId", "statement");
        Object rawStatement = input.get("statement");
        if (!(rawStatement instanceof JSONObject)) throw failure(Failure.INVALID_REQUEST);
        JSONObject statement = (JSONObject) rawStatement;
        exact(statement, "sql", "args");
        Object rawSql = statement.get("sql"), rawArgs = statement.get("args");
        if (!(rawSql instanceof String) || !(rawArgs instanceof JSONArray)) throw failure(Failure.INVALID_REQUEST);
        String sql = (String) rawSql;
        int arity = NativeSqliteStatementPolicy.validate(sql);
        JSONArray arguments = (JSONArray) rawArgs;
        if (arity != arguments.length()) throw failure(Failure.INVALID_REQUEST);
        Object[] args = new Object[arity];
        int bytes = 0;
        for (int index = 0; index < arity; index++) {
            Object tagged = arguments.get(index);
            if (!(tagged instanceof JSONObject)) throw failure(Failure.INVALID_REQUEST);
            JSONObject value = (JSONObject) tagged;
            if (value.has("value") && value.get("value") instanceof String) {
                String text = (String) value.get("value");
                int limit = "blob".equals(value.opt("type")) ? MAX_BIND_BYTES * 2 : MAX_BIND_BYTES;
                if (!NativeMessagePolicy.withinUtf8Budget(text, limit)) throw failure(Failure.INVALID_REQUEST);
            }
            args[index] = NativeSqliteValues.decodeBinding(value);
            if (args[index] instanceof String) bytes += ((String) args[index]).getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
            else if (args[index] instanceof byte[]) bytes += ((byte[]) args[index]).length;
            else bytes += 8;
            if (bytes > MAX_TOTAL_BIND_BYTES) throw failure(Failure.INVALID_REQUEST);
        }
        return new Command(operation, connection, transaction, sql, args);
    }
    private SessionException quarantine() { poisoned = true; return failure(Failure.OUTCOME_UNKNOWN); }
    private static void bind(SQLiteProgram statement, int index, Object value) {
        if (value == null) statement.bindNull(index);
        else if (value instanceof String) statement.bindString(index, (String) value);
        else if (value instanceof Long) statement.bindLong(index, (Long) value);
        else if (value instanceof Double) statement.bindDouble(index, (Double) value);
        else if (value instanceof byte[]) statement.bindBlob(index, (byte[]) value);
        else throw new IllegalArgumentException("INVALID_BINDING");
    }
    private static void exact(JSONObject value, String... names) throws SessionException {
        if (value.length() != names.length) throw failure(Failure.INVALID_REQUEST);
        for (String name : names) if (!value.has(name)) throw failure(Failure.INVALID_REQUEST);
    }
    private static String string(Object value) throws SessionException {
        if (!(value instanceof String) || !((String) value).matches("[A-Za-z0-9_-]{1,128}")) throw failure(Failure.INVALID_REQUEST);
        return (String) value;
    }
    private static JSONObject json(Object... pairs) throws JSONException {
        JSONObject value = new JSONObject();
        for (int index = 0; index < pairs.length; index += 2) value.put((String) pairs[index], pairs[index + 1]);
        return value;
    }
    private static SessionException failure(Failure value) { return new SessionException(value); }
    private static <T> CompletableFuture<T> failed(Exception reason) {
        CompletableFuture<T> value = new CompletableFuture<>(); value.completeExceptionally(reason); return value;
    }
}
