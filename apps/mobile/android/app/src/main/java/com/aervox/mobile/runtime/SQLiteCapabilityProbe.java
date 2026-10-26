package com.aervox.mobile.runtime;

import android.content.Context;
import android.database.Cursor;
import java.io.File;
import java.io.IOException;
import org.json.JSONArray;
import org.sqlite.database.sqlite.SQLiteConstraintException;
import org.sqlite.database.sqlite.SQLiteDatabase;

/** Native capability check against an isolated disposable database, never a business path.
 * This is not a Capacitor plugin and exposes no SQL or database access to JavaScript.
 */
public final class SQLiteCapabilityProbe {
    static { System.loadLibrary("sqliteX"); }
    private SQLiteCapabilityProbe() {}

    public static final class Result {
        public final String engineVersion;
        public final boolean returning, jsonNul, fts5, foreignKeys, rollback, reopen;
        private Result(String version) {
            engineVersion = version;
            returning = jsonNul = fts5 = foreignKeys = rollback = reopen = true;
        }
    }

    public static Result run(Context context) throws Exception {
        File directory = new File(context.getNoBackupFilesDir(), "sqlite-capability-probes");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("SQLITE_PROBE_DIRECTORY_UNAVAILABLE");
        File file = File.createTempFile("probe-", ".db", directory);
        SQLiteDatabase db = null;
        try {
            db = SQLiteDatabase.openOrCreateDatabase(file, null);
            db.setForeignKeyConstraintsEnabled(true);
            String version = scalar(db, "SELECT sqlite_version()", null);
            require("3.54.1".equals(version));
            require("1".equals(scalar(db, "PRAGMA foreign_keys", null)));
            db.execSQL("CREATE TABLE probe_record (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
            db.execSQL("CREATE TABLE probe_child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES probe_record(id))");
            String nulText = "input\u0000尾";
            try (Cursor returned = db.rawQuery("INSERT INTO probe_record(id, body) VALUES (?, ?) RETURNING id, json_quote(body)", new String[]{"persisted", nulText})) {
                require(returned.moveToFirst());
                require("persisted".equals(returned.getString(0)));
                require(nulText.equals(new JSONArray("[" + returned.getString(1) + "]").getString(0)));
                require(!returned.moveToNext());
            }
            String json = scalar(db, "SELECT json_object('value', body) FROM probe_record WHERE id = 'persisted'", null);
            require(nulText.equals(new org.json.JSONObject(json).getString("value")));
            require("9".equals(scalar(db, "SELECT length(CAST(body AS BLOB)) FROM probe_record WHERE id = 'persisted'", null)));
            db.execSQL("CREATE VIRTUAL TABLE probe_fts USING fts5(body)");
            db.execSQL("INSERT INTO probe_fts(body) VALUES (?)", new Object[]{"capabilityneedle"});
            require("1".equals(scalar(db, "SELECT count(*) FROM probe_fts WHERE probe_fts MATCH ?", new String[]{"capabilityneedle"})));
            boolean rejected = false;
            try { db.execSQL("INSERT INTO probe_child(id, parent_id) VALUES ('orphan', 'missing')"); }
            catch (SQLiteConstraintException expected) { rejected = true; }
            require(rejected);
            boolean transactionRejected = false;
            db.beginTransaction();
            try {
                db.execSQL("INSERT INTO probe_record(id, body) VALUES ('rolled-back', 'discard')");
                db.execSQL("INSERT INTO probe_child(id, parent_id) VALUES ('rollback-child', 'rolled-back')");
                db.execSQL("INSERT INTO probe_record(id, body) VALUES ('rolled-back', 'duplicate')");
            } catch (SQLiteConstraintException expected) { transactionRejected = true; }
            finally { db.endTransaction(); }
            require(transactionRejected);
            require("0".equals(scalar(db, "SELECT count(*) FROM probe_record WHERE id = 'rolled-back'", null)));
            require("0".equals(scalar(db, "SELECT count(*) FROM probe_child", null)));
            db.close(); db = SQLiteDatabase.openOrCreateDatabase(file, null);
            require("1".equals(scalar(db, "SELECT count(*) FROM probe_record WHERE id = 'persisted'", null)));
            require("0".equals(scalar(db, "SELECT count(*) FROM probe_record WHERE id = 'rolled-back'", null)));
            require(db.isDatabaseIntegrityOk());
            return new Result(version);
        } finally {
            if (db != null) db.close();
            if (!SQLiteDatabase.deleteDatabase(file)) throw new IOException("SQLITE_PROBE_CLEANUP_FAILED");
        }
    }

    private static String scalar(SQLiteDatabase db, String sql, String[] args) {
        try (Cursor cursor = db.rawQuery(sql, args)) {
            require(cursor.moveToFirst());
            return cursor.getString(0);
        }
    }
    private static void require(boolean condition) {
        if (!condition) throw new IllegalStateException("SQLITE_CAPABILITY_PROBE_FAILED");
    }
}
