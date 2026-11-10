import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LAYOUT, LAYOUT_STORAGE_KEY, parseLayout, pickActiveSlot, slotForKey, slotForShortcut, visibleSlotsFor } from "../src/lib/mosaic-layout.ts";
import { loadLayout, saveLayout } from "../src/lib/mosaic-storage.ts";

function stubStorage(initial: Record<string, string> = {}, throwing = false) {
  const data = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => {
      if (throwing) throw new Error("denied");
      return data.has(k) ? data.get(k)! : null;
    },
    setItem: (k: string, v: string) => {
      if (throwing) throw new Error("denied");
      data.set(k, v);
    },
  };
  return data;
}

test("loadLayout defaults to 2x2 when nothing is stored", () => {
  stubStorage();
  assert.equal(loadLayout(), "2x2");
  assert.equal(DEFAULT_LAYOUT, "2x2");
});

test("saveLayout persists and loadLayout reads it back", () => {
  const data = stubStorage();
  saveLayout("1x1");
  assert.equal(data.get(LAYOUT_STORAGE_KEY), "1x1");
  assert.equal(data.get("mt3k.mosaic.layout"), "1x1");
  assert.equal(loadLayout(), "1x1");
});

test("invalid stored value falls back to the default", () => {
  stubStorage({ [LAYOUT_STORAGE_KEY]: "3x3" });
  assert.equal(loadLayout(), "2x2");
  assert.equal(parseLayout(null), "2x2");
  assert.equal(parseLayout(42), "2x2");
});

test("storage failures never throw", () => {
  stubStorage({}, true);
  assert.equal(loadLayout(), "2x2");
  assert.doesNotThrow(() => saveLayout("1x1"));
});

test("pickActiveSlot: focus wins, then first non-empty, then 0", () => {
  const s = { id: 1 };
  assert.equal(pickActiveSlot([null, s, null, s], 3), 3);
  assert.equal(pickActiveSlot([null, null, s, s], null), 2);
  assert.equal(pickActiveSlot([null, null, null, null], null), 0);
  assert.equal(pickActiveSlot([null, s, null, null], 9), 1);
  assert.equal(pickActiveSlot([], null), 0);
});

test("slotForKey maps 1-4 to indexes and ignores the rest", () => {
  assert.equal(slotForKey("1"), 0);
  assert.equal(slotForKey("4"), 3);
  assert.equal(slotForKey("5"), null);
  assert.equal(slotForKey("0"), null);
  assert.equal(slotForKey("a"), null);
  assert.equal(slotForKey("12"), null);
});

test("pickActiveSlot ignores a focus on an empty slot and bounds the scan", () => {
  const s = { id: 1 };
  assert.equal(pickActiveSlot([null, s, null, null], 0), 1);
  assert.equal(pickActiveSlot([null, null, null, null, s], null), 0);
});

test("parseLayout accepts 1x2", () => {
  assert.equal(parseLayout("1x2"), "1x2");
});

test("visibleSlotsFor: 1x1 single, 1x2 pair holding active, 2x2 all", () => {
  for (const active of [0, 1, 2, 3]) {
    assert.deepEqual(visibleSlotsFor("1x1", active), [active]);
    assert.deepEqual(visibleSlotsFor("2x2", active), [0, 1, 2, 3]);
  }
  assert.deepEqual(visibleSlotsFor("1x2", 0), [0, 1]);
  assert.deepEqual(visibleSlotsFor("1x2", 1), [0, 1]);
  assert.deepEqual(visibleSlotsFor("1x2", 2), [2, 3]);
  assert.deepEqual(visibleSlotsFor("1x2", 3), [2, 3]);
});

test("slot shortcuts preserve typing, editing, composition and every modifier", () => {
  const plain = { key: "2", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false };
  assert.equal(slotForShortcut(plain, null), 1);
  assert.equal(slotForShortcut({ ...plain, key: "4" }, { tagName: "BUTTON" }), 3);
  assert.equal(slotForShortcut({ ...plain, key: "5" }, null), null);
  for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey", "isComposing"]) {
    assert.equal(slotForShortcut({ ...plain, [modifier]: true }, null), null, modifier);
  }
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(slotForShortcut(plain, { tagName }), null, tagName);
  }
  assert.equal(slotForShortcut(plain, { tagName: "SPAN", isContentEditable: true }), null);
});

test("1x2 round-trips through storage", () => {
  const data = stubStorage();
  saveLayout("1x2");
  assert.equal(data.get("mt3k.mosaic.layout"), "1x2");
  assert.equal(loadLayout(), "1x2");
});

test("visibleSlotsFor falls back to slot 0 for out-of-range or non-integer active", () => {
  for (const bad of [-1, 4, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(visibleSlotsFor("1x1", bad), [0]);
    assert.deepEqual(visibleSlotsFor("1x2", bad), [0, 1]);
    assert.deepEqual(visibleSlotsFor("2x2", bad), [0, 1, 2, 3]);
  }
});
