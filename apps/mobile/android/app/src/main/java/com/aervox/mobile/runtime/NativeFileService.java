package com.aervox.mobile.runtime;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Reads one user-picked document as bounded UTF-8 text.
 *
 * The picker (SAF) grants access to exactly the chosen document: no broad
 * storage permission is requested and nothing is copied into app storage. A
 * read is capped so a hostile or accidental huge file cannot exhaust memory.
 */
final class NativeFileService {
    static final int MAX_TEXT_BYTES = 2 * 1024 * 1024;

    static final class FileException extends Exception {
        final String code;
        FileException(String value) { super(value); code = value; }
    }

    private NativeFileService() { }

    /** Pure size policy shared with JVM tests. */
    static byte[] boundedBytes(byte[] source) throws FileException {
        if (source.length > MAX_TEXT_BYTES) throw new FileException("FILE_TOO_LARGE");
        return source;
    }

    static JSONObject readPickedText(Context context, Uri uri) throws Exception {
        String name = displayName(context, uri);
        byte[] bytes;
        try (InputStream stream = context.getContentResolver().openInputStream(uri)) {
            if (stream == null) throw new FileException("FILE_READ_FAILED");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[16 * 1024];
            int read;
            long total = 0;
            while ((read = stream.read(chunk)) != -1) {
                total += read;
                if (total > MAX_TEXT_BYTES) throw new FileException("FILE_TOO_LARGE");
                buffer.write(chunk, 0, read);
            }
            bytes = buffer.toByteArray();
        } catch (FileException error) {
            throw error;
        } catch (Exception error) {
            throw new FileException("FILE_READ_FAILED");
        }
        boundedBytes(bytes);
        return new JSONObject()
            .put("kind", "file_result")
            .put("name", name)
            .put("text", new String(bytes, StandardCharsets.UTF_8));
    }

    private static String displayName(Context context, Uri uri) {
        try (Cursor cursor = context.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) { /* The name is cosmetic. */ }
        String last = uri.getLastPathSegment();
        return last == null ? "picked.txt" : last;
    }
}
