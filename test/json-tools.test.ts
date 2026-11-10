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
import { isDangerousUrl, sanitizeContent } from '../lib/caas/sanitize';

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
  assert.equal(v.rich, '<p class="lead">Hi <b>there</b> <a href="https://x.test" target="_blank" rel="noopener noreferrer">x</a></p>');
  assert.doesNotMatch(v.xss, /onerror|script|javascript/i);
  assert.equal(v.svg, '');
  assert.equal(v.url, '');
  assert.equal(v.img, input.img);
  assert.equal(v.html, '');
  assert.equal(v.nested.list[0], 'ok');
  assert.deepEqual(r.changed.map((c) => c.pointer).sort(), ['/html', '/nested/list/0', '/rich', '/svg', '/url', '/xss']);
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
