package com.aervox.mobile.runtime;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Fixed APK asset names only. This is deliberately narrower than a URL router. */
final class NativeAssetPolicy {
    static final String ENTRY = "https://localhost/m0/index.html";
    static final String CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        + "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; "
        + "worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    private NativeAssetPolicy() {}

    static String assetPath(String url) {
        if (url == null || url.length() > 4096) return null;
        try {
            URI uri = new URI(url);
            if (!"https".equals(uri.getScheme()) || !"localhost".equals(uri.getHost())
                || uri.getPort() != -1 && uri.getPort() != 443 || uri.getRawUserInfo() != null
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || uri.getRawPath() == null || !uri.getRawPath().equals(uri.getPath())) return null;
            String path = uri.getRawPath();
            // Existing shared Live2D code uses root-relative immutable assets.
            // These aliases still resolve exclusively to the packaged m0 tree.
            if (path.startsWith("/live2d/")) path = "/m0" + path;
            if (path.equals("/aervox-mark.svg")) path = "/m0/aervox-mark.svg";
            if (!path.matches("/m0/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*")) return null;
            return mime(path) == null ? null : path.substring(1);
        } catch (URISyntaxException ignored) { return null; }
    }

    static String mime(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0) return null;
        switch (path.substring(dot + 1).toLowerCase(Locale.ROOT)) {
            case "html": return "text/html";
            case "js": case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "json": return "application/json";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "gif": return "image/gif";
            case "ico": return "image/x-icon";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "ttf": return "font/ttf";
            case "otf": return "font/otf";
            case "moc3": return "application/octet-stream";
            default: return null;
        }
    }
}
