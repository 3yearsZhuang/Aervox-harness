package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import org.junit.Test;

public final class NativeAssetPolicyTest {
    @Test public void permitsOnlyKnownApkAssetPathsAtTheFixedOrigin() {
        assertEquals("m0/index.html", NativeAssetPolicy.assetPath(NativeAssetPolicy.ENTRY));
        assertEquals("m0/assets/index-A_1.js", NativeAssetPolicy.assetPath("https://localhost:443/m0/assets/index-A_1.js"));
        assertEquals("m0/fonts/Ui.woff2", NativeAssetPolicy.assetPath("https://localhost/m0/fonts/Ui.woff2"));
    }
    @Test public void rejectsExternalSchemesHostsAndDecoratedOrigins() {
        for (String value : new String[]{"http://localhost/m0/index.html", "https://localhost:444/m0/index.html",
            "https://localhost.evil/m0/index.html", "https://sub.localhost/m0/index.html", "https://user@localhost/m0/index.html",
            "file:///m0/index.html", "content://localhost/m0/index.html", "data:text/html,hello", "about:blank",
            "https://localhost/m0/index.html?q=x", "https://localhost/m0/index.html#x"}) assertNull(value, NativeAssetPolicy.assetPath(value));
    }
    @Test public void rejectsTraversalEncodingAndNonAssetRoots() {
        for (String value : new String[]{"/public/index.html", "/m0/../index.html", "/m0/./index.html", "/m0/a/../../x.js",
            "/m0/%2e%2e/index.html", "/m0/%69ndex.html", "/m0/a%2fb.js", "/m0/a%5cb.js", "/m0/a\\b.js",
            "/m0//index.html", "/m0/.private.json", "/m0/中文.js", "/m0/", "/m0/index.html/"}) {
            assertNull(value, NativeAssetPolicy.assetPath("https://localhost" + value));
        }
    }
    @Test public void rejectsUnknownMimeTypesAndUnboundedUrls() {
        for (String path : new String[]{"file", "secret.db", "asset.map", "file.exe"}) assertNull(NativeAssetPolicy.assetPath("https://localhost/m0/" + path));
        assertNull(NativeAssetPolicy.assetPath(null));
        assertNull(NativeAssetPolicy.assetPath("https://localhost/m0/" + "x".repeat(4096) + ".js"));
        assertEquals("text/javascript", NativeAssetPolicy.mime("m0/main.mjs"));
        assertEquals("image/svg+xml", NativeAssetPolicy.mime("m0/icon.svg"));
    }
}
