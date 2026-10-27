package com.aervox.mobile;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public final class MobileBackNavigationTest {
    private static final class Target implements MobileBackNavigation.Target {
        boolean ime;
        int history;
        boolean historyRead;
        Runnable onSystemBack = () -> {};
        final List<String> actions = new ArrayList<>();
        @Override public boolean isImeVisible() { return ime; }
        @Override public void hideIme() { actions.add("hide-ime"); ime = false; }
        @Override public boolean canGoBack() { historyRead = true; return history > 0; }
        @Override public void goBack() { actions.add("history-back"); history--; }
        @Override public void systemBack() { actions.add("system-back"); onSystemBack.run(); }
    }

    @Test public void hidesKeyboardWithoutReadingOrConsumingHistoryThenReturnsThroughLayers() {
        Target target = new Target(); target.ime = true; target.history = 2;
        MobileBackNavigation navigation = new MobileBackNavigation(target);
        navigation.handleBack();
        assertEquals(List.of("hide-ime"), target.actions);
        assertFalse(target.historyRead); assertEquals(2, target.history);
        navigation.handleBack(); navigation.handleBack(); navigation.handleBack();
        assertEquals(List.of("hide-ime", "history-back", "history-back", "system-back"), target.actions);
    }

    @Test public void delegatesAtRootAndIgnoresSynchronousReentryFromTheDispatcher() {
        Target target = new Target();
        MobileBackNavigation navigation = new MobileBackNavigation(target);
        target.onSystemBack = navigation::handleBack;
        navigation.handleBack();
        assertEquals(List.of("system-back"), target.actions);
        navigation.handleBack();
        assertEquals(List.of("system-back", "system-back"), target.actions);
    }

    @Test public void doesNotKeepTheDispatcherLockedAfterAFailedRootDispatch() {
        Target target = new Target();
        MobileBackNavigation navigation = new MobileBackNavigation(target);
        target.onSystemBack = () -> { throw new IllegalStateException("test-dispatch"); };
        assertThrows(IllegalStateException.class, navigation::handleBack);
        target.onSystemBack = () -> {}; target.history = 1;
        navigation.handleBack();
        assertEquals(List.of("system-back", "history-back"), target.actions);
    }

    @Test public void readsTheCurrentKeyboardStateOnEachPressIncludingAfterHistoryNavigation() {
        Target target = new Target(); target.history = 2;
        MobileBackNavigation navigation = new MobileBackNavigation(target);
        navigation.handleBack(); target.ime = true;
        navigation.handleBack(); navigation.handleBack();
        assertEquals(List.of("history-back", "hide-ime", "history-back"), target.actions);
    }
}
