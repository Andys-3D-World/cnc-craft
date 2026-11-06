// Tests für den Pralinen-Halter – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MultiPolygon } from "polygon-clipping";
import { candyHolder, candySettings, edgeGap, foldAngle, foldProfile, tentGap, holeGap, middleLayers, minWall, safeCornerR, suggestSize, windowOf, windowSize, CANDY_DEFAULTS, CANDY_MAX_MIDDLE, type CandySettings } from "../src/candyHolder.ts";
import { ORNAMENT_SHAPES } from "../src/ornament.ts";
import { sanitizeSettings } from "../src/editor/genRun.ts";
import { bounds, inRegion } from "../src/nameConnect.ts";

const opt = (p: Partial<CandySettings> = {}): CandySettings => candySettings({ ...CANDY_DEFAULTS, build: "layers", ...p });
const flex = (p: Partial<CandySettings> = {}): CandySettings => opt({ build: "flex", ...p });
const keys = (r: { msgs: { key: string }[] }) => r.msgs.map(m => m.key);
const errors = (r: { msgs: { key: string; level: string }[] }) => r.msgs.filter(m => m.level === "error").map(m => m.key);
const rect = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];
const area = (m: MultiPolygon) => m.reduce((s, poly) => s + poly.reduce((u, r, i) => {
  let a = 0; for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += r[j][0] * r[k][1] - r[k][0] * r[j][1];
  return u + (i ? -1 : 1) * Math.abs(a / 2);
}, 0), 0);
const word: MultiPolygon = [...rect(0, 0, 6, 10), ...rect(8, 0, 14, 10), ...rect(16, 0, 22, 10)];

test("Anzahl Mittelschichten folgt aus Tiefe, Spiel und Material", () => {
  assert.equal(middleLayers(9, 0, 3), 3);
  assert.equal(middleLayers(9.1, 0, 3), 4);
  assert.equal(middleLayers(9, 0.5, 3), 4);
  assert.equal(middleLayers(0.3, 0, 0.1), 3, "Rundungsfehler darf keine Schicht dazumogeln");
  assert.equal(middleLayers(1, 0, 3), 1);
  assert.equal(middleLayers(12, 0, 4), 3);
  const r = candyHolder(opt({ depth: 12, clearance: 0.5, thickness: 3 }));
  assert.equal(r.middle, 5);
  assert.equal(r.parts.length, 7);
  assert.deepEqual(r.parts.map(p => p.kind), ["front", "middle", "middle", "middle", "middle", "middle", "back"]);
  assert.equal(r.total, 21);
});

test("Öffnung liegt in der echten Kontur mit Mindestwand – auch bei nicht rechteckigen Formen", () => {
  for (const shape of ["ball", "heart", "tree", "star", "bell", "egg", "pumpkin"] as const) {
    const o = opt({ shape, size: 140, diameter: 25 });
    const r = candyHolder(o);
    assert.equal(errors(r).length, 0, `${shape}: ${keys(r)}`);
    const front = r.parts[0].cut;
    for (const p of r.layout.pockets) {
      // unabhängig von der Rechnung nachmessen: Punkte im Abstand der Mindestwand um die Tasche liegen alle im Umriss
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2, R = p.hw + minWall(o.thickness) - 0.05;
        assert.ok(inRegion(r.outline, p.cx + R * Math.cos(a), p.cy + R * Math.sin(a)), `${shape} Punkt ${i}`);
      }
      assert.ok(!inRegion(front, p.cx, p.cy), `${shape}: Fenster ist offen`);
    }
  }
});

test("Umgebendes Rechteck reicht nicht: Herz hat oben eine Kerbe, Stern passt nur innen", () => {
  // Der 5er-Stern ist breit, aber in der Mitte eng: 60 mm passen nicht, obwohl das Rechteck der Form größer ist
  const r = candyHolder(opt({ shape: "star", size: 90, diameter: 60 }));
  const b = bounds(r.outline);
  assert.ok(b.x1 - b.x0 > 60 + 2 * minWall(3), "Rechteck wäre groß genug");
  assert.ok(errors(r).includes("ch.msg.tooLarge") || errors(r).includes("ch.msg.edge"), `${keys(r)}`);
  assert.equal(r.ok, false);
});

test("Abstand zur Kontur: exakt gemessen, negativ außerhalb", () => {
  const box = rect(-20, -20, 20, 20);
  const cell = { cx: 0, cy: 0, hw: 10, hh: 10, r: 10 };
  assert.ok(Math.abs(edgeGap(box, [cell]) - 10) < 1e-9);
  assert.ok(Math.abs(edgeGap(box, [{ ...cell, cx: 8 }]) - 2) < 1e-9);
  assert.ok(edgeGap(box, [{ ...cell, cx: 15 }]) < 0, "ragt hinaus");
  assert.ok(edgeGap(box, [{ ...cell, cx: 100 }]) < 0, "liegt außerhalb");
  assert.ok(edgeGap(rect(-1, -1, 1, 1), [cell]) < 0, "Kontur ganz in der Öffnung");
});

test("Meldungen: zu groß, zu nah am Rand, dünne Wand", () => {
  assert.ok(errors(candyHolder(opt({ size: 40, diameter: 80 }))).includes("ch.msg.tooLarge"));
  // Kreisform: Durchmesser ≈ 84 mm. Wand = (84 − Öffnung) / 2
  const edge = candyHolder(opt({ shape: "ball", size: 90, hanger: "none", diameter: 80, clearance: 0 }));
  assert.ok(errors(edge).includes("ch.msg.edge"), `${keys(edge)}`);
  const thin = candyHolder(opt({ shape: "ball", size: 90, hanger: "none", diameter: 74, clearance: 0 }));
  assert.ok(keys(thin).includes("ch.msg.wall"), `${keys(thin)}`);
  assert.equal(thin.ok, true, "dünne Wand warnt nur");
  const fine = candyHolder(opt({ shape: "ball", size: 90, diameter: 30 }));
  assert.equal(fine.msgs.length, 0, `${keys(fine)}`);
});

test("Haltesteg: Tasche ist um die Steghöhe länger, Fenster bleibt so groß wie die Füllung", () => {
  for (const fill of ["round", "rect"] as const) {
    const o = opt({ fill, bar: true, barH: 6, size: 120 });
    const r = candyHolder(o);
    assert.equal(errors(r).length, 0, `${keys(r)}`);
    const p = r.layout.pockets[0], w = r.windows[0], s = windowSize(o);
    assert.ok(Math.abs(w.hh * 2 - s.h) < 1e-9, "Fenster = Füllung + Spiel");
    assert.ok(Math.abs(p.hh * 2 - (s.h + 6)) < 1e-9, "Tasche = Fenster + Steg");
    assert.ok(Math.abs(p.cy + p.hh - (w.cy + w.hh)) < 1e-9, "oben bündig");
    // Steg: am unteren Rand der Tasche ist die Front noch Material, die Mittelschicht nicht
    const y = p.cy - p.hh + 2;
    assert.ok(inRegion(r.parts[0].cut, p.cx, y), "Front hat den Steg");
    assert.ok(!inRegion(r.parts[1].cut, p.cx, y), "Mittelschicht ist dort offen");
    assert.deepEqual(windowOf(p, o), w);
  }
});

test("Haltesteg passt nicht oder ist zu dünn: klare Meldung", () => {
  const big = candyHolder(opt({ shape: "ball", size: 90, hanger: "none", diameter: 70, clearance: 0, bar: true, barH: 20 }));
  assert.ok(errors(big).length > 0, "Tasche mit Steg passt nicht mehr");
  const without = candyHolder(opt({ shape: "ball", size: 90, hanger: "none", diameter: 70, clearance: 0 }));
  assert.equal(errors(without).length, 0, "ohne Steg ginge es");
  assert.ok(keys(candyHolder(opt({ size: 120, bar: true, barH: 3 }))).includes("ch.msg.barThin"));
  assert.ok(keys(candyHolder(opt({ size: 200, diameter: 10, bar: true, barH: 12 }))).includes("ch.msg.barTall"));
});

test("Aufhänge-Loch stößt nicht an die Öffnung und geht durch alle Schichten", () => {
  const o = opt({ size: 110, diameter: 40, holeD: 5 });
  const r = candyHolder(o);
  assert.ok(r.holeAt, "Loch gefunden");
  assert.ok(holeGap(r.layout.pockets, r.holeAt, r.holeR) >= o.thickness, "Wand zum Loch");
  for (const p of r.parts) assert.ok(!inRegion(p.cut, r.holeAt![0], r.holeAt![1]), `${p.kind}: Loch offen`);
  assert.ok(Math.abs(holeGap([{ cx: 0, cy: 0, hw: 10, hh: 10, r: 10 }], [0, 15], 2) - 3) < 1e-9);
  // Öffnung so groß, dass sie das Loch erreichen müsste
  const clash = candyHolder(opt({ shape: "ball", size: 90, diameter: 60, clearance: 0, holeD: 20 }));
  assert.ok(errors(clash).includes("ch.msg.hole"), `${keys(clash)}`);
  assert.equal(clash.ok, false);
});

test("Ohne Aufhänger keine Lochprüfung; Ring hängt außen an", () => {
  assert.equal(candyHolder(opt({ hanger: "none" })).holeAt, undefined);
  const ring = candyHolder(opt({ hanger: "ring" }));
  assert.ok(ring.holeAt && ring.ok);
});

test("Mehrere Öffnungen: gleich viele Taschen, Wand dazwischen, Mittelschicht bleibt ein Teil", () => {
  for (const count of [2, 3, 4, 5, 6]) {
    const o = opt({ shape: "arch", size: 220, diameter: 25, count });
    const r = candyHolder(o);
    assert.equal(r.layout.pockets.length, count);
    assert.equal(errors(r).length, 0, `${count}: ${keys(r)}`);
    const P = r.layout.pockets;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const d = Math.hypot(P[i].cx - P[j].cx, P[i].cy - P[j].cy) - P[i].hw - P[j].hw;
      assert.ok(d >= minWall(o.thickness) - 1e-6, `${count}: Wand ${d}`);
    }
    assert.equal(r.parts[1].cut.length, 1, "ein Teil");
    assert.equal(r.parts[1].cut[0].length, count + 2, "außen + Loch + Taschen");
  }
});

test("Riegel: Eckenradius passt zur Füllung; Fräse meldet zu enge Ecken", () => {
  const c = 0.5, r = safeCornerR(c);
  // Ecke der Füllung (mit Spiel c/2 je Seite) bleibt im Radius r
  assert.ok(Math.SQRT2 * (r - c / 2) <= r + 1e-9);
  const laser = candyHolder(opt({ fill: "rect", size: 120 }));
  assert.ok(!keys(laser).includes("ch.msg.corner"));
  assert.ok(laser.layout.pockets[0].r <= r + 1e-9);
  const mill = candyHolder(opt({ fill: "rect", size: 120, router: true }));
  assert.ok(keys(mill).includes("ch.msg.corner"));
  assert.ok(!keys(candyHolder(opt({ fill: "rect", size: 120, router: true, clearance: 1 }))).includes("ch.msg.corner"));
  // die Fläche der Tasche ist Füllung + Spiel (abzüglich runder Ecken)
  const full = area(candyHolder(opt({ fill: "rect", size: 120, hanger: "none" })).parts.at(-1)!.cut), mid = area(laser.parts[1].cut);
  assert.ok(full - mid > 0);
});

test("Text wird graviert und liegt frei von Fenster und Kontur; als Linie auf Wunsch", () => {
  const r = candyHolder(opt({ size: 110, diameter: 28 }), { area: word, lines: [] });
  const front = r.parts[0];
  assert.ok(front.engrave.length >= 3);
  for (const p of front.engrave) for (const [x, y] of p[0]) {
    assert.ok(inRegion(front.cut, x, y), "auf Material");
    for (const c of r.layout.pockets) assert.ok(Math.abs(x - c.cx) > c.hw || Math.abs(y - c.cy) > c.hh, "nicht auf der Tasche");
  }
  assert.ok(r.parts.slice(1).every(p => !p.engrave.length && !p.lines.length), "nur die Front");
  const s = candyHolder(opt({ size: 110, diameter: 28, inner: "score" }), { area: word, lines: [] });
  assert.equal(s.parts[0].engrave.length, 0);
  assert.ok(s.parts[0].lines.length >= 3);
  const none = candyHolder(opt({ shape: "ball", size: 90, hanger: "none", diameter: 72, clearance: 0 }), { area: rect(0, 0, 60, 10), lines: [] });
  assert.ok(keys(none).some(k => k === "ch.msg.textNoRoom" || k === "ch.msg.textSmall"), `${keys(none)}`);
});

test("Alle Themenformen rechnen ohne Absturz", () => {
  for (const shape of ORNAMENT_SHAPES) {
    const r = candyHolder(opt({ shape, size: 150, diameter: 20, deco: "dots" }), { area: word, lines: [] });
    assert.ok(r.parts.length >= 3, shape);
    if (r.ok) assert.ok(area(r.parts[0].cut) > 0, shape);
  }
});

test("Größen-Vorschlag: mit dieser Höhe passt es wirklich", () => {
  const o = opt({ shape: "star", size: 50, diameter: 40 });
  assert.equal(candyHolder(o).ok, false);
  const s = suggestSize(o)!;
  assert.ok(s > 50 && s % 5 === 0, String(s));
  assert.equal(candyHolder({ ...o, size: s }).ok, true);
});

test("Zu viele Schichten werden abgelehnt, die Teilezahl bleibt begrenzt", () => {
  const r = candyHolder(opt({ size: 200, depth: 200, thickness: 3 }));
  assert.ok(errors(r).includes("ch.msg.tooMany"));
  assert.ok(r.parts.length <= CANDY_MAX_MIDDLE + 2);
  assert.ok(keys(candyHolder(opt({ size: 200, depth: 30 }))).includes("ch.msg.thick"));
});

test("Einstellungen: Speichern + Neu öffnen ergibt denselben Halter; fremde Werte werden abgefangen", () => {
  const o = opt({ shape: "tree", size: 160, fill: "rect", fillW: 30, fillH: 18, depth: 6, thickness: 4, bar: true, barH: 8, count: 2, hanger: "ring", text: "Anna", theme: "easter" });
  const again = candySettings(sanitizeSettings(JSON.parse(JSON.stringify(o))));
  assert.deepEqual(again, o);
  const a = candyHolder(o), b = candyHolder(again);
  assert.deepEqual(a.layout.pockets, b.layout.pockets);
  const bad = candySettings({ shape: "<img>", thickness: -3, size: 1e9, count: 99, fill: "x", hanger: "y", theme: "z", inner: 5, depth: "9", text: "x".repeat(99) });
  assert.equal(bad.shape, CANDY_DEFAULTS.shape);
  assert.equal(bad.thickness, 0.5);
  assert.equal(bad.size, 1000);
  assert.equal(bad.count, 6);
  assert.equal(bad.fill, "round");
  assert.equal(bad.depth, CANDY_DEFAULTS.depth);
  assert.equal(bad.text.length, 60);
});

test("Faltstreifen: ein Teil, Reihenfolge Vorderseite – Biegezone – Boden – Biegezone – Rückseite", () => {
  const o = flex({ size: 90, diameter: 30 });
  const r = candyHolder(o);
  assert.equal(r.ok, true, `${keys(r)}`);
  assert.deepEqual(r.parts.map(p => p.kind), ["strip"]);
  const fx = r.flex!, strip = r.parts[0];
  assert.equal(strip.cut.length, 1, "ein Stück");
  assert.ok(Math.abs(fx.length - (2 * fx.panel + 2 * fx.band + fx.floor)) < 1e-9);
  assert.ok(Math.abs(fx.floor - 30.5) < 1e-9, "Boden so lang wie die Füllung tief");
  const b = bounds(strip.cut);
  assert.ok(Math.abs(b.y1 - b.y0 - fx.length) < 0.01);
  // Biegezonen haben Schnitte, der Boden und die Seiten nicht
  const ys = strip.slits!.flatMap(l => l.pts.map(p => Math.abs(p[1])));
  assert.ok(ys.length > 0);
  assert.ok(Math.min(...ys) >= fx.floor / 2 - 1e-9 && Math.max(...ys) <= fx.floor / 2 + fx.band + 1e-9);
  for (const l of strip.slits!) for (const [x] of l.pts) assert.ok(Math.abs(x) < fx.width / 2, "Rand bleibt ganz");
});

test("Faltstreifen: beide Seiten decken sich gefaltet, das Loch liegt in beiden", () => {
  const r = candyHolder(flex({ size: 90, diameter: 30 }));
  const fx = r.flex!, y0 = fx.floor / 2 + fx.band, c = r.parts[0].cut;
  assert.ok(r.holeAt);
  for (const sign of [1, -1]) {
    const y = sign * (r.holeAt![1] + y0);
    assert.ok(!inRegion(c, r.holeAt![0], y), "Loch offen");
    assert.ok(inRegion(c, r.holeAt![0], y + r.holeR + 0.5), "Material oben");
    assert.ok(inRegion(c, r.holeAt![0], y - r.holeR - 0.5), "Material unten");
  }
  // gespiegelt: gleiche Breite in gleichem Abstand vom Boden
  for (const d of [3, 20, 40]) for (const x of [-20, -5, 12, 25]) assert.equal(inRegion(c, x, y0 + d), inRegion(c, x, -y0 - d), `${x}/${d}`);
});

test("Faltwinkel: Spitzen treffen sich in der Mitte, sonst null", () => {
  const a = foldAngle(30, 14, 70)!;
  const p = foldProfile(30, 14, 70, a), tip = p[p.length - 1];
  assert.ok(Math.abs(tip[0]) < 1e-6, String(tip[0]));
  assert.ok(tip[1] > 50);
  const len = p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
  assert.ok(Math.abs(len - (15 + 14 + 70)) < 0.1, "Länge bleibt beim Falten gleich");
  assert.equal(foldAngle(100, 5, 10), null, "zu kurze Seiten treffen sich nicht");
});

test("Faltstreifen: Süßigkeit muss ins Zelt passen", () => {
  const a = foldAngle(30, 14, 70)!, prof = foldProfile(30, 14, 70, a);
  assert.ok(tentGap(prof, 3, [[0, 10]]) > 0, "Punkt innen");
  assert.ok(tentGap(prof, 3, [[0, 500]]) < 0, "über der Spitze");
  assert.ok(tentGap(prof, 3, [[500, 2]]) < 0, "neben dem Zelt");
  const ok = candyHolder(flex({ size: 90, diameter: 30 }));
  assert.ok(ok.flex!.sweetGap > 0);
  const tall = candyHolder(flex({ size: 60, fill: "rect", fillW: 25, fillH: 50, depth: 25 }));
  assert.ok(errors(tall).includes("ch.msg.tentTight"), `${keys(tall)}`);
  assert.equal(tall.ok, false);
});

test("Faltstreifen: Form zu schmal für die Füllung, Fußlinie an der echten Kontur", () => {
  const r = candyHolder(flex({ size: 40, diameter: 60 }));
  assert.ok(errors(r).includes("ch.msg.tooLarge"));
  const s = suggestSize(flex({ size: 40, diameter: 60 }))!;
  assert.equal(candyHolder(flex({ size: s, diameter: 60 })).ok, true);
  // Tannenbaum: der schmale Stamm fällt weg, der Streifen beginnt dort, wo die Form breit genug ist
  const tree = candyHolder(flex({ shape: "tree", size: 120, diameter: 25 }));
  assert.equal(tree.ok, true, `${keys(tree)}`);
  assert.ok(tree.flex!.width >= 25.5 + 6 - 1e-6);
  assert.ok(tree.flex!.panel < 120, "unten abgeschnitten");
});

test("Faltstreifen: Seitenstege passen auf den Boden, innen bleibt Platz für die Füllung", () => {
  const o = flex({ size: 90, diameter: 30, bar: true, barH: 8 });
  const r = candyHolder(o), fx = r.flex!;
  assert.deepEqual(r.parts.map(p => p.kind), ["strip", "sideBar", "sideBar"]);
  assert.ok(fx.innerW >= 30.5 - 1e-6, "zwischen den Stegen passt die Füllung");
  const bb = bounds(r.parts[1].cut);
  assert.ok(Math.abs(bb.x1 - bb.x0 - fx.floor) < 1e-6, "so lang wie der Boden");
  assert.ok(Math.abs(bb.y1 - bb.y0 - 8) < 1e-6);
  assert.equal(r.parts[0].lines.filter(l => l.pts.length === 2).length, 2, "Leimlinien auf dem Boden");
  assert.ok(keys(candyHolder(flex({ size: 90, diameter: 30, bar: true, barH: 3 }))).includes("ch.msg.barThin"));
  assert.ok(keys(candyHolder(flex({ size: 90, diameter: 30, bar: true, barH: 40 }))).includes("ch.msg.barTall"));
});

test("Faltstreifen: Warnungen für Fräse, fehlendes Band und zu enge Biegung", () => {
  assert.ok(keys(candyHolder(flex({ router: true }))).includes("ch.msg.flexLaser"));
  assert.ok(keys(candyHolder(flex({ hanger: "none" }))).includes("ch.msg.flexTie"));
  assert.ok(keys(candyHolder(flex({ bandLen: 5 }))).includes("ch.msg.bendTight"));
  assert.ok(!keys(candyHolder(flex())).includes("ch.msg.bendTight"), `${keys(candyHolder(flex()))}`);
});

test("Faltstreifen: Text nur auf der Vorderseite, auf Material; alle Formen rechnen", () => {
  const r = candyHolder(flex({ size: 100, diameter: 28 }), { area: word, lines: [] });
  const fx = r.flex!, y0 = fx.floor / 2 + fx.band;
  assert.ok(r.parts[0].engrave.length >= 3);
  for (const p of r.parts[0].engrave) for (const [x, y] of p[0]) {
    assert.ok(y > y0, "Vorderseite");
    assert.ok(inRegion(r.parts[0].cut, x, y), "auf Material");
  }
  for (const shape of ORNAMENT_SHAPES) {
    const q = candyHolder(flex({ shape, size: 150, diameter: 20, deco: "dots" }), { area: word, lines: [] });
    if (q.ok) assert.equal(q.parts[0].cut.length, 1, shape);
  }
});
