/**
 * XSS defence for content written through the admin API.
 *
 * Content is JSON that front ends render, sometimes as HTML. Before anything
 * is stored, every key and string value is checked:
 *  - keys that enable prototype pollution (__proto__, constructor, prototype),
 *    keys with control characters or markup, and over-long keys are refused;
 *  - strings containing markup go through an allowlist HTML sanitizer. The
 *    allowlist covers normal CMS markup (formatting, links, images, tables,
 *    media, inline styles limited to safe CSS properties, class / id / data-*
 *    / aria-* attributes, video embeds from approved hosts). Scripts, event
 *    handlers (on*), <style>, forms, objects, svg and javascript: URLs never pass;
 *  - what is stored is always the sanitizer's output. Only real removals are
 *    reported; formatting differences (<br> vs <br />, attribute quoting,
 *    comments) are normalised silently;
 *  - strings that are a javascript:, vbscript:, file: or non-image data: URL
 *    are blanked, because a consumer may put them in an href or src.
 *
 * Per environment (env or global.properties):
 *   CAAS_HTML_POLICY=sanitize|reject        clean, or refuse the write
 *   CAAS_HTML_EXTRA_TAGS=marquee,details    more allowed tags
 *   CAAS_HTML_EXTRA_ATTRIBUTES=a:ping,*:itemprop   more allowed tag:attribute pairs
 *   CAAS_HTML_IFRAME_HOSTS=www.youtube.com,player.vimeo.com   iframe hosts ("none" = no iframes)
 */
import sanitizeHtml from 'sanitize-html';
import { Parser } from 'htmlparser2';
import { isObject, toPointer, type Json, type JsonObject, type PathSeg } from './json-tools';

export type HtmlPolicy = 'sanitize' | 'reject';

export interface HtmlRules {
  policy: HtmlPolicy;
  extraTags: string[];
  /** tag -> attributes; "*" applies to every tag. */
  extraAttributes: Record<string, string[]>;
  iframeHosts: string[];
}

export const DEFAULT_IFRAME_HOSTS = ['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com'];

export const DEFAULT_HTML_RULES: HtmlRules = { policy: 'sanitize', extraTags: [], extraAttributes: {}, iframeHosts: DEFAULT_IFRAME_HOSTS };

export interface SanitizeIssue {
  pointer: string;
  reason: string;
  /** Start of the value before and after cleaning (for review screens). */
  before?: string;
  after?: string;
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
const URL_NOISE = /[\u0000- \u007f-\u009f]/g;
const SAFE_DATA_URL = /^data:image\/(?:png|gif|jpe?g|webp|avif);base64,/i;
const DANGEROUS_SCHEME = /^(?:javascript|vbscript|file|data):/i;

/** Tags and attributes that can run script or change the page; configuration cannot allow them. */
const NEVER_TAGS = new Set([
  'script', 'style', 'object', 'embed', 'applet', 'base', 'meta', 'link', 'form', 'input', 'textarea',
  'select', 'option', 'frame', 'frameset', 'svg', 'math', 'template', 'noscript', 'param', 'portal',
]);
const NEVER_ATTRIBUTES = new Set(['srcdoc', 'formaction', 'action', 'xmlns', 'xlink:href', 'http-equiv', 'is']);

// ---- CSS allowed in style="" (values are checked, so url(), expression() etc. never pass)
const LEN = String.raw`-?(?:\d+|\d*\.\d+)(?:px|em|rem|%|pt|vh|vw|ch)?|auto|0`;
const LENGTHS = new RegExp(String.raw`^(?:${LEN})(?:\s+(?:${LEN})){0,3}$`, 'i');
const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*[\d.\s,%/]+\)$/i, /^hsla?\(\s*[\d.\s,%/deg]+\)$/i, /^[a-z]{3,20}$/i];
const KEYWORD = [/^[a-z-]{2,30}$/i];
const BORDER = [/^(?:(?:\d*\.?\d+(?:px|em|rem)?|thin|medium|thick)\s*)?(?:none|solid|dashed|dotted|double)?\s*(?:#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d.\s,%/]+\))?$/i];
const FONT_FAMILY = [/^[\w\s,'"-]{1,100}$/];
const len = [LENGTHS];
const SAFE_STYLES: Record<string, RegExp[]> = {
  color: COLOR, 'background-color': COLOR,
  'text-align': [/^(?:left|right|center|justify|start|end)$/i],
  'vertical-align': [/^(?:top|middle|bottom|baseline|text-top|text-bottom|sub|super)$/i],
  'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/i],
  'font-style': [/^(?:normal|italic|oblique)$/i],
  'font-size': [LENGTHS, /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/i],
  'font-family': FONT_FAMILY,
  'line-height': [LENGTHS, /^normal$/i, /^\d*\.?\d+$/],
  'letter-spacing': len, 'text-indent': len,
  'text-decoration': [/^(?:none|underline|line-through|overline)(?:\s+[a-z#0-9()]+)*$/i],
  'text-transform': [/^(?:none|uppercase|lowercase|capitalize)$/i],
  'white-space': KEYWORD, 'list-style-type': KEYWORD, display: [/^(?:block|inline|inline-block|flex|inline-flex|grid|none|table|table-cell|list-item)$/i],
  margin: len, 'margin-top': len, 'margin-right': len, 'margin-bottom': len, 'margin-left': len,
  padding: len, 'padding-top': len, 'padding-right': len, 'padding-bottom': len, 'padding-left': len,
  width: len, height: len, 'max-width': len, 'min-width': len, 'max-height': len, 'min-height': len,
  border: BORDER, 'border-top': BORDER, 'border-right': BORDER, 'border-bottom': BORDER, 'border-left': BORDER,
  'border-color': COLOR, 'border-width': len, 'border-style': [/^(?:none|solid|dashed|dotted|double)$/i], 'border-radius': len,
  'border-collapse': [/^(?:collapse|separate)$/i],
  float: [/^(?:left|right|none)$/i], clear: [/^(?:left|right|both|none)$/i],
};

const BASE_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img', 'picture', 'source', 'video', 'audio', 'track', 'u', 's', 'del', 'ins', 'font', 'center', 'button', 'details', 'summary',
];

const BASE_ATTRIBUTES: Record<string, string[]> = {
  '*': ['class', 'id', 'lang', 'dir', 'title', 'role', 'style', 'translate', 'aria-*', 'data-*', 'itemprop', 'itemscope', 'itemtype'],
  a: ['href', 'name', 'target', 'rel', 'hreflang', 'type', 'download'],
  img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
  source: ['src', 'srcset', 'sizes', 'type', 'media'],
  video: ['src', 'poster', 'controls', 'autoplay', 'muted', 'loop', 'playsinline', 'preload', 'width', 'height'],
  audio: ['src', 'controls', 'autoplay', 'muted', 'loop', 'preload'],
  track: ['src', 'kind', 'srclang', 'label', 'default'],
  table: ['border', 'cellpadding', 'cellspacing', 'width', 'summary', 'align'],
  td: ['colspan', 'rowspan', 'headers', 'scope', 'width', 'align', 'valign', 'abbr'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'width', 'align', 'valign', 'abbr'],
  tr: ['align', 'valign'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  font: ['color', 'size', 'face'],
  button: ['type', 'name', 'value', 'disabled'],
  time: ['datetime'],
  data: ['value'],
  blockquote: ['cite'],
  q: ['cite'],
  details: ['open'],
  iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'title', 'frameborder', 'loading', 'referrerpolicy'],
};

const URL_ATTRIBUTES = ['href', 'src', 'srcset', 'poster', 'cite', 'action', 'background'];

/**
 * Applied to every tag in both passes:
 *  - CSS property names are case-insensitive, so they are lower-cased before the allowlist sees them;
 *  - target=_blank links get rel="noopener" unless they already say it. Not
 *    noreferrer: destination sites keep seeing the referrer (referral analytics).
 */
function normalizeTag(tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
  const out = { ...attribs };
  if (typeof out.style === 'string') {
    out.style = out.style
      .split(';')
      .map((d) => {
        const i = d.indexOf(':');
        return i > 0 ? `${d.slice(0, i).trim().toLowerCase()}:${d.slice(i + 1)}` : d;
      })
      .join(';');
  }
  if (tagName === 'a' && out.target === '_blank' && !/\bnoopener\b/i.test(out.rel ?? '')) {
    out.rel = `${out.rel ? out.rel + ' ' : ''}noopener`;
  }
  return { tagName, attribs: out };
}

/** Strict pass only: drops any URL attribute (including every srcset candidate) with a script scheme. */
function strictTag(tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
  const t = normalizeTag(tagName, attribs);
  for (const a of URL_ATTRIBUTES) {
    const v = t.attribs[a];
    if (typeof v !== 'string') continue;
    const candidates = a === 'srcset' ? v.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '') : [v];
    if (candidates.some((c) => isDangerousUrl(c))) delete t.attribs[a];
  }
  return t;
}

const transformTags: sanitizeHtml.IOptions['transformTags'] = { '*': strictTag };

/** Throws when configuration tries to allow something that can run script. */
export function validateHtmlRules(rules: HtmlRules): void {
  for (const t of rules.extraTags) {
    if (NEVER_TAGS.has(t.toLowerCase())) throw new Error(`CAAS_HTML_EXTRA_TAGS: <${t}> can run script and cannot be allowed`);
    if (t.toLowerCase() === 'iframe') throw new Error('CAAS_HTML_EXTRA_TAGS: allow iframes with CAAS_HTML_IFRAME_HOSTS instead');
  }
  for (const [tag, attrs] of Object.entries(rules.extraAttributes)) {
    for (const a of attrs) {
      const l = a.toLowerCase();
      if (l.startsWith('on') || NEVER_ATTRIBUTES.has(l)) throw new Error(`CAAS_HTML_EXTRA_ATTRIBUTES: ${tag}:${a} can run script and cannot be allowed`);
    }
  }
}

const optionsCache = new Map<string, sanitizeHtml.IOptions>();

export function htmlOptions(rules: HtmlRules = DEFAULT_HTML_RULES): sanitizeHtml.IOptions {
  const key = JSON.stringify([rules.extraTags, rules.extraAttributes, rules.iframeHosts]);
  const hit = optionsCache.get(key);
  if (hit) return hit;
  validateHtmlRules(rules);
  const attributes: Record<string, string[]> = {};
  for (const [tag, list] of Object.entries(BASE_ATTRIBUTES)) attributes[tag] = [...list];
  for (const [tag, list] of Object.entries(rules.extraAttributes)) attributes[tag] = [...(attributes[tag] ?? []), ...list];
  const tags = [...BASE_TAGS, ...rules.extraTags, ...(rules.iframeHosts.length ? ['iframe'] : [])];
  const opts: sanitizeHtml.IOptions = {
    allowedTags: [...new Set(tags)],
    allowedAttributes: attributes,
    allowedStyles: { '*': SAFE_STYLES },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'], source: ['http', 'https'], video: ['http', 'https'], audio: ['http', 'https'], track: ['http', 'https'], iframe: ['https'] },
    allowProtocolRelative: false,
    allowedIframeHostnames: rules.iframeHosts,
    allowIframeRelativeUrls: false,
    disallowedTagsMode: 'discard',
    transformTags,
    // An iframe whose src was not allowed is dropped entirely instead of left as an empty frame.
    exclusiveFilter: (frame) => frame.tag === 'iframe' && !frame.attribs.src,
  };
  optionsCache.set(key, opts);
  return opts;
}

/** Tags, attributes and CSS declarations in a fragment, as a multiset. */
function inventory(html: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (k: string) => out.set(k, (out.get(k) ?? 0) + 1);
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        add(`<${name}>`);
        for (const [a, v] of Object.entries(attrs)) {
          if (a === 'style') {
            for (const decl of v.split(';')) {
              const i = decl.indexOf(':');
              if (i > 0) add(`<${name}> style ${decl.slice(0, i).trim().toLowerCase()}: ${decl.slice(i + 1).trim().toLowerCase()}`);
            }
          } else add(`<${name}> ${a}="${v}"`);
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return out;
}

function describe(entry: string): string {
  const m = /^<([^>]+)>(?: (style [^:]+): .*| ([^=]+)="(.*)")?$/s.exec(entry);
  if (!m) return entry;
  const [, tag, style, attr, value] = m;
  if (style) return `${style.replace('style ', 'style "')}" on <${tag}>`;
  if (attr) return `${attr}${value && value.length <= 60 ? `="${value}"` : ''} on <${tag}>`;
  return `<${tag}>`;
}

/**
 * What the allowlist took out of `html`, in words; empty when the only
 * differences are formatting. Used for reporting only, never to decide what
 * is stored.
 */
function removals(html: string, cleaned: string): string[] {
  const before = inventory(html);
  const after = inventory(cleaned);
  const removed: string[] = [];
  for (const [k, n] of before) if (n > (after.get(k) ?? 0)) removed.push(describe(k));
  return [...new Set(removed)];
}

/** True when a plain string would run script if a consumer used it as a URL. */
export function isDangerousUrl(s: string): boolean {
  const compact = s.replace(URL_NOISE, '');
  return DANGEROUS_SCHEME.test(compact) && !SAFE_DATA_URL.test(compact);
}

/**
 * The stored value is always the sanitizer's output, never the original, so
 * safety does not depend on any parser agreeing with the browser. A change is
 * only reported when something was removed; pure formatting differences
 * (<br> -> <br />, attribute quoting, dropped comments) are stored silently.
 */
export function sanitizeString(s: string, rules: HtmlRules = DEFAULT_HTML_RULES): { value: string; reason?: string; removed?: string[] } {
  if (isDangerousUrl(s)) return { value: '', reason: 'removed a script URL', removed: ['script URL'] };
  if (!MARKUP.test(s)) return { value: s };
  const cleaned = sanitizeHtml(s, htmlOptions(rules));
  if (cleaned === s) return { value: s };
  const removed = removals(s, cleaned);
  if (removed.length === 0) return { value: cleaned };
  const shown = removed.slice(0, 6).join(', ') + (removed.length > 6 ? `, and ${removed.length - 6} more` : '');
  return { value: cleaned, reason: `removed ${shown}`, removed };
}

const excerpt = (s: string) => (s.length > 300 ? s.slice(0, 299) + '…' : s);

export function sanitizeContent(input: Json, rulesOrPolicy: HtmlRules | HtmlPolicy = DEFAULT_HTML_RULES, limits: Partial<SanitizeLimits> = {}): SanitizeResult {
  const rules: HtmlRules = typeof rulesOrPolicy === 'string' ? { ...DEFAULT_HTML_RULES, policy: rulesOrPolicy } : rulesOrPolicy;
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
      const r = sanitizeString(v, rules);
      if (r.reason) {
        const issue = { pointer: toPointer(path), reason: r.reason, before: excerpt(v), after: excerpt(r.value) };
        (rules.policy === 'reject' ? errors : changed).push(issue);
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
