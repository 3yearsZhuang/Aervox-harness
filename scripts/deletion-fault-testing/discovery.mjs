import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const METHODS = new Map([
  ...[
    'get', 'getById', 'getAll', 'getMemory', 'getMemoryById', 'select',
    'find', 'findFirst', 'findMany', 'search', 'similaritySearch',
    'similaritySearchWithScore', 'similaritySearchVectorWithScore', 'retrieve',
  ].map((method) => [method, 'read']),
  ...[
    'insert', 'insertBatch', 'update', 'upsert', 'addDocuments', 'addVectors',
    'addTexts', 'updateDocuments', 'updateMemory', 'insertMemory',
    'appendMemoryRevision', 'createMemoryEvidence', 'recordMemoryEvent',
    'execute', 'executeBatch', 'run',
  ].map((method) => [method, 'write']),
  ...[
    'delete', 'deleteById', 'deleteMany', 'deleteMemory', 'deleteMemoryById',
    'deleteDocuments', 'remove', 'removeMemory',
  ].map((method) => [method, 'delete']),
  ...[
    'complete', 'markComplete', 'markCompleted', 'completeDeletion',
    'completeMemoryDeletion', 'markDeletionComplete', 'verifyDeletion',
    'verifyMemoryDeletion',
  ].map((method) => [method, 'complete']),
]);
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ClassMethod', 'ClassPrivateMethod', 'ObjectMethod',
]);
const LIMITATIONS = [
  'Lexical method-name candidates only: receiver types, aliases, reachability and deletion semantics are not inferred; candidates are not confirmed storage operations or bugs.',
  'Only explicitly supplied JavaScript/TypeScript files are parsed. No import traversal, dependency traversal or source execution is performed.',
  'Dependency paths require allowDependencies=true (CLI --allow-dependencies); opt-in still requires explicitly named files with real paths inside root.',
  'String literals, SQL text, comments and arguments are not included in the report or used to classify calls; computed property calls and methods outside the lexical vocabulary are omitted.',
  'Write candidates include add/insert/upsert/put/append/update/set alone or followed by an uppercase letter; delete candidates similarly include delete/remove. Map.set, Set.add and unrelated helpers such as setTimeout remain possible false positives.',
  'execute, executeBatch and run are conservative write-candidates even when their SQL is read-only; read and complete classifications also require manual confirmation.',
  'Locations identify the called identifier, with one-based lines and one-based UTF-16 code-unit columns, not UTF-8 byte offsets.',
  'Candidate identifiers bind the relative file, complete source SHA-256, call offsets and lexical method; source edits intentionally invalidate identifiers.',
];

export class DiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DiscoveryError';
    this.code = code;
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateFileArgument(file, allowDependencies) {
  if (typeof file !== 'string' || !file || file.includes('\0') || file.includes('\\')
    || path.isAbsolute(file) || /^[A-Za-z]:/.test(file)) {
    throw new DiscoveryError('INVALID_PATH', 'Source files must be nonempty relative POSIX paths.');
  }
  const segments = file.split('/');
  if (segments.includes('..') || (!allowDependencies && segments.includes('node_modules'))) {
    throw new DiscoveryError('INVALID_PATH', 'Source paths cannot traverse parents; node_modules requires explicit opt-in.');
  }
  if (!EXTENSIONS.has(path.extname(file).toLowerCase())) {
    throw new DiscoveryError('UNSUPPORTED_FILE', 'Only JavaScript and TypeScript source files are supported.');
  }
}

function identifier(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'PrivateName') return `#${node.id.name}`;
  return null;
}

function inferredName(node, parent) {
  const ownName = identifier(node.id) ?? (!node.computed ? identifier(node.key) : null);
  if (ownName) return ownName;
  if (parent?.type === 'VariableDeclarator' && parent.init === node) return identifier(parent.id);
  if ((parent?.type === 'ObjectProperty' || parent?.type === 'ClassProperty')
    && parent.value === node && !parent.computed) return identifier(parent.key);
  if (parent?.type === 'AssignmentExpression' && parent.right === node) {
    if (parent.left.type === 'Identifier') return parent.left.name;
    if (parent.left.type === 'MemberExpression' && !parent.left.computed) return identifier(parent.left.property);
  }
  return null;
}

function callIdentifier(callee) {
  while (callee && [
    'TSNonNullExpression', 'TSAsExpression', 'TSTypeAssertion',
    'TSInstantiationExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression',
  ].includes(callee.type)) callee = callee.expression;
  if (callee?.type === 'Identifier') return callee;
  if ((callee?.type === 'MemberExpression' || callee?.type === 'OptionalMemberExpression') && !callee.computed) {
    return callee.property.type === 'Identifier' ? callee.property : null;
  }
  return null;
}

function classifyMethod(method) {
  if (METHODS.has(method)) return METHODS.get(method);
  if (/^(?:add|insert|upsert|put|append|update|set)(?:$|[A-Z])/.test(method)) return 'write';
  if (/^(?:delete|remove)(?:$|[A-Z])/.test(method)) return 'delete';
  return null;
}

function collect(program, file, sourceSha256) {
  const candidates = [];
  function visit(node, parent, enclosingMethod, className) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      className = inferredName(node, parent);
      enclosingMethod = null;
    }
    if (FUNCTION_TYPES.has(node.type)) enclosingMethod = inferredName(node, parent) ?? '<anonymous>';
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const called = callIdentifier(node.callee);
      const kind = called && classifyMethod(called.name);
      if (kind) {
        const method = called.name;
        candidates.push({
          id: `candidate:${digest(JSON.stringify([file, sourceSha256, node.start, node.end, method, kind]))}`,
          kind,
          classification: `${kind}-candidate`,
          basis: 'lexical-method-name',
          method,
          enclosingMethod,
          className,
          file,
          line: called.loc.start.line,
          column: called.loc.start.column + 1,
          sourceSha256,
        });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) visit(child, node, enclosingMethod, className);
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        visit(value, node, enclosingMethod, className);
      }
    }
  }
  visit(program, null, null, null);
  return candidates.sort((a, b) => a.line - b.line || a.column - b.column || compareText(a.method, b.method));
}

/** Parse explicitly named source files without importing or executing them. */
export async function discoverCandidates({ root, files, allowDependencies = false } = {}) {
  if (typeof root !== 'string' || !root || !Array.isArray(files) || typeof allowDependencies !== 'boolean') {
    throw new DiscoveryError('INVALID_ARGUMENT', 'discoverCandidates requires root, an explicit files array and a boolean allowDependencies option.');
  }
  const canonicalRoot = await realpath(root);
  if (!(await stat(canonicalRoot)).isDirectory()) throw new DiscoveryError('INVALID_ROOT', 'root must name a directory.');
  const uniqueFiles = new Map();
  // Validate the complete list before reading any source.
  for (const file of files) {
    validateFileArgument(file, allowDependencies);
    const absolute = path.resolve(canonicalRoot, file);
    if (!within(canonicalRoot, absolute)) throw new DiscoveryError('INVALID_PATH', 'Source path escapes root.');
    const canonicalFile = await realpath(absolute);
    if (!within(canonicalRoot, canonicalFile)) throw new DiscoveryError('INVALID_PATH', 'Source symlink escapes root.');
    if (!allowDependencies && path.relative(canonicalRoot, canonicalFile).split(path.sep).includes('node_modules')) {
      throw new DiscoveryError('INVALID_PATH', 'Source resolves to node_modules without explicit opt-in.');
    }
    if (!(await stat(canonicalFile)).isFile()) throw new DiscoveryError('INVALID_PATH', 'Source must name a regular file.');
    uniqueFiles.set(path.relative(canonicalRoot, absolute).split(path.sep).join('/'), canonicalFile);
  }
  const scannedFiles = [];
  const candidates = [];
  for (const [file, canonicalFile] of [...uniqueFiles].sort(([a], [b]) => compareText(a, b))) {
    const bytes = await readFile(canonicalFile);
    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new DiscoveryError('INVALID_ENCODING', `Source is not valid UTF-8: ${file}`);
    }
    const sha256 = digest(bytes);
    const extension = path.extname(file).toLowerCase();
    const plugins = [];
    if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) plugins.push('typescript');
    if (['.js', '.jsx', '.mjs', '.cjs', '.tsx'].includes(extension)) plugins.push('jsx');
    let ast;
    try {
      ast = parse(source, { sourceType: 'unambiguous', plugins, attachComment: false });
    } catch (error) {
      // Babel's full error can include source fragments. Report location only.
      const location = error.loc ? `:${error.loc.line}:${error.loc.column + 1}` : '';
      throw new DiscoveryError('PARSE_ERROR', `Cannot parse source: ${file}${location}`);
    }
    scannedFiles.push({ path: file, sha256 });
    candidates.push(...collect(ast.program, file, sha256));
  }
  return { schemaVersion: 1, files: scannedFiles, candidates, limitations: [...LIMITATIONS] };
}

async function main(args) {
  let root;
  let out;
  let allowDependencies = false;
  const files = [];
  for (const arg of args) {
    if (arg.startsWith('--root=') && root === undefined) root = arg.slice(7);
    else if (arg.startsWith('--file=')) files.push(arg.slice(7));
    else if (arg.startsWith('--out=') && out === undefined) out = arg.slice(6);
    else if (arg === '--allow-dependencies' && !allowDependencies) allowDependencies = true;
    else throw new DiscoveryError('CLI_USAGE', 'Usage: node discovery.mjs --root=DIR --file=RELATIVE_FILE [--file=RELATIVE_FILE] [--allow-dependencies] --out=NEW_JSON');
  }
  if (!root || !out || !files.length) throw new DiscoveryError('CLI_USAGE', '--root, at least one --file and --out are required.');
  const result = await discoverCandidates({ root, files, allowDependencies });
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ files: result.files.length, candidates: result.candidates.length, output: path.resolve(out) })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.code ?? 'DISCOVERY_ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
