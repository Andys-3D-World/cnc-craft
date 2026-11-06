// Tests für die Faltschachtel – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldBox, foldLayersFirst, innerSizes, perforate, FOLD_END_GAP, PERF_BRIDGE, type FoldBoxOptions, type FoldBoxResult, type XY } from "../src/foldBox.ts";

const tuck: FoldBoxOptions = { style: "tuck", width: 80, depth: 40, height: 120, outside: false, thickness: 0.5, flap: 20, clearance: 0.3,
  lock: true, windowW: 0, windowH: 0, hangD: 0, foldOut: "score" };
const tray: FoldBoxOptions = { ...tuck, style: "tray", width: 120, depth: 80, height: 40, flap: 15 };

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-3, msg ?? `${a} ≠ ${b}`);
const panel = (r: FoldBoxResult, n: string) => { const p = r.panels.find(q => q.name === n); assert.ok(p, n); return p!; };
const flap = (r: FoldBoxResult, n: string) => { const f = r.flaps.find(q => q.name === n); assert.ok(f, n); return f!; };
const hingeLen = (f: { hinge: [XY, XY] }) => Math.hypot(f.hinge[1][0] - f.hinge[0][0], f.hinge[1][1] - f.hinge[0][1]);

function inside(ring: XY[], [x, y]: XY) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if ((ring[i][1] > y) !== (ring[j][1] > y) && x < (ring[j][0] - ring[i][0]) * (y - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0]) c = !c;
  }
  return c;
}
function distToSeg(p: XY, a: XY, b: XY) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const s = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - s * dx, p[1] - a[1] - s * dy);
}
const distToRing = (p: XY, ring: XY[]) => Math.min(...ring.map((a, i) => distToSeg(p, a, ring[(i + 1) % ring.length])));
function samples([a, b]: [XY, XY], n = 40): XY[] {
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n] as XY);
}
function segCross(a: XY, b: XY, c: XY, d: XY) {
  const o = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < -1e-9 && o(c, d, a) * o(c, d, b) < -1e-9;
}
const VARIANTS: [string, FoldBoxOptions][] = [
  ["Steckschachtel", tuck], ["Steckschachtel klein", { ...tuck, width: 30, depth: 20, height: 30, flap: 10 }],
  ["Steckschachtel ohne Lasche", { ...tuck, lock: false }], ["Steckschachtel dick", { ...tuck, thickness: 1.5 }],
  ["Steckschachtel mit Fenster+Loch", { ...tuck, windowW: 30, windowH: 30, hangD: 6 }],
  ["Schale", tray], ["Schale klein", { ...tray, width: 30, depth: 25, height: 15, flap: 8 }],
  ["Schale ohne Lasche", { ...tray, lock: false }], ["Schale dick", { ...tray, thickness: 1.5 }],
  ["Schale mit Fenster+Loch", { ...tray, windowW: 40, windowH: 30, hangD: 6 }],
  ["Schale, Klappe lang", { ...tray, flap: 500 }], ["Steckschachtel, Klappe lang", { ...tuck, flap: 500 }]
];

for (const [name, o] of VARIANTS) {
  test(`${name}: ein geschlossener Umriss ohne Selbstüberschneidung`, () => {
    const r = foldBox(o);
    assert.deepEqual(r.errors, []);
    assert.ok(r.outline.length > 20);
    assert.notDeepEqual(r.outline[0], r.outline[r.outline.length - 1]);
    const n = r.outline.length;
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      assert.ok(!segCross(r.outline[i], r.outline[(i + 1) % n], r.outline[j], r.outline[(j + 1) % n]), `Kanten ${i}/${j}`);
    }
    near(Math.min(...r.outline.map(p => p[0])), 0);
    near(Math.min(...r.outline.map(p => p[1])), 0);
  });

  test(`${name}: Faltlinien und Schnitte überlappen nie`, () => {
    const r = foldBox(o);
    assert.ok(r.folds.length >= 8);
    for (const f of r.folds) for (const p of samples(f)) {
      assert.ok(inside(r.outline, p), `Faltlinie außerhalb: ${p}`);
      assert.ok(distToRing(p, r.outline) >= FOLD_END_GAP - 1e-3, `zu nah an der Kontur: ${p} ${distToRing(p, r.outline)}`);
      for (const h of r.holes) {
        assert.ok(!inside(h, p), `Faltlinie im Loch: ${p}`);
        assert.ok(distToRing(p, h) > 0.05, `Faltlinie berührt Loch: ${p}`);
      }
    }
  });

  test(`${name}: Löcher liegen im Teil und berühren sich nicht`, () => {
    const r = foldBox(o);
    for (const h of r.holes) for (const p of h) {
      assert.ok(inside(r.outline, p), `Loch außerhalb: ${p}`);
      for (const k of r.holes) if (k !== h) assert.ok(!inside(k, p), "Löcher überlappen");
    }
  });

  test(`${name}: Laschen haben einen Widerhaken, Hals so lang wie das Material`, () => {
    for (const l of foldBox(o).locks) {
      const long = Math.max(l.slot.x1 - l.slot.x0, l.slot.y1 - l.slot.y0), thin = Math.min(l.slot.x1 - l.slot.x0, l.slot.y1 - l.slot.y0);
      assert.ok(l.tabW < long, "Hals passt in den Schlitz");
      assert.ok(l.headW > long, "Kopf breiter als der Schlitz");
      assert.ok(thin >= o.thickness, "Schlitz so breit wie das Material");
      assert.ok(l.neck >= o.thickness + o.clearance, "Hals reicht durch das Material");
    }
  });
}

test("Steckschachtel: Wände = Innenmaß + Dicke, Umfang geht auf", () => {
  const t = 0.5, r = foldBox(tuck);
  near(panel(r, "back").w, 80 + t);
  near(panel(r, "sideL").w, 40 + t);
  near(panel(r, "sideR").w, 40 + t);
  near(panel(r, "front").w, 80 + 1.5 * t);   // freie Kante bis zur Außenseite der Seitenwand
  // Mittellinien-Umfang: alle vier Wände, die Überlappung (t/2) der freien Kante nicht mitgezählt
  near(panel(r, "front").w - t / 2 + panel(r, "sideL").w + panel(r, "back").w + panel(r, "sideR").w, 2 * (80 + 40) + 4 * t);
  // Höhe: Staubklappen oben und unten liegen zwischen Boden und Deckel
  near(panel(r, "back").h, 120 + 3 * t);
  near(panel(r, "sideL").h, 120 + t);
  near(panel(r, "back").h - panel(r, "sideL").h, 2 * t);
  near(r.outer.w, 80 + 2 * t);
  near(panel(foldBox({ ...tuck, thickness: 1 }), "back").w, 81);
});

test("Schale: Boden deckt doppelte Seitenwände ab, Wände stimmen", () => {
  const t = 0.5, r = foldBox(tray);
  near(panel(r, "floor").w, 120 + 5 * t);
  near(panel(r, "floor").h, 80 + t);
  near(panel(r, "back").h, 40 + t);
  near(panel(r, "front").h, 40 + t / 2);
  near(panel(r, "sideL").w, 40);
  near(panel(r, "lid").h, 80 - tray.clearance);
  near(panel(r, "lid").w, panel(r, "floor").w);
});

test("Außenmaße ergeben die passenden Innenmaße", () => {
  for (const o of [tuck, tray]) {
    const a = foldBox(o);
    const out = { ...o, outside: true, width: a.outer.w, depth: a.outer.d, height: a.outer.h };
    const i = innerSizes(out);
    near(i.w, o.width); near(i.d, o.depth); near(i.h, o.height);
    assert.equal(foldBox(out).outline.length, a.outline.length);
  }
});

test("Einsteckklappe schmaler als die Öffnung, auch mit der Nahtklappe daneben", () => {
  const r = foldBox(tuck), t = tuck.thickness, c = tuck.clearance;
  // Öffnung = Innenbreite minus Nahtklappe
  near(hingeLen(flap(r, "tuckTop")), tuck.width - t - 2 * c);
  assert.ok(hingeLen(flap(r, "tuckTop")) < tuck.width - t);
  assert.ok(hingeLen(flap(r, "tuckBottom")) < tuck.width - t);
  const s = foldBox(tray);
  near(hingeLen(flap(s, "tuckTop")), tray.width - 2 * c);
  assert.ok(hingeLen(flap(s, "tuckTop")) < tray.width);
});

test("Staubklappen schmaler als die Tiefe und überlappen sich nicht", () => {
  const big = foldBox({ ...tuck, width: 30, flap: 25 });
  const a = flap(big, "dustLTop"), b = flap(big, "dustRTop");
  assert.ok(hingeLen(a) <= 40 - tuck.thickness - 2 * tuck.clearance + 1e-6);
  assert.ok(a.len + b.len < 30 + tuck.thickness, "Staubklappen von beiden Seiten treffen sich nicht");
  assert.ok(big.warnings.some(w => w.key === "fold.warn.dustLong"));
});

test("Zu lange Klappen werden gekürzt und gemeldet – Boden- und Deckelklappe stoßen nie aneinander", () => {
  const r = foldBox({ ...tuck, flap: 500 });
  assert.ok(r.warnings.some(w => w.key === "fold.warn.tuckLong"));
  const front = panel(r, "front");
  const slots = r.locks.filter(l => l.kind === "tuck").map(l => l.slot);
  assert.equal(slots.length, 2);
  assert.ok(slots[0].y0 > slots[1].y1 || slots[1].y0 > slots[0].y1, "Schlitze überlappen");
  assert.ok(r.lengths.tuck * 2 < front.h);
  const s = foldBox({ ...tray, flap: 500 });
  assert.ok(s.warnings.some(w => w.key === "fold.warn.tuckLong"));
  assert.ok(s.lengths.tuck < tray.height);
  // Ecklaschen der Vorder- und Rückwand treffen sich in der Seitenwand nicht
  assert.ok(2 * s.lengths.side < panel(s, "floor").h);
  assert.deepEqual(foldBox(tuck).warnings, []);
});

test("Steckschachtel: Naht- und Einstecklaschen treffen gefaltet ihren Schlitz", () => {
  const r = foldBox(tuck), t = tuck.thickness;
  const front = panel(r, "front"), back = panel(r, "back");
  const seams = r.locks.filter(l => l.kind === "seam");
  assert.equal(seams.length, 2);
  const seam = flap(r, "seam");
  for (const l of seams) {
    near(l.at[1], (l.slot.y0 + l.slot.y1) / 2);                       // gleiche Höhe
    near(l.slot.x0 - front.x, t / 2 + seam.len);                      // Klappenende = Schlitzkante
  }
  const foldX = front.x + front.w;                                    // Faltlinie Vorderwand/Seitenwand
  const tucks = r.locks.filter(l => l.kind === "tuck");
  for (const l of tucks) {
    near(l.at[0], back.x + back.w / 2);                               // Lasche in der Mitte der Rückwand
    near((l.slot.x0 + l.slot.x1) / 2, foldX - back.w / 2);            // Schlitz spiegelbildlich in der Vorderwand
  }
  near(front.y + front.h - tucks[0].slot.y1, r.lengths.tuck);         // Abstand vom Deckelfalz = Klappenlänge
  near(tucks[1].slot.y0 - front.y, r.lengths.tuck);
});

test("Schale: Einstecklasche und Rückschlag treffen ihren Schlitz", () => {
  const r = foldBox(tray), t = tray.thickness;
  const floor = panel(r, "floor"), back = panel(r, "back");
  const tk = r.locks.filter(l => l.kind === "tuck");
  assert.equal(tk.length, 1);
  near((tk[0].slot.x0 + tk[0].slot.x1) / 2, floor.x + floor.w / 2);
  // Klappe endet back.h − tuck über dem Boden, Schlitzkante dort in der Vorderwand
  near(floor.y - tk[0].slot.y0, back.h - r.lengths.tuck);
  const rets = r.locks.filter(l => l.kind === "return");
  assert.equal(rets.length, 4);
  for (const l of rets) {
    near(l.at[1], (l.slot.y0 + l.slot.y1) / 2);
    const cx = (l.slot.x0 + l.slot.x1) / 2;
    near(Math.min(cx - floor.x, floor.x + floor.w - cx), 2 * t);      // Seitenwand + Ecklasche + Rückschlag
  }
  // Rückschlag passt zwischen Vorder- und Rückwand
  assert.ok(hingeLen(flap(r, "returnL")) < tray.depth);
});

test("Fenster und Loch: sitzen richtig, zu groß = Fehler", () => {
  const r = foldBox({ ...tuck, windowW: 30, windowH: 30, hangD: 6 });
  assert.equal(r.holes.length, foldBox(tuck).holes.length + 2);
  const front = panel(r, "front"), win = r.holes[r.holes.length - 2];
  near((Math.min(...win.map(p => p[0])) + Math.max(...win.map(p => p[0]))) / 2, front.x + front.w - (tuck.width + tuck.thickness) / 2);
  for (const o of [{ ...tuck, windowW: 79, windowH: 30 }, { ...tuck, windowW: 30, windowH: 118 }, { ...tuck, hangD: 200 }, { ...tray, windowW: 500, windowH: 20 }, { ...tray, hangD: 60 }]) {
    const e = foldBox(o);
    assert.ok(e.errors.length > 0, JSON.stringify(o));
    assert.equal(e.outline.length, 0);
  }
  assert.ok(foldBox({ ...tuck, windowW: 30 }).warnings.some(w => w.key === "fold.warn.windowHalf"));
});

test("Fehler und Warnungen bei unmöglichen Werten", () => {
  const keys = (o: Partial<FoldBoxOptions>) => { const r = foldBox({ ...tuck, ...o }); return [...r.errors, ...r.warnings].map(m => m.key); };
  assert.ok(keys({ thickness: 0 }).includes("fold.err.thickness"));
  assert.ok(keys({ thickness: 4 }).includes("fold.err.tooThick"));
  assert.ok(keys({ thickness: 2 }).includes("fold.warn.thick"));
  assert.ok(keys({ thickness: 2, width: 18 }).includes("fold.err.thickForSize"));
  assert.ok(keys({ width: 5 }).includes("fold.err.small"));
  assert.ok(keys({ flap: 1 }).includes("fold.err.flapShort"));
  assert.ok(keys({ flap: 5 }).includes("fold.warn.flapShort"));
  assert.ok(keys({ outside: true, width: 10 }).includes("fold.err.small"));
  // NaN (leeres Feld) darf nie durchrutschen
  assert.ok(foldBox({ ...tuck, width: NaN }).errors.length > 0);
  assert.ok(foldBox({ ...tuck, thickness: NaN }).errors.length > 0);
});

test("Perforation: Stücke liegen auf der Linie, an den Enden bleibt ein Steg", () => {
  const line: [XY, XY] = [[10, 5], [10, 65]];
  const d = perforate(line);
  assert.ok(d.length >= 5);
  near(d[0][0][1] - 5, 65 - d[d.length - 1][1][1], "gleiche Stege an beiden Enden");
  assert.ok(d[0][0][1] - 5 >= PERF_BRIDGE - 1e-9);
  let cut = 0;
  for (const [a, b] of d) { assert.equal(a[0], 10); assert.equal(b[0], 10); cut += Math.abs(b[1] - a[1]); }
  assert.ok(cut < 60);
  assert.equal(perforate([[0, 0], [0, 3]]).length, 0, "zu kurz: bleibt ganz");
  assert.equal(perforate([[0, 0], [0, 6]]).length, 1);
  const r = foldBox(tuck);
  for (const [a, b] of r.dashes) {
    assert.ok(r.folds.some(f => distToSeg(a, f[0], f[1]) < 1e-6 && distToSeg(b, f[0], f[1]) < 1e-6));
    for (const p of [a, b]) assert.ok(distToRing(p, r.outline) >= PERF_BRIDGE, "Perforation läuft nicht in die Schnittkante");
  }
});

test("Ebenen mit Faltlinien kommen vor alle anderen, sonst bleibt die Reihenfolge", () => {
  assert.deepEqual(foldLayersFirst(["gravur", "schnitt", "falz"], x => x === "falz"), ["falz", "gravur", "schnitt"]);
  assert.deepEqual(foldLayersFirst(["a", "b"], () => false), ["a", "b"]);
});
