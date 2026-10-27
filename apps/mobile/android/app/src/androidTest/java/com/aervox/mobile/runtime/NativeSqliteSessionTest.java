package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.sqlite.database.sqlite.SQLiteDatabase;
import org.sqlite.database.sqlite.SQLiteStatement;

/** Actual native actor/ownership tests. Every database belongs to a unique
 * temporary fixture; no production path, schema, credentials or bridge is used.
 */
@RunWith(AndroidJUnit4.class)
public final class NativeSqliteSessionTest {
    static { System.loadLibrary("sqliteX"); }

    @Test public void bindsValuesOnceAndPreservesUnknownDeclaredTypesAndPinnedReceipts() throws Exception {
        try (Fixture fixture = new Fixture(db -> db.execSQL("CREATE TABLE record(id INTEGER PRIMARY KEY, body TEXT, data BLOB)"))) {
            JSONObject values = fixture.execute(null, "SELECT ?, ?, ?, ?, ?, ?", null, "中文\0尾", Long.MIN_VALUE, -0.0d, 1.5d, new byte[]{0, (byte) 255});
            assertEquals("result", values.get("kind"));
            assertEquals("null", cell(values, 0).get("type"));
            assertEquals("中文\0尾", cell(values, 1).get("value"));
            assertEquals(Long.toString(Long.MIN_VALUE), cell(values, 2).get("value"));
            assertEquals("-0", cell(values, 3).get("value"));
            assertEquals(1.5d, (Double) cell(values, 4).get("value"), 0.0d);
            assertEquals("00ff", cell(values, 5).get("value"));
            assertEquals("", values.getJSONObject("result").getJSONArray("columnTypes").get(0));
            JSONObject inserted = fixture.execute(null, "INSERT INTO record VALUES (?, ?, ?)", 1L, "stored\0尾", new byte[]{1, 2});
            assertEquals("result", inserted.get("kind"));
            assertEquals(1, inserted.getJSONObject("result").getInt("rowsAffected"));
            assertEquals("1", inserted.getJSONObject("result").get("lastInsertRowid"));
            JSONObject returned = fixture.execute(null, "INSERT INTO record VALUES (?, ?, ?) RETURNING id, body", 2L, "returned", new byte[0]);
            assertEquals("2", cell(returned, 0).get("value"));
            assertEquals(0, returned.getJSONObject("result").getInt("rowsAffected"));
            assertTrue(returned.getJSONObject("result").isNull("lastInsertRowid"));
            assertEquals("2", cell(fixture.execute(null, "SELECT count(*) FROM record"), 0).get("value"));
        }
    }

    @Test public void requiresTheExactNativeOwnerAndNeverInterleavesRootWork() throws Exception {
        try (Fixture fixture = new Fixture(db -> db.execSQL("CREATE TABLE record(id INTEGER PRIMARY KEY)"))) {
            JSONObject begun = await(fixture.session.request(json("operation", "begin", "connectionEpoch", fixture.epoch, "mode", "write")));
            String tx = begun.getString("transactionId");
            rejected(fixture.session.request(command(fixture.epoch, null, "SELECT 1")), NativeSqliteSession.Failure.OWNER_MISMATCH);
            rejected(fixture.session.request(command(fixture.epoch, "different", "SELECT 1")), NativeSqliteSession.Failure.OWNER_MISMATCH);
            rejected(fixture.session.request(json("operation", "begin", "connectionEpoch", fixture.epoch, "mode", "write")), NativeSqliteSession.Failure.OWNER_MISMATCH);
            fixture.execute(tx, "INSERT INTO record VALUES (?)", 1L);
            JSONObject rolled = await(fixture.session.request(json("operation", "rollback", "connectionEpoch", fixture.epoch, "transactionId", tx)));
            assertEquals("rolledBack", rolled.get("outcome"));
            assertEquals("0", cell(fixture.execute(null, "SELECT count(*) FROM record"), 0).get("value"));
            rejected(fixture.session.request(command(fixture.epoch, tx, "SELECT 1")), NativeSqliteSession.Failure.OWNER_MISMATCH);
            String next = await(fixture.session.request(json("operation", "begin", "connectionEpoch", fixture.epoch, "mode", "write"))).getString("transactionId");
            assertNotEquals(tx, next);
            fixture.execute(next, "INSERT INTO record VALUES (?)", 2L);
            assertEquals("committed", await(fixture.session.request(json("operation", "commit", "connectionEpoch", fixture.epoch, "transactionId", next))).get("outcome"));
            assertEquals("1", cell(fixture.execute(null, "SELECT count(*) FROM record"), 0).get("value"));
        }
    }

    @Test public void rejectsWrongEpochMalformedBindingsAndUnsupportedSqlBeforeNativeEffects() throws Exception {
        try (Fixture fixture = new Fixture(db -> db.execSQL("CREATE TABLE record(id INTEGER PRIMARY KEY)"))) {
            rejected(fixture.session.request(command("wrong", null, "SELECT 1")), NativeSqliteSession.Failure.INVALID_IDENTITY);
            for (String sql : new String[]{"ATTACH DATABASE 'x' AS extra", "PRAGMA user_version=9", "BEGIN", "CREATE TABLE other(id)",
                    "INSERT INTO record VALUES (1); DELETE FROM record", "SELECT load_extension('x')", "SELECT ?1", "SELECT :named"}) {
                rejected(fixture.session.request(command(fixture.epoch, null, sql)), NativeSqliteSession.Failure.INVALID_REQUEST);
            }
            rejected(fixture.session.request(command(fixture.epoch, null, "SELECT ?")), NativeSqliteSession.Failure.INVALID_REQUEST);
            JSONObject extra = command(fixture.epoch, null, "SELECT 1").put("path", "/PRIVATE_CANARY");
            rejected(fixture.session.request(extra), NativeSqliteSession.Failure.INVALID_REQUEST);
            JSONObject named = command(fixture.epoch, null, "SELECT 1");
            named.getJSONObject("statement").put("args", new JSONObject());
            rejected(fixture.session.request(named), NativeSqliteSession.Failure.INVALID_REQUEST);
            assertEquals("0", cell(fixture.execute(null, "SELECT count(*) FROM record"), 0).get("value"));
            rejected(fixture.session.dispose("wrong"), NativeSqliteSession.Failure.INVALID_IDENTITY);
            assertFalse(fixture.session.isClosed());
        }
    }

    @Test public void rejectsFirstWindowOverflowAndRollsBackTheWholeRootMutation() throws Exception {
        try (Fixture fixture = windowFixture()) {
            JSONObject result = fixture.execute(null, "UPDATE record SET visits=visits+1 RETURNING id, padding");
            assertEquals("rejected", result.get("kind")); assertEquals("SQLITE_ABORT", result.get("code"));
            assertEquals("none", result.get("state")); assertTrue(result.isNull("transactionId"));
            assertEquals("0", cell(fixture.execute(null, "SELECT sum(visits) FROM record"), 0).get("value"));
            assertFalse(fixture.session.isClosed());
        }
    }

    @Test public void quarantinesAnActiveOwnerOnOverflowUntilExplicitDrainRollback() throws Exception {
        try (Fixture fixture = windowFixture()) {
            String tx = await(fixture.session.request(json("operation", "begin", "connectionEpoch", fixture.epoch, "mode", "write"))).getString("transactionId");
            rejected(fixture.session.request(command(fixture.epoch, tx, "UPDATE record SET visits=visits+1 RETURNING id, padding")), NativeSqliteSession.Failure.OUTCOME_UNKNOWN);
            assertTrue(fixture.session.isClosed()); assertFalse(fixture.session.isDrained());
            rejected(fixture.session.request(command(fixture.epoch, tx, "SELECT 1")), NativeSqliteSession.Failure.CLOSED);
            await(fixture.session.dispose(fixture.epoch));
            assertTrue(fixture.session.isDrained());
            try (SQLiteDatabase reopened = open(fixture.file); Cursor row = reopened.rawQuery("SELECT sum(visits) FROM record", null)) {
                assertTrue(row.moveToFirst()); assertEquals(0, row.getLong(0));
            }
        }
    }

    @Test public void treatsFailedCommitAsUnknownAndClosesThePoolBeforeReopening() throws Exception {
        try (Fixture fixture = new Fixture(db -> {
            db.execSQL("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
            db.execSQL("CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
        })) {
            String tx = await(fixture.session.request(json("operation", "begin", "connectionEpoch", fixture.epoch, "mode", "write"))).getString("transactionId");
            fixture.execute(tx, "INSERT INTO child VALUES (?, ?)", 1L, 404L);
            rejected(fixture.session.request(json("operation", "commit", "connectionEpoch", fixture.epoch, "transactionId", tx)), NativeSqliteSession.Failure.OUTCOME_UNKNOWN);
            assertTrue(fixture.session.isClosed()); assertFalse(fixture.session.isDrained());
            await(fixture.session.dispose(fixture.epoch));
            assertTrue(fixture.session.isDrained());
            try (SQLiteDatabase reopened = open(fixture.file); Cursor row = reopened.rawQuery("SELECT count(*) FROM child", null)) {
                assertTrue(row.moveToFirst()); assertEquals(0, row.getLong(0));
            }
        }
    }

    @Test public void boundsPendingAdmissionAndDoesNotAcknowledgeDrainWhileNativeWorkRuns() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        try (Fixture fixture = new Fixture(db -> {
            db.execSQL("CREATE TABLE record(id INTEGER PRIMARY KEY)");
            db.addCustomFunction("hold_native", 0, values -> {
                entered.countDown();
                try { if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("FIXTURE_TIMEOUT"); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IllegalStateException("FIXTURE_INTERRUPTED"); }
            });
        })) {
            CompletableFuture<JSONObject> executing = fixture.session.request(command(fixture.epoch, null, "SELECT hold_native()"));
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            List<CompletableFuture<JSONObject>> queued = new ArrayList<>();
            for (int index = 1; index < NativeSqliteSession.MAX_PENDING; index++) queued.add(fixture.session.request(command(fixture.epoch, null, "INSERT INTO record VALUES (?)", (long) index)));
            rejected(fixture.session.request(command(fixture.epoch, null, "SELECT 1")), NativeSqliteSession.Failure.QUEUE_FULL);
            CompletableFuture<JSONObject> disposed = fixture.session.dispose(fixture.epoch);
            assertTrue(fixture.session.isClosed()); assertFalse(fixture.session.isDrained()); assertFalse(disposed.isDone());
            release.countDown();
            await(executing); await(disposed);
            for (CompletableFuture<JSONObject> waiting : queued) rejected(waiting, NativeSqliteSession.Failure.CLOSED);
            assertTrue(fixture.session.isDrained());
            try (SQLiteDatabase reopened = open(fixture.file); Cursor row = reopened.rawQuery("SELECT count(*) FROM record", null)) {
                assertTrue(row.moveToFirst()); assertEquals(0, row.getLong(0));
            }
        } finally { release.countDown(); }
    }

    private static Fixture windowFixture() throws Exception {
        return new Fixture(db -> {
            db.execSQL("CREATE TABLE record(id INTEGER PRIMARY KEY, visits INTEGER NOT NULL, padding TEXT NOT NULL)");
            String padding = new String(new char[8192]).replace('\0', 'x');
            db.beginTransactionNonExclusive();
            try (SQLiteStatement insert = db.compileStatement("INSERT INTO record VALUES (?, 0, ?)")) {
                for (int index = 0; index < 256; index++) { insert.bindLong(1, index); insert.bindString(2, padding); insert.executeInsert(); }
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
        });
    }
    private interface Initialize { void apply(SQLiteDatabase db) throws Exception; }
    private static final class Fixture implements AutoCloseable {
        final File file;
        final NativeSqliteSession session;
        final String epoch;
        Fixture(Initialize initialize) throws Exception {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            file = File.createTempFile("session-", ".db", context.getNoBackupFilesDir());
            session = new NativeSqliteSession(() -> {
                SQLiteDatabase db = open(file);
                try { initialize.apply(db); return db; }
                catch (Exception failure) { db.close(); throw failure; }
            });
            epoch = session.ready().get(10, TimeUnit.SECONDS);
        }
        JSONObject execute(String tx, String sql, Object... values) throws Exception { return await(session.request(command(epoch, tx, sql, values))); }
        @Override public void close() throws Exception {
            await(session.dispose(epoch)); // Delete only after a confirmed native close.
            assertTrue(SQLiteDatabase.deleteDatabase(file));
        }
    }
    private static SQLiteDatabase open(File file) {
        return SQLiteDatabase.openDatabase(file.getAbsolutePath(), null,
            SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.CREATE_IF_NECESSARY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
    }
    private static JSONObject command(String epoch, String tx, String sql, Object... values) throws Exception {
        JSONArray args = new JSONArray(); for (Object value : values) args.put(NativeSqliteValues.encodeResultValue(value));
        return json("operation", "execute", "connectionEpoch", epoch, "transactionId", tx == null ? JSONObject.NULL : tx,
            "statement", json("sql", sql, "args", args));
    }
    private static JSONObject cell(JSONObject response, int index) throws Exception {
        return response.getJSONObject("result").getJSONArray("rows").getJSONArray(0).getJSONObject(index);
    }
    private static JSONObject json(Object... pairs) throws Exception {
        JSONObject result = new JSONObject();
        for (int index = 0; index < pairs.length; index += 2) result.put((String) pairs[index], pairs[index + 1]);
        return result;
    }
    private static <T> T await(CompletableFuture<T> value) throws Exception { return value.get(10, TimeUnit.SECONDS); }
    private static void rejected(CompletableFuture<?> value, NativeSqliteSession.Failure code) throws Exception {
        try { await(value); fail("Expected native failure"); }
        catch (ExecutionException rejected) {
            assertTrue(rejected.getCause() instanceof NativeSqliteSession.SessionException);
            NativeSqliteSession.SessionException failure = (NativeSqliteSession.SessionException) rejected.getCause();
            assertEquals(code, failure.code); assertEquals(code.name(), failure.getMessage()); assertNull(failure.getCause());
            assertFalse(failure.toString().contains("PRIVATE_CANARY"));
        }
    }
}
