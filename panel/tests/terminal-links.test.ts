import assert from "node:assert/strict";
import test from "node:test";
import { ansiToHtml } from "../src/lib/ansi.ts";
import { branchTarget, branchTitle, branchTitles, parentDir, type GitRef } from "../src/lib/terminal-links.ts";

const fsLinks = (html: string) => [...html.matchAll(/data-fs-path="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
const branchLinks = (html: string) => [...html.matchAll(/data-git-branch="([^"]*)"[^>]*>([^<]*)</g)].map((m) => m[1]);
const BR = new Map([["master", "GitHub: o/r@master"], ["feat/panel-links", "local: /w"], ["v1.2", "local: /r"]]);
const CODE = (t: string) => `\x1b[38;5;153m${t}\x1b[39m`; // Claude Code inline code (measured)

test("POSIX, ~ and Windows paths become data-fs-path links", () => {
  assert.deepEqual(fsLinks(ansiToHtml("open /Users/mondo/x.ts now")), [["/Users/mondo/x.ts", "/Users/mondo/x.ts"]]);
  assert.deepEqual(fsLinks(ansiToHtml("see /private/tmp/a/b and /home/u/c")), [["/private/tmp/a/b", "/private/tmp/a/b"], ["/home/u/c", "/home/u/c"]]);
  assert.deepEqual(fsLinks(ansiToHtml("in ~/Developer/app")), [["~/Developer/app", "~/Developer/app"]]);
  assert.deepEqual(fsLinks(ansiToHtml("at C:\\Users\\mondo\\x.txt ok")), [["C:\\Users\\mondo\\x.txt", "C:\\Users\\mondo\\x.txt"]]);
});

test(":line and :line:col stay in the text, not in the path", () => {
  assert.deepEqual(fsLinks(ansiToHtml("/a/b.ts:12")), [["/a/b.ts", "/a/b.ts:12"]]);
  assert.deepEqual(fsLinks(ansiToHtml("(/a/b.ts:12:5)")), [["/a/b.ts", "/a/b.ts:12:5"]]);
});

test("trailing prose punctuation and closing quotes are not part of the path", () => {
  assert.deepEqual(fsLinks(ansiToHtml("edit /a/b/c.")), [["/a/b/c", "/a/b/c"]]);
  assert.deepEqual(fsLinks(ansiToHtml("(see /a/b/c), then /d/e/f; /g/h!")), [["/a/b/c", "/a/b/c"], ["/d/e/f", "/d/e/f"], ["/g/h", "/g/h"]]);
  assert.deepEqual(fsLinks(ansiToHtml('"/a/b/c" and `/d/e/f` and \'/g/h\'')), [["/a/b/c", "/a/b/c"], ["/d/e/f", "/d/e/f"], ["/g/h", "/g/h"]]);
  assert.deepEqual(fsLinks(ansiToHtml("/a/b/c:")), [["/a/b/c", "/a/b/c"]]);
});

test("relative paths, bare names, slash commands and lone roots are not linked", () => {
  for (const t of ["src/lib/ansi.ts", "./x/y", "../x/y", "file.txt", "/review", "/clear now", "and/or", "a / b", "src/Users/x/y", "~", "file:///Users/x/y"]) {
    assert.deepEqual(fsLinks(ansiToHtml(t)), [], t);
  }
});

test("a path inside an http(s) URL stays part of the URL link only", () => {
  const html = ansiToHtml("go https://github.com/Users/foo/bar now");
  assert.deepEqual(fsLinks(html), []);
  assert.match(html, /<a href="https:\/\/github\.com\/Users\/foo\/bar" target="_blank"/);
});

test("branch: exact token in a code-styled run only", () => {
  assert.deepEqual(branchLinks(ansiToHtml(`merge ${CODE("master")} please`, { branches: BR })), ["master"]);
  assert.deepEqual(branchLinks(ansiToHtml(`on ${CODE("master")}.`, { branches: BR })), ["master"]);
  assert.deepEqual(branchLinks(ansiToHtml(`(${CODE("feat/panel-links")}, ${CODE("master")})`, { branches: BR })), ["feat/panel-links", "master"]);
  assert.deepEqual(branchLinks(ansiToHtml(`${CODE("v1.2")}`, { branches: BR })), ["v1.2"]);
});

test("branch: plain, grey or inverse text, no branch list, and substrings are not linked", () => {
  assert.deepEqual(branchLinks(ansiToHtml("merge master please", { branches: BR })), []);
  assert.deepEqual(branchLinks(ansiToHtml("\x1b[38;5;246mmaster\x1b[39m", { branches: BR })), []);
  assert.deepEqual(branchLinks(ansiToHtml("\x1b[7m\x1b[38;5;153mmaster\x1b[0m", { branches: BR })), []);
  assert.deepEqual(branchLinks(ansiToHtml(CODE("master"))), []);
  assert.deepEqual(branchLinks(ansiToHtml(CODE("master"), { branches: new Map() })), []);
  for (const t of ["mastering", "master-2", "origin/master", "pre-master", "masters", "feat/panel-links/x", "xfeat/panel-links"]) {
    assert.deepEqual(branchLinks(ansiToHtml(CODE(t), { branches: BR })), [], t);
  }
});

test("branch: a coloured run that merely CONTAINS the name is not linked (diff line, code, string, unicode word)", () => {
  const green = (t: string) => `\x1b[32m${t}\x1b[0m`;
  assert.deepEqual(branchLinks(ansiToHtml(green("+ master"), { branches: BR })), []);
  assert.deepEqual(branchLinks(ansiToHtml(CODE("main() master()"), { branches: BR })), []);
  assert.deepEqual(branchLinks(ansiToHtml(CODE('"master" is'), { branches: BR })), []);
  assert.deepEqual(branchLinks(ansiToHtml(CODE("émasteré"), { branches: BR })), []);
  assert.deepEqual(branchLinks(ansiToHtml(CODE("master branch"), { branches: BR })), []);
});

test("branch: whole run equal to the name (positive control, quotes/space/punctuation trimmed, wrapper kept as text)", () => {
  const BR2 = new Map([["feat/panel-motion", "t"], ["master", "t"]]);
  assert.deepEqual(branchLinks(ansiToHtml(CODE("feat/panel-motion"), { branches: BR2 })), ["feat/panel-motion"]);
  assert.deepEqual(branchLinks(ansiToHtml(CODE("master"), { branches: BR2 })), ["master"]);
  const html = ansiToHtml(CODE(' "master". '), { branches: BR2 });
  assert.deepEqual(branchLinks(html), ["master"]);
  assert.match(html, /> "<a data-git-branch="master"[^>]*>master<\/a>"\. <\/span>/);
});

test("pathological lines stay linear: long punctuation run after a path, many paths, long URL tail (50k units < 200 ms)", () => {
  const cases = ["/a/b" + ".".repeat(50000) + "x", " /a/b".repeat(50000), "https://a.io/x" + ".".repeat(50000) + "x", "/a/b" + ":1".repeat(25000)];
  for (const input of cases) {
    const t0 = performance.now();
    ansiToHtml(input);
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `${input.slice(0, 20)}… took ${ms.toFixed(0)} ms`);
  }
});

test("branch inside a path or URL is not linked", () => {
  assert.deepEqual(branchLinks(ansiToHtml(CODE("/Users/mondo/master/x"), { branches: BR })), []);
  assert.deepEqual(branchLinks(ansiToHtml(CODE("https://github.com/o/r/tree/master"), { branches: BR })), []);
});

test("output has no href other than http(s), no event handlers, no file:/javascript:", () => {
  const nasty = [
    "/Users/a\"onclick=\"x/y", "<script>/a/b</script>", "C:\\a\\\"><img src=x onerror=1>", "javascript:alert(1) /a/b",
    CODE("master"), "https://e.com/\"onmouseover=\"1", "~/x'/y",
  ].join("\n");
  const html = ansiToHtml(nasty, { branches: BR });
  for (const m of html.matchAll(/href="([^"]*)"/g)) assert.match(m[1], /^https?:\/\//);
  // all text is escaped, so every "<" opens one of our own tags; none may carry an event handler
  for (const tag of html.matchAll(/<[^>]*>/g)) assert.match(tag[0], /^<\/?(span|a)\b/);
  for (const tag of html.matchAll(/<[^>]*>/g)) assert.doesNotMatch(tag[0], /\son\w+=/i);
  assert.doesNotMatch(html, /href="(?!https?:)/);
  for (const m of html.matchAll(/<a (?![^>]*href="https?:)[^>]*>/g)) assert.doesNotMatch(m[0], /href=/);
});

test("with no options the output equals today's plus path links (URLs unchanged)", () => {
  assert.equal(ansiToHtml("plain text"), '<span style="">plain text</span>');
  assert.match(ansiToHtml("see https://a.io/x."), /<a href="https:\/\/a\.io\/x" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">https:\/\/a\.io\/x<\/a>\.<\/span>$/);
});

const ref = (o: Partial<GitRef>): GitRef => ({ name: "b", current: false, pushed: false, url: null, worktree: null, ...o });

test("click target: GitHub url when pushed, else worktree, else repo root; only github.com opens", () => {
  const gh = "https://github.com/o/r/tree/feat/x";
  assert.deepEqual(branchTarget(ref({ url: gh, worktree: "/w" }), "/root"), { kind: "url", url: gh });
  assert.deepEqual(branchTarget(ref({ worktree: "/w" }), "/root"), { kind: "files", path: "/w" });
  assert.deepEqual(branchTarget(ref({}), "/root"), { kind: "files", path: "/root" });
  assert.equal(branchTarget(ref({}), null), null);
  assert.deepEqual(branchTarget(ref({ url: "https://evil.com/o/r/tree/x" }), "/root"), { kind: "files", path: "/root" });
  assert.deepEqual(branchTarget(ref({ url: "javascript:alert(1)" }), "/root"), { kind: "files", path: "/root" });
});

test("tooltips name the destination", () => {
  assert.equal(branchTitle(ref({ name: "feat/x", url: "https://github.com/o/r/tree/feat/x" }), "/root"), "GitHub: o/r@feat/x");
  assert.equal(branchTitle(ref({ name: "b", worktree: "/w" }), "/root"), "local: /w");
  const m = branchTitles({ ok: true, root: "/root", branches: [ref({ name: "master" })] });
  assert.equal(m.get("master"), "local: /root");
  assert.equal(branchTitles(null).size, 0);
});

test("parentDir handles both separators and roots", () => {
  assert.equal(parentDir("/a/b/c.ts"), "/a/b");
  assert.equal(parentDir("/c.ts"), "/");
  assert.equal(parentDir("C:\\u\\x.txt"), "C:\\u");
  assert.equal(parentDir("C:\\x.txt"), "C:\\");
  assert.equal(parentDir("C:/x.txt"), "C:/");
  assert.equal(parentDir("\\\\host\\share\\x.txt"), "\\\\host\\share\\");
  assert.equal(parentDir("\\\\host\\share\\d\\x.txt"), "\\\\host\\share\\d");
  assert.equal(parentDir("x"), "");
});
