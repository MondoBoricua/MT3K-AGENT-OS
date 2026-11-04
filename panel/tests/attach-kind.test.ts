import assert from "node:assert/strict";
import test from "node:test";
import { attachKind } from "../src/lib/attach-kind.ts";

test("attachKind: JPEG de iPhone sin MIME → imagen", () => {
  assert.equal(attachKind("IMG_0001.jpeg", ""), "image");
});

test("attachKind: HEIC en mayúsculas sin MIME → imagen", () => {
  assert.equal(attachKind("IMG_0002.HEIC", ""), "image");
});

test("attachKind: PNG con type correcto → imagen", () => {
  assert.equal(attachKind("foo.png", "image/png"), "image");
});

test("attachKind: ejecutable sin pistas → null", () => {
  assert.equal(attachKind("x.exe", ""), null);
});

test("attachKind: PDF por extensión", () => {
  assert.equal(attachKind("doc.pdf", ""), "pdf");
});

test("attachKind: audio sin MIME → audio", () => {
  assert.equal(attachKind("voz.m4a", ""), "audio");
});

test("attachKind: HEIC/webp y octet-stream (cross-review r2)", () => {
  assert.equal(attachKind("blob", "image/heic"), "image");
  assert.equal(attachKind("mi.foto.final.heic", ""), "image");
  assert.equal(attachKind("IMG_0001.heic", "application/octet-stream"), "image");
  assert.equal(attachKind("x.bin", "application/octet-stream"), null);
});
