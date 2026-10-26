package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.res.AssetManager;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.webkit.Profile;
import androidx.webkit.WebViewCompat;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual isolated-profile WebViews and test-APK fixtures; no MainActivity,
 * native SQL, credentials, business files or network service is accessed.
 * Unsupported required capabilities fail visibly instead of becoming a skip.
 */
@RunWith(AndroidJUnit4.class)
public final class NativeAssetWebViewHostTest {
    private NativeAssetWebViewHost host;
    private WebView view;
    private final AtomicInteger calls = new AtomicInteger();
    @After public void close() { main(() -> { if (host != null) host.close(); }); }

    @Test public void firstBundledDocumentUsesFreshProfileAndNativePingWithNoNetworkOrFrames() throws Exception {
        AtomicReference<Boolean> defaultCookies = new AtomicReference<>();
        main(() -> defaultCookies.set(CookieManager.getInstance().acceptCookie()));
        ready();
        awaitJs("window.fixture && fixture.reply && fixture.networkBlocked && fixture.workerBlocked && fixture.frameChecked");
        assertEquals("true", js("fixture.reply.id==='first' && fixture.reply.result.echo==='apk-fixture' && !window.frameExecuted"));
        assertEquals(1, calls.get());
        main(() -> {
            Profile profile = WebViewCompat.getProfile(view);
            assertEquals(host.profileName(), profile.getName());
            assertNotEquals(Profile.DEFAULT_PROFILE_NAME, profile.getName());
            assertFalse(profile.getCookieManager().acceptCookie());
            assertEquals(defaultCookies.get(), CookieManager.getInstance().acceptCookie());
            assertTrue(view.getSettings().getBlockNetworkLoads());
            assertFalse(view.getSettings().getAllowFileAccess()); assertFalse(view.getSettings().getAllowContentAccess());
        });
    }
    @Test public void externalMainNavigationRetiresTheEntireOwner() throws Exception {
        ready(); awaitJs("window.fixture && fixture.reply");
        main(() -> view.evaluateJavascript("location.href='https://remote.invalid/next.html'", null));
        awaitRetired();
        assertEquals(1, calls.get());
    }
    @Test public void reloadCannotReuseAnOldMessageObjectOrProfile() throws Exception {
        ready(); awaitJs("window.fixture && fixture.reply");
        main(() -> view.evaluateJavascript("location.reload()", null));
        awaitRetired();
        assertEquals(1, calls.get());
    }
    @Test public void closeRevokesPendingReplyWithoutAcknowledgingHostWorkCancellation() throws Exception {
        CompletableFuture<String> work = new CompletableFuture<>();
        main(() -> {
            boolean priorCookies = CookieManager.getInstance().acceptCookie();
            host = NativeAssetWebViewHost.create(context(), body -> { calls.incrementAndGet(); return work; });
            assertEquals(NativeAssetWebViewHost.Status.READY, host.status()); view = host.view();
            assertEquals(priorCookies, CookieManager.getInstance().acceptCookie());
        });
        awaitJs("window.fixture && fixture.sent");
        assertEquals(1, calls.get());
        main(() -> {
            host.close(); host.close(); assertEquals(NativeAssetWebViewHost.Status.CLOSED, host.status());
            assertNull(host.view());
            assertNotEquals(NativeAssetWebViewHost.ProfileCleanup.NONE, host.profileCleanup());
        });
        assertFalse(work.isCancelled()); work.complete("{\"privateResult\":true}");
        InstrumentationRegistry.getInstrumentation().waitForIdleSync(); assertEquals(1, calls.get());
    }
    private void ready() {
        main(() -> {
            boolean priorCookies = CookieManager.getInstance().acceptCookie();
            host = NativeAssetWebViewHost.create(context(), body -> { calls.incrementAndGet(); return CompletableFuture.completedFuture(body.toString()); });
            assertEquals("Fixed-assets host feature/asset/profile gate", NativeAssetWebViewHost.Status.READY, host.status());
            assertEquals(priorCookies, CookieManager.getInstance().acceptCookie());
            view = host.view(); assertNotNull(view);
        });
    }
    private static Context context() {
        AssetManager fixtures = InstrumentationRegistry.getInstrumentation().getContext().getAssets();
        return new ContextWrapper(InstrumentationRegistry.getInstrumentation().getTargetContext()) {
            @Override public AssetManager getAssets() { return fixtures; }
        };
    }
    private void awaitRetired() throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (true) {
            AtomicReference<NativeAssetWebViewHost.Status> status = new AtomicReference<>();
            main(() -> status.set(host.status()));
            if (status.get() != NativeAssetWebViewHost.Status.READY) {
                assertEquals(NativeAssetWebViewHost.Status.RETIRED_NAVIGATION, status.get());
                main(() -> assertNull(host.view())); return;
            }
            if (System.nanoTime() > end) fail("ASSET_OWNER_RETIRE_TIMEOUT");
            Thread.sleep(20);
        }
    }
    private void awaitJs(String predicate) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!"true".equals(js("Boolean(" + predicate + ")"))) {
            if (System.nanoTime() > end) fail("ASSET_FIXTURE_TIMEOUT");
            Thread.sleep(20);
        }
    }
    private String js(String expression) throws Exception {
        AtomicReference<String> result = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
        main(() -> view.evaluateJavascript(expression, value -> { result.set(value); done.countDown(); }));
        assertTrue("ASSET_SCRIPT_TIMEOUT", done.await(5, TimeUnit.SECONDS)); return result.get();
    }
    private static void main(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
}
