import assert from "node:assert/strict";
import test from "node:test";
import { DESKTOP_QUERY, MOSAIC_QUERY } from "../src/lib/use-media-query.ts";
import { layoutsForViewport, layoutForViewport } from "../src/lib/mosaic-layout.ts";

test("mosaic gate starts at 600px while desktop stays at 1024px", () => {
  const matches = (query: string, width: number) => width >= Number(query.match(/min-width: (\d+)px/)![1]);
  assert.equal(MOSAIC_QUERY, "(min-width: 600px)");
  assert.equal(DESKTOP_QUERY, "(min-width: 1024px)");
  for (const width of [412, 599, 600, 884, 1023, 1024, 1104, 1280]) {
    assert.equal(matches(MOSAIC_QUERY, width), width >= 600);
    assert.equal(matches(DESKTOP_QUERY, width), width >= 1024);
  }
});

test("tablet layouts avoid a four-tile grid below the desktop breakpoint", () => {
  assert.deepEqual(layoutsForViewport(false), ["1x1", "1x2"]);
  assert.equal(layoutForViewport("2x2", false), "1x2");
  for (const layout of ["1x1", "1x2"] as const) assert.equal(layoutForViewport(layout, false), layout);
});

test("desktop preserves every saved layout, including after a tablet fallback", () => {
  assert.deepEqual(layoutsForViewport(true), ["1x1", "1x2", "2x2"]);
  for (const saved of ["1x1", "1x2", "2x2"] as const) {
    layoutForViewport(saved, false);
    assert.equal(layoutForViewport(saved, true), saved);
  }
});
