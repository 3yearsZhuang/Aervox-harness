package com.aervox.mobile.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import java.util.Calendar;
import org.junit.Test;

public final class NativeNotifyPolicyTest {

    @Test public void schedulesTheNextNineNotBeforeNow() {
        Calendar today = Calendar.getInstance();
        today.set(2026, Calendar.NOVEMBER, 3, 8, 0, 0);
        today.set(Calendar.MILLISECOND, 0);
        long now = today.getTimeInMillis();
        Calendar expected = Calendar.getInstance();
        expected.setTimeInMillis(now);
        expected.set(Calendar.HOUR_OF_DAY, 9);
        assertEquals(expected.getTimeInMillis(), NativeNotifyService.nextTriggerAt(now, 9));

        // After 9:00 the next trigger is tomorrow.
        today.set(Calendar.HOUR_OF_DAY, 10);
        long later = today.getTimeInMillis();
        assertTrue(NativeNotifyService.nextTriggerAt(later, 9) > later);
        Calendar tomorrow = Calendar.getInstance();
        tomorrow.setTimeInMillis(later);
        tomorrow.add(Calendar.DAY_OF_YEAR, 1);
        tomorrow.set(Calendar.HOUR_OF_DAY, 9);
        tomorrow.set(Calendar.MINUTE, 0);
        tomorrow.set(Calendar.SECOND, 0);
        tomorrow.set(Calendar.MILLISECOND, 0);
        assertEquals(tomorrow.getTimeInMillis(), NativeNotifyService.nextTriggerAt(later, 9));
    }
}
