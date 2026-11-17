package com.aervox.mobile.runtime;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

/** Native startup failures retain typed owner errors beneath the actor wrapper. */
final class NativeDatabaseStartupError {
    private NativeDatabaseStartupError() { }

    static String message(Throwable failure) {
        Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        for (Throwable cause = failure; cause != null && seen.add(cause); cause = cause.getCause()) {
            if (cause instanceof NativeBusinessDatabase.DatabaseException) {
                switch (((NativeBusinessDatabase.DatabaseException) cause).code) {
                    case EXISTING_DATABASE_REJECTED:
                    case ASSET_INVALID:
                    case ENGINE_MISMATCH:
                    case UNSAFE_PATH:
                        return "当前版本无法安全打开本地数据库。原有数据已保留，请联系维护者处理。";
                    default: break;
                }
            }
            if (cause instanceof NativeSqliteSession.SessionException
                && ((NativeSqliteSession.SessionException) cause).code == NativeSqliteSession.Failure.WINDOW_API_UNAVAILABLE) {
                return "当前系统不支持本地数据库。原有数据已保留，请更新系统后再试。";
            }
        }
        return "本地数据库暂不可用。原有数据已保留，请关闭后重试。";
    }
}
