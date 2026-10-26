package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import com.aervox.mobile.runtime.NativeCredentialStore.CredentialException;
import com.aervox.mobile.runtime.NativeCredentialStore.Failure;
import com.aervox.mobile.runtime.NativeCredentialStore.Slot;

/** Every test uses its own native directory and Keystore alias. No production
 * slot, business data, network, JavaScript or external path is involved.
 */
@RunWith(AndroidJUnit4.class)
public final class NativeCredentialStoreTest {
    private Context context;
    private String namespace, alias;
    private NativeCredentialStore store;
    private File directory, record;
    private final byte[] secret = "native-api-key-canary".getBytes(StandardCharsets.UTF_8);
    @Before public void prepare() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        namespace = UUID.randomUUID().toString();
        alias = "com.aervox.mobile.credential-tests.v1." + namespace + ".primary-model";
        directory = new File(new File(context.getNoBackupFilesDir(), "aervox-credential-tests"), namespace);
        record = new File(directory, "primary-model.v1.bin");
        store = NativeCredentialStore.isolatedForTest(context, namespace, () -> {});
    }
    @After public void clean() throws Exception {
        Arrays.fill(secret, (byte) 0);
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null); keys.deleteEntry(alias);
        if (directory.isDirectory()) {
            File[] files = directory.listFiles();
            if (files != null) for (File file : files) assertTrue(file.delete());
            assertTrue(directory.delete());
        }
    }
    @Test public void encryptsWithNonExportableKeyAndFreshNonceThenExplicitlyClears() throws Exception {
        assertNull(store.get(Slot.PRIMARY_MODEL));
        store.put(Slot.PRIMARY_MODEL, secret);
        byte[] first = bytes(record), plaintext = store.get(Slot.PRIMARY_MODEL);
        assertArrayEquals(secret, plaintext); Arrays.fill(plaintext, (byte) 0);
        assertFalse(new String(first, StandardCharsets.ISO_8859_1).contains("native-api-key-canary"));
        KeyStore keys = keys(); assertTrue(keys.containsAlias(alias)); assertNull(keys.getKey(alias, null).getEncoded());
        store.put(Slot.PRIMARY_MODEL, secret);
        assertFalse(Arrays.equals(first, bytes(record)));
        store.clear(Slot.PRIMARY_MODEL); assertNull(store.get(Slot.PRIMARY_MODEL));
        assertFalse(record.exists()); assertTrue(keys().containsAlias(alias));
    }
    @Test public void missingMasterKeyPreservesCiphertextAndNeverCreatesAReplacement() throws Exception {
        store.put(Slot.PRIMARY_MODEL, secret); byte[] original = bytes(record); keys().deleteEntry(alias);
        rejected(Failure.KEY_UNAVAILABLE, () -> store.get(Slot.PRIMARY_MODEL));
        rejected(Failure.KEY_UNAVAILABLE, () -> { store.put(Slot.PRIMARY_MODEL, secret); return null; });
        assertArrayEquals(original, bytes(record)); assertFalse(keys().containsAlias(alias));
    }
    @Test public void missingMasterWithOnlyBackupIsEvidenceAndDoesNotTriggerRecovery() throws Exception {
        missingSidecar(".bak");
    }
    @Test public void missingMasterWithOnlyStagedRecordIsEvidenceAndDoesNotTriggerRecovery() throws Exception {
        missingSidecar(".new");
    }
    private void missingSidecar(String suffix) throws Exception {
        store.put(Slot.PRIMARY_MODEL, secret); byte[] original = bytes(record);
        File sidecar = new File(record.getPath() + suffix); assertTrue(record.renameTo(sidecar)); keys().deleteEntry(alias);
        rejected(Failure.KEY_UNAVAILABLE, () -> store.get(Slot.PRIMARY_MODEL));
        rejected(Failure.KEY_UNAVAILABLE, () -> { store.put(Slot.PRIMARY_MODEL, secret); return null; });
        assertFalse(record.exists()); assertArrayEquals(original, bytes(sidecar)); assertFalse(keys().containsAlias(alias));
    }
    @Test public void unauthenticatedRecordCannotBeReadOrOverwritten() throws Exception {
        store.put(Slot.PRIMARY_MODEL, secret);
        byte[] changed = bytes(record); changed[changed.length - 1] ^= 1; write(record, changed);
        rejected(Failure.RECORD_INVALID, () -> store.get(Slot.PRIMARY_MODEL));
        rejected(Failure.RECORD_INVALID, () -> { store.put(Slot.PRIMARY_MODEL, secret); return null; });
        assertArrayEquals(changed, bytes(record));
        store.clear(Slot.PRIMARY_MODEL); assertNull(store.get(Slot.PRIMARY_MODEL));
    }
    @Test public void authenticatedDataBindsTheRecordToTheSlotAndVersion() throws Exception {
        store.put(Slot.PRIMARY_MODEL, secret);
        SecretKey key = (SecretKey) keys().getKey(alias, null);
        for (String aad : new String[]{"aervox.mobile.credentials\u00001\u0000another-slot", "aervox.mobile.credentials\u00002\u0000primary-model"}) {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key);
            cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            byte[] encrypted = cipher.doFinal(secret), nonce = cipher.getIV();
            byte[] envelope = ByteBuffer.allocate(8 + 4 + 1 + 4 + nonce.length + encrypted.length)
                .put("AVXKEY01".getBytes(StandardCharsets.US_ASCII)).putInt(1).put((byte) nonce.length).putInt(encrypted.length).put(nonce).put(encrypted).array();
            write(record, envelope);
            rejected(Failure.RECORD_INVALID, () -> store.get(Slot.PRIMARY_MODEL));
            assertArrayEquals(envelope, bytes(record));
        }
    }
    @Test public void failureBeforeCommitRetainsThePreviouslyCommittedRecord() throws Exception {
        store.put(Slot.PRIMARY_MODEL, secret); byte[] original = bytes(record);
        NativeCredentialStore failing = NativeCredentialStore.isolatedForTest(context, namespace, () -> { throw new IOException("PRIVATE_FAILURE_CANARY"); });
        rejected(Failure.WRITE_FAILED, () -> { failing.put(Slot.PRIMARY_MODEL, "replacement".getBytes(StandardCharsets.UTF_8)); return null; });
        assertArrayEquals(original, bytes(record)); assertArrayEquals(secret, store.get(Slot.PRIMARY_MODEL));
    }
    @Test public void interruptedSidecarsPreserveOldBytesAndRequireExplicitRecovery() throws Exception {
        store.put(Slot.PRIMARY_MODEL, secret); byte[] original = bytes(record);
        File staged = new File(record.getPath() + ".new"); write(staged, new byte[]{1, 2, 3});
        rejected(Failure.RECOVERY_REQUIRED, () -> store.get(Slot.PRIMARY_MODEL));
        rejected(Failure.RECOVERY_REQUIRED, () -> { store.put(Slot.PRIMARY_MODEL, secret); return null; });
        assertArrayEquals(original, bytes(record)); assertArrayEquals(new byte[]{1, 2, 3}, bytes(staged));
        store.clear(Slot.PRIMARY_MODEL); assertNull(store.get(Slot.PRIMARY_MODEL)); assertFalse(staged.exists());
    }
    @Test public void explicitClearCoversBackupAndStagedEvidenceWithoutReplacingTheKey() throws Exception {
        store.put(Slot.PRIMARY_MODEL, secret);
        byte[] original = bytes(record);
        write(new File(record.getPath() + ".bak"), original);
        write(new File(record.getPath() + ".new"), original);
        store.clear(Slot.PRIMARY_MODEL);
        assertNull(store.get(Slot.PRIMARY_MODEL));
        assertFalse(record.exists());
        assertFalse(new File(record.getPath() + ".bak").exists());
        assertFalse(new File(record.getPath() + ".new").exists());
        assertTrue(keys().containsAlias(alias));
    }
    @Test public void malformedVersionAndOversizedRecordArePreserved() throws Exception {
        store.put(Slot.PRIMARY_MODEL, secret); byte[] changed = bytes(record); ByteBuffer.wrap(changed).putInt(8, 2); write(record, changed);
        rejected(Failure.RECORD_INVALID, () -> store.get(Slot.PRIMARY_MODEL)); assertArrayEquals(changed, bytes(record));
        byte[] oversized = new byte[9000]; write(record, oversized);
        rejected(Failure.RECORD_INVALID, () -> store.get(Slot.PRIMARY_MODEL)); assertArrayEquals(oversized, bytes(record));
    }
    @Test public void invalidInputDoesNotCreateKeysOrCiphertext() throws Exception {
        rejected(Failure.INVALID_INPUT, () -> { store.put(Slot.PRIMARY_MODEL, new byte[0]); return null; });
        rejected(Failure.INVALID_INPUT, () -> { store.put(Slot.PRIMARY_MODEL, new byte[8193]); return null; });
        rejected(Failure.INVALID_INPUT, () -> store.get(null));
        assertFalse(record.exists()); assertFalse(keys().containsAlias(alias));
    }
    private interface Checked { Object run() throws Exception; }
    private void rejected(Failure expected, Checked operation) throws Exception {
        try { operation.run(); fail("Expected a fixed credential failure"); }
        catch (CredentialException error) {
            assertEquals(expected, error.failure); assertEquals(expected.name(), error.getMessage()); assertNull(error.getCause());
            assertFalse(error.toString().contains("PRIVATE_FAILURE_CANARY")); assertFalse(error.toString().contains("native-api-key-canary"));
        }
    }
    private KeyStore keys() throws Exception { KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null); return keys; }
    private byte[] bytes(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file); java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
            byte[] chunk = new byte[1024]; int count; while ((count = input.read(chunk)) != -1) output.write(chunk, 0, count); return output.toByteArray();
        }
    }
    private void write(File file, byte[] value) throws Exception { try (FileOutputStream output = new FileOutputStream(file)) { output.write(value); output.getFD().sync(); } }
}
