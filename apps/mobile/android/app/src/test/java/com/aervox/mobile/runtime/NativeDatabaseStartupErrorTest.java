package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import java.io.IOException;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import org.junit.Test;

public final class NativeDatabaseStartupErrorTest {
    @Test public void actorAndFutureWrappersRetainThePermanentDatabaseRefusal() {
        NativeBusinessDatabase.DatabaseException rejected = new NativeBusinessDatabase.DatabaseException(
            NativeBusinessDatabase.Failure.EXISTING_DATABASE_REJECTED);
        rejected.initCause(new IOException("private database details"));
        String message = NativeDatabaseStartupError.message(new CompletionException(new ExecutionException(actor(rejected))));
        assertEquals("当前版本无法安全打开本地数据库。原有数据已保留，请联系维护者处理。", message);
        assertFalse(message.contains("重试"));
        assertFalse(message.contains("private database details"));
    }

    @Test public void fixedPackageAndUnsafePathRefusalsDoNotSuggestRestarting() {
        for (NativeBusinessDatabase.Failure failure : new NativeBusinessDatabase.Failure[] {
            NativeBusinessDatabase.Failure.ASSET_INVALID, NativeBusinessDatabase.Failure.ENGINE_MISMATCH,
            NativeBusinessDatabase.Failure.UNSAFE_PATH }) {
            String message = NativeDatabaseStartupError.message(actor(new NativeBusinessDatabase.DatabaseException(failure)));
            assertTrue(message.contains("原有数据已保留"));
            assertTrue(message.contains("联系维护者"));
            assertFalse(message.contains("重试"));
        }
    }

    @Test public void unsupportedWindowApiRequiresSystemSupportInsteadOfRestarting() {
        String message = NativeDatabaseStartupError.message(new CompletionException(
            new NativeSqliteSession.SessionException(NativeSqliteSession.Failure.WINDOW_API_UNAVAILABLE)));
        assertEquals("当前系统不支持本地数据库。原有数据已保留，请更新系统后再试。", message);
    }

    @Test public void busyOwnerAndUnknownIoKeepRetryWithoutMatchingMessageText() {
        String retry = "本地数据库暂不可用。原有数据已保留，请关闭后重试。";
        assertEquals(retry, NativeDatabaseStartupError.message(actor(new NativeBusinessDatabase.DatabaseException(
            NativeBusinessDatabase.Failure.OWNER_BUSY))));
        assertEquals(retry, NativeDatabaseStartupError.message(actor(new IOException("EXISTING_DATABASE_REJECTED"))));
    }

    @Test(timeout = 1000) public void malformedCauseCycleCannotBlockTheStartupCallback() {
        IOException first = new IOException("first"), second = new IOException("second");
        first.initCause(second); second.initCause(first);
        assertEquals("本地数据库暂不可用。原有数据已保留，请关闭后重试。", NativeDatabaseStartupError.message(first));
    }

    private static Throwable actor(Throwable failure) {
        return new NativeSqliteSession.SessionException(NativeSqliteSession.Failure.INITIALIZATION_FAILED).initCause(failure);
    }
}
