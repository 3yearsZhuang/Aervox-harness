package com.aervox.mobile.runtime;

import android.content.Context;
import android.database.CursorWindow;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Looper;
import android.os.OperationCanceledException;
import java.io.File;
import java.util.Arrays;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import org.sqlite.database.sqlite.SQLiteCursor;
import org.sqlite.database.sqlite.SQLiteDatabase;
import org.sqlite.database.sqlite.SQLiteProgram;

/** Fixed, disposable API-viability experiment, not a SQL service or bridge.
 * No caller selects SQL, values, paths, database identity or schema. Every DB
 * action and cleanup stays on one dedicated worker; results contain no data.
 * A small explicit CursorWindow requires API 28, separate from M0 support policy.
 */
public final class NativeExecutionProbe {
    static { System.loadLibrary("sqliteX"); }
    private NativeExecutionProbe() {}

    public enum Failure {
        REQUIRES_BACKGROUND_CALLER, WINDOW_API_UNAVAILABLE, TEMPORARY_FILE_FAILED,
        ENGINE_MISMATCH, TYPED_QUERY_FAILED, TYPED_VALUE_MISMATCH,
        RETURNING_QUERY_FAILED, RETURNING_EFFECT_MISMATCH,
        WINDOW_OVERFLOW, RESULT_LIMIT, OVERFLOW_NOT_REJECTED, OVERFLOW_QUERY_FAILED, ROLLBACK_MISMATCH, TERMINAL_FAILED,
        CANCEL_NOT_OBSERVED, CANCEL_QUERY_FAILED, REOPEN_FAILED,
        CLEANUP_FAILED, DEADLINE_EXCEEDED, DRAIN_UNCONFIRMED, EXECUTION_FAILED
    }
    public static class ProbeException extends Exception {
        public final Failure code;
        private ProbeException(Failure value) { super(value.name()); code = value; }
    }
    public static final class Result {
        public final String engineVersion;
        public final boolean typedValues, returningOnce, overflowRejected, rollback,
            cancellationObserved, reopened, workerDrained;
        public final int overflowRows, firstWindowRows;
        private Result(String engine, int total, int first) {
            engineVersion = engine; overflowRows = total; firstWindowRows = first;
            typedValues = returningOnce = overflowRejected = rollback =
                cancellationObserved = reopened = workerDrained = true;
        }
    }

    public static Result run(Context context) throws ProbeException {
        if (Looper.myLooper() == Looper.getMainLooper()) throw failure(Failure.REQUIRES_BACKGROUND_CALLER);
        if (Build.VERSION.SDK_INT < 28) throw failure(Failure.WINDOW_API_UNAVAILABLE);
        AtomicReference<CancellationSignal> active = new AtomicReference<>();
        ExecutorService worker = Executors.newSingleThreadExecutor(task -> new Thread(task, "aervox-sqlite-probe"));
        Future<Result> task = worker.submit(() -> runOwned(context.getApplicationContext(), active));
        worker.shutdown();
        try {
            Result result = task.get(30, TimeUnit.SECONDS);
            if (!worker.awaitTermination(5, TimeUnit.SECONDS)) throw failure(Failure.DRAIN_UNCONFIRMED);
            return result;
        } catch (TimeoutException expired) {
            cancel(active);
            try {
                if (!worker.awaitTermination(5, TimeUnit.SECONDS)) throw failure(Failure.DRAIN_UNCONFIRMED);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt(); throw failure(Failure.DRAIN_UNCONFIRMED);
            }
            throw failure(Failure.DEADLINE_EXCEEDED);
        } catch (InterruptedException interrupted) {
            cancel(active); Thread.currentThread().interrupt(); throw failure(Failure.DRAIN_UNCONFIRMED);
        } catch (ExecutionException rejected) {
            if (rejected.getCause() instanceof ProbeException) throw (ProbeException) rejected.getCause();
            throw failure(Failure.EXECUTION_FAILED);
        }
    }

    private static Result runOwned(Context context, AtomicReference<CancellationSignal> active) throws ProbeException {
        File file;
        try {
            File directory = new File(context.getNoBackupFilesDir(), "sqlite-execution-probes");
            if (!directory.isDirectory() && !directory.mkdirs()) throw failure(Failure.TEMPORARY_FILE_FAILED);
            file = File.createTempFile("execution-", ".db", directory);
        } catch (Exception rejected) { throw failure(Failure.TEMPORARY_FILE_FAILED); }
        SQLiteDatabase db = null;
        try {
            db = open(file);
            db.disableWriteAheadLogging();
            db.setForeignKeyConstraintsEnabled(true);
            String engine = (String) select(db, "SELECT sqlite_version()", new Object[0], null, 1).rows[0][0];
            require("3.54.1".equals(engine), Failure.ENGINE_MISMATCH);
            verifyValues(db);
            db.execSQL("CREATE TABLE execution_record(id INTEGER PRIMARY KEY, changes_seen INTEGER NOT NULL, body TEXT)");
            db.beginTransactionNonExclusive();
            try {
                Rows returned = select(db, "INSERT INTO execution_record VALUES (1, 0, ?) RETURNING id, body",
                    new Object[]{"one\0尾"}, null, 1);
                require(returned.rows.length == 1 && Long.valueOf(1).equals(returned.rows[0][0])
                    && "one\0尾".equals(returned.rows[0][1]), Failure.RETURNING_EFFECT_MISMATCH);
                db.setTransactionSuccessful();
            } catch (ProbeException rejected) { throw rejected; }
            catch (RuntimeException rejected) { throw failure(Failure.RETURNING_QUERY_FAILED); }
            finally { finishTransaction(db); }
            require(longScalar(db, "SELECT count(*) FROM execution_record") == 1, Failure.RETURNING_EFFECT_MISMATCH);

            // Each row fits the 64 KiB window, while the complete fixed result
            // exceeds it. No huge single value or unbounded generated data.
            db.execSQL("CREATE TABLE window_record(id INTEGER PRIMARY KEY, changes_seen INTEGER NOT NULL, padding TEXT NOT NULL)");
            db.beginTransactionNonExclusive();
            try {
                String padding = new String(new char[4096]).replace('\0', 'x');
                try (org.sqlite.database.sqlite.SQLiteStatement insert = db.compileStatement("INSERT INTO window_record VALUES (?, 0, ?)")) {
                    for (int index = 0; index < 128; index++) {
                        insert.bindLong(1, index); insert.bindString(2, padding); insert.executeInsert();
                    }
                }
                db.setTransactionSuccessful();
            } finally { finishTransaction(db); }
            WindowException overflow = null;
            db.beginTransactionNonExclusive();
            try {
                select(db, "UPDATE window_record SET changes_seen=changes_seen+1 RETURNING id, padding", new Object[0], null, 256);
                throw failure(Failure.OVERFLOW_NOT_REJECTED);
            } catch (WindowException expected) { overflow = expected; }
            catch (ProbeException rejected) { throw rejected; }
            catch (RuntimeException rejected) { throw failure(Failure.OVERFLOW_QUERY_FAILED); }
            finally { finishTransaction(db); } // No successful mark: reject atomically.
            require(overflow != null && overflow.total == 128 && overflow.first > 0 && overflow.first < overflow.total,
                Failure.OVERFLOW_NOT_REJECTED);
            require(longScalar(db, "SELECT sum(changes_seen) FROM window_record") == 0, Failure.ROLLBACK_MISMATCH);
            verifyCancellation(db, active);
            db.close(); db = null;
            try {
                db = open(file);
                require(longScalar(db, "SELECT count(*) FROM execution_record") == 1
                    && longScalar(db, "SELECT count(*) FROM window_record") == 128
                    && longScalar(db, "SELECT sum(changes_seen) FROM window_record") == 0
                    && db.isDatabaseIntegrityOk(), Failure.REOPEN_FAILED);
            } catch (ProbeException rejected) { throw rejected; }
            catch (RuntimeException rejected) { throw failure(Failure.REOPEN_FAILED); }
            return new Result(engine, overflow.total, overflow.first);
        } catch (ProbeException rejected) { throw rejected; }
        catch (RuntimeException rejected) { throw failure(Failure.EXECUTION_FAILED); }
        finally {
            active.set(null);
            try {
                if (db != null) db.close();
                if (!SQLiteDatabase.deleteDatabase(file)) throw failure(Failure.CLEANUP_FAILED);
            } catch (RuntimeException rejected) { throw failure(Failure.CLEANUP_FAILED); }
        }
    }

    private static void verifyValues(SQLiteDatabase db) throws ProbeException {
        Object[] args = {null, "中文\0尾", new byte[]{0, (byte) 128, (byte) 255}, Long.MIN_VALUE, Long.MAX_VALUE,
            1.5d, -0.0d, Double.MIN_VALUE, Double.MAX_VALUE};
        Rows returned;
        try { returned = select(db, "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?", args, null, 1); }
        catch (ProbeException rejected) { throw rejected; }
        catch (RuntimeException rejected) { throw failure(Failure.TYPED_QUERY_FAILED); }
        require(returned.rows.length == 1 && returned.columns.length == args.length, Failure.TYPED_VALUE_MISMATCH);
        Object[] row = returned.rows[0];
        for (int index = 0; index < args.length; index++) {
            Object expected = args[index], actual = row[index];
            boolean same = expected instanceof byte[] ? actual instanceof byte[] && Arrays.equals((byte[]) expected, (byte[]) actual)
                : expected instanceof Double ? actual instanceof Double && Double.doubleToRawLongBits((Double) expected) == Double.doubleToRawLongBits((Double) actual)
                : expected == null ? actual == null : expected.equals(actual);
            require(same, Failure.TYPED_VALUE_MISMATCH);
        }
    }

    private static void verifyCancellation(SQLiteDatabase db, AtomicReference<CancellationSignal> active) throws ProbeException {
        CancellationSignal signal = new CancellationSignal(); active.set(signal);
        ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
        java.util.concurrent.ScheduledFuture<?> alarm = timer.schedule(signal::cancel, 50, TimeUnit.MILLISECONDS);
        try {
            select(db, "WITH RECURSIVE numbers(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM numbers WHERE x<100000000) SELECT sum(x) FROM numbers",
                new Object[0], signal, 1);
            throw failure(Failure.CANCEL_NOT_OBSERVED);
        } catch (OperationCanceledException expected) {
            require(signal.isCanceled(), Failure.CANCEL_NOT_OBSERVED);
        } catch (ProbeException rejected) { throw rejected; }
        catch (RuntimeException rejected) { throw failure(Failure.CANCEL_QUERY_FAILED); }
        finally { alarm.cancel(false); timer.shutdown(); active.compareAndSet(signal, null); }
    }

    private static void finishTransaction(SQLiteDatabase db) throws ProbeException {
        try { db.endTransaction(); }
        catch (RuntimeException rejected) { throw failure(Failure.TERMINAL_FAILED); }
    }

    private static SQLiteDatabase open(File file) {
        return SQLiteDatabase.openDatabase(file.getAbsolutePath(), null,
            SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.CREATE_IF_NECESSARY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
    }
    private static long longScalar(SQLiteDatabase db, String sql) throws ProbeException {
        return (Long) select(db, sql, new Object[0], null, 1).rows[0][0];
    }
    private static final class Rows {
        final String[] columns;
        final Object[][] rows;
        Rows(String[] names, Object[][] values) { columns = names; rows = values; }
    }
    private static final class WindowException extends ProbeException {
        final int total, first;
        WindowException(int count, int filled) { super(Failure.WINDOW_OVERFLOW); total = count; first = filled; }
    }

    @android.annotation.TargetApi(28)
    private static Rows select(SQLiteDatabase db, String sql, Object[] args, CancellationSignal signal, int maxRows) throws ProbeException {
        try (SQLiteCursor cursor = (SQLiteCursor) db.rawQueryWithFactory((database, driver, editTable, query) -> {
            for (int index = 0; index < args.length; index++) bind(query, index + 1, args[index]);
            return new SQLiteCursor(driver, editTable, query);
        }, sql, null, null, signal)) {
            cursor.setWindow(new CursorWindow("aervox-execution-probe", 64 * 1024L));
            int total = cursor.getCount(); // Exactly one fill; never move/refill.
            CursorWindow window = cursor.getWindow();
            if (window == null || window.getStartPosition() != 0) throw failure(Failure.RESULT_LIMIT);
            if (window.getNumRows() != total) throw new WindowException(total, window.getNumRows());
            if (total > maxRows) throw failure(Failure.RESULT_LIMIT);
            String[] columns = cursor.getColumnNames();
            Object[][] rows = new Object[total][columns.length];
            for (int row = 0; row < total; row++) for (int column = 0; column < columns.length; column++) {
                switch (window.getType(row, column)) {
                    case android.database.Cursor.FIELD_TYPE_NULL: rows[row][column] = null; break;
                    case android.database.Cursor.FIELD_TYPE_INTEGER: rows[row][column] = window.getLong(row, column); break;
                    case android.database.Cursor.FIELD_TYPE_FLOAT: rows[row][column] = window.getDouble(row, column); break;
                    case android.database.Cursor.FIELD_TYPE_STRING: rows[row][column] = window.getString(row, column); break;
                    case android.database.Cursor.FIELD_TYPE_BLOB: rows[row][column] = window.getBlob(row, column); break;
                    default: throw failure(Failure.TYPED_VALUE_MISMATCH);
                }
            }
            return new Rows(columns, rows);
        }
    }
    private static void bind(SQLiteProgram statement, int index, Object value) {
        if (value == null) statement.bindNull(index);
        else if (value instanceof String) statement.bindString(index, (String) value);
        else if (value instanceof Long) statement.bindLong(index, (Long) value);
        else if (value instanceof Double) statement.bindDouble(index, (Double) value);
        else if (value instanceof byte[]) statement.bindBlob(index, (byte[]) value);
        else throw new IllegalArgumentException("INVALID_PROBE_BINDING");
    }
    private static void cancel(AtomicReference<CancellationSignal> active) {
        CancellationSignal signal = active.get(); if (signal != null) signal.cancel();
    }
    private static void require(boolean condition, Failure code) throws ProbeException { if (!condition) throw failure(code); }
    private static ProbeException failure(Failure code) { return new ProbeException(code); }
}
