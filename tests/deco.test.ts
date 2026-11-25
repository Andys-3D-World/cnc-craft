import test from "node:test";
import assert from "node:assert/strict";
import { makeTexture, regionOf, TEXTURE_KINDS } from "../src/deco/texture.ts";
import { inradius, nesting, ridgeDepth, ridgeHeight } from "../src/deco/ridge.ts";
import { cutterZ, laneAt, lanes, leftover, MOULD_KINDS, mouldLines, offsetOpen, profileZ, STANDING, type MouldOpts } from "../src/deco/moulding.ts";
import { pointInPoly } from "../src/polyOffset.ts";
import { distToPath } from "../src/millLead.ts";
import { profile } from "../src/view3d/carveSim.ts";
import { lintGcode } from "../src/gcodeLint.ts";

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const sq = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const ring = (cx: number, cy: number, r: number, n = 90) => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(2 * Math.PI * i / n), y: cy + r * Math.sin(2 * Math.PI * i / n) }));

// ---------- Flächenmuster ----------
test("texture: every kind stays inside the area, keeps the edge distance and leaves holes free", () => {
  const outer = sq(0, 0, 60, 40), hole = ring(30, 20, 8);
  for (const kind of TEXTURE_KINDS) for (const angle of [0, 30]) {
    const t = makeTexture([outer, hole], { kind, spacing: 3, angle, inset: 1.5, seed: 4 });
    assert.ok(!t.tooMany && t.lines.length + t.dots.length > 5, kind);
    const check = (x: number, y: number) => assert.ok(pointInPoly(x, y, outer) && distToPath({ x, y }, outer, true) >= 1.5 - 0.02 && distToPath({ x, y }, hole, true) >= 1.5 - 0.03 && !pointInPoly(x, y, hole), `${kind} ${x} ${y}`);
    for (const l of t.lines) for (let i = 1; i < l.pts.length; i++) for (let f = 0; f <= 1; f += 0.25) check(l.pts[i - 1].x + (l.pts[i].x - l.pts[i - 1].x) * f, l.pts[i - 1].y + (l.pts[i].y - l.pts[i - 1].y) * f);
    for (const d of t.dots) check(d.x, d.y);
  }
});

test("texture: straight lines have the spacing, same seed gives the same dots, limits are kept", () => {
  const t = makeTexture([sq(0, 0, 40, 40)], { kind: "lines", spacing: 5, angle: 0, inset: 0, seed: 1 });
  const ys = [...new Set(t.lines.map(l => l.pts[0].y.toFixed(3)))].map(Number).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) near(ys[i] - ys[i - 1], 5, 1e-6);
  for (const l of t.lines) near(Math.abs(l.pts[l.pts.length - 1].x - l.pts[0].x), 40, 1e-6);
  const d = (seed: number) => JSON.stringify(makeTexture([sq(0, 0, 40, 40)], { kind: "hammer", spacing: 4, angle: 0, inset: 1, seed }).dots);
  assert.equal(d(3), d(3)); assert.notEqual(d(3), d(4));
  assert.equal(makeTexture([sq(0, 0, 3000, 3000)], { kind: "lines", spacing: 0.1, angle: 0, inset: 0, seed: 1 }).tooMany, true);
  assert.deepEqual(makeTexture([], { kind: "lines", spacing: 1, angle: 0, inset: 0, seed: 1 }), { lines: [], dots: [], tooMany: false });
  assert.equal(regionOf([sq(0, 0, 4, 4)], 3).length, 0);
});

// ---------- Grat ----------
test("ridge: nesting, half stroke width and depth, worked by hand", () => {
  const letter = [sq(0, 0, 40, 10), sq(5, 3, 4, 4)];
  assert.deepEqual(nesting(letter), [0, 1]);
  near(inradius([sq(0, 0, 40, 10)]), 5, 0.06);
  near(inradius([ring(0, 0, 7, 200)]), 7, 0.1);
  assert.ok(inradius(letter) <= 5 && inradius(letter) > 4.9);
  near(inradius([sq(0, 0, 200, 2)]), 1, 0.02);
  // 60°: Höhe = Abstand / tan 30°
  const o = { angle: 60, tipDia: 0, toolDia: 20, maxDepth: 20 };
  const p = ridgeDepth(5, o);
  near(p.depth, 5 / Math.tan(Math.PI / 6), 1e-9); near(p.flat, 0); assert.equal(p.coneLimit, false);
  const q = ridgeDepth(5, { ...o, maxDepth: 4 });
  near(q.depth, 4); near(q.flat, 2 * (5 - 4 * Math.tan(Math.PI / 6)), 1e-9);
  assert.equal(ridgeDepth(5, { ...o, toolDia: 6 }).coneLimit, true);
  near(ridgeHeight(0, 4, o), -4); near(ridgeHeight(5, p.depth, o), 0, 1e-9); near(ridgeHeight(99, 4, o), 0);
});

// ---------- Profilleiste ----------
const tool = (type: string, d: number, extra = {}) => profile({ type, diameter: d, shankDia: d, fluteLen: 20, length: 40, flutes: 2, helix: "up", angle: 0, tipDia: 0, cornerR: 0, ...extra } as any);
const opts = (kind: any, type = "ball", d = 3): MouldOpts => ({ kind, width: 12, height: 8, R: d / 2, shape: tool(type, d), roughOver: 1, finishOver: 0.3, stepDown: 2, allowance: 0.3 });

test("moulding: sections start at 0, end at the depth and never leave the range", () => {
  for (const k of MOULD_KINDS) {
    near(profileZ(k, -1, 12, 8), 0); near(profileZ(k, 13, 12, 8), STANDING.includes(k) ? 0 : -8);
    for (let u = 0; u <= 12; u += 0.05) { const z = profileZ(k, u, 12, 8); assert.ok(z <= 1e-9 && z >= -8 - 1e-9, k); }
  }
  near(profileZ("round", 12, 12, 8), -8); near(profileZ("cove", 0, 12, 8), 0); near(profileZ("groove", 6, 12, 8), -8); near(profileZ("bead", 6, 12, 8), 0); near(profileZ("ogee", 6, 12, 8), -4);
});

test("moulding: no pass ever cuts below the section, finishing comes close to it", () => {
  for (const k of MOULD_KINDS) for (const [type, d, extra] of [["ball", 3, {}], ["endmill", 4, {}], ["taper", 3.175, { angle: 8, tipDia: 1 }]] as const) {
    const o = { ...opts(k, type, d), shape: tool(type, d, extra) };
    for (const l of lanes(o)) {
      for (let r = -o.R; r <= o.R + 1e-9; r += 0.02) { const h = o.shape(Math.min(o.R, Math.abs(r))); if (Number.isFinite(h)) assert.ok(l.z + h >= profileZ(k, l.u + r, o.width, o.height) - 0.06, `${k} ${type} u=${l.u} z=${l.z} r=${r} p=${profileZ(k, l.u + r, o.width, o.height)} h=${h}`); }
      if (!l.finish) assert.ok(l.z >= cutterZ(l.u, o) + o.allowance - 1e-9);
      assert.ok(l.from - l.z <= o.stepDown + 1e-6 || l.finish, `step ${l.from - l.z}`);
    }
    if (type === "ball" && k !== "steps") { const s = leftover(o); for (let u = 2; u <= 10; u += 0.1) assert.ok(s(u) >= profileZ(k, u, 12, 8) - 0.06 && s(u) <= profileZ(k, u, 12, 8) + 1.2, `${k} u=${u}`); }
  }
});

test("moulding: lanes keep their distance, corners and closed shapes", () => {
  const L = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }];
  for (const d of [2, -2, 5]) for (const r of offsetOpen(L, d)) for (const p of r) near(distToPath(p, L, false), Math.abs(d), 0.02);
  assert.equal(offsetOpen(L, 2).length, 1); // Innenecke: eine durchgehende Bahn
  const inner = offsetOpen(L, 2)[0];
  assert.ok(inner.some(p => Math.hypot(p.x - 28, p.y - 2) < 0.2));
  assert.deepEqual(offsetOpen(L, 0), [L]);
  const c = laneAt(sq(0, 0, 40, 30), true, 1, 3)[0];
  for (const p of c.pts) near(distToPath(p, sq(0, 0, 40, 30), true), 3, 0.02);
  assert.equal(laneAt(sq(0, 0, 10, 10), true, -1, 6).length, 0);
});

test("moulding: G-code passes the check, reaches the depth and never moves sideways at rapid in the material", () => {
  for (const closed of [true, false]) {
    const o = opts("ogee");
    const r = mouldLines({ paths: [{ pts: closed ? sq(50, 50, 60, 40) : [{ x: 20, y: 20 }, { x: 80, y: 20 }], closed }], side: 1, opts: o, feed: 1000, plunge: 300, safeZ: 5 });
    const zs = r.lines.map(l => /Z(-?[\d.]+)/.exec(l)).filter(Boolean).map(m => +m![1]);
    near(Math.min(...zs), Math.min(...lanes(o).map(l => l.z)), 0.001);
    const g = ["G21", "G90", "G17", "G0 Z5.00", "M3 S12000", "G4 P3", ...r.lines, "M5", "G0 X0 Y0", "M30"].join("\n");
    assert.deepEqual(lintGcode(g, { kind: "mill" }), []);
    // geschlossene Bahnen: kein Schnitt quer durch die Mitte (jede Schnittbewegung bleibt im Streifen)
    let x = 0, y = 0, z = 5;
    for (const l of r.lines) {
      const X = /X(-?[\d.]+)/.exec(l), Y = /Y(-?[\d.]+)/.exec(l), Z = /Z(-?[\d.]+)/.exec(l), nx = X ? +X[1] : x, ny = Y ? +Y[1] : y, nz = Z ? +Z[1] : z;
      if (closed && l.startsWith("G1") && (X || Y) && nz < 0) for (const f of [0.25, 0.5, 0.75]) { const q = { x: x + (nx - x) * f, y: y + (ny - y) * f }; assert.ok(!pointInPoly(q.x, q.y, sq(52, 52, 56, 36)), `cuts across: ${l}`); }
      x = nx; y = ny; z = nz;
    }
  }
});
