import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { COMPACT_MOSAIC_QUERY, MOSAIC_DESKTOP_QUERY, DESKTOP_QUERY, MOSAIC_QUERY } from "../src/lib/use-media-query.ts";
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

// Evaluate the exported JavaScript media-query conditions at both sides of every boundary.
const matchesViewport = (query: string, width: number, height: number) =>
  query.split(",").some((alternative) => [...alternative.matchAll(/\((min|max)-(width|height): (\d+)px\)/g)]
    .every(([, bound, axis, value]) => {
      const size = axis === "width" ? width : height;
      return bound === "min" ? size >= Number(value) : size <= Number(value);
    }));

test("compact mosaic covers every mosaic viewport; desktop layouts depend only on width", () => {
  for (const [width, height, compact, desktop] of [
    [412, 915, false, false], [599, 700, false, false],
    [600, 800, true, false], [700, 1000, true, false],
    [884, 1104, true, false], [1000, 700, true, false],
    [1023, 800, true, false], [1024, 799, true, true],
    [1280, 700, true, true], [1024, 800, true, true], [1280, 800, true, true],
    [1440, 900, true, true], [1920, 1080, true, true],
  ] as const) {
    assert.equal(matchesViewport(COMPACT_MOSAIC_QUERY, width, height), compact, `${width}x${height} compact`);
    assert.equal(matchesViewport(MOSAIC_DESKTOP_QUERY, width, height), desktop, `${width}x${height} desktop`);
  }
});


test("stylesheet keeps compact, fine-pointer and full-label breakpoints aligned", () => {
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(css, /@media \(min-width: 600px\)\s*\{\s*\.mosaic \{ --mosaic-target: 40px;/);
  assert.match(css, /@media \(min-width: 1024px\) and \(pointer: fine\)\s*\{\s*\.mosaic \{ --mosaic-target: 32px;/);
  assert.match(css, /@media \(min-width: 1280px\)\s*\{\s*\.mosaic-full-label \{ display: inline; \}/);
});
