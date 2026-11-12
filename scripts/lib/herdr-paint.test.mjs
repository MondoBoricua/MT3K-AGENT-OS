import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { paintToAnsiLines } from './herdr-paint.mjs';

const E = '\x1b';
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');
const paint = (text, options = {}) => paintToAnsiLines(Buffer.from(text), { cols: 20, rows: 5, ...options });

test('CR, LF, BS and TAB; LF keeps column', () => {
  assert.deepEqual(paint('abc\rX\nY\bZ\tQ').lines, ['Xbc', ' Z      Q', '', '', '']);
});
test('cursor movements A/B/C/D/G/H/f use 1-based coordinates and default one', () => {
  assert.deepEqual(paint('abcd\x1b[2DX\x1b[2CY\x1b[2BZ\x1b[AW\x1b[3GQ\x1b[4;2HR\x1b[5;3fS').lines,
    ['abXd Y', '  Q    W', '      Z', ' R', '  S']);
  assert.equal(paint(`${E}[999;999HX`).lines[4], ' '.repeat(19) + 'X');
  assert.equal(paint(`${E}[H${E}[A${E}[DX`).lines[0], 'X');
});
test('delayed wrap, combining marks and deliberately simple wide glyphs', () => {
  assert.deepEqual(paint('abcde\rZ', { cols: 5, rows: 2 }).lines, ['Zbcde', '']);
  assert.deepEqual(paint('abcdef', { cols: 5, rows: 2 }).lines, ['abcde', 'f']);
  assert.equal(paint('界😀e\u0301X').lines[0], '界😀e\u0301X');
});
test('SGR changes are re-emitted at cell boundaries; rows close attributes', () => {
  assert.deepEqual(paint(`${E}[31mred\r\nred${E}[0m!`).lines.slice(0, 2), [`${E}[31mred${E}[0m`, `${E}[31mred${E}[0m!`]);
  assert.equal(paint(`${E}[1;31mA${E}[22;39mB`).lines[0], `${E}[1;31mA${E}[0mB`);
  assert.equal(paint(`${E}[38;2;1;2;3;48;5;7mX`).lines[0], `${E}[38;2;1;2;3;48;5;7mX${E}[0m`);
  assert.equal(paint(`${E}[31mabc\r${E}[32mZ`).lines[0], `${E}[32mZ${E}[0m${E}[31mbc${E}[0m`);
});
test('SGR off codes restore default attributes and state stays bounded', () => {
  assert.equal(paint(`${E}[1;2;3;4;5;7;8;9;31;41;58;5;1mA${E}[22;23;24;25;27;28;29;39;49;59mB`).lines[0].endsWith(`${E}[0mB`), true);
  const out = paint(`${E}[31m`.repeat(100000) + 'X');
  assert.equal(out.lines[0], `${E}[31mX${E}[0m`);
});
for (const [mode, expected] of [[0, 'ab'], [1, '   de'], [2, '']]) {
  test(`EL ${mode}`, () => assert.equal(paint(`abcde${E}[3G${E}[${mode}K`).lines[0], expected));
}
for (const [mode, expected] of [
  [0, ['111', '2', '', '', '']], [1, ['', '  2', '333', '', '']], [2, ['', '', '', '', '']],
]) {
  test(`ED ${mode}`, () => assert.deepEqual(paint(`111\r\n222\r\n333${E}[2;2H${E}[${mode}J`).lines, expected));
}
test('ED3 drops scrollback; ED2 keeps it', () => {
  const input = 'one\r\ntwo\r\nthree\r\nfour';
  assert.deepEqual(paint(input + `${E}[3J`, { rows: 2 }).lines, ['three', 'four']);
  assert.deepEqual(paint(input + `${E}[2J`, { rows: 2 }).lines, ['one', 'two', '', '']);
});
test('LF scrolling keeps all history above the visible screen', () => {
  assert.deepEqual(paint('a\r\nb\r\nc\r\nd', { rows: 2 }).lines, ['a', 'b', 'c', 'd']);
});
for (const [save, restore] of [[`${E}7`, `${E}8`], [`${E}[s`, `${E}[u`]]) {
  test(`cursor and SGR save/restore ${JSON.stringify(save)}`, () => {
    assert.equal(paint(`${E}[31mA${save}${E}[2;3H${E}[0mX${restore}B`).lines[0], `${E}[31mAB${E}[0m`);
  });
}
for (const mode of [47, 1047, 1049]) {
  test(`alternate screen ${mode} starts blank and restores main history and attributes`, () => {
    const start = `a\r\nb\r\nc${E}[31m${E}[?${mode}h`;
    assert.deepEqual(paint(start + 'ALT', { rows: 2 }).lines, ['ALT', '']);
    assert.deepEqual(paint(start + `ALT${E}[?${mode}h${E}[?${mode}lX`, { rows: 2 }).lines, ['a', 'b', `c${E}[31mX${E}[0m`]);
  });
}
test('OSC/DCS/charset/modes/soft reset and unknown CSI are consumed', () => {
  const controls = `${E}]0;secret-title\x07${E}]8;;https://example.test${E}\\${E}Popaque${E}\\${E}(B${E}[!p${E}[?2004h${E}[=0;1u${E}[99z`;
  assert.equal(paint('before' + controls + 'after').lines[0], 'beforeafter');
  assert.equal(paint('x\u009dhidden\u009cy').lines[0], 'xy');
});
test('trims trailing blank cells even with attributes', () => {
  assert.equal(paint(`${E}[31mX   `).lines[0], `${E}[31mX${E}[0m`);
});
test('caps input, dimensions and total retained rows; malformed bytes never throw', () => {
  assert.equal(paint(Buffer.alloc(2 * 1024 * 1024 + 1)).complete, false);
  assert.equal(paint('', { cols: 1001 }).complete, false);
  assert.equal(paint('', { rows: 5001 }).complete, false);
  const result = paint('\r\n'.repeat(6000), { rows: 2 });
  assert.equal(result.complete, false); assert.equal(result.lines.length, 5000);
  assert.equal(paintToAnsiLines(Symbol('invalid')).complete, false);
  assert.doesNotThrow(() => paintToAnsiLines('ok', null));
  assert.doesNotThrow(() => paintToAnsiLines('ok', { cols: Symbol('invalid') }));
  assert.doesNotThrow(() => paintToAnsiLines(Buffer.from([0xff, 0x1b, 0x5b])));
});
test('golden: reviewed, secret-scanned 1426-byte prefix of real 96x43 repaint', () => {
  // Trim ends on CRLF, before the next heading. No tokens/keys/private paths in
  // this prefix; it was inspected as JSON and scanned before adding the fixture.
  const sample = readFileSync(new URL('./fixtures/herdr-paint-sample.bin', import.meta.url));
  assert.equal(sample.length, 1426);
  const result = paintToAnsiLines(sample, { cols: 96, rows: 43 });
  assert.equal(result.complete, true);
  assert.equal(plain(result.lines[7]), '  Quién la hace');
  assert.match(result.lines[4], /\x1b\[38;2;177;185;249mdev\.herdr\.mobile/);
  assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), 'f30c43089e6e962ca94ec836d4e665a465d5bf05ac56a0c52ba29d2153ca5fa7');
});
test('property: arbitrary bytes never produce non-SGR escape/control sequences', () => {
  let seed = 42;
  for (let j = 0; j < 200; j++) {
    const bytes = Buffer.alloc(512);
    for (let i = 0; i < bytes.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bytes[i] = seed >>> 24; }
    const { lines } = paintToAnsiLines(bytes, { cols: 80, rows: 10 });
    assert.doesNotMatch(plain(lines.join('')), /[\x00-\x1f\x7f-\x9f]/);
  }
});
test('pathological inputs each finish within 200ms', t => {
  for (const input of [`${E}[C`.repeat(100000), `${E}]` + 'x'.repeat(100000), `ok${E}`]) {
    const start = performance.now(); const result = paint(input); const elapsed = performance.now() - start;
    t.diagnostic(`pathological ${Buffer.byteLength(input)} bytes: ${elapsed.toFixed(2)}ms`);
    assert.ok(elapsed < 200, `${elapsed}ms`);
    if (!input.endsWith('C')) assert.equal(result.complete, false);
  }
});
