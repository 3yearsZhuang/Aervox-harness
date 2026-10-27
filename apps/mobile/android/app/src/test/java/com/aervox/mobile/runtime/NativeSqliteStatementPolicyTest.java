package com.aervox.mobile.runtime;

import static org.junit.Assert.*;
import org.junit.Test;

/** JVM lexical-subset tests, not Android execution or authorizer evidence. */
public final class NativeSqliteStatementPolicyTest {
    @Test public void acceptsCanonicalDataStatementsAndCountsOnlyBoundParameters() {
        assertEquals(2, valid("INSERT INTO \"messages\" (\"id\",\"content\") VALUES (?,?) ON CONFLICT DO NOTHING RETURNING \"id\""));
        assertEquals(1, valid("UPDATE [turns] SET status='Running' WHERE id=? RETURNING id; -- tail\n /* ignored */"));
        assertEquals(1, valid("DELETE FROM `messages` WHERE id=?"));
        assertEquals(1, valid("/* start */ SeLeCt json_quote(body), '?:$@; ATTACH', \"x?\", `a``?`, [x?] FROM records WHERE id=?"));
        assertEquals(0, valid("SELECT CASE WHEN 1 THEN 'it''s ?' ELSE 'x' END, sqlite_version()"));
    }
    @Test public void acceptsExplicitDataOnlyCtesAndRejectsOtherMainCommands() {
        assertEquals(1, valid("WITH input(id) AS (VALUES(?)) SELECT * FROM input"));
        assertEquals(2, valid("WITH RECURSIVE n(x) AS (VALUES(?) UNION ALL SELECT x+1 FROM n WHERE x<?) SELECT sum(x) FROM n"));
        assertEquals(2, valid("WITH \"a\" AS NOT MATERIALIZED (SELECT ?), b AS MATERIALIZED (SELECT ?) UPDATE records SET id=(SELECT * FROM a)"));
        for (String value : new String[]{"WITH a AS (SELECT 1) REPLACE INTO record VALUES(1)", "WITH a AS (DELETE FROM record) SELECT 1", "WITH a AS (SELECT 1) PRAGMA foreign_keys", "WITH a SELECT 1", "WITH a AS SELECT 1", "WITH a AS (SELECT 1), SELECT 1"}) bad(value);
    }
    @Test public void rejectsAuthorityAndConflictTransitionsEvenThroughQuotedNames() {
        for (String value : new String[]{"ATTACH ? AS extra", "PRAGMA writable_schema=1", "SELECT load_extension(?)", "SELECT 'load_extension' /*comment*/ (?)", "SELECT \"load_extension\"(?)", "SELECT [load_extension](?)", "SELECT `load_extension`(?)", "SELECT readfile(?)", "SELECT * FROM pragma_table_info(?)", "UPDATE sqlite_schema SET sql=?", "SELECT * FROM \"sqlite_master\"", "INSERT OR ROLLBACK INTO record VALUES(?)", "INSERT OR FAIL INTO record VALUES(?)", "WITH a AS (SELECT 1) SELECT load_extension(?)", "BEGIN IMMEDIATE", "COMMIT", "ROLLBACK", "CREATE TABLE x(id)", "EXPLAIN SELECT 1"}) bad(value);
    }
    @Test public void refusesScriptsNamedOrNumberedBindingsAndMalformedQuoting() {
        for (String value : new String[]{"SELECT ?; DELETE FROM record", "SELECT 1;;", "SELECT :id", "SELECT @id", "SELECT $id", "SELECT ?1", "SELECT ?01", "SELECT ?alias", "SELECT 'unterminated", "SELECT \"unterminated", "SELECT [unterminated", "SELECT `unterminated", "SELECT 1 /* unclosed", "SELECT (1", "SELECT 1)", "'SELECT' 1", "SELECTED 1", "-- only comment", "/* only comment */", "SELECT 1; /*comment*/ SELECT 2", "SELECT 1\0; DELETE FROM x"}) bad(value);
    }
    @Test public void respectsExactUtf8ArgumentAndNestingBudgets() {
        assertEquals(0, valid("SELECT '" + repeat("中", 10919) + "'"));
        bad("SELECT '" + repeat("中", 10920) + "'");
        bad("SELECT '\ud800'"); bad("SELECT '\udc00'");
        assertEquals(0, valid("SELECT '😀'"));
        assertEquals(256, valid("SELECT " + repeat("?,", 255) + "?"));
        bad("SELECT " + repeat("?,", 256) + "?");
        assertEquals(0, valid("SELECT " + repeat("(",64) + "1" + repeat(")",64)));
        bad("SELECT " + repeat("(",65) + "1" + repeat(")",65));
    }
    @Test public void quotedLiteralsAndCommentsDoNotInventCommandsOrBinds() {
        assertEquals(1, valid("SELECT '?; /*', '-- COMMIT', 'load_extension', \"a\"\"?\" FROM record -- ?\n WHERE id=? /* ; BEGIN ? */;"));
        assertEquals(0, valid("SELECT 'x''y', x'00ff', '--' /* ??? */"));
        assertEquals(0, valid("SELECT 1;-- ? DELETE\r\n/* ; ATTACH */"));
    }
    private static int valid(String sql) { return NativeSqliteStatementPolicy.validate(sql); }
    private static void bad(String sql) {
        try { valid(sql); fail("Expected fixed rejection"); }
        catch (IllegalArgumentException error) { assertEquals("UNSUPPORTED_SQL", error.getMessage()); assertNull(error.getCause()); }
    }
    private static String repeat(String value, int count) { StringBuilder out = new StringBuilder(); for (int i=0;i<count;i++) out.append(value); return out.toString(); }
}
