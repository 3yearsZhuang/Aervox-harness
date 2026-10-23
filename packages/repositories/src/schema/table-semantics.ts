/** Read the table semantics SQLite PRAGMAs omit. This does not evaluate or rewrite SQL. */
type Token = { kind: "word" | "identifier" | "literal" | "symbol"; value: string };

function tokens(sql: string): Token[] {
  const result: Token[] = [];
  for (let offset = 0; offset < sql.length;) {
    const character = sql[offset]!;
    if (/\s/.test(character)) { offset++; continue; }
    if (sql.startsWith("--", offset)) {
      const end = sql.indexOf("\n", offset + 2);
      offset = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      const end = sql.indexOf("*/", offset + 2);
      if (end < 0) throw new Error("unterminated SQL comment");
      offset = end + 2;
      continue;
    }
    if (["'", '"', "`", "["].includes(character)) {
      const closing = character === "[" ? "]" : character;
      let value = "", closed = false;
      for (offset++; offset < sql.length; offset++) {
        if (sql[offset] !== closing) { value += sql[offset]; continue; }
        if (closing !== "]" && sql[offset + 1] === closing) { value += closing; offset++; continue; }
        offset++; closed = true; break;
      }
      if (!closed) throw new Error("unterminated SQL quote");
      result.push({ kind: character === "'" ? "literal" : "identifier", value });
      continue;
    }
    const word = /^[a-z_\u0080-\uffff][a-z0-9_$\u0080-\uffff]*/i.exec(sql.slice(offset));
    if (word) {
      result.push({ kind: "word", value: word[0].toLowerCase() });
      offset += word[0].length;
      continue;
    }
    const operator = /^(?:->>|->|<>|!=|==|<=|>=|\|\||<<|>>)/.exec(sql.slice(offset));
    result.push({ kind: "symbol", value: operator?.[0] ?? character });
    offset += operator?.[0].length ?? 1;
  }
  return result;
}

const word = (token: Token | undefined, value: string): boolean => token?.kind === "word" && token.value === value;
const identifier = (token: Token | undefined): string => {
  if (!token || token.kind === "symbol") throw new Error("expected SQL identifier");
  return token.value.toLowerCase();
};

function closingParenthesis(input: Token[], opening: number): number {
  if (input[opening]?.kind !== "symbol" || input[opening]?.value !== "(") throw new Error("expected SQL parenthesis");
  let depth = 1;
  for (let index = opening + 1; index < input.length; index++) {
    if (input[index]?.kind !== "symbol") continue;
    if (input[index]?.value === "(") depth++;
    else if (input[index]?.value === ")" && --depth === 0) return index;
  }
  throw new Error("unbalanced SQL parentheses");
}

function expressionKey(input: Token[], columns?: ReadonlySet<string>): string {
  // Identifier quoting and whitespace do not change CHECK semantics. Literal contents do.
  while (input[0]?.kind === "symbol" && input[0]?.value === "(" && closingParenthesis(input, 0) === input.length - 1) input = input.slice(1, -1);
  return JSON.stringify(input.map(token => token.kind === "identifier" && (!columns || columns.has(token.value.toLowerCase()))
    ? ["word", token.value.toLowerCase()] : [token.kind, token.value]));
}

/** These supplements are compared with the same reader applied to the canonical disposable database. */
export function tableDefinitionSemantics(sql: string) {
  const input = tokens(sql);
  if (!word(input[0], "create") || !word(input[1], "table")) throw new Error("unsupported table definition");
  let opening = 2;
  if (word(input[opening], "if") && word(input[opening + 1], "not") && word(input[opening + 2], "exists")) opening += 3;
  identifier(input[opening++]);
  if (input[opening]?.value === ".") { opening++; identifier(input[opening++]); }
  const closing = closingParenthesis(input, opening);
  const suffix = input.slice(closing + 1).filter(token => token.value !== ";" && token.value !== ",");
  for (let index = 0; index < suffix.length; index++) {
    if (word(suffix[index], "strict")) continue;
    if (word(suffix[index], "without") && word(suffix[index + 1], "rowid")) { index++; continue; }
    throw new Error("unsupported table option");
  }
  const fields: Token[][] = [];
  let start = opening + 1;
  for (let index = start; index < closing; index++) {
    if (input[index]?.kind !== "symbol") continue;
    if (input[index]?.value === "(") index = closingParenthesis(input, index);
    else if (input[index]?.value === ",") { fields.push(input.slice(start, index)); start = index + 1; }
  }
  fields.push(input.slice(start, closing));
  const columns = new Set(fields.flatMap(field => {
    const first = word(field[0], "constraint") ? 2 : 0;
    return ["primary", "unique", "foreign", "check"].some(value => word(field[first], value)) ? [] : [identifier(field[first])];
  }));
  const checks: string[] = [], collations: string[] = [], conflicts: string[] = [], autoIncrement: string[] = [], foreignModifiers: string[] = [];
  for (const field of fields) {
    let first = 0;
    if (word(field[first], "constraint")) { identifier(field[first + 1]); first += 2; }
    const tableConstraint = ["primary", "unique", "foreign", "check"].some(value => word(field[first], value));
    const column = tableConstraint ? null : identifier(field[first]);
    // A column can carry several independently acting constraints. Keep each policy
    // attached to its constraint; sorting policies by column would miss swaps.
    let owner = column === null ? expressionKey(field.slice(first)) : JSON.stringify(["column", column]);
    if (column === null && ["primary", "unique"].some(value => word(field[first], value))) {
      const list = field.findIndex((token, index) => index > first && token.kind === "symbol" && token.value === "(");
      owner = expressionKey(field.slice(first, closingParenthesis(field, list) + 1));
    }
    let foreign: { owner: string; deferrable: boolean; initially: "immediate" | "deferred"; match: string } | null = null;
    const finishForeign = () => {
      if (foreign && (foreign.deferrable || foreign.initially !== "immediate" || foreign.match !== "none")) {
        foreignModifiers.push(JSON.stringify(foreign));
      }
    };
    let collation = "binary";
    for (let index = column === null ? first : first + 1; index < field.length; index++) {
      const token = field[index];
      if (word(token, "constraint")) {
        identifier(field[++index]);
      } else if (word(token, "check")) {
        const end = closingParenthesis(field, index + 1);
        const check = expressionKey(field.slice(index + 2, end), columns);
        checks.push(check);
        owner = JSON.stringify(["check", column, check]);
        index = end;
      } else if (column !== null && word(token, "primary") && word(field[index + 1], "key")) {
        owner = JSON.stringify(["primary key", column]);
        index++;
      } else if (column !== null && word(token, "unique")) {
        owner = JSON.stringify(["unique", column]);
      } else if (column !== null && word(token, "not") && word(field[index + 1], "null")) {
        owner = JSON.stringify(["not null", column]);
        index++;
      } else if (word(token, "references")) {
        let end = index + 1;
        identifier(field[end++]);
        if (field[end]?.value === ".") { end++; identifier(field[end++]); }
        if (field[end]?.kind === "symbol" && field[end]?.value === "(") end = closingParenthesis(field, end) + 1;
        finishForeign();
        foreign = { owner: JSON.stringify([column ?? expressionKey(field.slice(first, index)), expressionKey(field.slice(index, end))]),
          deferrable: false, initially: "immediate", match: "none" };
        index = end - 1;
      } else if (token?.kind === "symbol" && token.value === "(") {
        index = closingParenthesis(field, index);
      } else if (word(token, "collate")) {
        if (column === null) throw new Error("unsupported table collation");
        collation = identifier(field[++index]);
      } else if (word(token, "on") && word(field[index + 1], "conflict")) {
        const policy = identifier(field[index + 2]);
        if (!["rollback", "abort", "fail", "ignore", "replace"].includes(policy)) throw new Error("unsupported conflict policy");
        // ABORT is SQLite's default for these constraints.
        if (policy !== "abort") conflicts.push(JSON.stringify([owner, policy]));
        index += 2;
      } else if (word(token, "autoincrement")) {
        if (column === null) throw new Error("unsupported table autoincrement");
        autoIncrement.push(column);
      } else if (word(token, "deferrable")) {
        if (foreign === null) throw new Error("foreign key modifier without reference");
        foreign.deferrable = !word(field[index - 1], "not");
      } else if (word(token, "initially")) {
        if (foreign === null) throw new Error("foreign key modifier without reference");
        if (word(field[index + 1], "deferred")) foreign.initially = "deferred";
        else if (!word(field[index + 1], "immediate")) throw new Error("unsupported foreign key timing");
        index++;
      } else if (word(token, "match")) {
        if (foreign === null) throw new Error("foreign key modifier without reference");
        foreign.match = identifier(field[++index]);
      }
    }
    finishForeign();
    if (column !== null) collations.push(JSON.stringify([column, collation]));
  }
  return { checks: checks.sort(), collations: collations.sort(), conflicts: conflicts.sort(), autoIncrement: autoIncrement.sort(), foreignModifiers: foreignModifiers.sort() };
}
