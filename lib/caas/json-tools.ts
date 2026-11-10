/**
 * JSON helpers shared by the server and the admin page (no Node-only imports).
 *
 *  - parseJsonDetailed: a strict JSON parser that, unlike JSON.parse, reports
 *    duplicate keys ({"a":1,"a":2}) together with every value seen, and lets
 *    the caller pick which value each duplicate keeps.
 *  - mergeJson: deep merge of two documents that lists every key whose value
 *    differs between them, so an upload never silently overwrites a value.
 *  - JSON pointer (RFC 6901) helpers used by the field editor.
 *  - stringifyForHtml: JSON text that is also safe to embed in HTML.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type PathSeg = string | number;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------- pointers

const escapeSeg = (s: PathSeg) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

export function toPointer(path: readonly PathSeg[]): string {
  return path.length === 0 ? '' : '/' + path.map(escapeSeg).join('/');
}

export function fromPointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer "${pointer}"`);
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Sets an own property without ever touching the prototype, even for "__proto__". */
function defineKey(obj: JsonObject, key: string, value: Json): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function getAt(doc: Json, path: readonly PathSeg[]): Json | undefined {
  let cur: Json | undefined = doc;
  for (const seg of path) {
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (isObject(cur) && hasOwn(cur, String(seg))) cur = cur[String(seg)];
    else return undefined;
  }
  return cur;
}

/** Returns a copy of `doc` with the value at `path` replaced. Parents must exist. */
export function setAt(doc: Json, path: readonly PathSeg[], value: Json): Json {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(doc)) {
    const i = Number(head);
    const copy = doc.slice();
    copy[i] = setAt(doc[i] ?? null, rest, value);
    return copy;
  }
  if (isObject(doc)) {
    const copy = cloneShallow(doc);
    defineKey(copy, String(head), setAt(hasOwn(doc, String(head)) ? doc[String(head)] : null, rest, value));
    return copy;
  }
  throw new Error(`cannot set ${toPointer(path)}: parent is not an object or array`);
}

export function removeAt(doc: Json, path: readonly PathSeg[]): Json {
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1];
  const parent = getAt(doc, parentPath);
  if (Array.isArray(parent)) {
    const copy = parent.slice();
    copy.splice(Number(last), 1);
    return setAt(doc, parentPath, copy);
  }
  if (isObject(parent)) {
    const copy: JsonObject = {};
    for (const k of Object.keys(parent)) if (k !== String(last)) defineKey(copy, k, parent[k]);
    return setAt(doc, parentPath, copy);
  }
  return doc;
}

/** Renames a key in place, keeping its position among its siblings. */
export function renameKeyAt(doc: Json, parentPath: readonly PathSeg[], from: string, to: string): Json {
  const parent = getAt(doc, parentPath);
  if (!isObject(parent)) throw new Error('parent is not an object');
  if (from === to) return doc;
  if (hasOwn(parent, to)) throw new Error(`a field named "${to}" already exists here`);
  const copy: JsonObject = {};
  for (const k of Object.keys(parent)) defineKey(copy, k === from ? to : k, parent[k]);
  return setAt(doc, parentPath, copy);
}

function cloneShallow(obj: JsonObject): JsonObject {
  const copy: JsonObject = {};
  for (const k of Object.keys(obj)) defineKey(copy, k, obj[k]);
  return copy;
}

export function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

// ---------------------------------------------------------------- parser

export interface DuplicateKey {
  /** JSON pointer of the duplicated key, e.g. "/cta/label". */
  pointer: string;
  key: string;
  /** Every value the key had, in document order. */
  values: Json[];
  /** Index into `values` that was kept. */
  kept: number;
}

/**
 * How duplicate keys are resolved: keep the first or last occurrence, or a
 * per-key choice ({ "/cta/label": 0 }) with `fallback` for keys not listed.
 */
export type DuplicateChoice = 'first' | 'last' | { choices: Record<string, number>; fallback: 'first' | 'last' };

export interface ParseOptions {
  duplicates?: DuplicateChoice;
  maxDepth?: number;
}

export interface ParseResult {
  value: Json;
  duplicates: DuplicateKey[];
}

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} at line ${line}, column ${column}`);
    this.name = 'JsonSyntaxError';
  }
}

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Parser {
  private i = 0;
  readonly duplicates: DuplicateKey[] = [];

  constructor(
    private readonly s: string,
    private readonly choose: DuplicateChoice,
    private readonly maxDepth: number,
  ) {}

  parse(): Json {
    if (this.s.charCodeAt(0) === 0xfeff) this.i = 1; // BOM
    this.ws();
    const v = this.value([], 0);
    this.ws();
    if (this.i < this.s.length) this.fail('Unexpected data after the JSON value');
    return v;
  }

  private fail(msg: string, at = this.i): never {
    const before = this.s.slice(0, at);
    const line = before.split('\n').length;
    const column = at - before.lastIndexOf('\n');
    throw new JsonSyntaxError(msg, at, line, column);
  }

  private ws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }

  private value(path: PathSeg[], depth: number): Json {
    if (depth > this.maxDepth) this.fail(`Nesting deeper than ${this.maxDepth} levels`);
    const c = this.s[this.i];
    if (c === '{') return this.object(path, depth);
    if (c === '[') return this.array(path, depth);
    if (c === '"') return this.string();
    if (c === '-' || (c >= '0' && c <= '9')) return this.number();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.s.startsWith(word, this.i)) {
        this.i += word.length;
        return v;
      }
    }
    return this.fail(c === undefined ? 'Unexpected end of input' : `Unexpected character ${JSON.stringify(c)}`);
  }

  private string(): string {
    const start = this.i;
    let j = start + 1;
    const s = this.s;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 0x22) break; // "
      if (c === 0x5c) j += 2; // backslash escape
      else j++;
    }
    if (j >= s.length) this.fail('Unterminated string', start);
    this.i = j + 1;
    try {
      return JSON.parse(s.slice(start, j + 1)) as string;
    } catch {
      return this.fail('Invalid string (bad escape or unescaped control character)', start);
    }
  }

  private number(): number {
    NUMBER_RE.lastIndex = this.i;
    const m = NUMBER_RE.exec(this.s);
    if (!m) this.fail('Invalid number');
    this.i += m[0].length;
    return Number(m[0]);
  }

  private array(path: PathSeg[], depth: number): Json[] {
    this.i++; // [
    const out: Json[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value([...path, out.length], depth + 1));
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') return out;
      if (c !== ',') this.fail("Expected ',' or ']' in array", this.i - 1);
    }
  }

  private object(path: PathSeg[], depth: number): JsonObject {
    this.i++; // {
    const seen = new Map<string, Json[]>();
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return {};
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail('Expected a double-quoted key');
      const key = this.string();
      this.ws();
      if (this.s[this.i++] !== ':') this.fail("Expected ':' after key", this.i - 1);
      this.ws();
      const v = this.value([...path, key], depth + 1);
      const list = seen.get(key);
      if (list) list.push(v);
      else seen.set(key, [v]);
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') break;
      if (c !== ',') this.fail("Expected ',' or '}' in object", this.i - 1);
    }

    const out: JsonObject = {};
    for (const [key, values] of seen) {
      let kept = 0;
      if (values.length > 1) {
        const pointer = toPointer([...path, key]);
        kept = this.pick(pointer, values.length);
        this.duplicates.push({ pointer, key, values, kept });
      }
      defineKey(out, key, values[kept]);
    }
    return out;
  }

  private pick(pointer: string, count: number): number {
    const c = this.choose;
    const mode = typeof c === 'string' ? c : c.fallback;
    if (typeof c === 'object') {
      const chosen = c.choices[pointer];
      if (Number.isInteger(chosen) && chosen >= 0 && chosen < count) return chosen;
    }
    return mode === 'first' ? 0 : count - 1;
  }
}

/**
 * Parses JSON text strictly and reports duplicate keys. JSON.parse silently
 * keeps the last value of a duplicated key; this keeps whichever the caller
 * chooses (default: last, matching JSON.parse) and lists all of them.
 */
export function parseJsonDetailed(text: string, opts: ParseOptions = {}): ParseResult {
  const p = new Parser(text, opts.duplicates ?? 'last', opts.maxDepth ?? 64);
  const value = p.parse();
  return { value, duplicates: p.duplicates };
}

// ---------------------------------------------------------------- merge

export interface MergeConflict {
  pointer: string;
  existing: Json;
  incoming: Json;
}

export interface MergeResult {
  value: Json;
  /** Keys present in both documents with different values. */
  conflicts: MergeConflict[];
  /** Keys only in the incoming document. */
  added: string[];
  /** Keys only in the existing document (kept by a merge, dropped by a replace). */
  untouched: string[];
}

/**
 * Deep-merges `incoming` into `existing`. Objects merge key by key; arrays
 * and scalars are values. When both sides have a key with different values,
 * `prefer` decides which one is kept, and the key is listed in `conflicts`.
 */
export function mergeJson(existing: Json, incoming: Json, prefer: 'incoming' | 'existing'): MergeResult {
  const conflicts: MergeConflict[] = [];
  const added: string[] = [];
  const untouched: string[] = [];

  const walk = (a: Json, b: Json, path: PathSeg[]): Json => {
    if (isObject(a) && isObject(b)) {
      const out: JsonObject = {};
      for (const k of Object.keys(a)) {
        if (hasOwn(b, k)) defineKey(out, k, walk(a[k], b[k], [...path, k]));
        else {
          untouched.push(toPointer([...path, k]));
          defineKey(out, k, a[k]);
        }
      }
      for (const k of Object.keys(b)) {
        if (!hasOwn(a, k)) {
          added.push(toPointer([...path, k]));
          defineKey(out, k, b[k]);
        }
      }
      return out;
    }
    if (deepEqual(a, b)) return a;
    conflicts.push({ pointer: toPointer(path), existing: a, incoming: b });
    return prefer === 'incoming' ? b : a;
  };

  return { value: walk(existing, incoming, []), conflicts, added, untouched };
}

// ---------------------------------------------------------------- output

/**
 * JSON.stringify, but with <, >, & and the JS line separators escaped as
 * \uXXXX. The result parses to exactly the same value, and can never close a
 * <script> block or be sniffed as HTML if a consumer embeds it in a page.
 */
export function stringifyForHtml(value: unknown, space?: number): string {
  return escapeJsonText(JSON.stringify(value, null, space));
}

/** Same escaping applied to JSON text that already exists (idempotent). */
export function escapeJsonText(text: string): string {
  return text.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function typeOf(v: Json): 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v as 'object' | 'string' | 'number' | 'boolean';
}
