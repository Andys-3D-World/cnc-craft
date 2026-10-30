// Tests für den Vogelhaus-Generator – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { birdhousePanels, birdDims, birdProblem, holeSpot, holeFloor, worldPt, birdhouseSize, HOLE_SIZES, HANGERS, ENTRANCES, BASES, type BirdhouseOptions, type BirdPanel } from "../src/birdhouse.ts";
import type { V3 } from "../src/box.ts";

type Pt = { x: number; y: number };
const base: BirdhouseOptions = { w: 120, d: 120, h: 180, t: 6, finger: 15, kerf: 0, pitch: 40, overhang: 20, hole: 32,
  perch: true, drain: true, vent: true, hang: true, door: false };

const area = (p: Pt[]) => Math.abs(p.reduce((s, q, i) => { const n = p[(i + 1) % p.length]; return s + q.x * n.y - n.x * q.y; }, 0)) / 2;
const panelArea = (p: BirdPanel) => area(p.pts) - (p.holes || []).reduce((s, h) => s + area(h), 0);
const get = (ps: BirdPanel[], n: BirdPanel["name"]) => ps.find(p => p.name === n)!;

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
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const variants: [string, Partial<BirdhouseOptions>][] = [
  ["Standard", {}], ["Klappe", { door: true }], ["flach 25°", { pitch: 25 }], ["steil 55°", { pitch: 55, door: true }],
  ["3 mm Sperrholz", { t: 3, finger: 9, w: 100, d: 100, h: 150, hole: 28 }], ["Star", { w: 150, d: 150, h: 250, hole: 45 }],
  ["ohne Extras", { perch: false, drain: false, vent: false, hang: false, overhang: 0 }]
];

for (const [name, more] of variants) for (const kerf of [0, 0.15]) {
  test(`Umrisse geschlossen, Löcher in der Platte (${name}, Kerf ${kerf})`, () => {
    const o = { ...base, ...more, kerf };
    assert.equal(birdProblem(o), "");
    const ps = birdhousePanels(o);
    assert.equal(ps.length, 7);
    for (const p of ps) {
      assert.ok(p.pts.length >= 3, `${p.name}: Umriss`);
      assert.ok(p.pts.every(q => Number.isFinite(q.x) && Number.isFinite(q.y)), `${p.name}: Zahlen`);
      assert.ok(!selfIntersects(p.pts), `${p.name}: Umriss überschneidet sich`);
      for (const h of p.holes || []) {
        assert.ok(h.length >= 3 && !selfIntersects(h), `${p.name}: Loch`);
        assert.ok(h.every(q => inside(q, p.pts)), `${p.name}: Loch liegt nicht in der Platte`);
      }
    }
  });
}

// Fingerzinken passen genau, wenn jedes Stück der Wand genau einer Platte gehört: Fläche × t = Volumen der Hülle
test("Fingerzinken greifen lückenlos ineinander (ohne Klappe)", () => {
  const o = { ...base, perch: false, drain: false, vent: false }, { t, W, D, Hs, Zr } = birdDims(o);
  const ps = birdhousePanels(o).filter(p => !p.name.startsWith("roof"));
  const shell = W * D * Hs - (W - 2 * t) * (D - 2 * t) * (Hs - t) + 2 * t * (W * (Zr - Hs)) / 2;
  const sum = ps.reduce((s, p) => s + panelArea(p), 0) * t;
  const holes = get(ps, "front").holes!.reduce((s, h) => s + area(h), 0) * t;
  assert.ok(Math.abs(sum + holes - shell) < 1e-6 * shell, `Fläche × t = ${sum + holes}, Hülle = ${shell}`);
});

test("Fingerzinken greifen lückenlos ineinander (mit Klappe)", () => {
  const o = { ...base, door: true, drain: false, vent: false }, { t, s, W, D, Hs, Zr } = birdDims(o);
  const ps = birdhousePanels(o).filter(p => ["left", "right", "back", "bottom"].includes(p.name));
  const pinHoles = ps.reduce((n, p) => n + (p.holes || []).reduce((m, h) => m + area(h), 0), 0);
  // Seitenwände ganz, Rückwand dazwischen + Giebel, Boden dazwischen hinter der Klappe
  const vol = 2 * t * D * Hs + (W - 2 * t) * t * Hs + t * W * (Zr - Hs) / 2 + (W - 2 * t) * (D - s - 2 * t) * t;
  const sum = (ps.reduce((n, p) => n + panelArea(p), 0) + pinHoles) * t;
  assert.ok(Math.abs(sum - vol) < 1e-6 * vol, `Fläche × t = ${sum}, Hülle = ${vol}`);
});

test("Zinken-Kanten benachbarter Platten sind gleich lang", () => {
  for (const door of [false, true]) {
    const o = { ...base, door }, ps = birdhousePanels(o), { W, D, Hs, s } = birdDims(o);
    const ext = (p: BirdPanel, k: "x" | "y") => Math.max(...p.pts.map(q => q[k])) - Math.min(...p.pts.map(q => q[k]));
    assert.ok(Math.abs(ext(get(ps, "left"), "x") - D) < 1e-9, "Seitenwand so tief wie das Haus");
    assert.ok(Math.abs(ext(get(ps, "left"), "y") - Hs) < 1e-9, "Seitenwand so hoch wie die Traufe");
    assert.ok(Math.abs(ext(get(ps, "back"), "x") - W) < 1e-9, "Rückwand so breit wie das Haus");
    assert.ok(Math.abs(ext(get(ps, "bottom"), "x") - W) < 1e-9, "Boden so breit wie die Rückwand");
    assert.ok(Math.abs(ext(get(ps, "bottom"), "y") - (D - s - (door ? o.t : 0))) < 1e-9, "Boden so tief wie die Seitenwand (hinter der Klappe)");
    // die gezinkte Höhe von Rück- und Seitenwand ist dieselbe: Punkte der Rückwand auf x = 0 / x = t enden bei Hs
    const backEdge = get(ps, "back").pts.filter(q => q.x < 1e-9 || Math.abs(q.x - o.t) < 1e-9).map(q => q.y);
    assert.ok(Math.abs(Math.max(...backEdge) - Hs) < 1e-9, "Rückwand: Zinken bis zur Traufe");
  }
});

test("Dachschrägen liegen auf Giebel und Seitenwänden", () => {
  for (const pitch of [25, 40, 45, 55]) for (const door of [false, true]) {
    const o = { ...base, pitch, door }, ps = birdhousePanels(o), { t, W, D, Hs, Zr, a } = birdDims(o);
    const L = get(ps, "roofL"), R = get(ps, "roofR");
    const plane = (p: BirdPanel, q: V3, s = 0) => dot(sub(q, worldPt(p.at!, 0, 0, s)), p.at!.n); // Abstand zur Fläche
    for (const y of [0, D / 2, D]) {
      assert.ok(Math.abs(plane(L, [0, y, Hs])) < 1e-9, `links: Oberkante Seitenwand (${pitch}°)`);
      assert.ok(Math.abs(plane(R, [W, y, Hs])) < 1e-9, `rechts: Oberkante Seitenwand (${pitch}°)`);
      assert.ok(Math.abs(plane(L, [W / 2, y, Zr])) < 1e-9 && Math.abs(plane(R, [W / 2, y, Zr])) < 1e-9, `First (${pitch}°)`);
      // innere Oberkante der Seitenwand liegt unter dem Dach
      assert.ok(plane(L, [t, y, Hs]) < 0 && plane(R, [W - t, y, Hs]) < 0, "Seitenwand ragt nicht ins Dach");
    }
    // Giebelschräge der Rückwand hat die Dachneigung
    const back = get(ps, "back").pts, apex = back.reduce((m, q) => (q.y > m.y ? q : m));
    assert.ok(Math.abs(Math.atan2(apex.y - Hs, apex.x) - a) < 1e-9 && Math.abs(apex.y - Zr) < 1e-9, "Giebel");
    // am First: die rechte Hälfte stößt mit der äußeren Ecke an die Innenseite der linken, ohne hineinzuragen
    const rTop = worldPt(R.at!, 0, 0, t), rIn = worldPt(R.at!, 0, 0, 0);
    assert.ok(plane(L, rTop) < 1e-9 && plane(L, rIn) < 1e-9, `rechte Hälfte ragt nicht in die linke (${pitch}°)`);
    assert.ok(Math.abs(plane(R, worldPt(L.at!, L.w, 0, 0), t)) < 1e-9, `linke Hälfte deckt die rechte ab (${pitch}°)`);
    // Dach überdeckt das Haus mit dem Überstand
    assert.equal(L.h, D + 2 * o.overhang);
  }
});

test("Einflugloch sitzt in der Front, mit Platz darunter", () => {
  for (const hole of HOLE_SIZES) for (const door of [false, true]) {
    const o = { ...base, hole, door, w: 150, d: 150, h: 250 };
    assert.equal(birdProblem(o), "");
    const ps = birdhousePanels(o), fr = get(ps, door ? "door" : "front"), [h] = fr.holes!;
    const xs = h.map(q => q.x), ys = h.map(q => q.y);
    assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - hole) < 0.01, `Ø ${hole}`);
    assert.ok(h.every(q => inside(q, fr.pts)), "Loch in der Front");
    assert.ok(Math.min(...ys) > o.t + 15, "Loch nicht direkt über dem Boden");
    assert.ok(Math.max(...ys) < birdDims(o).Hs, "Loch unter der Traufe");
    assert.ok(holeSpot(o).floor > 15);
  }
});

test("Klappe hat Luft zu Seitenwänden und Dach", () => {
  const o = { ...base, door: true, vent: false }, ps = birdhousePanels(o), { t, W } = birdDims(o), dr = get(ps, "door");
  assert.ok(Math.abs(dr.w - (W - 2 * t - 1)) < 1e-9);
  const L = get(ps, "roofL");
  for (const q of dr.pts) assert.ok(dot(sub(worldPt(dr.at!, q.x, q.y, 0), worldPt(L.at!, 0, 0, 0)), L.at!.n) < 0, "unter dem Dach");
  assert.equal(get(ps, "left").holes!.length, 2, "Stift-Löcher");
});

test("zu klein / Loch zu groß wird erkannt", () => {
  assert.equal(birdProblem({ ...base, w: 20 }), "small");
  assert.equal(birdProblem({ ...base, w: 40, hole: 45 }), "holeWide");
  assert.equal(birdProblem({ ...base, h: 50, hole: 45 }), "holeLow");
});

test("Kerf macht Platten größer und Löcher kleiner", () => {
  const a = birdhousePanels(base), b = birdhousePanels({ ...base, kerf: 0.2 });
  const fa = get(a, "front"), fb = get(b, "front");
  assert.ok(area(fb.pts) > area(fa.pts));
  assert.ok(area(fb.holes![0]) < area(fa.holes![0]));
  const sz = birdhouseSize(base);
  assert.ok(sz.W > birdDims(base).W + 2 * base.overhang - 1e-9 && sz.H > birdDims(base).Zr);
});

// ───────── Anhänger (Mini-Vogelhaus) ─────────
const orn: BirdhouseOptions = { w: 40, d: 34, h: 32, t: 3, finger: 8, kerf: 0, pitch: 45, overhang: 4, hole: 14, perch: true,
  drain: false, vent: false, hang: false, door: false, kind: "ornament", hanger: "ring", entrance: "circle", frame: true, base: "rect", baseMargin: 5 };
const wallsOf = (ps: BirdPanel[]) => ps.filter(p => ["front", "back", "left", "right"].includes(p.name));

for (const hanger of HANGERS) for (const entrance of ENTRANCES) for (const base of BASES) {
  test(`Anhänger: Umrisse geschlossen (${hanger}, ${entrance}, ${base})`, () => {
    for (const kerf of [0, 0.1]) {
      const o = { ...orn, hanger, entrance, base, kerf };
      assert.equal(birdProblem(o), "");
      const ps = birdhousePanels(o);
      for (const p of ps) {
        assert.ok(p.pts.length >= 3 && p.pts.every(q => Number.isFinite(q.x) && Number.isFinite(q.y)), `${p.name}: Umriss`);
        assert.ok(!selfIntersects(p.pts), `${p.name}: Umriss überschneidet sich`);
        for (const h of p.holes || []) {
          assert.ok(!selfIntersects(h), `${p.name}: Loch überschneidet sich`);
          assert.ok(h.every(q => inside(q, p.pts)), `${p.name}: Loch liegt nicht in der Platte`);
        }
      }
      assert.equal(ps.some(p => p.name === "hanger"), hanger !== "none");
      assert.equal(ps.some(p => p.name === "base"), base !== "none");
      assert.equal(ps.some(p => p.name === "frame"), entrance !== "none");
    }
  });
}

test("Anhänger: jeder Zapfen der Wände hat einen Schlitz in der Grundplatte", () => {
  for (const base of ["rect", "round", "oval", "wave"] as const) {
    const o = { ...orn, base }, ps = birdhousePanels(o), b = get(ps, "base"), { t } = birdDims(o);
    // Zapfen = Kanten der Wand-Umrisse, die ganz unten (y = 0) liegen
    let tabs = 0;
    for (const p of wallsOf(ps)) p.pts.forEach((q, i) => { const n = p.pts[(i + 1) % p.pts.length]; if (q.y < 1e-9 && n.y < 1e-9) tabs++; });
    assert.equal(b.holes!.length, tabs, base);
    // Mitte jedes Schlitzes liegt in einer Wand (Welt → Wand-Koordinaten)
    for (const sl of b.holes!) {
      const cx = sl.reduce((s, q) => s + q.x, 0) / 4, cy = sl.reduce((s, q) => s + q.y, 0) / 4;
      const w = worldPt(b.at!, cx, cy, t / 2);
      const hit = wallsOf(ps).some(p => {
        const at = p.at!, d = sub(w, at.o), lx = dot(d, at.u), ly = dot(d, at.v), ln = dot(d, at.n);
        return ln > 0 && ln < t && inside({ x: lx, y: ly }, p.pts);
      });
      assert.ok(hit, `Schlitz ohne Zapfen (${base})`);
    }
  }
});

test("Anhänger: Dachhälften lehnen an der Firstplatte, Öse über dem Dach", () => {
  for (const pitch of [30, 45, 60]) for (const hanger of ["ring", "arch", "point"] as const) {
    const o = { ...orn, pitch, hanger }, ps = birdhousePanels(o), { t, W, D, Hs, a } = birdDims(o);
    const L = get(ps, "roofL"), R = get(ps, "roofR"), hg = get(ps, "hanger");
    const plane = (p: BirdPanel, q: V3) => dot(sub(q, worldPt(p.at!, 0, 0, 0)), p.at!.n);
    for (const y of [0, D]) {
      assert.ok(Math.abs(plane(L, [0, y, Hs])) < 1e-9 && Math.abs(plane(R, [W, y, Hs])) < 1e-9, "auf den Seitenwänden");
    }
    assert.ok(Math.abs(L.w - R.w) < 1e-9, "gleich lang");
    // obere Innenkanten genau an den Seiten der Firstplatte, keine Ecke ragt hinein
    for (const s of [0, t]) {
      assert.ok(worldPt(L.at!, L.w, 0, s)[0] <= W / 2 - t / 2 + 1e-9, "links nicht in der Firstplatte");
      assert.ok(worldPt(R.at!, 0, 0, s)[0] >= W / 2 + t / 2 - 1e-9, "rechts nicht in der Firstplatte");
    }
    assert.ok(Math.abs(worldPt(L.at!, L.w, 0, 0)[0] - (W / 2 - t / 2)) < 1e-9);
    // Firstplatte steckt genau so tief, wie der Schlitz im Giebel ist
    const fr = get(ps, "front"), z0 = t;
    const slotBottom = Math.min(...fr.pts.filter(q => Math.abs(Math.abs(q.x - W / 2) - t / 2) < 1e-9).map(q => q.y)) - z0;
    const plateBottom = Math.min(...hg.pts.map(q => worldPt(hg.at!, q.x, q.y, 0)[2]));
    assert.ok(Math.abs(slotBottom - plateBottom) < 1e-9, `Schlitz ${slotBottom} / Platte ${plateBottom}`);
    // Aufhänge-Loch liegt über dem höchsten Punkt des Daches
    const roofTop = Math.max(...[L, R].flatMap(p => p.pts.flatMap(q => [0, t].map(s => worldPt(p.at!, q.x, q.y, s)[2]))));
    const holeLow = Math.min(...hg.holes![0].map(q => worldPt(hg.at!, q.x, q.y, 0)[2]));
    assert.ok(holeLow > roofTop, `Öse (${hanger}, ${pitch}°) frei über dem Dach`);
    assert.ok(Math.abs(a - (pitch * Math.PI) / 180) < 1e-9);
  }
});

test("Anhänger: Zierrahmen passt um das Einflugloch und liegt auf der Front", () => {
  for (const entrance of ["circle", "arch", "heart", "square"] as const) {
    const o = { ...orn, entrance }, ps = birdhousePanels(o), fr = get(ps, "front"), fm = get(ps, "frame"), { t } = birdDims(o);
    const toFront = (q: Pt) => { const w = worldPt(fm.at!, q.x, q.y, 0); return { x: w[0], y: w[2] + t }; };
    const inner = fm.holes![0].map(toFront), hole = fr.holes![0];
    const box = (p: Pt[]) => [Math.min(...p.map(q => q.x)), Math.min(...p.map(q => q.y)), Math.max(...p.map(q => q.x)), Math.max(...p.map(q => q.y))];
    box(inner).forEach((v, i) => assert.ok(Math.abs(v - box(hole)[i]) < 1e-6, `${entrance}: Rahmen-Loch = Einflugloch`));
    assert.ok(fm.pts.map(toFront).every(q => inside(q, fr.pts)), `${entrance}: Rahmen auf der Front`);
    assert.ok(area(fm.pts) > area(fm.holes![0]));
    assert.ok(holeFloor(o) > 0);
  }
});

test("Anhänger: zu klein wird erkannt, Größe stimmt", () => {
  assert.equal(birdProblem({ ...orn, w: 10 }), "small");
  assert.equal(birdProblem({ ...orn, hole: 40 }), "holeWide");
  assert.equal(birdProblem({ ...orn, h: 16, hole: 14, entrance: "arch" }), "holeLow");
  const sz = birdhouseSize(orn);
  assert.ok(sz.W > 40 && sz.W < 80 && sz.H > 40 && sz.H < 100, JSON.stringify(sz));
});
