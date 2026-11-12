import test from 'node:test';
import assert from 'node:assert/strict';
import { lineWindow, humanSize, humanAge, previewKind, previewPlacement, PreviewCache, PreviewRequests } from '../src/lib/path-preview.ts';
import { ansiToHtml } from '../src/lib/ansi.ts';

test('20-line windows centre, clamp at either end, and preserve untrusted text literally', () => {
  const text = Array.from({ length: 100 }, (_, i) => i === 49 ? '<img onerror=alert(1)>' : `${i + 1}`).join('\n');
  const middle = lineWindow(text, 50);
  assert.equal(middle.length, 20);
  assert.equal(middle[0].number, 40);
  assert.deepEqual(middle[10], { number: 50, text: '<img onerror=alert(1)>', highlight: true });
  assert.equal(lineWindow(text, 1)[0].number, 1);
  assert.equal(lineWindow(text, 100)[0].number, 81);
  assert.equal(lineWindow(text, 999)[19].number, 100);
  assert.equal(lineWindow('a\r\nb', 0).length, 2);
  assert.equal(lineWindow('a', 0)[0].highlight, false);
});
test('metadata blocks HTML, SVG, PDFs, videos and oversized files even if API says text', () => {
  for (const [path, mime] of [['/x/a.svg', 'text/plain'], ['/x/a.html', 'text/plain'], ['/x/a.txt', 'image/svg+xml'], ['/x/a.pdf', 'application/pdf'], ['/x/a.mov', 'video/quicktime']]) {
    assert.equal(previewKind(path, { mime, kind: 'text' }), 'metadata');
  }
  assert.equal(previewKind('/x/a.png', { mime: 'image/png', kind: 'binary' }), 'image');
  assert.equal(previewKind('/x/a.png', { mime: 'text/html', kind: 'text' }), 'metadata');
  assert.equal(previewKind('/x/a.png', { mime: 'image/png', kind: 'binary', tooBig: true }), 'metadata');
  assert.equal(previewKind('/x/a.ts', { mime: 'text/plain', kind: 'text' }), 'text');
});
test('placement stays inside viewport and to one side of pointer, including narrow viewports', () => {
  for (const vw of [320, 800, 1440]) for (const x of [1, vw / 2, vw - 1]) for (const y of [1, 300, 599]) {
    const p = previewPlacement(x, y, 560, 360, vw, 600);
    assert.ok(p.left >= 0 && p.left + p.width <= vw);
    assert.ok(p.top >= 0 && p.top + p.maxHeight <= 600);
    assert.ok(x < p.left || x > p.left + p.width);
  }
});
test('cache expires at 30s, refreshes recency, caps at 50 and separates hosts', () => {
  const cache = new PreviewCache<number>();
  for (let i = 0; i < 50; i++) cache.set(`h|${i}`, i, 0);
  assert.equal(cache.get('h|0', 1), 0);
  cache.set('remote|0', 51, 2);
  assert.equal(cache.get('h|1', 2), undefined);
  assert.equal(cache.get('h|0', 2), 0);
  assert.equal(cache.get('remote|0', 2), 51);
  assert.equal(cache.get('h|0', 30_000), undefined);
});
test('human sizes and ages use API milliseconds', () => {
  assert.equal(humanSize(100), '100 B');
  assert.equal(humanSize(1536), '1.5 KB');
  assert.equal(humanSize(2 * 1024 ** 2), '2.0 MB');
  assert.equal(humanAge(0, 120000), 'hace 2 min');
  assert.equal(humanAge(0, 86400000), 'hace 1 d');
});
test('line and column suffix exposes escaped data attributes without changing path clicks', () => {
  const html = ansiToHtml('/tmp/example.ts:42:7');
  assert.match(html, /data-fs-line="42"/);
  assert.match(html, /data-fs-path="\/tmp\/example.ts"/);
  assert.doesNotMatch(html, /href=|onclick=/);
});

test('preview lines are bounded, omit only the phantom trailing line, and cache the bounded window', () => {
  const lines = lineWindow('x'.repeat(2_000_000) + '\n', 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'x'.repeat(300) + '…');
  assert.equal(lineWindow('x'.repeat(300))[0].text.length, 300);
  assert.equal(lineWindow('a\n\n').length, 2);
  assert.equal(lineWindow('').length, 1);
  const cache = new PreviewCache<ReturnType<typeof lineWindow>>();
  cache.set('host|path', lines);
  assert.equal(cache.get('host|path')?.[0].text.length, 301);
});
test('size rounding rolls into MB and non-finite sizes and ages are unknown', () => {
  assert.equal(humanSize(1048575), '1.0 MB');
  assert.equal(humanSize(1024), '1.0 KB');
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(humanSize(value), '—');
    assert.equal(humanAge(value), '—');
    assert.equal(humanAge(0, value), '—');
  }
});

test('latest request aborts a hung predecessor without waiting for it', async () => {
  const requests = new PreviewRequests();
  let firstSignal: AbortSignal | undefined;
  const first = requests.run((signal) => { firstSignal = signal; return new Promise<never>(() => {}); });
  const second = requests.run(async (signal) => { assert.equal(signal.aborted, false); return 'new host'; });
  assert.equal(firstSignal?.aborted, true);
  assert.equal(await first, undefined);
  assert.equal(await second, 'new host');
});
test('leave cancellation and timeout settle even if transport ignores abort; failures can retry', async () => {
  const requests = new PreviewRequests();
  let signal: AbortSignal | undefined;
  const leaving = requests.run((s) => { signal = s; return new Promise<never>(() => {}); });
  requests.cancel();
  assert.equal(signal?.aborted, true);
  assert.equal(await leaving, undefined);
  const timedOut = requests.run((s) => { signal = s; return new Promise<never>(() => {}); }, 5);
  assert.equal(await timedOut, undefined);
  assert.equal(signal?.aborted, true);
  assert.equal(await requests.run(async () => { throw new Error('transient'); }), undefined);
  assert.equal(await requests.run(async () => 'retry'), 'retry');
});
