package com.aervox.mobile.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;
import org.junit.Test;

public final class NativeBackupFilePolicyTest {
    @Test public void countsUtf8BytesAndAllowsBoundedChunksBeyondBinderTextShare() throws Exception {
        assertEquals(7, NativeBackupFileService.nextSize(0, "中😀"));
        int bytes = 0;
        for (int index = 0; index < 20; index++) bytes = NativeBackupFileService.nextSize(bytes, "x".repeat(32 * 1024));
        assertEquals(640 * 1024, bytes);
    }
    @Test public void refusesOversizedChunksAndFilesBeforeWriting() throws Exception {
        try { NativeBackupFileService.nextSize(0, "x".repeat(32 * 1024 + 1)); fail(); }
        catch (NativeFileService.FileException expected) { assertEquals("BACKUP_FILE_CHUNK_INVALID", expected.code); }
        try { NativeBackupFileService.nextSize(NativeBackupFileService.MAX_BYTES - 1, "中"); fail(); }
        catch (NativeFileService.FileException expected) { assertEquals("BACKUP_FILE_TOO_LARGE", expected.code); }
    }
}
