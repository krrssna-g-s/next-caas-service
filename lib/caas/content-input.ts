/**
 * Everything a JSON document goes through before the admin API stores it:
 * strict parsing with duplicate-key detection, then the XSS sanitizer.
 */
import { JsonSyntaxError, parseJsonDetailed, type DuplicateChoice, type DuplicateKey, type Json } from './json-tools';
import { sanitizeContent, type HtmlPolicy, type SanitizeIssue } from './sanitize';

/**
 * ?duplicates=  error (default) | first | last
 * With "error", a document that repeats a key in the same object is refused
 * and the response lists every duplicated key with all of its values, so the
 * caller can decide which one is meant instead of the last one winning silently.
 */
export type DuplicatePolicy = 'error' | 'first' | 'last';

export function duplicatePolicyFrom(req: Request): DuplicatePolicy | undefined {
  const v = new URL(req.url).searchParams.get('duplicates') ?? 'error';
  return v === 'error' || v === 'first' || v === 'last' ? v : undefined;
}

export type Prepared =
  | { ok: true; value: Json; duplicates: DuplicateKey[] }
  | { ok: false; status: number; error: string; details: Record<string, unknown> };

export function parseInput(text: string, duplicates: DuplicatePolicy, maxDepth = 64): Prepared {
  let parsed;
  try {
    const choice: DuplicateChoice = duplicates === 'first' ? 'first' : 'last';
    parsed = parseJsonDetailed(text, { duplicates: choice, maxDepth });
  } catch (err) {
    const e = err as Error;
    const details = err instanceof JsonSyntaxError ? { line: err.line, column: err.column } : {};
    return { ok: false, status: 400, error: `body must be valid JSON: ${e.message}`, details };
  }
  if (duplicates === 'error' && parsed.duplicates.length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'the JSON repeats keys; choose which value to keep with ?duplicates=first|last or remove the duplicates',
      details: { duplicates: parsed.duplicates.map(({ pointer, values }) => ({ pointer, values })) },
    };
  }
  return { ok: true, value: parsed.value, duplicates: parsed.duplicates };
}

export type Cleaned =
  | { ok: true; body: string; sanitized: SanitizeIssue[] }
  | { ok: false; status: number; error: string; details: Record<string, unknown> };

export function cleanContent(value: Json, policy: HtmlPolicy, maxBytes: number): Cleaned {
  const r = sanitizeContent(value, policy);
  if (r.errors.length > 0) {
    return { ok: false, status: 422, error: 'content was refused by the safety checks', details: { problems: r.errors } };
  }
  const body = JSON.stringify(r.value);
  if (Buffer.byteLength(body) > maxBytes) {
    return { ok: false, status: 413, error: `content exceeds ${maxBytes} bytes`, details: {} };
  }
  return { ok: true, body, sanitized: r.changed };
}
