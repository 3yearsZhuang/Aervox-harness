package com.aervox.mobile;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.security.NetworkSecurityPolicy;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.aervox.mobile.runtime.SQLiteCapabilityProbe;
import java.io.File;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Runs only on a real authorized Android target; compilation is not execution evidence. */
@RunWith(AndroidJUnit4.class)
public final class SQLiteCapabilityProbeTest {
    @Test public void bundledEngineMeetsSqlContractAndCleansItsPrivateDatabase() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SQLiteCapabilityProbe.Result result = SQLiteCapabilityProbe.run(context);
        assertEquals("3.54.1", result.engineVersion);
        assertTrue(result.returning && result.jsonNul && result.fts5 && result.foreignKeys && result.rollback && result.reopen);
        assertTrue(SQLiteCapabilityProbe.run(context).reopen);
        File directory = new File(context.getNoBackupFilesDir(), "sqlite-capability-probes");
        assertArrayEquals(new String[0], directory.list());
    }
    @Test public void dependencyManifestCannotEnableBackupOrCleartext() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(0, context.getApplicationInfo().flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
        assertFalse(NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted());
    }
}
