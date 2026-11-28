// Photo-like tool picture for the tool library: true to scale, and without a screen it falls back to the line drawing
import test from "node:test";
import assert from "node:assert/strict";
import { libraryMesh, rasterize, toolImageTag } from "../src/toolRender.ts";
import { toolSideSvg, toolEndSvg, type ToolGeom } from "../src/toolGraphics.ts";

const g: ToolGeom = { type: "endmill", diameter: 6, shankDia: 6, fluteLen: 20, length: 50, flutes: 2, helix: "up", angle: 90, tipDia: 0, cornerR: 0 };
const mesh = () => libraryMesh(g, [[0, 0], [3, 0], [3, 20]], [[3, 20], [3, 50]], [1, 0, 0]);

test("side picture: the shank fills the full width, the picture is as tall as the tool", () => {
  const W = 60, H = 500, px = rasterize(mesh(), "side", { x0: -3, x1: 3, y0: 0, y1: 50 }, W, H);
  const row = (y: number) => { let n = 0; for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3]) n++; return n; };
  assert.equal(row(100), W, "shank: 6 mm = whole width");
  assert.ok(row(2) >= W - 1 && row(H - 3) > 0, "top and tip are inside the picture");
  assert.ok(row(400) < W, "flutes: narrower than the full diameter somewhere");
});

test("colour ring of the tool sits on the shank", () => {
  const W = 60, H = 500, px = rasterize(mesh(), "side", { x0: -3, x1: 3, y0: 0, y1: 50 }, W, H);
  let red = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 120 && px[i + 1] < 60 && px[i + 2] < 60) red++;
  assert.ok(red > 200, `${red} red pixels`);
});

test("end picture: round, inside the cutter diameter", () => {
  const S = 80, px = rasterize(mesh(), "end", { x0: -3, x1: 3, y0: -3, y1: 3 }, S, S);
  assert.equal(px[3], 0, "corner stays empty");
  assert.equal(px[((S / 2) * S + S / 2) * 4 + 3], 255, "centre is filled");
});

test("without a screen: no picture, the drawing falls back to lines", () => {
  assert.equal(toolImageTag({ g, cut: [[0, 0], [3, 0], [3, 20]], rest: [[3, 20], [3, 50]] }, "side", { x0: -3, x1: 3, y0: 0, y1: 50 }, 30, 250, ""), null);
  const svg = toolSideSvg(g, { w: 120, h: 300, dims: true });
  assert.ok(svg.includes("<path") && !svg.includes("<image"));
  assert.ok(svg.includes("Ø 6"));
  assert.ok(toolEndSvg(g, 80).includes("<circle"));
});
