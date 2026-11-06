package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class NativeBackupFileServiceTest {
    @Test public void nativeGeneratedIdentityOrderedChunksAndRetainedReadGrant() throws Exception {
        File directory = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(), "backup-test-" + UUID.randomUUID());
        File[] shared = new File[1];
        NativeBackupFileService service = new NativeBackupFileService(directory, () -> true, (file, result) -> {
            shared[0] = file;
            result.complete(new JSONObject().put("kind", "backup_file_shared").put("ok", true));
        });
        try {
            String id = service.request(new JSONObject().put("operation", "begin")).get(5, TimeUnit.SECONDS).getString("exportId");
            service.request(new JSONObject().put("operation", "append").put("exportId", id).put("sequence", 1).put("text", "中😀")).get(5, TimeUnit.SECONDS);
            assertTrue(service.request(new JSONObject().put("operation", "finish").put("exportId", id).put("sequence", 1)).get(5, TimeUnit.SECONDS).getBoolean("ok"));
            assertEquals("中😀", new String(Files.readAllBytes(shared[0].toPath()), StandardCharsets.UTF_8));
            String next = service.request(new JSONObject().put("operation", "begin")).get(5, TimeUnit.SECONDS).getString("exportId");
            assertTrue("new export must not revoke a recent recipient URI", shared[0].exists());
            try {
                service.request(new JSONObject().put("operation", "append").put("exportId", next).put("sequence", 2).put("text", "out of order")).get(5, TimeUnit.SECONDS);
                fail("must reject an omitted chunk");
            } catch (ExecutionException expected) { assertEquals("BACKUP_FILE_SEQUENCE_INVALID", expected.getCause().getMessage()); }
            service.request(new JSONObject().put("operation", "abort").put("exportId", next)).get(5, TimeUnit.SECONDS);
            assertEquals(1, directory.listFiles().length);
        } finally {
            service.close();
            service.awaitClosedForTest();
            File[] files = directory.listFiles();
            if (files != null) for (File file : files) file.delete();
            directory.delete();
        }
    }
}
