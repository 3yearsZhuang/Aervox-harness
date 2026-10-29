package com.aervox.mobile.runtime;

import android.content.Context;
import android.content.res.AssetManager;
import android.database.Cursor;
import android.os.Build;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.sqlite.database.sqlite.SQLiteDatabase;

/** Fixed app-private M0 database owner. This class is never registered on a
 * bridge and accepts neither paths nor schema from JavaScript. An existing
 * database must carry our durable initialization/identity receipt and match the
 * packaged release exactly. SQLite owns recovery of its rollback journal;
 * there is no adoption, repair, migration or automatic overwrite here.
 *
 * open() transfers the only database reference to NativeSqliteSession. The
 * separate process/file owner lock survives that transfer and can be released
 * only after the bound actor confirms that all accepted SQL has drained.
 */
final class NativeBusinessDatabase implements AutoCloseable {
    static { System.loadLibrary("sqliteX"); }
    enum Failure {
        CLOSED, ALREADY_OPENED, INVALID_BINDING, OWNER_BUSY, UNSAFE_PATH,
        ASSET_INVALID, ENGINE_MISMATCH, EXISTING_DATABASE_REJECTED,
        INITIALIZATION_FAILED, CLEANUP_UNCONFIRMED, DRAIN_REQUIRED
    }
    static final class DatabaseException extends IOException {
        final Failure code;
        DatabaseException(Failure code) { super(code.name()); this.code = code; }
    }
    private enum Phase { NEW, OPENING, TRANSFERRED, FAILED, CLOSED }
    private static final int MAX_ASSET_BYTES = 256 * 1024;
    private static final int APPLICATION_ID = 0x41455230;
    private final File root;
    private final AssetManager assets;
    private Phase phase = Phase.NEW;
    private NativeSqliteSession session;
    private FileOutputStream lockStream;
    private FileDescriptor lockDescriptor;
    private FileLock ownerLock;
    private boolean cleanupConfirmed = true;

    NativeBusinessDatabase(Context context) {
        if (context == null) throw new IllegalArgumentException("INVALID_CONTEXT");
        root = context.getNoBackupFilesDir();
        assets = context.getAssets();
    }

    synchronized void bindSession(NativeSqliteSession value) throws DatabaseException {
        if (value == null || session != null || phase == Phase.CLOSED) throw failure(Failure.INVALID_BINDING);
        session = value;
    }

    /** Call once, on the actor's worker. No database handle is retained here. */
    synchronized SQLiteDatabase open() throws DatabaseException {
        if (phase == Phase.CLOSED) throw failure(Failure.CLOSED);
        if (phase != Phase.NEW) throw failure(Failure.ALREADY_OPENED);
        phase = Phase.OPENING;
        File file = null;
        SQLiteDatabase database = null;
        boolean created = false, initialized = false, transferred = false;
        try {
            File directory = prepareDirectory();
            acquireOwner(new File(directory, "main.db.owner.lock"));
            file = new File(directory, "main.db");
            File receipt = new File(directory, "main.db.owner.json");
            requireRegularOrAbsent(file);
            requireRegularOrAbsent(receipt);
            requireAbsent(new File(file.getPath() + "-wal"));
            requireAbsent(new File(file.getPath() + "-shm"));
            Artifact artifact = readArtifact();
            List<String> physical;
            try (SQLiteDatabase canonical = memoryDatabase()) {
                verifyEngine(canonical);
                createSchema(canonical, artifact, false);
                physical = physicalSnapshot(canonical);
            }
            // createNewFile is the sole authority for the empty-state path.
            // A pre-existing empty file is an unknown database, not ours.
            if (stat(file) == null && stat(receipt) != null) throw failure(Failure.EXISTING_DATABASE_REJECTED);
            if (stat(file) == null) requireAbsent(new File(file.getPath() + "-journal"));
            created = file.createNewFile();
            if (!created) {
                requireRegularOrAbsent(file);
                if (file.length() == 0) throw failure(Failure.EXISTING_DATABASE_REJECTED);
                verifyOwnership(file, receipt, artifact);
                File journal = new File(file.getPath() + "-journal");
                requireRegularOrAbsent(journal);
                if (stat(journal) == null) {
                    // No recovery is needed: reject all structural mismatches
                    // before ever opening an existing database for writing.
                    try (SQLiteDatabase readonly = diskDatabase(file, true)) {
                        verifyExisting(readonly, artifact, physical);
                    }
                }
            }
            database = diskDatabase(file, false);
            verifyEngine(database);
            database.disableWriteAheadLogging();
            database.setForeignKeyConstraintsEnabled(true);
            if (created) {
                if (!masterRows(database).isEmpty()) throw failure(Failure.INITIALIZATION_FAILED);
                database.beginTransaction();
                try {
                    createSchema(database, artifact, true);
                    database.execSQL("PRAGMA application_id=" + APPLICATION_ID);
                    database.execSQL("PRAGMA user_version=" + artifact.schemaVersion);
                    verifyExisting(database, artifact, physical);
                    database.setTransactionSuccessful();
                } finally { database.endTransaction(); }
                initialized = true;
                database.close(); database = null;
                forceFile(file);
                publishOwnership(file, receipt, artifact);
                database = diskDatabase(file, false);
                database.disableWriteAheadLogging();
                database.setForeignKeyConstraintsEnabled(true);
            }
            // Recheck the writable connection too, before granting the actor
            // ownership. Only our lock-owning process may write this path.
            verifyExisting(database, artifact, physical);
            phase = Phase.TRANSFERRED;
            transferred = true;
            return database;
        } catch (Exception rejected) {
            phase = Phase.FAILED;
            if (rejected instanceof DatabaseException) throw (DatabaseException) rejected;
            DatabaseException bounded = failure(created ? Failure.INITIALIZATION_FAILED : Failure.EXISTING_DATABASE_REJECTED);
            bounded.initCause(rejected); throw bounded;
        } finally {
            if (!transferred) {
                try { if (database != null) database.close(); }
                catch (RuntimeException unknown) { cleanupConfirmed = false; }
                if (created && !initialized && cleanupConfirmed && file != null) {
                    try { if (!SQLiteDatabase.deleteDatabase(file)) cleanupConfirmed = false; }
                    catch (RuntimeException unknown) { cleanupConfirmed = false; }
                }
            }
        }
    }

    @Override public synchronized void close() throws DatabaseException {
        if (phase == Phase.CLOSED) return;
        if (!cleanupConfirmed) throw failure(Failure.CLEANUP_UNCONFIRMED);
        if (ownerLock != null && (session == null && phase == Phase.TRANSFERRED
                || session != null && !session.isDrained())) throw failure(Failure.DRAIN_REQUIRED);
        try {
            if (ownerLock != null) { ownerLock.release(); ownerLock = null; }
            if (lockStream != null) { lockStream.close(); lockStream = null; }
            // Android's FileOutputStream(FileDescriptor) does not own/close
            // the descriptor supplied by Os.open().
            if (lockDescriptor != null) {
                if (lockDescriptor.valid()) Os.close(lockDescriptor);
                lockDescriptor = null;
            }
            phase = Phase.CLOSED;
        } catch (Exception unknown) { throw failure(Failure.CLEANUP_UNCONFIRMED); }
    }

    private File prepareDirectory() throws Exception {
        File canonicalRoot = root.getCanonicalFile();
        if (!canonicalRoot.isDirectory()) throw failure(Failure.UNSAFE_PATH);
        File directory = new File(canonicalRoot, "aervox-m0");
        StructStat before = stat(directory);
        if (before == null) {
            if (!directory.mkdir() && stat(directory) == null) throw failure(Failure.UNSAFE_PATH);
        }
        StructStat current = stat(directory);
        if (current == null || !OsConstants.S_ISDIR(current.st_mode)
                || !directory.equals(directory.getCanonicalFile())) throw failure(Failure.UNSAFE_PATH);
        return directory;
    }

    private void acquireOwner(File file) throws Exception {
        requireRegularOrAbsent(file);
        FileDescriptor descriptor = openDescriptor(file,
            OsConstants.O_RDWR | OsConstants.O_CREAT | OsConstants.O_NOFOLLOW, 0600);
        FileOutputStream stream = new FileOutputStream(descriptor);
        try {
            StructStat info = Os.fstat(descriptor);
            if (!OsConstants.S_ISREG(info.st_mode) || info.st_nlink != 1) throw failure(Failure.UNSAFE_PATH);
            FileLock lock;
            try { lock = stream.getChannel().tryLock(); }
            catch (OverlappingFileLockException busy) { throw failure(Failure.OWNER_BUSY); }
            if (lock == null) throw failure(Failure.OWNER_BUSY);
            lockStream = stream;
            lockDescriptor = descriptor;
            ownerLock = lock;
        } finally {
            if (lockStream != stream) {
                try { stream.close(); }
                finally { if (descriptor.valid()) Os.close(descriptor); }
            }
        }
    }

    private static void requireRegularOrAbsent(File file) throws Exception {
        StructStat info = stat(file);
        if (info != null && (!OsConstants.S_ISREG(info.st_mode) || info.st_nlink != 1)) throw failure(Failure.UNSAFE_PATH);
    }
    private static void requireAbsent(File file) throws Exception {
        if (stat(file) != null) throw failure(Failure.EXISTING_DATABASE_REJECTED);
    }
    private static StructStat stat(File file) throws Exception {
        try { return Os.lstat(file.getAbsolutePath()); }
        catch (ErrnoException missing) { if (missing.errno == OsConstants.ENOENT) return null; throw missing; }
    }

    /** Ownership is local to this app-private directory and a stable DB inode.
     * It is not authentication against arbitrary same-UID/root modification.
     * Rollback journals have no DB UUID; once this ownership is established,
     * their hot/cold classification and recovery belong solely to SQLite.
     */
    private static void verifyOwnership(File file, File receipt, Artifact artifact) throws Exception {
        requireRegularOrAbsent(receipt);
        if (stat(receipt) == null || receipt.length() > 2048) throw failure(Failure.EXISTING_DATABASE_REJECTED);
        JSONObject record;
        try (FileInputStream input = new FileInputStream(receipt)) {
            byte[] bytes = new byte[2049];
            int size = 0, count;
            while ((count = input.read(bytes, size, bytes.length - size)) > 0) {
                size += count;
                if (size > 2048) throw failure(Failure.EXISTING_DATABASE_REJECTED);
            }
            record = new JSONObject(new String(bytes, 0, size, StandardCharsets.UTF_8));
        }
        StructStat info = Os.lstat(file.getAbsolutePath());
        if (record.length() != 7 || record.getInt("formatVersion") != 1
                || !UUID.fromString(record.getString("identity")).toString().equals(record.getString("identity"))
                || !Long.toString(info.st_dev).equals(record.getString("device"))
                || !Long.toString(info.st_ino).equals(record.getString("inode"))
                || record.getInt("schemaVersion") != artifact.schemaVersion
                || !artifact.fingerprint.equals(record.getString("fingerprint"))
                || record.getInt("applicationId") != APPLICATION_ID) throw failure(Failure.EXISTING_DATABASE_REJECTED);
        byte[] header = new byte[100];
        try (FileInputStream input = new FileInputStream(file)) {
            int size = 0, count;
            while (size < header.length && (count = input.read(header, size, header.length - size)) > 0) size += count;
            if (size != header.length) throw failure(Failure.EXISTING_DATABASE_REJECTED);
        }
        byte[] signature = "SQLite format 3\0".getBytes(StandardCharsets.US_ASCII);
        for (int index = 0; index < signature.length; index++) {
            if (header[index] != signature[index]) throw failure(Failure.EXISTING_DATABASE_REJECTED);
        }
        if (ByteBuffer.wrap(header).getInt(68) != APPLICATION_ID
                || ByteBuffer.wrap(header).getInt(60) != artifact.schemaVersion) throw failure(Failure.EXISTING_DATABASE_REJECTED);
    }

    private static void publishOwnership(File file, File receipt, Artifact artifact) throws Exception {
        StructStat info = Os.lstat(file.getAbsolutePath());
        JSONObject record = new JSONObject().put("formatVersion", 1).put("identity", UUID.randomUUID().toString())
            .put("device", Long.toString(info.st_dev)).put("inode", Long.toString(info.st_ino))
            .put("schemaVersion", artifact.schemaVersion).put("fingerprint", artifact.fingerprint)
            .put("applicationId", APPLICATION_ID);
        // Android SELinux can deny hardlink publication even in app-private
        // directories. O_EXCL never replaces an existing ownership receipt.
        // The process/file lock excludes other readers until the complete record
        // and parent directory are durable. A crash leaves an invalid receipt
        // which is preserved and refused, never guessed into ownership.
        FileDescriptor descriptor = openDescriptor(receipt, OsConstants.O_WRONLY
            | OsConstants.O_CREAT | OsConstants.O_EXCL | OsConstants.O_NOFOLLOW, 0600);
        try {
            FileOutputStream output = new FileOutputStream(descriptor);
            output.write(record.toString().getBytes(StandardCharsets.UTF_8));
            output.flush(); Os.fsync(descriptor);
        } finally { Os.close(descriptor); }
        forceDirectory(file.getParentFile());
    }

    private static void forceFile(File file) throws Exception {
        FileDescriptor descriptor = openDescriptor(file, OsConstants.O_RDWR | OsConstants.O_NOFOLLOW, 0);
        try { Os.fsync(descriptor); }
        finally { Os.close(descriptor); }
    }
    private static void forceDirectory(File directory) throws Exception {
        FileDescriptor descriptor = openDescriptor(directory,
            OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW, 0);
        try {
            if (!OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode)) throw failure(Failure.UNSAFE_PATH);
            Os.fsync(descriptor);
        }
        finally { Os.close(descriptor); }
    }

    private static FileDescriptor openDescriptor(File file, int flags, int mode) throws Exception {
        // O_CLOEXEC is a stable bionic/Linux ABI flag for this APK's four ABIs.
        // Its Java name was added in API 27; Os.fcntlInt needs API 30. Use the
        // same atomic open flag on API 24-26, without hidden API reflection.
        // https://android.googlesource.com/platform/bionic/+/6861c6f/libc/include/fcntl.h
        int closeOnExec = Build.VERSION.SDK_INT >= 27 ? OsConstants.O_CLOEXEC : 02000000;
        return Os.open(file.getAbsolutePath(), flags | closeOnExec, mode);
    }

    private Artifact readArtifact() throws DatabaseException {
        try (InputStream input = assets.open("aervox-schema-main.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            for (int count; (count = input.read(chunk)) != -1;) {
                bytes.write(chunk, 0, count);
                if (bytes.size() > MAX_ASSET_BYTES) throw failure(Failure.ASSET_INVALID);
            }
            return new Artifact(new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8)));
        } catch (Exception rejected) { throw failure(Failure.ASSET_INVALID); }
    }

    private static final class Artifact {
        final JSONArray statements, projections;
        final String version, fingerprint, journal;
        final int schemaVersion;
        Artifact(JSONObject value) throws Exception {
            if (value.getInt("formatVersion") != 1 || !"main".equals(value.getString("scope"))
                    || value.getInt("schemaVersion") < 1) throw failure(Failure.ASSET_INVALID);
            version = Integer.toString(value.getInt("schemaVersion"));
            schemaVersion = value.getInt("schemaVersion");
            fingerprint = value.getString("fingerprint");
            if (!fingerprint.matches("[a-f0-9]{64}")) throw failure(Failure.ASSET_INVALID);
            JSONObject initialization = value.getJSONObject("initialization");
            if (!"empty".equals(initialization.getString("requiredDatabaseState"))) throw failure(Failure.ASSET_INVALID);
            statements = initialization.getJSONArray("statements");
            JSONObject receipt = initialization.getJSONObject("journal"), parameters = receipt.getJSONObject("parameters");
            if (!"main".equals(parameters.getString("scope")) || !version.equals(parameters.getString("version"))
                    || !fingerprint.equals(parameters.getString("fingerprint"))) throw failure(Failure.ASSET_INVALID);
            journal = receipt.getString("sql");
            JSONArray runtime = receipt.getJSONArray("requiredRuntimeParameters");
            if (runtime.length() != 1 || !"applied_at".equals(runtime.getString(0))) throw failure(Failure.ASSET_INVALID);
            JSONObject projection = value.getJSONObject("projections");
            if (!projection.getBoolean("rebuildable")) throw failure(Failure.ASSET_INVALID);
            projections = projection.getJSONArray("statements");
            if (statements.length() == 0 || statements.length() > 1024 || projections.length() > 16)
                throw failure(Failure.ASSET_INVALID);
        }
    }

    private static SQLiteDatabase memoryDatabase() {
        return SQLiteDatabase.openDatabase(":memory:", null,
            SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.CREATE_IF_NECESSARY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
    }
    private static SQLiteDatabase diskDatabase(File file, boolean readonly) {
        return SQLiteDatabase.openDatabase(file.getAbsolutePath(), null,
            (readonly ? SQLiteDatabase.OPEN_READONLY : SQLiteDatabase.OPEN_READWRITE) | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
    }
    private static void verifyEngine(SQLiteDatabase database) throws DatabaseException {
        try (Cursor row = database.rawQuery("SELECT sqlite_version()", null)) {
            if (!row.moveToFirst() || !"3.54.1".equals(row.getString(0)) || row.moveToNext()) throw failure(Failure.ENGINE_MISMATCH);
        }
    }
    private static void createSchema(SQLiteDatabase database, Artifact artifact, boolean receipt) throws Exception {
        for (int index = 0; index < artifact.statements.length(); index++) database.execSQL(artifact.statements.getString(index));
        for (int index = 0; index < artifact.projections.length(); index++) database.execSQL(artifact.projections.getString(index));
        if (receipt) {
            // java.time.Instant needs API 26 without core-library desugaring.
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));
            database.execSQL(artifact.journal, new Object[]{"main", artifact.version, artifact.fingerprint, format.format(new Date())});
        }
    }
    private static void verifyExisting(SQLiteDatabase database, Artifact artifact, List<String> expected) throws Exception {
        verifyEngine(database);
        try (Cursor row = database.rawQuery("PRAGMA application_id", null)) {
            if (!row.moveToFirst() || row.getInt(0) != APPLICATION_ID || row.moveToNext()) throw failure(Failure.EXISTING_DATABASE_REJECTED);
        }
        try (Cursor row = database.rawQuery("PRAGMA user_version", null)) {
            if (!row.moveToFirst() || row.getInt(0) != artifact.schemaVersion || row.moveToNext()) throw failure(Failure.EXISTING_DATABASE_REJECTED);
        }
        if (!expected.equals(physicalSnapshot(database))) throw failure(Failure.EXISTING_DATABASE_REJECTED);
        try (Cursor row = database.rawQuery("SELECT scope,version,fingerprint,applied_at FROM _aervox_schema_versions", null)) {
            if (!row.moveToFirst() || !"main".equals(row.getString(0)) || !artifact.version.equals(row.getString(1))
                    || !artifact.fingerprint.equals(row.getString(2)) || row.isNull(3) || row.getString(3).isEmpty()
                    || row.moveToNext()) throw failure(Failure.EXISTING_DATABASE_REJECTED);
        }
        try (Cursor row = database.rawQuery("PRAGMA integrity_check(1)", null)) {
            if (!row.moveToFirst() || !"ok".equals(row.getString(0)) || row.moveToNext()) throw failure(Failure.EXISTING_DATABASE_REJECTED);
        }
        try (Cursor row = database.rawQuery("PRAGMA foreign_key_check", null)) {
            if (row.moveToFirst()) throw failure(Failure.EXISTING_DATABASE_REJECTED);
        }
    }

    /** Compare the canonical engine's parsed physical structures, including
     * hidden/generated columns, auto-indexes, foreign keys and FTS shadows.
     * Exact sqlite_master text is intentionally conservative for this prototype.
     */
    private static List<String> physicalSnapshot(SQLiteDatabase database) throws Exception {
        List<String> result = masterRows(database);
        List<String> tables = names(database, "table"), indexes = names(database, "index");
        for (String table : tables) {
            result.add("table_xinfo:" + table);
            result.addAll(rows(database, "PRAGMA table_xinfo(" + quote(table) + ")"));
            result.add("foreign_key_list:" + table);
            result.addAll(rows(database, "PRAGMA foreign_key_list(" + quote(table) + ")"));
            result.add("index_list:" + table);
            result.addAll(rows(database, "PRAGMA index_list(" + quote(table) + ")"));
        }
        for (String index : indexes) {
            result.add("index_xinfo:" + index);
            result.addAll(rows(database, "PRAGMA index_xinfo(" + quote(index) + ")"));
        }
        return result;
    }
    private static String quote(String value) { return "'" + value.replace("'", "''") + "'"; }
    private static List<String> names(SQLiteDatabase database, String type) throws Exception {
        List<String> result = new ArrayList<>();
        try (Cursor cursor = database.rawQuery("SELECT name FROM sqlite_master WHERE type=? ORDER BY name", new String[]{type})) {
            while (cursor.moveToNext()) {
                if (result.size() >= 2048) throw failure(Failure.EXISTING_DATABASE_REJECTED);
                result.add(cursor.getString(0));
            }
        }
        return result;
    }
    private static List<String> masterRows(SQLiteDatabase database) throws Exception {
        return rows(database, "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name");
    }
    private static List<String> rows(SQLiteDatabase database, String sql) throws Exception {
        List<String> result = new ArrayList<>();
        try (Cursor cursor = database.rawQuery(sql, null)) {
            while (cursor.moveToNext()) {
                if (result.size() >= 4096 || cursor.getColumnCount() > 32) throw failure(Failure.EXISTING_DATABASE_REJECTED);
                JSONArray row = new JSONArray();
                for (int index = 0; index < cursor.getColumnCount(); index++) {
                    switch (cursor.getType(index)) {
                        case Cursor.FIELD_TYPE_NULL: row.put(JSONObject.NULL); break;
                        case Cursor.FIELD_TYPE_INTEGER: row.put(cursor.getLong(index)); break;
                        case Cursor.FIELD_TYPE_STRING: row.put(cursor.getString(index)); break;
                        default: throw failure(Failure.EXISTING_DATABASE_REJECTED);
                    }
                }
                result.add(row.toString());
            }
        }
        return result;
    }
    private static DatabaseException failure(Failure code) { return new DatabaseException(code); }
}
