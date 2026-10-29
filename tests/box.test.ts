// Tests für den Box-Generator – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { boxPanels, outerSize, cabinetDrawer, diceMinHeight, diceAngle, BOX_TYPES, type BoxOptions, type Panel } from "../src/box.ts";

type Pt = { x: number; y: number };
const base: BoxOptions = { w: 120, d: 90, h: 70, inner: false, t: 3, finger: 9, lid: true, kerf: 0, nx: 1, ny: 2, overhang: 5, shelves: 2, radius: 15, sides: 6 };
/** Würfelturm und Schrank brauchen mehr Höhe */
const opts = (type: BoxOptions["type"], more: Partial<BoxOptions> = {}): BoxOptions =>
  ({ ...base, type, ...(type === "dice" ? { w: 80, d: 80, h: 200 } : type === "cabinet" ? { w: 200, d: 150, h: 220 } : {}), ...more });

const area = (p: Pt[]) => Math.abs(p.reduce((s, q, i) => { const n = p[(i + 1) % p.length]; return s + q.x * n.y - n.x * q.y; }, 0)) / 2;
const panelArea = (p: Panel) => area(p.pts) - (p.holes || []).reduce((s, h) => s + area(h), 0);

/** schneiden sich zwei Strecken echt (nicht nur an gemeinsamen Endpunkten)? */
function cross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}
function selfIntersects(p: Pt[]): boolean {
  for (let i = 0; i < p.length; i++) for (let j = i + 2; j < p.length; j++) {
    if (i === 0 && j === p.length - 1) continue;
    if (cross(p[i], p[(i + 1) % p.length], p[j], p[(j + 1) % p.length])) return true;
  }
  return false;
}
function inside(q: Pt, p: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++)
    if ((p[i].y > q.y) !== (p[j].y > q.y) && q.x < ((p[j].x - p[i].x) * (q.y - p[i].y)) / (p[j].y - p[i].y) + p[i].x) c = !c;
  return c;
}

for (const type of BOX_TYPES) for (const kerf of [0, 0.15]) {
  test(`Umrisse geschlossen und ohne Überschneidung (${type}, Kerf ${kerf})`, () => {
    const ps = boxPanels(opts(type, { kerf }));
    assert.ok(ps.length >= 3, "genug Platten");
    for (const p of ps) {
      assert.ok(p.pts.length >= 3, `${p.name}: Umriss`);
      assert.ok(p.pts.every(q => Number.isFinite(q.x) && Number.isFinite(q.y)), `${p.name}: Zahlen`);
      assert.ok(!selfIntersects(p.pts), `${p.name}: Umriss überschneidet sich`);
      for (const h of p.holes || []) {
        assert.ok(!selfIntersects(h), `${p.name}: Loch überschneidet sich`);
        assert.ok(h.every(q => inside(q, p.pts)), `${p.name}: Loch liegt nicht in der Platte`);
      }
    }
  });
}

// Fingerzinken passen genau, wenn jedes Stück der Wand genau einer Platte gehört: Fläche × t = Volumen der Wand
for (const [type, lidded] of [["closed", true], ["open", false]] as const) {
  test(`Fingerzinken greifen lückenlos ineinander (${type})`, () => {
    const o = opts(type), t = o.t, { W, D, H } = outerSize(o);
    const shell = W * D * H - (W - 2 * t) * (D - 2 * t) * (H - (lidded ? 2 : 1) * t);
    const sum = boxPanels(o).reduce((s, p) => s + panelArea(p), 0) * t;
    assert.ok(Math.abs(sum - shell) < 1e-6 * shell, `Fläche × t = ${sum}, Wand = ${shell}`);
  });
}

test("Vieleck-Kiste: Zapfen der Wände passen in die Schlitze im Boden", () => {
  for (const sides of [5, 6, 8, 12]) {
    const o = opts("hex", { sides }), ps = boxPanels(o), t = o.t;
    const walls = ps.filter(p => p.name === "hexWall"), bottom = ps.find(p => p.name === "bottom")!;
    assert.equal(walls.length, sides);
    // Zapfen = Teile der Wand unterhalb y = t
    const wall = walls[0], xs = wall.pts.filter(q => q.y === 0).map(q => q.x).sort((a, b) => a - b);
    const tabs: number[] = [];
    for (let i = 0; i < xs.length; i += 2) tabs.push(xs[i + 1] - xs[i]);
    assert.equal(bottom.holes!.length, tabs.length * sides, "ein Schlitz je Zapfen");
    for (const h of bottom.holes!) {
      const e = [Math.hypot(h[1].x - h[0].x, h[1].y - h[0].y), Math.hypot(h[2].x - h[1].x, h[2].y - h[1].y)].sort((a, b) => a - b);
      assert.ok(Math.abs(e[0] - t) < 1e-9, "Schlitz so breit wie das Material");
      assert.ok(tabs.some(L => Math.abs(L - e[1]) < 1e-9), "Schlitz so lang wie ein Zapfen");
    }
    // Wände innen genau so breit wie die Innenseite des Vielecks: alle zusammen = Umfang innen
    const ai = o.w / 2 - 2 * t;
    assert.ok(Math.abs(wall.w - 2 * ai * Math.tan(Math.PI / sides)) < 1e-9);
    // Deckel innen passt zwischen die Wände
    const li = ps.find(p => p.name === "lidInner")!;
    assert.ok(li.w < 2 * ai / Math.cos(Math.PI / sides) && li.h < 2 * ai / Math.cos(Math.PI / sides));
  }
});

test("Würfelturm: Rampen-Zapfen und Schlitze passen, Ausgang vorne unten", () => {
  const o = opts("dice"), ps = boxPanels(o), t = o.t;
  const ramps = ps.filter(p => p.name === "ramp"), left = ps.find(p => p.name === "left")!, right = ps.find(p => p.name === "right")!;
  assert.equal(ramps.length, 3);
  // jede Rampe hat auf beiden Seiten gleich viele Zapfen; insgesamt so viele wie Schlitze je Seitenwand
  const tabsPerSide = (p: Panel) => p.pts.filter(q => q.y === 0).length / 2;
  assert.equal(ramps.reduce((s, r) => s + tabsPerSide(r), 0), left.holes!.length);
  assert.deepEqual(left.holes, right.holes);
  for (const h of left.holes!) {
    const e = [Math.hypot(h[1].x - h[0].x, h[1].y - h[0].y), Math.hypot(h[2].x - h[1].x, h[2].y - h[1].y)];
    assert.ok(Math.abs(e[1] - t) < 1e-9, "Schlitz so breit wie das Material");
    // nicht im Bereich der Fingerzinken
    assert.ok(h.every(q => q.x > t && q.x < left.w - t && q.y > t && q.y < left.h), "Schlitz im freien Bereich");
  }
  for (const r of ramps) assert.ok(Math.abs(r.h - (o.w - 2 * t + 2 * t)) < 1e-9, "Rampe so breit wie innen + Zapfen");
  const front = ps.find(p => p.name === "front")!;
  assert.equal(front.holes!.length, 1);
  assert.ok(Math.min(...front.holes![0].map(q => q.y)) < 3 * t + 1, "Ausgang unten");
  // zu niedrig → keine zwei Rampen
  assert.ok(boxPanels(opts("dice", { h: 60 })).filter(p => p.name === "ramp").length < 2);
});

test("Schubladenschrank: je Fach eine Schublade, die mit Luft hineinpasst", () => {
  for (const shelves of [0, 1, 3]) {
    const o = opts("cabinet", { shelves }), ps = boxPanels(o), t = o.t, { W, D, H } = outerSize(o);
    const dr = cabinetDrawer(o);
    assert.equal(ps.filter(p => p.name === "drPlate").length, shelves + 1);
    assert.equal(ps.filter(p => p.name === "shelf").length, shelves);
    assert.ok(dr.w < W - 2 * t && dr.d + t < D - t, "Schublade passt in Breite und Tiefe");
    assert.ok(dr.h * (shelves + 1) + shelves * t < H - 2 * t, "Schubladen passen übereinander");
    // Blende so groß wie die Schubladen-Front
    const plate = ps.find(p => p.name === "drPlate")!;
    assert.ok(Math.abs(plate.w - dr.w) < 1e-9 && Math.abs(plate.h - dr.h) < 1e-9);
  }
});

// 3D-Lage: jede Platte hat einen Platz, und in der fertigen Kiste steckt keine Platte in einer anderen
// (Prüfung: Punkte im Inneren jeder Platte – in halber Dicke, Raster 1,5 mm – liegen in keiner anderen Platte)
type V = [number, number, number];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function solidAt(p: Panel, q: V, t: number, eps = 0.05): boolean {
  const at = p.at!, d: V = [q[0] - at.o[0], q[1] - at.o[1], q[2] - at.o[2]];
  const s = dot(d, at.n);
  if (s < eps || s > t - eps) return false;
  const pt = { x: dot(d, at.u), y: dot(d, at.v) };
  if (!inside(pt, p.pts) || (p.holes || []).some(h => inside(pt, h))) return false;
  // nicht direkt an einer Kante (dort berühren sich Platten nur)
  const near = (ring: Pt[]) => ring.some((a, i) => {
    const b = ring[(i + 1) % ring.length], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const u = L ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L)) : 0;
    return Math.hypot(pt.x - a.x - u * dx, pt.y - a.y - u * dy) < eps;
  });
  return !near(p.pts) && !(p.holes || []).some(near);
}
for (const type of BOX_TYPES) {
  test(`3D: alle Platten an ihrem Platz, keine steckt in einer anderen (${type})`, () => {
    const o = opts(type, type === "cabinet" ? { w: 160, d: 120, h: 160 } : {}), t = o.t, ps = boxPanels(o);
    for (const p of ps) assert.ok(p.at || p.wrap, `${p.name}: keine Lage`);
    const solid = ps.filter(p => p.at);
    for (const p of solid) {
      const at = p.at!, xs = p.pts.map(q => q.x), ys = p.pts.map(q => q.y);
      for (let x = Math.min(...xs) + 0.37; x < Math.max(...xs); x += 1.5) for (let y = Math.min(...ys) + 0.41; y < Math.max(...ys); y += 1.5) {
        const pt = { x, y };
        if (!inside(pt, p.pts) || (p.holes || []).some(h => inside(pt, h))) continue;
        const q: V = [0, 1, 2].map(k => at.o[k] + at.u[k] * x + at.v[k] * y + at.n[k] * t / 2) as V;
        for (const other of solid) if (other !== p && solidAt(other, q, t))
          assert.fail(`${p.name} steckt in ${other.name} bei ${q.map(v => v.toFixed(1)).join(", ")}`);
      }
    }
  });
}

test("Würfelturm: Mindesthöhe stimmt (ab da zwei Rampen, darunter nicht)", () => {
  for (const d of [60, 80, 120, 200]) for (const tt of [3, 6]) {
    const o = opts("dice", { d, t: tt }), h = diceMinHeight(o);
    const ramps = (hh: number) => boxPanels({ ...o, h: hh }).filter(p => p.name === "ramp").length;
    assert.ok(ramps(h) >= 2, `Tiefe ${d}: bei ${h} mm passen zwei Rampen`);
    assert.ok(ramps(h - 2) < 2, `Tiefe ${d}: bei ${h - 2} mm passen keine zwei Rampen`);
  }
});

test("Würfelturm: niedriger Turm bekommt flachere Rampen (35° … 20°)", () => {
  assert.ok(Math.abs(diceAngle(opts("dice")) - 35) < 1e-6, "hoch genug: 35°");
  for (const h of [130, 160, 200, 260]) {
    const o = opts("dice", { w: 300, d: 200, h }), a = diceAngle(o);
    assert.ok(a >= 20 - 1e-9 && a <= 35 + 1e-9, `Neigung ${a}`);
    assert.ok(boxPanels(o).filter(p => p.name === "ramp").length >= 2, `bei ${h} mm Höhe passen Rampen`);
  }
});
