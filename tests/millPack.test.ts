import test from "node:test";
import assert from "node:assert/strict";
import { fluteFits, fluteFrac, flutePasses, fluteSettings, type FluteOpts } from "../src/fluting.ts";
import { helixZ, trochoidPlan, troFits, troSettings } from "../src/trochoid.ts";
import { coneDepth, depthForWidth, photoLines, photoPlan, tooMuch, widthAtDepth, type PhotoOpts } from "../src/photoVcarve.ts";
import { distToPath } from "../src/millLead.ts";
import { pointInPoly } from "../src/polyOffset.ts";
import { coneHeight, taperHeight } from "../src/toolGraphics.ts";
import { profile } from "../src/view3d/carveSim.ts";
import { lintGcode } from "../src/gcodeLint.ts";

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

// ---------- Konischer Fräser ----------
test("taper: ball tip and cone meet without a step, hand-worked height", () => {
  // Ø3,175, Spitze Ø1 (R0,5), 8° ganz = 4° je Seite
  const g = { type: "taper" as const, diameter: 3.175, shankDia: 3.175, fluteLen: 0, length: 38, flutes: 2, helix: "up" as const, angle: 8, tipDia: 1, cornerR: 0 };
  const a = 4 * Math.PI / 180, rt = 0.5 * Math.cos(a), zt = 0.5 - 0.5 * Math.sin(a);
  near(taperHeight(g, 0), 0);
  near(taperHeight(g, 0.3), 0.5 - 0.4);
  near(taperHeight(g, rt - 1e-9), taperHeight(g, rt + 1e-9), 1e-6);
  near(taperHeight(g, rt), zt);
  near(coneHeight(g), zt + (1.5875 - rt) / Math.tan(a));
  const p = profile(g);
  near(p(1), taperHeight(g, 1));
  assert.equal(p(2), Infinity);
  for (let r = 0; r < 1.58; r += 0.01) assert.ok(p(r + 0.005) >= p(r));
});

// ---------- Flöten ----------
const FL: FluteOpts = { in: 20, out: 10, start: 0, end: 50, linear: true };
test("flute: only open on-line shapes, settings are cleaned", () => {
  assert.ok(fluteFits({ type: "line", millingMode: "on-line" }));
  assert.ok(fluteFits({ type: "polyline", closed: false, points: [{}, {}], millingMode: "on-line" }));
  assert.ok(!fluteFits({ type: "polyline", closed: true, points: [{}, {}, {}], millingMode: "on-line" }));
  assert.ok(!fluteFits({ type: "line", millingMode: "outside" }));
  assert.ok(!fluteFits({ type: "line" }));
  assert.equal(fluteSettings({}), null);
  assert.deepEqual(fluteSettings({ flute: true, fluteIn: -5, fluteOut: "x", fluteStart: 500, fluteEnd: NaN, fluteEase: "<b>" }), { in: 0, out: 20, start: 100, end: 0, linear: false });
});

test("flute: depth follows the hand-worked profile and zones never overlap", () => {
  near(fluteFrac(0, 100, FL), 0); near(fluteFrac(10, 100, FL), 0.5); near(fluteFrac(20, 100, FL), 1); near(fluteFrac(50, 100, FL), 1);
  near(fluteFrac(95, 100, FL), 0.75); near(fluteFrac(100, 100, FL), 0.5);
  // Bahn kürzer als beide Zonen: Verhältnis 2:1 bleibt, in der Mitte volle Tiefe
  near(fluteFrac(10, 15, FL), 1); near(fluteFrac(5, 15, FL), 0.5);
  const s = { ...FL, linear: false };
  near(fluteFrac(10, 100, s), 0.5); near(fluteFrac(20, 100, s), 1);
});

test("flute: passes never go below the profile, start in cut material and reach full depth", () => {
  const path = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }];
  for (const o of [FL, { ...FL, linear: false }, { in: 0, out: 0, start: 100, end: 100, linear: false }, { in: 300, out: 5, start: 30, end: 0, linear: false }]) {
    const passes = [-2, -4, -5];
    const res = flutePasses(path, passes, o);
    assert.equal(Math.min(...res.flatMap(p => p.pts.map(q => q.z))), -5);
    res.forEach((p, k) => {
      for (let i = 1; i < p.pts.length; i++) for (let f = 0; f <= 1; f += 0.25) {
        const a = p.pts[i - 1], b = p.pts[i], x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f, z = a.z + (b.z - a.z) * f;
        const s = y > 1e-9 ? 60 + y : x;
        assert.ok(z >= -5 * fluteFrac(s, 100, o) - 0.02, `too deep at s=${s}: ${z}`);
        assert.ok(z >= passes[k] - 1e-9);
        assert.ok(z <= p.top + 1e-9);
      }
    });
  }
  // ohne Ein-/Auslauf genau die alte Form: je Durchgang die ganze Bahn
  const flat = flutePasses(path, [-1, -2], { in: 0, out: 0, start: 100, end: 100, linear: false });
  assert.equal(flat.length, 2);
  assert.deepEqual(flat[1].pts.map(p => [p.x, p.y, p.z]), [[0, 0, -2], [60, 0, -2], [60, 40, -2]]);
  // volle Tiefe am Anfang 0 %: erster Punkt an der Oberfläche
  near(flutePasses(path, [-2], FL)[0].pts[0].z, 0);
});

// ---------- Trochoidal ----------
const rect = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }];
const T0 = { w: 160, step: 10, down: 0 };
test("trochoid: settings and shapes", () => {
  assert.equal(troSettings({}), null);
  assert.deepEqual(troSettings({ tro: true, troW: 9999, troStep: 0, troDown: "x" }), { w: 200, step: 2, down: 0 });
  assert.ok(troFits({ type: "circle" }));
  assert.ok(troFits({ type: "polyline", closed: true, millingMode: "inside" }));
  assert.ok(!troFits({ type: "polyline", closed: true, millingMode: "pocket" }));
  assert.ok(!troFits({ type: "line" }));
});

test("trochoid outside: the cutter never touches the part and clears the whole contour", () => {
  const r = 3, p = trochoidPlan(rect, "outside", r, 0, T0)!;
  near(p.rho, 1.8);
  assert.ok(p.full);
  let n = 0;
  for (const list of p.loops) for (let k = 0; k < list.length; k++) {
    const { c, start } = list[k];
    near(Math.hypot(start.x - c.x, start.y - c.y), p.rho);
    for (let a = 0; a < 16; a++) {
      const q = { x: c.x + p.rho * Math.cos(a), y: c.y + p.rho * Math.sin(a) };
      assert.ok(!pointInPoly(q.x, q.y, rect) && distToPath(q, rect, true) >= r - 0.02);
    }
    if (k) {
      const o = list[k - 1];
      assert.ok(Math.hypot(c.x - o.c.x, c.y - o.c.y) <= 0.6 + 1e-9, "step");
      // der Weg zum nächsten Kreis liegt in der schon freien Scheibe
      assert.ok(Math.hypot(start.x - o.c.x, start.y - o.c.y) <= p.rho + 0.2);
    }
    n++;
  }
  // Umfang in Kreismitte: 200 + 2π(3+1,8) → 0,6 mm je Kreis
  near(n, Math.ceil((200 + 2 * Math.PI * 4.8) / 0.6) + 1, 2);
});

test("trochoid inside: stays in the hole; a too narrow hole gives no plan, tight corners are reported", () => {
  const p = trochoidPlan(rect, "inside", 3, 0.3, T0)!;
  for (const l of p.loops) for (const { c } of l) assert.ok(pointInPoly(c.x, c.y, rect) && distToPath(c, rect, true) >= 3 + 0.3 + p.rho - 0.02);
  // rechtwinklige Innenecke: dort steht nach den Kreisen noch Material → Kontur bleibt bei normalen Durchgängen
  assert.equal(p.full, false);
  assert.equal(trochoidPlan([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 8 }, { x: 0, y: 8 }], "inside", 3, 0, T0), null);
  // runde Innenkontur: ganz frei
  const ring = Array.from({ length: 180 }, (_, i) => ({ x: 20 * Math.cos(i * Math.PI / 90), y: 20 * Math.sin(i * Math.PI / 90) }));
  assert.equal(trochoidPlan(ring, "inside", 3, 0, T0)!.full, true);
});

test("trochoid: helix reaches the depth and is never steeper than asked", () => {
  const zs = helixZ(-2, -5, 1.8, Math.tan(3 * Math.PI / 180));
  near(zs[zs.length - 1], -5);
  let prev = -2;
  for (const z of zs) { assert.ok(z < prev && (prev - z) <= 2 * Math.PI * 1.8 * Math.tan(3 * Math.PI / 180) + 1e-9); prev = z; }
});

// ---------- Foto mit V-Stichel ----------
const PO: PhotoOpts = { x0: 10, y0: 20, w: 40, h: 30, spacing: 1, angle: 90, tipDia: 0.2, toolDia: 6, maxDepth: 1, stepDown: 5, lines: 0 };
test("photo: width and depth, worked by hand for a 90° bit", () => {
  // 90°: Breite = Spitze + 2 · Tiefe
  near(depthForWidth(1, PO), 0.4);
  near(widthAtDepth(0.4, PO), 1);
  assert.equal(depthForWidth(0.05, PO), 0);
  near(coneDepth(PO), 2.9);
});

test("photo: black fills the spacing, white is left out, half black is half as wide", () => {
  const black = photoPlan(() => 1, PO);
  assert.equal(black.lines, 30);
  near(black.deepest, 0.4);
  assert.equal(black.clipped, 0);
  assert.equal(photoPlan(() => 0, PO).segs.length, 0);
  const mid = photoPlan(() => 0.5, PO);
  near(widthAtDepth(mid.deepest, PO), 0.5);
  // links weiß, rechts schwarz: je Linie ein Stück, nur rechts
  const p = photoPlan(u => (u > 20 ? 1 : 0), PO);
  assert.equal(p.segs.length, 30);
  for (const s of p.segs) for (const q of s) assert.ok(q.x >= 29.6 && q.x <= 50 + 1e-9 && q.y >= 20 && q.y <= 50);
  // hin und zurück
  assert.ok(p.segs[0][0].x < p.segs[0][p.segs[0].length - 1].x && p.segs[1][0].x > p.segs[1][p.segs[1].length - 1].x);
});

test("photo: slanted lines stay inside the picture, depth limit is kept and reported", () => {
  for (const lines of [45, 90, 135]) {
    const p = photoPlan((u, v) => 0.5 + 0.5 * Math.sin(u) * Math.cos(v), { ...PO, lines, maxDepth: 0.2 });
    assert.ok(p.segs.length > 10 && p.clipped > 0);
    for (const s of p.segs) for (const q of s) assert.ok(q.x >= 10 - 1e-6 && q.x <= 50 + 1e-6 && q.y >= 20 - 1e-6 && q.y <= 50 + 1e-6 && q.d <= 0.2 + 1e-9);
  }
  assert.ok(tooMuch({ w: 5000, h: 5000, spacing: 0.1 }));
  assert.ok(!tooMuch({ w: 150, h: 150, spacing: 0.8 }));
});

test("photo: G-code lifts between pieces, never below the limit, several passes only go deeper", () => {
  const o = { ...PO, stepDown: 0.15 };
  const plan = photoPlan((u, v) => (u % 10 < 4 ? 0 : 0.3 + 0.7 * Math.abs(Math.sin(v))), o);
  const r = photoLines(plan, o, 1000, 300, 5);
  const zs = r.lines.map(l => /Z(-?[\d.]+)/.exec(l)).filter(Boolean).map(m => +m![1]);
  near(Math.min(...zs), -plan.deepest, 0.001);
  // Eilgang seitlich nur oben
  let z = 5, cutting = false;
  for (const l of r.lines) {
    if (l.startsWith("G0 X")) assert.ok(z > 0, l);
    const m = /Z(-?[\d.]+)/.exec(l);
    if (m) z = +m[1];
    if (l.startsWith("G1")) cutting = true;
  }
  assert.ok(cutting && z === 5);
  const g = ["G21", "G90", "G17", "G0 Z5.00", "M3 S12000", "G4 P3", ...r.lines, "M5", "G0 X0 Y0", "M30"].join("\n");
  assert.deepEqual(lintGcode(g, { kind: "mill" }), []);
});
