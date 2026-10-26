package com.aervox.mobile;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.sqlite.database.sqlite.SQLiteDatabase;
import org.sqlite.database.sqlite.SQLiteException;

/** Actual Android contract for the generated target; never initializes an app business database. */
@RunWith(AndroidJUnit4.class)
public final class PortableSchemaArtifactTest {
    static { System.loadLibrary("sqliteX"); }
    private static final Pattern DEFINITION = Pattern.compile("^CREATE (?:UNIQUE )?(TABLE|INDEX) \"((?:[^\"]|\"\")*)\" ");

    @Test public void generatedMainSchemaIsAtomicAndMatchesPhysicalDefinitions() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        try (InputStream input = context.getAssets().open("aervox-schema-main.json")) {
            byte[] chunk = new byte[8192];
            for (int count; (count = input.read(chunk)) != -1;) {
                buffer.write(chunk, 0, count);
                assertTrue("Schema asset budget", buffer.size() <= 256 * 1024);
            }
        }
        JSONObject artifact = new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
        assertEquals(1, artifact.getInt("formatVersion"));
        assertEquals("main", artifact.getString("scope"));
        JSONObject initialization = artifact.getJSONObject("initialization");
        assertEquals("empty", initialization.getString("requiredDatabaseState"));
        JSONArray statements = initialization.getJSONArray("statements");
        assertTrue(statements.length() > 0);
        File directory = new File(context.getNoBackupFilesDir(), "schema-artifact-probes");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        File file = File.createTempFile("main-", ".db", directory);
        SQLiteDatabase db = null;
        try {
            db = portableDatabase(file);
            db.setForeignKeyConstraintsEnabled(true);
            assertEquals(0, objectCount(db));
            boolean rejected = false;
            db.beginTransaction();
            try {
                db.execSQL(statements.getString(0));
                db.execSQL(statements.getString(0));
            } catch (SQLiteException expected) { rejected = true; }
            finally { db.endTransaction(); }
            assertTrue(rejected);
            assertEquals(0, objectCount(db));
            db.beginTransaction();
            try {
                for (int index = 0; index < statements.length(); index++) db.execSQL(statements.getString(index));
                assertEquals(statements.length(), objectCount(db));
                for (int index = 0; index < statements.length(); index++) {
                    String expected = statements.getString(index);
                    Matcher definition = DEFINITION.matcher(expected);
                    assertTrue("Canonical definition", definition.find());
                    try (Cursor row = db.rawQuery("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
                            new String[]{definition.group(1).toLowerCase(java.util.Locale.ROOT), definition.group(2).replace("\"\"", "\"")})) {
                        assertTrue(row.moveToFirst());
                        assertEquals(expected, row.getString(0));
                        assertFalse(row.moveToNext());
                    }
                }
                assertTrue(db.isDatabaseIntegrityOk());
                try (Cursor violations = db.rawQuery("PRAGMA foreign_key_check", null)) { assertFalse(violations.moveToFirst()); }
                JSONObject journal = initialization.getJSONObject("journal"), parameters = journal.getJSONObject("parameters");
                assertEquals(artifact.getString("fingerprint"), parameters.getString("fingerprint"));
                db.execSQL(journal.getString("sql"), new Object[]{parameters.getString("scope"), parameters.getString("version"),
                        parameters.getString("fingerprint"), "2026-10-26T00:00:00.000Z"});
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            db.close(); db = portableDatabase(file);
            try (Cursor receipt = db.rawQuery("SELECT scope, version, fingerprint FROM _aervox_schema_versions", null)) {
                assertTrue(receipt.moveToFirst());
                assertEquals("main", receipt.getString(0));
                assertEquals(String.valueOf(artifact.getInt("schemaVersion")), receipt.getString(1));
                assertEquals(artifact.getString("fingerprint"), receipt.getString(2));
                assertFalse(receipt.moveToNext());
            }
        } finally {
            if (db != null) db.close();
            assertTrue("Probe cleanup", SQLiteDatabase.deleteDatabase(file));
        }
    }
    @Test public void defaultLocaleMetadataIsNotPartOfThePortableEmptySchema() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File file = File.createTempFile("locale-", ".db", context.getNoBackupFilesDir());
        try {
            try (SQLiteDatabase db = SQLiteDatabase.openOrCreateDatabase(file, null)) {
                assertEquals(1, objectCount(db));
                try (Cursor row = db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", null)) {
                    assertTrue(row.moveToFirst()); assertEquals("android_metadata", row.getString(0)); assertFalse(row.moveToNext());
                }
            }
            assertTrue(SQLiteDatabase.deleteDatabase(file));
            try (SQLiteDatabase db = portableDatabase(file)) { assertEquals(0, objectCount(db)); }
        } finally { assertTrue("Locale probe cleanup", SQLiteDatabase.deleteDatabase(file)); }
    }
    private static SQLiteDatabase portableDatabase(File file) {
        // The canonical schema uses explicit SQLite collations. Android locale
        // metadata must not be created before the required empty-state check.
        return SQLiteDatabase.openDatabase(file.getAbsolutePath(), null,
            SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.CREATE_IF_NECESSARY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
    }
    private static int objectCount(SQLiteDatabase db) {
        try (Cursor row = db.rawQuery("SELECT count(*) FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'", null)) {
            assertTrue(row.moveToFirst()); return row.getInt(0);
        }
    }
}
