package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.database.Cursor;
import android.system.Os;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.sqlite.database.sqlite.SQLiteDatabase;

/** Each case substitutes a unique no-backup root. No test opens, deletes or
 * adopts the app's actual aervox-m0 business directory. */
@RunWith(AndroidJUnit4.class)
public final class NativeBusinessDatabaseTest {
    static { System.loadLibrary("sqliteX"); }

    @Test public void initializesOneReleaseAndPersistsOrdinarySessionRowsAcrossOwners() throws Exception {
        try (Fixture fixture = new Fixture()) {
            try (Owner first = fixture.open()) {
                first.execute("INSERT INTO sessions(id,title,created_at,updated_at) VALUES (?,?,?,?)",
                    "persisted", "手机会话\0尾", "2026-10-27T00:00:00Z", "2026-10-27T00:00:00Z");
                assertEquals("1", first.scalar("SELECT count(*) FROM _aervox_schema_versions"));
                assertEquals("1", first.scalar("SELECT count(*) FROM sessions"));
                assertEquals("0", first.scalar("SELECT count(*) FROM sqlite_master WHERE name='android_metadata'"));
                assertEquals("2", first.scalar("SELECT count(*) FROM sqlite_master WHERE name IN ('messages_fts','memories_fts')"));
            }
            try (Owner second = fixture.open()) {
                assertEquals("1", second.scalar("SELECT count(*) FROM sessions WHERE id='persisted'"));
                assertEquals("\"手机会话\\u0000尾\"", second.scalar("SELECT json_quote(title) FROM sessions WHERE id='persisted'"));
            }
        }
    }

    @Test public void refusesExistingEmptyFilesWithoutInitializingOrDeletingThem() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.directory();
            assertTrue(fixture.file().createNewFile());
            fixture.rejected(NativeBusinessDatabase.Failure.EXISTING_DATABASE_REJECTED);
            assertTrue(fixture.file().isFile());
            assertEquals(0, fixture.file().length());
        }
    }

    @Test public void refusesAnUnknownDatabaseAndPreservesItsExactBytesAndRows() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.directory();
            try (SQLiteDatabase db = direct(fixture.file(), true)) {
                db.execSQL("CREATE TABLE private_unknown(id INTEGER PRIMARY KEY, value TEXT)");
                db.execSQL("INSERT INTO private_unknown VALUES (1, 'PRIVATE_CANARY')");
            }
            byte[] before = read(fixture.file());
            fixture.rejected(NativeBusinessDatabase.Failure.EXISTING_DATABASE_REJECTED);
            assertArrayEquals(before, read(fixture.file()));
            try (SQLiteDatabase db = direct(fixture.file(), false);
                    Cursor row = db.rawQuery("SELECT value FROM private_unknown", null)) {
                assertTrue(row.moveToFirst()); assertEquals("PRIVATE_CANARY", row.getString(0));
            }
        }
    }

    @Test public void rejectsExtraTablesTriggersAndRemovedIndexesWithoutRepair() throws Exception {
        for (String mutation : new String[]{"CREATE TABLE unexpected(id TEXT)",
                "CREATE TRIGGER unexpected AFTER INSERT ON sessions BEGIN SELECT 1; END",
                "DROP INDEX turns_session_idx"}) {
            try (Fixture fixture = new Fixture()) {
                try (Owner owner = fixture.open()) { owner.execute("SELECT 1"); }
                try (SQLiteDatabase db = direct(fixture.file(), false)) { db.execSQL(mutation); }
                byte[] before = read(fixture.file());
                fixture.rejected(NativeBusinessDatabase.Failure.EXISTING_DATABASE_REJECTED);
                assertArrayEquals(before, read(fixture.file()));
            }
        }
    }

    @Test public void rejectsMissingAndMismatchedReleaseReceiptsWithoutRestamping() throws Exception {
        for (String mutation : new String[]{"DELETE FROM _aervox_schema_versions",
                "UPDATE _aervox_schema_versions SET fingerprint='unknown'",
                "INSERT INTO _aervox_schema_versions VALUES ('ledger','1','unknown','2026-10-27')"}) {
            try (Fixture fixture = new Fixture()) {
                try (Owner owner = fixture.open()) { owner.execute("SELECT 1"); }
                try (SQLiteDatabase db = direct(fixture.file(), false)) { db.execSQL(mutation); }
                byte[] before = read(fixture.file());
                fixture.rejected(NativeBusinessDatabase.Failure.EXISTING_DATABASE_REJECTED);
                assertArrayEquals(before, read(fixture.file()));
            }
        }
    }

    @Test public void retainsExclusiveOwnerUntilTheActorHasConfirmedDrain() throws Exception {
        try (Fixture fixture = new Fixture()) {
            Owner first = fixture.open();
            try {
                try { first.database.close(); fail("The live actor still owns the database"); }
                catch (NativeBusinessDatabase.DatabaseException rejected) {
                    assertEquals(NativeBusinessDatabase.Failure.DRAIN_REQUIRED, rejected.code);
                }
                fixture.rejected(NativeBusinessDatabase.Failure.OWNER_BUSY);
                assertEquals("1", first.scalar("SELECT 1"));
            } finally { first.close(); }
            try (Owner replacement = fixture.open()) { assertEquals("1", replacement.scalar("SELECT 1")); }
        }
    }

    @Test public void refusesSymlinksAndHardlinksInsteadOfFollowingOtherAppPrivateFiles() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.directory();
            File target = new File(fixture.root, "canary");
            try (FileOutputStream output = new FileOutputStream(target)) { output.write(new byte[]{1, 2, 3}); }
            Os.symlink(target.getAbsolutePath(), fixture.file().getAbsolutePath());
            fixture.rejected(NativeBusinessDatabase.Failure.UNSAFE_PATH);
            assertArrayEquals(new byte[]{1, 2, 3}, read(target));
            assertTrue(fixture.file().delete());
            try {
                Os.link(target.getAbsolutePath(), fixture.file().getAbsolutePath());
                fixture.rejected(NativeBusinessDatabase.Failure.UNSAFE_PATH);
            } catch (android.system.ErrnoException denied) {
                // Some Android SELinux policies forbid hardlinks altogether.
                // The OS has then rejected the attack before our opener runs.
                assertTrue(denied.errno == android.system.OsConstants.EACCES || denied.errno == android.system.OsConstants.EPERM);
                assertFalse(fixture.file().exists());
            }
            assertArrayEquals(new byte[]{1, 2, 3}, read(target));
        }
    }

    @Test public void preservesUnknownDatabaseSidecarsInsteadOfAdoptingTheirContents() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.directory();
            try (SQLiteDatabase db = direct(fixture.file(), true)) { db.execSQL("CREATE TABLE unknown(id INTEGER)"); }
            File sidecar = new File(fixture.file().getPath() + "-journal");
            try (FileOutputStream output = new FileOutputStream(sidecar)) { output.write(new byte[]{4, 5, 6}); }
            byte[] before = read(fixture.file());
            fixture.rejected(NativeBusinessDatabase.Failure.EXISTING_DATABASE_REJECTED);
            assertArrayEquals(before, read(fixture.file()));
            assertArrayEquals(new byte[]{4, 5, 6}, read(sidecar));
        }
    }

    @Test public void rejectsForeignWalStateEvenForAnOwnedRollbackDatabase() throws Exception {
        for (String suffix : new String[]{"-wal", "-shm"}) {
            try (Fixture fixture = new Fixture()) {
                try (Owner owner = fixture.open()) { owner.execute("SELECT 1"); }
                File sidecar = new File(fixture.file().getPath() + suffix);
                try (FileOutputStream output = new FileOutputStream(sidecar)) { output.write(new byte[]{4, 5, 6}); }
                byte[] before = read(fixture.file());
                fixture.rejected(NativeBusinessDatabase.Failure.EXISTING_DATABASE_REJECTED);
                assertArrayEquals(before, read(fixture.file()));
                assertArrayEquals(new byte[]{4, 5, 6}, read(sidecar));
            }
        }
    }

    @Test public void neverAdoptsACompleteSchemaWhenItsExternalInitializationReceiptIsMissingOrCopied() throws Exception {
        try (Fixture fixture = new Fixture()) {
            try (Owner owner = fixture.open()) { owner.execute("SELECT 1"); }
            File receipt = new File(fixture.file().getParentFile(), "main.db.owner.json");
            byte[] before = read(fixture.file());
            byte[] marker = read(receipt);
            assertTrue(receipt.delete());
            fixture.rejected(NativeBusinessDatabase.Failure.EXISTING_DATABASE_REJECTED);
            assertArrayEquals(before, read(fixture.file()));
            assertFalse(receipt.exists());
            try (FileOutputStream output = new FileOutputStream(receipt)) { output.write(marker); }
            // Same schema/bytes in a replacement inode is still an unknown DB.
            File replacement = new File(fixture.file().getParentFile(), "replacement.db");
            try (FileOutputStream output = new FileOutputStream(replacement)) { output.write(before); }
            assertTrue(fixture.file().delete());
            assertTrue(replacement.renameTo(fixture.file()));
            fixture.rejected(NativeBusinessDatabase.Failure.EXISTING_DATABASE_REJECTED);
            assertArrayEquals(before, read(fixture.file()));
        }
    }

    @Test public void letsSQLiteRecoverAnOwnedHotJournalWithoutReplayingUncommittedRows() throws Exception {
        try (Fixture fixture = new Fixture()) {
            try (Owner owner = fixture.open()) {
                owner.execute("INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('stable','committed','now','now')");
            }
            File journal = new File(fixture.file().getPath() + "-journal");
            byte[] interruptedDatabase, interruptedJournal;
            try (SQLiteDatabase db = direct(fixture.file(), false)) {
                db.execSQL("PRAGMA cache_size=1");
                db.execSQL("PRAGMA cache_spill=ON");
                db.beginTransaction();
                try {
                    String large = new String(new char[8192]).replace('\0', 'x');
                    for (int index = 0; index < 64; index++) {
                        db.execSQL("INSERT INTO sessions(id,title,created_at,updated_at) VALUES (?,?,?,?)",
                            new Object[]{"uncommitted-" + index, large, "now", "now"});
                    }
                    // Snapshot the exact native pager state after cache spill,
                    // before rollback. Restore these bytes into the same inode
                    // to simulate a power-loss image, never a production file.
                    interruptedDatabase = read(fixture.file());
                    interruptedJournal = read(journal);
                    assertTrue(interruptedJournal.length > 512);
                    assertArrayEquals(new byte[]{(byte) 0xd9, (byte) 0xd5, 0x05, (byte) 0xf9, 0x20, (byte) 0xa1, 0x63, (byte) 0xd7},
                        java.util.Arrays.copyOf(interruptedJournal, 8));
                } finally { db.endTransaction(); }
            }
            try (FileOutputStream output = new FileOutputStream(fixture.file())) {
                output.write(interruptedDatabase); output.getFD().sync();
            }
            try (FileOutputStream output = new FileOutputStream(journal)) {
                output.write(interruptedJournal); output.getFD().sync();
            }
            try (Owner recovered = fixture.open()) {
                assertEquals("1", recovered.scalar("SELECT count(*) FROM sessions"));
                assertEquals("committed", recovered.scalar("SELECT title FROM sessions WHERE id='stable'"));
                assertEquals("0", recovered.scalar("SELECT count(*) FROM sessions WHERE id LIKE 'uncommitted-%'"));
            }
            assertFalse("SQLite, rather than this initializer, retires the recovered journal", journal.exists());
        }
    }

    @Test public void letsSQLiteClassifyAnOwnedColdJournalAfterInterruptedFirstWrite() throws Exception {
        try (Fixture fixture = new Fixture()) {
            try (Owner owner = fixture.open()) { owner.execute("SELECT 1"); }
            File journal = new File(fixture.file().getPath() + "-journal");
            try (FileOutputStream output = new FileOutputStream(journal)) { output.write(new byte[512]); output.getFD().sync(); }
            try (Owner reopened = fixture.open()) {
                assertEquals("1", reopened.scalar("SELECT count(*) FROM _aervox_schema_versions"));
                reopened.execute("INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('after-cold','ready','now','now')");
                assertEquals("1", reopened.scalar("SELECT count(*) FROM sessions"));
            }
        }
    }

    private static final class Fixture implements AutoCloseable {
        final File root;
        final Context context;
        Fixture() throws Exception {
            Context application = InstrumentationRegistry.getInstrumentation().getTargetContext();
            root = File.createTempFile("business-database-test-", "", application.getNoBackupFilesDir());
            assertTrue(root.delete()); assertTrue(root.mkdir());
            context = new ContextWrapper(application) { @Override public File getNoBackupFilesDir() { return root; } };
        }
        void directory() { assertTrue(new File(root, "aervox-m0").isDirectory() || new File(root, "aervox-m0").mkdir()); }
        File file() { return new File(root, "aervox-m0/main.db"); }
        Owner open() throws Exception { return new Owner(context); }
        void rejected(NativeBusinessDatabase.Failure expected) throws Exception {
            NativeBusinessDatabase database = new NativeBusinessDatabase(context);
            NativeSqliteSession actor = new NativeSqliteSession(database::open);
            database.bindSession(actor);
            try { actor.ready().get(15, TimeUnit.SECONDS); fail("Expected rejected database"); }
            catch (ExecutionException rejected) {
                // The actor intentionally does not expose initializer errors to
                // JS. Reopen directly below to inspect the fixed native reason.
                assertTrue(rejected.getCause() instanceof NativeSqliteSession.SessionException);
            } finally {
                actor.close(); awaitDrain(actor); database.close();
            }
            // Verify the native classification without granting any SQL handle.
            try (NativeBusinessDatabase check = new NativeBusinessDatabase(context)) {
                try { SQLiteDatabase unexpected = check.open(); unexpected.close(); fail("Expected native rejection"); }
                catch (NativeBusinessDatabase.DatabaseException rejected) {
                    assertEquals(expected, rejected.code);
                    assertEquals(expected.name(), rejected.getMessage());
                    assertNull(rejected.getCause());
                }
            }
        }
        @Override public void close() throws Exception { remove(root); }
    }
    private static final class Owner implements AutoCloseable {
        final NativeBusinessDatabase database;
        final NativeSqliteSession actor;
        final String epoch;
        Owner(Context context) throws Exception {
            database = new NativeBusinessDatabase(context);
            actor = new NativeSqliteSession(database::open);
            database.bindSession(actor);
            String opened;
            try { opened = actor.ready().get(15, TimeUnit.SECONDS); }
            catch (Exception rejected) { actor.close(); awaitDrain(actor); database.close(); throw rejected; }
            epoch = opened;
        }
        JSONObject execute(String sql, Object... values) throws Exception {
            JSONArray args = new JSONArray();
            for (Object value : values) args.put(NativeSqliteValues.encodeResultValue(value));
            return actor.request(new JSONObject().put("operation", "execute").put("connectionEpoch", epoch)
                .put("transactionId", JSONObject.NULL)
                .put("statement", new JSONObject().put("sql", sql).put("args", args))).get(10, TimeUnit.SECONDS);
        }
        String scalar(String sql) throws Exception {
            return execute(sql).getJSONObject("result").getJSONArray("rows").getJSONArray(0).getJSONObject(0).getString("value");
        }
        @Override public void close() throws Exception {
            actor.dispose(epoch).get(10, TimeUnit.SECONDS);
            assertTrue(actor.isDrained());
            database.close();
        }
    }
    private static void awaitDrain(NativeSqliteSession actor) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!actor.isDrained() && System.nanoTime() < deadline) Thread.sleep(10);
        assertTrue("Native initializer/worker cleanup must finish", actor.isDrained());
    }
    private static SQLiteDatabase direct(File file, boolean create) {
        return SQLiteDatabase.openDatabase(file.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE
            | SQLiteDatabase.NO_LOCALIZED_COLLATORS | (create ? SQLiteDatabase.CREATE_IF_NECESSARY : 0));
    }
    private static byte[] read(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int count; (count = input.read(buffer)) != -1;) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }
    private static void remove(File file) throws Exception {
        if (java.nio.file.Files.isSymbolicLink(file.toPath())) { assertTrue(file.delete()); return; }
        File[] children = file.listFiles();
        if (children != null) for (File child : children) remove(child);
        assertTrue(file.delete());
    }
}
