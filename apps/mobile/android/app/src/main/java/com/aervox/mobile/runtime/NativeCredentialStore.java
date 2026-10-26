package com.aervox.mobile.runtime;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.system.Os;
import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Native-only encrypted credential primitive. No JavaScript bridge, external path,
 * arbitrary alias, network call or business database is exposed by this class.
 * Callers own returned plaintext buffers and must erase them after use.
 */
public final class NativeCredentialStore {
    public enum Slot {
        PRIMARY_MODEL("primary-model");
        final String id;
        Slot(String value) { id = value; }
    }
    public enum Failure {
        INVALID_INPUT, STORAGE_UNAVAILABLE, KEY_UNAVAILABLE,
        RECORD_INVALID, RECOVERY_REQUIRED, CRYPTO_UNAVAILABLE, WRITE_FAILED
    }
    public static final class CredentialException extends Exception {
        public final Failure failure;
        private CredentialException(Failure value) { super(value.name()); failure = value; }
    }
    private interface Operation<T> { T run() throws CredentialException; }
    interface BeforeCommit { void run() throws IOException; }
    private static final Object PROCESS_LOCK = new Object();
    private static final byte[] MAGIC = "AVXKEY01".getBytes(StandardCharsets.US_ASCII);
    private static final int VERSION = 1, NONCE_BYTES = 12, TAG_BITS = 128, MAX_SECRET_BYTES = 8192;
    private static final int MAX_RECORD_BYTES = MAGIC.length + 4 + 1 + 4 + NONCE_BYTES + MAX_SECRET_BYTES + 16;
    private static final String ALIAS_PREFIX = "com.aervox.mobile.native-credentials.v1.";
    private final File directory;
    private final String aliasPrefix;
    private final BeforeCommit beforeCommit;

    public NativeCredentialStore(Context context) throws CredentialException {
        this(new File(privateRoot(context), "aervox-native-credentials"), ALIAS_PREFIX, () -> {});
    }
    private NativeCredentialStore(File location, String alias, BeforeCommit fault) {
        directory = location;
        aliasPrefix = alias;
        beforeCommit = fault;
    }
    /** Package-only instrumentation seam: each test has a distinct private directory
     * and Keystore namespace; it cannot select a production alias or external path.
     */
    static NativeCredentialStore isolatedForTest(Context context, String namespace, BeforeCommit fault) throws CredentialException {
        if (namespace == null || !namespace.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) {
            throw new IllegalArgumentException("INVALID_TEST_NAMESPACE");
        }
        return new NativeCredentialStore(new File(new File(privateRoot(context), "aervox-credential-tests"), namespace),
            "com.aervox.mobile.credential-tests.v1." + namespace + ".", fault);
    }

    /** Explicit replacement authenticates any existing record before overwriting it.
     * Invalid or uncertain state requires an explicit clear; it is never repaired by
     * silently creating a replacement master key or replacing unreadable ciphertext.
     */
    public void put(Slot slot, byte[] secret) throws CredentialException {
        requireSlot(slot);
        if (secret == null || secret.length == 0 || secret.length > MAX_SECRET_BYTES) fail(Failure.INVALID_INPUT);
        byte[] owned = Arrays.copyOf(secret, secret.length);
        try {
            locked(() -> {
                checkRecordPaths(slot);
                boolean evidence = hasEvidence(slot);
                SecretKey key = findKey(slot);
                if (key == null && evidence) return fail(Failure.KEY_UNAVAILABLE);
                if (hasSidecars(slot)) return fail(Failure.RECOVERY_REQUIRED);
                if (evidence) {
                    byte[] prior = decrypt(slot, key, readRecord(record(slot)));
                    Arrays.fill(prior, (byte) 0);
                }
                if (key == null) key = createKey(slot);
                byte[] envelope = encrypt(slot, key, owned);
                writeRecord(slot, envelope);
                return null;
            });
        } finally { Arrays.fill(owned, (byte) 0); }
    }

    /** Returns null only when no base/backup/staged ciphertext exists. */
    public byte[] get(Slot slot) throws CredentialException {
        requireSlot(slot);
        return locked(() -> {
            checkRecordPaths(slot);
            if (!hasEvidence(slot)) return null;
            SecretKey key = findKey(slot);
            if (key == null) return fail(Failure.KEY_UNAVAILABLE);
            if (hasSidecars(slot)) return fail(Failure.RECOVERY_REQUIRED);
            return decrypt(slot, key, readRecord(record(slot)));
        });
    }

    /** Explicitly forgets this slot's ciphertext. The wrapping key is retained and
     * never regenerated by clear; no plaintext or provider error is returned.
     */
    public void clear(Slot slot) throws CredentialException {
        requireSlot(slot);
        locked(() -> {
            checkRecordPaths(slot);
            // API 24's AtomicFile predates the .new staging convention. Explicit
            // clear covers all recognized evidence on every supported platform.
            File base = record(slot);
            for (String suffix : new String[]{".new", ".bak", ""}) {
                File file = new File(base.getPath() + suffix);
                if (file.exists() && !file.delete()) return fail(Failure.STORAGE_UNAVAILABLE);
            }
            if (hasEvidence(slot)) return fail(Failure.STORAGE_UNAVAILABLE);
            return null;
        });
    }

    private <T> T locked(Operation<T> operation) throws CredentialException {
        synchronized (PROCESS_LOCK) {
            try {
                if (!directory.isDirectory() && !directory.mkdirs()) return fail(Failure.STORAGE_UNAVAILABLE);
                if (!directory.getCanonicalFile().equals(directory.getAbsoluteFile())) return fail(Failure.STORAGE_UNAVAILABLE);
                Os.chmod(directory.getPath(), 0700);
                try (RandomAccessFile lock = new RandomAccessFile(new File(directory, ".lock"), "rw")) {
                    Os.fchmod(lock.getFD(), 0600);
                    try (FileLock ignored = lock.getChannel().lock()) { return operation.run(); }
                }
            } catch (CredentialException expected) { throw expected; }
            catch (Exception ignored) { return fail(Failure.STORAGE_UNAVAILABLE); }
        }
    }
    private static File privateRoot(Context context) throws CredentialException {
        if (context == null) return fail(Failure.INVALID_INPUT);
        try { return context.getNoBackupFilesDir().getCanonicalFile(); }
        catch (Exception ignored) { return fail(Failure.STORAGE_UNAVAILABLE); }
    }
    private void checkRecordPaths(Slot slot) throws CredentialException {
        File base = record(slot);
        for (String suffix : new String[]{"", ".bak", ".new"}) {
            File file = new File(base.getPath() + suffix);
            try {
                if (!file.getCanonicalFile().equals(file.getAbsoluteFile()) || (file.exists() && !file.isFile())) fail(Failure.RECORD_INVALID);
            } catch (IOException ignored) { fail(Failure.STORAGE_UNAVAILABLE); }
        }
    }
    private File record(Slot slot) { return new File(directory, slot.id + ".v1.bin"); }
    private boolean hasSidecars(Slot slot) {
        File base = record(slot);
        return new File(base.getPath() + ".bak").exists() || new File(base.getPath() + ".new").exists();
    }
    private boolean hasEvidence(Slot slot) { return record(slot).exists() || hasSidecars(slot); }
    private String alias(Slot slot) { return aliasPrefix + slot.id; }
    private static void requireSlot(Slot slot) throws CredentialException { if (slot == null) fail(Failure.INVALID_INPUT); }
    private static <T> T fail(Failure failure) throws CredentialException { throw new CredentialException(failure); }

    private SecretKey findKey(Slot slot) throws CredentialException {
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            if (!store.containsAlias(alias(slot))) return null;
            Key key = store.getKey(alias(slot), null);
            if (!(key instanceof SecretKey)) return fail(Failure.KEY_UNAVAILABLE);
            return (SecretKey) key;
        } catch (CredentialException expected) { throw expected; }
        catch (Exception ignored) { return fail(Failure.KEY_UNAVAILABLE); }
    }
    private SecretKey createKey(Slot slot) throws CredentialException {
        try {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias(slot), KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(false).build());
            return generator.generateKey();
        } catch (Exception ignored) { return fail(Failure.KEY_UNAVAILABLE); }
    }
    private byte[] aad(Slot slot) {
        return ("aervox.mobile.credentials\u0000" + VERSION + "\u0000" + slot.id).getBytes(StandardCharsets.UTF_8);
    }
    private byte[] encrypt(Slot slot, SecretKey key, byte[] plaintext) throws CredentialException {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            cipher.updateAAD(aad(slot));
            byte[] encrypted = cipher.doFinal(plaintext), nonce = cipher.getIV();
            if (nonce.length != NONCE_BYTES) return fail(Failure.CRYPTO_UNAVAILABLE);
            return ByteBuffer.allocate(MAGIC.length + 4 + 1 + 4 + nonce.length + encrypted.length)
                .put(MAGIC).putInt(VERSION).put((byte) nonce.length).putInt(encrypted.length).put(nonce).put(encrypted).array();
        } catch (CredentialException expected) { throw expected; }
        catch (GeneralSecurityException ignored) { return fail(Failure.CRYPTO_UNAVAILABLE); }
    }
    private byte[] decrypt(Slot slot, SecretKey key, byte[] envelope) throws CredentialException {
        if (envelope.length < MAGIC.length + 4 + 1 + 4 + NONCE_BYTES + 17) return fail(Failure.RECORD_INVALID);
        ByteBuffer buffer = ByteBuffer.wrap(envelope);
        byte[] magic = new byte[MAGIC.length]; buffer.get(magic);
        int version = buffer.getInt(), nonceSize = Byte.toUnsignedInt(buffer.get()), payloadSize = buffer.getInt();
        if (!Arrays.equals(magic, MAGIC) || version != VERSION || nonceSize != NONCE_BYTES
            || payloadSize < 17 || payloadSize > MAX_SECRET_BYTES + 16 || buffer.remaining() != nonceSize + payloadSize) {
            return fail(Failure.RECORD_INVALID);
        }
        byte[] nonce = new byte[nonceSize], encrypted = new byte[payloadSize]; buffer.get(nonce); buffer.get(encrypted);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(aad(slot));
            return cipher.doFinal(encrypted);
        } catch (AEADBadTagException ignored) { return fail(Failure.RECORD_INVALID); }
        catch (java.security.InvalidKeyException ignored) { return fail(Failure.KEY_UNAVAILABLE); }
        catch (GeneralSecurityException ignored) { return fail(Failure.CRYPTO_UNAVAILABLE); }
    }
    private byte[] readRecord(File file) throws CredentialException {
        if (!file.isFile() || file.length() > MAX_RECORD_BYTES) return fail(Failure.RECORD_INVALID);
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[1024]; int count;
            while ((count = input.read(chunk)) != -1) {
                if (output.size() + count > MAX_RECORD_BYTES) return fail(Failure.RECORD_INVALID);
                output.write(chunk, 0, count);
            }
            return output.toByteArray();
        } catch (IOException ignored) { return fail(Failure.STORAGE_UNAVAILABLE); }
    }
    private void writeRecord(Slot slot, byte[] envelope) throws CredentialException {
        AtomicFile atomic = new AtomicFile(record(slot));
        FileOutputStream output = null;
        try {
            output = atomic.startWrite();
            Os.fchmod(output.getFD(), 0600);
            output.write(envelope); output.getFD().sync();
            beforeCommit.run();
            atomic.finishWrite(output); output = null;
            if (hasSidecars(slot) || !Arrays.equals(envelope, readRecord(record(slot)))) fail(Failure.WRITE_FAILED);
        } catch (Exception ignored) {
            if (output != null) atomic.failWrite(output);
            fail(Failure.WRITE_FAILED);
        }
    }
}
