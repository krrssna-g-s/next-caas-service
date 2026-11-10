/**
 * XSS defence for content written through the admin API.
 *
 * Content is JSON that front ends render, sometimes as HTML. Before anything
 * is stored, every key and string value is checked:
 *  - keys that enable prototype pollution (__proto__, constructor, prototype),
 *    keys with control characters or markup, and over-long keys are rejected;
 *  - strings containing markup are run through an allowlist HTML sanitizer
 *    (no scripts, no event handlers, no style, only http/https/mailto/tel links);
 *  - strings that are a javascript:, vbscript:, file: or non-image data: URL
 *    are blanked, because a consumer may put them in an href or src.
 *
 * With CAAS_HTML_POLICY=reject the write is refused instead of cleaned.
 */
import sanitizeHtml from 'sanitize-html';
import { isObject, toPointer, type Json, type JsonObject, type PathSeg } from './json-tools';

export type HtmlPolicy = 'sanitize' | 'reject';

export interface SanitizeIssue {
  pointer: string;
  reason: string;
}

export interface SanitizeResult {
  value: Json;
  /** Values that were changed (policy "sanitize"). */
  changed: SanitizeIssue[];
  /** Problems that block the write. */
  errors: SanitizeIssue[];
}

export interface SanitizeLimits {
  maxDepth: number;
  maxKeyLength: number;
  maxNodes: number;
}

const DEFAULT_LIMITS: SanitizeLimits = { maxDepth: 64, maxKeyLength: 256, maxNodes: 200_000 };
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const BAD_KEY_CHARS = /[\u0000-\u001f\u007f<>]/;
/** Something that looks like an HTML tag, comment, or doctype. */
const MARKUP = /<\s*[a-zA-Z!/?]/;
const URL_NOISE = /[\u0000-\u0020\u007f-\u009f]/g;
const SAFE_DATA_URL = /^data:image\/(?:png|gif|jpe?g|webp|avif);base64,/i;
const DANGEROUS_SCHEME = /^(?:javascript|vbscript|file|data):/i;

const HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img'],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['class', 'lang', 'dir'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    // Links that open a new window must not get a handle on this window.
    a: (tagName, attribs) =>
      attribs.target === '_blank' ? { tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } } : { tagName, attribs },
  },
};

/** True when a plain string would run script if a consumer used it as a URL. */
export function isDangerousUrl(s: string): boolean {
  const compact = s.replace(URL_NOISE, '');
  return DANGEROUS_SCHEME.test(compact) && !SAFE_DATA_URL.test(compact);
}

export function sanitizeString(s: string): { value: string; reason?: string } {
  if (isDangerousUrl(s)) return { value: '', reason: 'removed a script URL' };
  if (!MARKUP.test(s)) return { value: s };
  const clean = sanitizeHtml(s, HTML_OPTIONS);
  return clean === s ? { value: s } : { value: clean, reason: 'removed unsafe HTML' };
}

export function sanitizeContent(input: Json, policy: HtmlPolicy = 'sanitize', limits: Partial<SanitizeLimits> = {}): SanitizeResult {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const changed: SanitizeIssue[] = [];
  const errors: SanitizeIssue[] = [];
  let nodes = 0;

  const walk = (v: Json, path: PathSeg[]): Json => {
    if (++nodes > lim.maxNodes) {
      if (nodes === lim.maxNodes + 1) errors.push({ pointer: toPointer(path), reason: `more than ${lim.maxNodes} values` });
      return v;
    }
    if (path.length > lim.maxDepth) {
      errors.push({ pointer: toPointer(path), reason: `nested deeper than ${lim.maxDepth} levels` });
      return v;
    }
    if (typeof v === 'string') {
      const r = sanitizeString(v);
      if (r.reason) {
        const issue = { pointer: toPointer(path), reason: r.reason };
        (policy === 'reject' ? errors : changed).push(issue);
      }
      return r.value;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) errors.push({ pointer: toPointer(path), reason: 'not a finite number' });
      return v;
    }
    if (Array.isArray(v)) return v.map((item, i) => walk(item, [...path, i]));
    if (isObject(v)) {
      const out: JsonObject = {};
      for (const k of Object.keys(v)) {
        const p = [...path, k];
        if (FORBIDDEN_KEYS.has(k)) errors.push({ pointer: toPointer(p), reason: `"${k}" is not allowed as a field name` });
        else if (BAD_KEY_CHARS.test(k)) errors.push({ pointer: toPointer(p), reason: 'field names cannot contain control characters, < or >' });
        else if (k.length > lim.maxKeyLength) errors.push({ pointer: toPointer(p), reason: `field name longer than ${lim.maxKeyLength} characters` });
        Object.defineProperty(out, k, { value: walk(v[k], p), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return v; // boolean | null
  };

  const value = walk(input, []);
  return { value, changed, errors };
}
