package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Android org.json roundtrips only: no SQL connection, application files,
 * credentials, network, WebView or production resources are accessed.
 */
@RunWith(AndroidJUnit4.class)
public final class NativeSqliteValuesTest {
    @Test public void preservesNullTextNulAndUtf16ThroughActualJson() throws Exception {
        assertNull(roundtripBinding(null));
        for (String value : new String[]{"", "中文\0尾", "before\ud800after", "\udfff", "\ud83d\ude00", "\ufeffbody"}) {
            assertEquals(value, roundtripBinding(value));
        }
        assertEquals("中文\0尾", NativeSqliteValues.decodeBinding(new JSONObject("{\"type\":\"text\",\"value\":\"中文\\u0000尾\"}")));
    }

    @Test public void preservesFiniteRealBitsAndNegativeZeroMarker() throws Exception {
        for (double value : new double[]{0.0d, -0.0d, 1.0d, -1.5d, Double.MIN_VALUE, -Double.MIN_VALUE,
            Double.MAX_VALUE, -Double.MAX_VALUE, Math.nextDown(1.0d), Math.nextUp(1.0d), 9007199254740992.0d}) {
            Object actual = roundtripBinding(value);
            assertEquals(Double.class, actual.getClass());
            assertEquals(Double.doubleToRawLongBits(value), Double.doubleToRawLongBits((Double) actual));
        }
        assertEquals("-0", NativeSqliteValues.encodeResultValue(-0.0d).get("value"));
        assertTrue(NativeSqliteValues.encodeResultValue(0.0d).get("value") instanceof Double);
        assertEquals(Double.MIN_VALUE, (Double) NativeSqliteValues.decodeBinding(new JSONObject("{\"type\":\"float\",\"value\":5e-324}")), 0.0d);
        assertEquals(Double.MAX_VALUE, (Double) NativeSqliteValues.decodeBinding(new JSONObject("{\"type\":\"float\",\"value\":1.7976931348623157e308}")), 0.0d);
    }

    @Test public void preservesInfiniteResultsWithoutAllowingInfiniteInputBinding() throws Exception {
        for (double value : new double[]{Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY}) {
            JSONObject result = new JSONObject(NativeSqliteValues.encodeResultValue(value).toString());
            assertEquals("float", result.get("type"));
            assertEquals(value > 0 ? "Infinity" : "-Infinity", result.get("value"));
            rejected(() -> NativeSqliteValues.decodeBinding(result));
        }
        rejected(() -> NativeSqliteValues.encodeResultValue(Double.NaN));
        // JSONObject forbids nonfinite JSON numbers, while parsed numeric
        // overflow can produce infinity on some platform implementations.
        rejected(() -> NativeSqliteValues.decodeBinding(new JSONObject("{\"type\":\"float\",\"value\":\"NaN\"}")));
    }

    @Test public void preservesSignedInt64AsDecimalStringsAndKeepsIntegralRealDistinct() throws Exception {
        for (long value : new long[]{0L, 1L, -1L, Long.MIN_VALUE, Long.MAX_VALUE, 9007199254740993L}) {
            JSONObject encoded = NativeSqliteValues.encodeResultValue(value);
            assertEquals("int64", encoded.get("type"));
            assertEquals(Long.toString(value), encoded.get("value"));
            Object actual = NativeSqliteValues.decodeBinding(new JSONObject(encoded.toString()));
            assertEquals(Long.class, actual.getClass()); assertEquals(value, actual);
        }
        assertEquals(Double.class, NativeSqliteValues.decodeBinding(new JSONObject("{\"type\":\"float\",\"value\":1}")).getClass());
        assertEquals(Long.class, NativeSqliteValues.decodeBinding(new JSONObject("{\"type\":\"int64\",\"value\":\"1\"}")).getClass());
    }

    @Test public void preservesAllBinaryBytesEmptyValuesAndIndependentDecodedStorage() throws Exception {
        byte[] all = new byte[256]; for (int index = 0; index < all.length; index++) all[index] = (byte) index;
        for (byte[] value : new byte[][]{new byte[0], all, Arrays.copyOfRange(all, 7, 247)}) {
            assertArrayEquals(value, (byte[]) roundtripBinding(value));
        }
        JSONObject encoded = NativeSqliteValues.encodeResultValue(all);
        assertTrue(encoded.getString("value").startsWith("00010203"));
        assertTrue(encoded.getString("value").endsWith("fcfdfeff"));
        byte[] first = (byte[]) NativeSqliteValues.decodeBinding(encoded);
        first[0] = 127;
        assertEquals(0, ((byte[]) NativeSqliteValues.decodeBinding(encoded))[0]);
        all[1] = 127;
        assertEquals(1, ((byte[]) NativeSqliteValues.decodeBinding(encoded))[1]);
    }

    @Test public void rejectsMissingExtraAndWronglyTypedFieldsWithoutCoercion() throws Exception {
        for (String input : new String[]{"{}", "{\"type\":null}", "{\"type\":1}", "{\"type\":\"unknown\",\"value\":\"PRIVATE_CANARY\"}",
            "{\"type\":\"null\",\"value\":null}", "{\"type\":\"null\",\"extra\":true}", "{\"type\":\"text\"}",
            "{\"type\":\"text\",\"value\":null}", "{\"type\":\"text\",\"value\":1}", "{\"type\":\"text\",\"value\":true}",
            "{\"type\":\"text\",\"value\":[]}", "{\"type\":\"text\",\"value\":{}}", "{\"type\":\"text\",\"value\":\"ok\",\"extra\":1}"}) {
            rejected(() -> NativeSqliteValues.decodeBinding(new JSONObject(input)));
        }
        for (Object input : new Object[]{null, JSONObject.NULL, "PRIVATE_CANARY", 1, new JSONArray()}) {
            rejected(() -> NativeSqliteValues.decodeBinding(input));
        }
    }

    @Test public void rejectsNoncanonicalOrOutOfRangeIntegers() throws Exception {
        for (String value : new String[]{"", "+1", "01", "-0", "-01", "1.0", "1e2", " 1", "1\n", "9223372036854775808", "-9223372036854775809"}) {
            JSONObject input = new JSONObject().put("type", "int64").put("value", value);
            rejected(() -> NativeSqliteValues.decodeBinding(input));
        }
        for (Object value : new Object[]{1, true, JSONObject.NULL}) {
            JSONObject input = new JSONObject().put("type", "int64").put("value", value);
            rejected(() -> NativeSqliteValues.decodeBinding(input));
        }
    }

    @Test public void rejectsNoncanonicalBinaryAndFloatPayloads() throws Exception {
        for (String value : new String[]{"0", "ABCDEF", "zz", "0g", "00\n", " 00", "00 01"}) {
            JSONObject input = new JSONObject().put("type", "blob").put("value", value);
            rejected(() -> NativeSqliteValues.decodeBinding(input));
        }
        for (Object value : new Object[]{"0", "-0.0", "Infinity", "-Infinity", "NaN", true, JSONObject.NULL, new JSONArray(), new JSONObject()}) {
            JSONObject input = new JSONObject().put("type", "float").put("value", value);
            rejected(() -> NativeSqliteValues.decodeBinding(input));
        }
    }

    @Test public void rejectsUnexpectedNativeTypesRatherThanInventingConversions() throws Exception {
        for (Object value : new Object[]{JSONObject.NULL, true, 1, 1.5f, new java.util.Date(0), new int[]{1}, new Object(),
            new java.math.BigInteger("9223372036854775808"), new java.math.BigDecimal("1.5")}) {
            rejected(() -> NativeSqliteValues.encodeResultValue(value));
        }
        JSONObject arbitraryNumber = new JSONObject().put("type", "float").put("value", new java.math.BigDecimal("1.5"));
        rejected(() -> NativeSqliteValues.decodeBinding(arbitraryNumber));
    }

    private Object roundtripBinding(Object value) throws Exception {
        return NativeSqliteValues.decodeBinding(new JSONObject(NativeSqliteValues.encodeResultValue(value).toString()));
    }
    private interface Checked { Object run() throws Exception; }
    private void rejected(Checked operation) throws Exception {
        try { operation.run(); fail("Expected fixed value failure"); }
        catch (NativeSqliteValues.ValueException error) {
            assertEquals("INVALID_SQLITE_VALUE", error.getMessage()); assertNull(error.getCause());
            assertFalse(error.toString().contains("PRIVATE_CANARY"));
        }
    }
}
