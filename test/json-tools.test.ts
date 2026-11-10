/** Unit tests for the duplicate-aware parser, merge, pointer helpers and the XSS sanitizer. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  escapeJsonText,
  JsonSyntaxError,
  mergeJson,
  parseJsonDetailed,
  removeAt,
  renameKeyAt,
  setAt,
  stringifyForHtml,
  toPointer,
  fromPointer,
} from '../lib/caas/json-tools';
import { DEFAULT_HTML_RULES, isDangerousUrl, sanitizeContent, sanitizeString, validateHtmlRules } from '../lib/caas/sanitize';
import { loadConfig } from '../lib/caas/config';

test('parser matches JSON.parse on valid documents', () => {
  const samples = ['{}', '[]', '"x"', '0', '-1.5e3', 'true', 'null', '{"a":[1,{"b":"\\u00e9\\n"}],"c":{"d":null}}', ' \n{"a" : 1 }\t'];
  for (const s of samples) assert.deepEqual(parseJsonDetailed(s).value, JSON.parse(s), s);
});

test('parser rejects invalid JSON with a position', () => {
  for (const s of ['', '{', '{"a":1,}', "{'a':1}", '[1 2]', '01', '{"a":1} x', '"\u0001"', 'NaN']) {
    assert.throws(() => parseJsonDetailed(s), JsonSyntaxError, s);
  }
  try {
    parseJsonDetailed('{\n  "a": 1,\n  oops\n}');
  } catch (e) {
    assert.equal((e as JsonSyntaxError).line, 3);
  }
});

test('duplicate keys are reported with every value, at any depth', () => {
  const text = '{"title":"A","cta":{"label":"Go","label":"Start","label":"Run"},"title":"B"}';
  const last = parseJsonDetailed(text);
  assert.deepEqual(last.value, { title: 'B', cta: { label: 'Run' } });
  assert.deepEqual(
    last.duplicates.map((d) => [d.pointer, d.values, d.kept]),
    [
      ['/cta/label', ['Go', 'Start', 'Run'], 2],
      ['/title', ['A', 'B'], 1],
    ],
  );
  assert.deepEqual(parseJsonDetailed(text, { duplicates: 'first' }).value, { title: 'A', cta: { label: 'Go' } });
  const picked = parseJsonDetailed(text, { duplicates: { choices: { '/cta/label': 1 }, fallback: 'first' } });
  assert.deepEqual(picked.value, { title: 'A', cta: { label: 'Start' } });
});

test('"__proto__" in input becomes an own key and never pollutes prototypes', () => {
  const r = parseJsonDetailed('{"__proto__":{"polluted":true},"a":1}');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(r.value), Object.prototype);
  assert.ok(Object.prototype.hasOwnProperty.call(r.value, '__proto__'));
});

test('nesting depth is limited', () => {
  assert.throws(() => parseJsonDetailed('['.repeat(100) + ']'.repeat(100), { maxDepth: 64 }), /Nesting deeper/);
});

test('merge lists conflicts, additions and untouched keys', () => {
  const existing = { title: 'Old', cta: { label: 'Go', href: '/a' }, tags: ['x'] };
  const incoming = { title: 'New', cta: { label: 'Go', color: 'red' }, tags: ['y'] };
  const m = mergeJson(existing, incoming, 'incoming');
  assert.deepEqual(m.value, { title: 'New', cta: { label: 'Go', href: '/a', color: 'red' }, tags: ['y'] });
  assert.deepEqual(m.conflicts.map((c) => c.pointer), ['/title', '/tags']);
  assert.deepEqual(m.added, ['/cta/color']);
  assert.deepEqual(m.untouched, ['/cta/href']);
  assert.deepEqual(mergeJson(existing, incoming, 'existing').value, { title: 'Old', cta: { label: 'Go', href: '/a', color: 'red' }, tags: ['x'] });
});

test('pointer helpers edit nested content immutably', () => {
  const doc = { a: { 'b/c': [1, 2, 3] } };
  assert.equal(toPointer(['a', 'b/c', 1]), '/a/b~1c/1');
  assert.deepEqual(fromPointer('/a/b~1c/1'), ['a', 'b/c', '1']);
  assert.deepEqual(setAt(doc, ['a', 'b/c', 1], 9), { a: { 'b/c': [1, 9, 3] } });
  assert.deepEqual(removeAt(doc, ['a', 'b/c', 0]), { a: { 'b/c': [2, 3] } });
  assert.deepEqual(doc, { a: { 'b/c': [1, 2, 3] } });
  const renamed = renameKeyAt({ x: 1, y: 2, z: 3 }, [], 'y', 'w');
  assert.deepEqual(Object.keys(renamed as object), ['x', 'w', 'z']);
  assert.throws(() => renameKeyAt({ x: 1, y: 2 }, [], 'y', 'x'), /already exists/);
});

test('HTML-safe JSON output parses to the same value', () => {
  const v = { s: '</script><script>alert(1)</script> & \u2028' };
  const out = stringifyForHtml(v);
  assert.doesNotMatch(out, /[<>&\u2028]/);
  assert.deepEqual(JSON.parse(out), v);
  assert.equal(escapeJsonText(out), out);
});

test('sanitizer strips script, event handlers and script URLs, keeps safe HTML', () => {
  const input = {
    plain: 'Tom & Jerry say 1 < 2',
    rich: '<p class="lead">Hi <b>there</b> <a href="https://x.test" target="_blank">x</a></p>',
    xss: '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">y</a>',
    svg: '<svg onload=alert(1)>',
    url: ' java\tscript:alert(1)',
    img: 'data:image/png;base64,AAAA',
    html: 'data:text/html,<script>alert(1)</script>',
    nested: { list: ['<iframe src="https://evil.test"></iframe>ok'] },
  };
  const r = sanitizeContent(input);
  const v = r.value as typeof input;
  assert.equal(v.plain, input.plain);
  assert.equal(v.rich, '<p class="lead">Hi <b>there</b> <a href="https://x.test" target="_blank" rel="noopener">x</a></p>');
  assert.doesNotMatch(v.xss, /onerror|script|javascript/i);
  assert.equal(v.svg, '');
  assert.equal(v.url, '');
  assert.equal(v.img, input.img);
  assert.equal(v.html, '');
  assert.equal(v.nested.list[0], 'ok');
  // '/rich' only gets rel="noopener" added: normalised, not reported as a removal.
  assert.deepEqual(r.changed.map((c) => c.pointer).sort(), ['/html', '/nested/list/0', '/svg', '/url', '/xss']);
  assert.equal(r.errors.length, 0);
  assert.ok(isDangerousUrl('JaVaScRiPt:alert(1)'));
});

test('sanitizer refuses dangerous keys, and with policy "reject" refuses unsafe HTML', () => {
  const bad = parseJsonDetailed('{"__proto__":{"x":1},"ok":{"constructor":1},"a<b":1}').value;
  const r = sanitizeContent(bad);
  assert.deepEqual(r.errors.map((e) => e.pointer), ['/__proto__', '/ok/constructor', '/a<b']);
  const rej = sanitizeContent({ t: '<script>x</script>' }, 'reject');
  assert.equal(rej.errors.length, 1);
});

test('typical CMS markup is kept and not reported', () => {
  const kept = [
    '<p style="color:#c00;text-align:center">Red</p>',
    '<span class="price" data-sku="123">$9.99</span>',
    '<div id="hero" role="banner" aria-label="Hero">x</div>',
    '<img src="https://cdn.x.com/a.png" alt="a" loading="lazy" srcset="a.png 1x, a@2x.png 2x" />',
    '<u>u</u> <font color="red">f</font> <center>c</center>',
    '<iframe src="https://www.youtube.com/embed/abc" allowfullscreen></iframe>',
    '<video controls src="https://cdn.x.com/v.mp4"></video>',
    '<button class="cta">Buy</button>',
    '<table border="1" cellpadding="2"><tr><td colspan="2" rowspan="1">a</td></tr></table>',
    '<a href="/offers" target="_blank" rel="noopener">x</a>',
  ];
  for (const s of kept) {
    const r = sanitizeString(s);
    assert.equal(r.reason, undefined, s);
    assert.equal(r.value, s, s);
  }
  // Formatting-only differences are stored normalised but not reported.
  const br = sanitizeString('a<br>b<!-- note --><p style="COLOR: red">x</p>');
  assert.equal(br.reason, undefined);
  assert.equal(br.value, 'a<br />b<p style="color:red">x</p>');
});

test('removals are described, and bypass attempts are still caught', () => {
  const cases: Array<[string, RegExp]> = [
    ['<img src=x onerror=alert(1)>', /onerror="alert\(1\)" on <img>/],
    ['<p style="color:red;position:fixed;top:0">x</p>', /style "position" on <p>, style "top" on <p>/],
    ['<p style="background:url(javascript:alert(1))">x</p>', /style "background" on <p>/],
    ['<div style="width:expression(alert(1))">x</div>', /style "width" on <div>/],
    ['<iframe src="https://evil.example/x"></iframe>', /src="https:\/\/evil.example\/x" on <iframe>/],
    ['<a href="jav&#x09;ascript:alert(1)">x</a>', /href=.* on <a>/],
    ['<img srcset="a.png 1x, javascript:alert(1) 2x" src="a.png">', /srcset=.* on <img>/],
    ['<!-- a --!><img src=x onerror=alert(1)> -->', /onerror/],
    ['<form action="https://evil"><input name=p></form>', /<form>.*<input>/],
    ['<svg onload=alert(1)>', /<svg>/],
  ];
  for (const [s, re] of cases) {
    const r = sanitizeString(s);
    assert.match(r.reason ?? '', re, s);
    assert.doesNotMatch(r.value, /onerror|onload|javascript|expression|evil|<form|<svg|position/i, s);
  }
  assert.equal(sanitizeString('<iframe src="https://evil.example/x"></iframe>ok').value, 'ok');
});

test('HTML rules are configurable per environment and cannot allow script', () => {
  const rules = { ...DEFAULT_HTML_RULES, extraTags: ['marquee'], extraAttributes: { a: ['ping'] }, iframeHosts: [] };
  assert.equal(sanitizeString('<marquee>hi</marquee>', rules).reason, undefined);
  assert.equal(sanitizeString('<a href="/x" ping="/p">x</a>', rules).reason, undefined);
  assert.match(sanitizeString('<iframe src="https://www.youtube.com/embed/a"></iframe>', rules).reason ?? '', /iframe/);
  assert.throws(() => validateHtmlRules({ ...DEFAULT_HTML_RULES, extraTags: ['script'] }), /cannot be allowed/);
  assert.throws(() => validateHtmlRules({ ...DEFAULT_HTML_RULES, extraAttributes: { '*': ['onclick'] } }), /cannot be allowed/);

  const cfg = loadConfig({ CAAS_HTML_EXTRA_TAGS: 'marquee', CAAS_HTML_EXTRA_ATTRIBUTES: 'a:ping,*:itemref', CAAS_HTML_IFRAME_HOSTS: 'none' });
  assert.deepEqual(cfg.html.extraTags, ['marquee']);
  assert.deepEqual(cfg.html.extraAttributes, { a: ['ping'], '*': ['itemref'] });
  assert.deepEqual(cfg.html.iframeHosts, []);
  assert.throws(() => loadConfig({ CAAS_HTML_EXTRA_TAGS: 'style' }), /cannot be allowed/);
  assert.throws(() => loadConfig({ CAAS_HTML_EXTRA_ATTRIBUTES: 'img' }), /expected tag:attribute/);
});
