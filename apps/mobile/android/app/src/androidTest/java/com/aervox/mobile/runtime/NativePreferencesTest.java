package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Unique preferences namespaces only; never reads the user's real UI cache. */
@RunWith(AndroidJUnit4.class)
public final class NativePreferencesTest {
    @Test public void restoresTheExactUnsubmittedDraftAndSelectionAcrossOwners() throws Exception {
        try (Fixture fixture = new Fixture()) {
            JSONObject values = new JSONObject().put("aervox_active_session_id", "session-1")
                .put("aervox-mobile-draft:session-1", "尚未发送\n完整草稿\u0000尾");
            JSONObject saved = await(fixture.preferences.request(write(values)));
            assertEquals(values.toString(), saved.getJSONObject("values").toString());
            fixture.preferences.close();
            fixture.preferences = new NativePreferences(fixture.context);
            JSONObject restored = await(fixture.preferences.request(new JSONObject().put("operation", "read")));
            assertEquals("preferences", restored.getString("kind"));
            assertEquals(values.getString("aervox_active_session_id"), restored.getJSONObject("values").getString("aervox_active_session_id"));
            assertEquals(values.getString("aervox-mobile-draft:session-1"), restored.getJSONObject("values").getString("aervox-mobile-draft:session-1"));
        }
    }

    @Test public void rejectedWritesCannotClearAcceptedDraftsOrStoreCredentials() throws Exception {
        try (Fixture fixture = new Fixture()) {
            await(fixture.preferences.request(write(new JSONObject().put("aervox-mobile-draft:owned", "retain me"))));
            for (JSONObject invalid : new JSONObject[]{
                new JSONObject().put("apiKey", "never stored"),
                new JSONObject().put("aervox-mobile-draft:owned", new JSONObject().put("credential", "never stored")),
                new JSONObject().put("aervox-mobile-draft:owned", new String(new char[32769]).replace('\0', 'x'))
            }) rejected(fixture.preferences.request(write(invalid)));
            JSONObject restored = await(fixture.preferences.request(new JSONObject().put("operation", "read"))).getJSONObject("values");
            assertEquals(1, restored.length()); assertEquals("retain me", restored.getString("aervox-mobile-draft:owned"));
        }
    }

    @Test public void closingRevokesAdmissionWithoutChangingStoredState() throws Exception {
        try (Fixture fixture = new Fixture()) {
            await(fixture.preferences.request(write(new JSONObject().put("aervox_active_session_id", "retained"))));
            fixture.preferences.close();
            rejected(fixture.preferences.request(write(new JSONObject())));
            fixture.preferences = new NativePreferences(fixture.context);
            JSONObject restored = await(fixture.preferences.request(new JSONObject().put("operation", "read"))).getJSONObject("values");
            assertEquals("retained", restored.getString("aervox_active_session_id"));
        }
    }

    private static JSONObject write(JSONObject values) throws Exception {
        return new JSONObject().put("operation", "write").put("values", values);
    }
    private static JSONObject await(CompletableFuture<JSONObject> future) throws Exception { return future.get(5, TimeUnit.SECONDS); }
    private static void rejected(CompletableFuture<JSONObject> future) throws Exception {
        try { await(future); fail("Expected bounded preference failure"); }
        catch (ExecutionException error) {
            assertTrue(error.getCause() instanceof IllegalStateException);
            assertEquals("UI_PREFERENCES_UNAVAILABLE", error.getCause().getMessage());
        }
    }
    private static final class Fixture implements AutoCloseable {
        final Context application = InstrumentationRegistry.getInstrumentation().getTargetContext();
        final String namespace = "native-preferences-test-" + UUID.randomUUID();
        final Context context = new ContextWrapper(application) {
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                assertEquals("aervox_mobile_ui", name);
                return application.getSharedPreferences(namespace, mode);
            }
        };
        NativePreferences preferences = new NativePreferences(context);
        @Override public void close() { preferences.close(); assertTrue(application.deleteSharedPreferences(namespace)); }
    }
}
