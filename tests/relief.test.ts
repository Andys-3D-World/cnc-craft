// Relief aus Bild und Vektoren, OBJ-Leser, G-Code gegen das Höhenfeld – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridFor, fieldToMesh, fieldPreviewTris, fieldRange, detailLoss, blur, MAX_NODES, type HeightField } from "../src/relief/heightField.ts";
import { grayToField, resampleGray, type ImageReliefOpts } from "../src/relief/imageRelief.ts";
import { loopsToField, insideMask, contourDistance, type VPt } from "../src/relief/vectorRelief.ts";
import { buildRelief } from "../src/relief/reliefBuild.ts";
import { parseObjBytes, ObjError } from "../src/importers/objParse.ts";
import { parseGcodeProgram } from "../src/sim/gcodeParser.ts";
import { LiveCarve } from "../src/sim/simCarve.ts";
import type { ToolGeom } from "../src/toolGraphics.ts";

const opts = (x: Partial<ImageReliefOpts> = {}): ImageReliefOpts => ({
  w: 40, h: 20, nx: 41, ny: 21, depth: 5, invert: false, smooth: 0, contrast: 1, gamma: 1, border: 0, fade: 0, fadeTo: "top", ...x
});
/** Graubild: Verlauf von links (schwarz) nach rechts (weiß) */
function ramp(w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) g[j * w + i] = i / (w - 1);
  return g;
}
const at = (f: HeightField, i: number, j: number) => f.z[j * f.nx + i];

test("Raster: Seitenverhältnis, Mindestzelle, Obergrenze", () => {
  assert.deepEqual(gridFor(100, 50, 100), { nx: 101, ny: 51 });
  assert.deepEqual(gridFor(10, 10, 1000), { nx: 201, ny: 201 });  // nie feiner als 0,05 mm
  const big = gridFor(5000, 5000, 100000);
  assert.ok(big.nx * big.ny <= MAX_NODES);
});

test("Bild: hell = hoch, volle Tiefe, Oberkante genau 0, nie tiefer als gewählt", () => {
  const { field, flat } = grayToField(ramp(41, 21), 41, 21, opts());
  assert.equal(flat, false);
  assert.ok(Math.abs(at(field, 40, 10)) < 1e-3);
  assert.ok(Math.abs(at(field, 0, 10) + 5) < 0.05);
  assert.ok(Math.abs(at(field, 20, 10) + 2.5) < 0.1);
  assert.ok(Math.max(...field.z) === 0);
  assert.ok(Math.min(...field.z) >= -5);
});

test("Bild: dunkel = hoch beim Umkehren", () => {
  const { field } = grayToField(ramp(41, 21), 41, 21, opts({ invert: true }));
  assert.ok(Math.abs(at(field, 0, 10)) < 1e-3);
  assert.ok(Math.abs(at(field, 40, 10) + 5) < 0.05);
});

test("Bild: nicht gespiegelt – oberste Bildzeile liegt bei großem Y", () => {
  const g = new Float32Array(11 * 11);
  for (let i = 0; i < 11; i++) g[i] = 1;            // oberste Zeile weiß, Rest schwarz
  const { field } = grayToField(g, 11, 11, opts({ w: 10, h: 10, nx: 11, ny: 11 }));
  assert.ok(Math.abs(at(field, 5, 10)) < 1e-3);
  assert.ok(Math.abs(at(field, 5, 0) + 5) < 1e-3);
});

test("Bild: einfarbig = flach", () => {
  const { flat, field } = grayToField(new Float32Array(100).fill(0.5), 10, 10, opts({ w: 10, h: 10, nx: 11, ny: 11 }));
  assert.equal(flat, true);
  assert.equal(fieldRange(field), 0);
});

test("Bild: Kontrast und Gamma halten die Enden, ändern die Mitte", () => {
  const base = grayToField(ramp(41, 21), 41, 21, opts()).field;
  const hard = grayToField(ramp(41, 21), 41, 21, opts({ contrast: 3 })).field;
  assert.ok(at(hard, 30, 10) > at(base, 30, 10));
  assert.ok(at(hard, 10, 10) < at(base, 10, 10));
  const lift = grayToField(ramp(41, 21), 41, 21, opts({ gamma: 2 })).field;
  assert.ok(at(lift, 20, 10) > at(base, 20, 10));
  for (const f of [hard, lift]) { assert.ok(Math.min(...f.z) >= -5); assert.equal(Math.max(...f.z), 0); }
});

test("Bild: Rand läuft zur Oberkante oder zur tiefsten Höhe", () => {
  const top = grayToField(ramp(41, 21), 41, 21, opts({ border: 2, fade: 4 })).field;
  for (let j = 0; j < 21; j++) assert.equal(at(top, 0, j), 0);             // Rand steht auf Z 0
  for (let i = 0; i < 41; i++) assert.equal(at(top, i, 0), 0);
  const mid = grayToField(ramp(41, 21), 41, 21, opts()).field;
  assert.ok(Math.abs(at(top, 20, 10) - at(mid, 20, 10)) < 1e-3);           // Mitte unverändert (Abstand ≥ 6 mm)
  const bot = grayToField(ramp(41, 21), 41, 21, opts({ fade: 4, fadeTo: "bottom" })).field;
  const low = Math.min(...bot.z);
  assert.ok(Math.abs(at(bot, 0, 10) - low) < 1e-3 && Math.abs(at(bot, 40, 10) - low) < 1e-3);   // Rand = tiefste Stelle
  assert.ok(low >= -5);
  assert.equal(Math.max(...bot.z), 0);                                      // Oberkante wieder genau 0
  // Übergang ohne Sprung
  for (let i = 1; i < 41; i++) assert.ok(Math.abs(at(bot, i, 10) - at(bot, i - 1, 10)) < 2);
});

test("Bild: Glätten nimmt einen Ausreißer weg, ändert die Tiefe nicht", () => {
  const g = new Float32Array(41 * 41).fill(0.5);
  g[20 * 41 + 20] = 1;
  for (let i = 0; i < 41; i++) g[i] = 0;             // schwarze Zeile für den Tiefenbereich
  const f = grayToField(g, 41, 41, opts({ w: 40, h: 40, nx: 41, ny: 41, smooth: 1.5 })).field;
  assert.ok(Math.min(...f.z) >= -5);
  const a = new Float32Array(25); a[12] = 1;
  blur(a, 5, 5, 1, 1);
  assert.ok(a[12] < 0.5 && a[12] > 0);
  assert.ok(Math.abs(a.reduce((s, v) => s + v, 0) - 1) < 0.2);
});

test("Verkleinern mittelt, Vergrößern läuft weich", () => {
  const g = new Float32Array(100 * 100);
  for (let i = 0; i < g.length; i++) g[i] = (i % 2);  // Streifen
  const s = resampleGray(g, 100, 100, 11, 11);
  assert.ok(Math.abs(s[5 * 11 + 5] - 0.5) < 0.1);
  const u = resampleGray(new Float32Array([0, 1, 0, 1]), 2, 2, 3, 3);
  assert.ok(Math.abs(u[1] - 0.5) < 1e-6);
});

test("Netz: 2 Dreiecke je Zelle, Eckpunkte richtig; Ansicht mit Wänden bis zum Boden", () => {
  const f: HeightField = { nx: 3, ny: 2, w: 20, h: 10, z: new Float32Array([0, -1, -2, -3, -4, -5]) };
  const m = fieldToMesh(f);
  assert.equal(m.length, 2 * 2 * 9);
  assert.deepEqual(Array.from(m.slice(0, 9)), [0, 0, 0, 10, 0, -1, 10, 10, -4]);
  // alle Normalen nach oben (Drehsinn)
  for (let k = 0; k < m.length; k += 9) {
    const ux = m[k + 3] - m[k], uy = m[k + 4] - m[k + 1], vx = m[k + 6] - m[k], vy = m[k + 7] - m[k + 1];
    assert.ok(ux * vy - uy * vx > 0);
  }
  const p = fieldPreviewTris(f, -8);
  assert.ok(p.length > m.length);
  assert.equal(Math.min(...p.filter((_, i) => i % 3 === 2)), -8);
});

const square = (x: number, y: number, s: number): VPt[] => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
const fieldAt = (r: { field: HeightField; x0: number; y0: number }, x: number, y: number) => {
  const f = r.field;
  return f.z[Math.round(((y - r.y0) / f.h) * (f.ny - 1)) * f.nx + Math.round(((x - r.x0) / f.w) * (f.nx - 1))];
};

test("Vektor: Loch bleibt Loch (gerade/ungerade), Insel im Loch steht wieder", () => {
  const loops = [square(0, 0, 40), square(10, 10, 20), square(17, 17, 6)];
  const r = loopsToField(loops, { height: 4, profile: "round", width: 1, pad: 2, smooth: 0, long: 300 })!;
  assert.ok(Math.abs(fieldAt(r, 5, 20)) < 1e-3);      // im Rand: oben
  assert.ok(Math.abs(fieldAt(r, 13, 20) + 4) < 1e-3); // im Loch: Boden
  assert.ok(Math.abs(fieldAt(r, 20, 20)) < 1e-3);     // Insel im Loch: oben
  assert.ok(Math.abs(fieldAt(r, -1, 20) + 4) < 1e-3); // draußen: Boden
  assert.equal(Math.max(...r.field.z), 0);
  assert.ok(Math.min(...r.field.z) >= -4 - 1e-6);
});

test("Vektor: Profile – schräg linear, rund höher, Kuppel wächst mit dem Abstand und ist gedeckelt", () => {
  const loops = [square(0, 0, 40)];
  const base = { height: 4, width: 4, pad: 2, smooth: 0, long: 440 };
  const slope = loopsToField(loops, { ...base, profile: "slope" })!;
  assert.ok(Math.abs(fieldAt(slope, 2, 20) - (-2)) < 0.05);       // halbe Kantenbreite = halbe Höhe
  assert.ok(Math.abs(fieldAt(slope, 20, 20)) < 1e-3);
  const round = loopsToField(loops, { ...base, profile: "round" })!;
  assert.ok(fieldAt(round, 2, 20) > fieldAt(slope, 2, 20) + 0.3);  // runde Kante steigt schneller
  const dome = loopsToField(loops, { ...base, profile: "dome", width: 0 })!;
  const seq = [1, 5, 10, 15, 20].map(x => fieldAt(dome, x, 20));
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1]);
  assert.ok(Math.abs(seq[4]) < 0.02);                              // Mitte = höchste Stelle
  assert.ok(fieldRange(dome.field) <= 4 + 1e-6);
  const capped = loopsToField(loops, { ...base, profile: "dome", width: 5 })!;
  assert.ok(Math.abs(fieldAt(capped, 10, 20)) < 1e-3 && Math.abs(fieldAt(capped, 20, 20)) < 1e-3);  // ab 5 mm oben flach
});

test("Vektor: Abstand stimmt gegen die Rechnung von Hand; Glätten hebt nie an", () => {
  const circle: VPt[] = Array.from({ length: 64 }, (_, k) => ({ x: 20 * Math.cos((k * Math.PI) / 32), y: 20 * Math.sin((k * Math.PI) / 32) }));
  const d = contourDistance([circle], -25, -25, 0.5, 0.5, 101, 101);
  for (let j = 0; j < 101; j += 7) for (let i = 0; i < 101; i += 7) {
    const want = Math.abs(Math.hypot(-25 + i * 0.5, -25 + j * 0.5) - 20);
    assert.ok(Math.abs(d[j * 101 + i] - want) < 0.15, `${i},${j}: ${d[j * 101 + i]} vs ${want}`);
  }
  const m = insideMask([circle], -25, -25, 0.5, 0.5, 101, 101);
  assert.equal(m[50 * 101 + 50], 1);
  assert.equal(m[0], 0);
  const sharp = loopsToField([circle], { height: 4, profile: "dome", width: 0, pad: 2, smooth: 0, long: 100 })!;
  const soft = loopsToField([circle], { height: 4, profile: "dome", width: 0, pad: 2, smooth: 2, long: 100 })!;
  // Hintergrund bleibt Hintergrund
  assert.ok(Math.abs(fieldAt(soft, -21, 0) + (fieldRange(soft.field))) < 1e-3);
  assert.ok(fieldRange(soft.field) <= fieldRange(sharp.field) + 1e-6);
});

test("Vektor: nichts Geschlossenes, Worker-Rechnung", () => {
  assert.equal(loopsToField([[{ x: 0, y: 0 }, { x: 1, y: 1 }]], { height: 1, profile: "round", width: 1, pad: 1, smooth: 0, long: 10 }), null);
  const b = buildRelief({ kind: "vector", loops: [square(5, 7, 10)], opts: { height: 2, profile: "slope", width: 1, pad: 1, smooth: 0, long: 60 } })!;
  assert.equal(b.x0, 4); assert.equal(b.y0, 6);
  assert.equal(b.pos.length, (b.field.nx - 1) * (b.field.ny - 1) * 18);
});

test("Detail-Warnung: sanfte Fläche und Schräge gehen, enge Rille nicht", () => {
  const make = (fn: (x: number, y: number) => number): HeightField => {
    const nx = 201, ny = 201, z = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = fn(i * 0.5, j * 0.5);
    return { nx, ny, w: 100, h: 100, z };
  };
  const slope = make(x => -x * 0.5);                               // Schräge: keine Details
  assert.ok(detailLoss(slope, 100, 100, 50, 3).share < 0.01);
  const wave = make(x => -2.5 - 2.5 * Math.cos(x / 10));            // weite Welle
  assert.ok(detailLoss(wave, 100, 100, 5, 3).share < 0.01);
  // Rillen alle 4 mm, 1 mm breit, 3 mm tief: 6-mm-Kugel kommt nicht hinein, 1-mm-Kugel schon
  const groove = make(x => (x % 4 < 1 ? -3 : 0));
  const coarse = detailLoss(groove, 100, 100, 3, 3);
  assert.ok(coarse.share > 0.1, String(coarse.share));
  assert.ok(coarse.worst > 2);
  assert.ok(detailLoss(groove, 100, 100, 3, 0.25).share < coarse.share);
});

// ---- OBJ ----
const obj = (s: string) => parseObjBytes(new TextEncoder().encode(s));
const fails = (s: string, code: string) => assert.throws(() => obj(s), (e: any) => e instanceof ObjError && e.code === code, code);

test("OBJ: Dreiecke, Vielecke auffächern, v/vt/vn, negative Nummern, Rest übergehen", () => {
  const m = obj(`# Kommentar
mtllib x.mtl
o Teil
v 0 0 0
v 1 0 0 1.0
v 1.5e0 1 0
v 0 1 -2.5
vn 0 0 1
vt 0 0
usemtl holz
s off
f 1 2 3
f 1/1/1 2/1/1 3/1/1 4/1/1
f -4 -3 -1
`);
  assert.equal(m.triangles, 4);
  assert.equal(m.vertices, 4);
  assert.deepEqual(Array.from(m.positions.slice(0, 9)), [0, 0, 0, 1, 0, 0, 1.5, 1, 0]);
  // Vieleck 1-2-3-4 → (1,2,3) + (1,3,4)
  assert.deepEqual(Array.from(m.positions.slice(18, 27)), [0, 0, 0, 1.5, 1, 0, 0, 1, -2.5]);
  // negativ: -4 = erster Punkt, -1 = letzter
  assert.deepEqual(Array.from(m.positions.slice(27, 36)), [0, 0, 0, 1, 0, 0, 0, 1, -2.5]);
});

test("OBJ: Fortsetzung mit \\, CRLF, ausgeartete Flächen zählen nicht", () => {
  const m = obj("v 0 0 0\r\nv 1 0 0\r\nv 0 1 0\r\nf 1 2 \\\r\n 3\r\nf 1 1 2\r\nf 1 2\r\n");
  assert.equal(m.triangles, 1);
  assert.equal(m.skipped, 2);
});

test("OBJ: kaputte Dateien geben eine klare Meldung", () => {
  fails("", "noVertices");
  fails("hallo welt\n\x00\x01\x02", "noVertices");
  fails("v 0 0 0\nv 1 1 1\n", "noFaces");
  fails("v 0 0\nf 1 1 1\n", "badNumber");
  fails("v 0 abc 0\n", "badNumber");
  fails("v 1e999 0 0\n", "badNumber");
  fails("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n", "badIndex");
  fails("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 -9\n", "badIndex");
  fails("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 0\n", "badIndex");
  fails("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 x\n", "badIndex");
  // Zeile steht im Fehler, Text aus der Datei nicht
  try { obj("v 0 0 0\n<script>alert(1)</script> \nv <img> 0 0\n"); assert.fail(); }
  catch (e: any) { assert.equal(e.line, 3); assert.ok(!e.message.includes("<")); }
});

// ---- G-Code gegen das Höhenfeld ----
const ball = (d: number): ToolGeom => ({ type: "ball", diameter: d, shankDia: d, fluteLen: 20, length: 40, flutes: 2, helix: "up", angle: 0, tipDia: 0, cornerR: 0 });

/** Drop-Cutter mit Kugel auf dem Feld (Knoten): so tief darf die Spitze über (x, y) */
function dropBall(f: HeightField, x: number, y: number, R: number): number {
  const dx = f.w / (f.nx - 1), dy = f.h / (f.ny - 1);
  const i0 = Math.max(0, Math.floor((x - R) / dx)), i1 = Math.min(f.nx - 1, Math.ceil((x + R) / dx));
  const j0 = Math.max(0, Math.floor((y - R) / dy)), j1 = Math.min(f.ny - 1, Math.ceil((y + R) / dy));
  let best = -fieldRange(f);      // wie der Boden in cam3d.rs: nie tiefer als das Relief
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const d2 = (i * dx - x) ** 2 + (j * dy - y) ** 2;
    if (d2 > R * R) continue;
    best = Math.max(best, f.z[j * f.nx + i] - (R - Math.sqrt(R * R - d2)));
  }
  return best;
}

/** Zeilen wie beim Schlichten als G-Code; der echte Bahnen-Rechner (cam3d.rs) hat denselben Test in cargo test */
function finishGcode(f: HeightField, R: number, over: number): string {
  const g = ["G21", "G90", "G0 Z5", "M3 S10000", "F1000"];
  for (let y = 0, k = 0; y <= f.h + 1e-9; y += over, k++) {
    const xs: number[] = [];
    for (let x = 0; x <= f.w + 1e-9; x += 0.05) xs.push(x);
    if (k % 2) xs.reverse();
    g.push("G0 Z5", `G0 X${xs[0].toFixed(3)} Y${y.toFixed(3)}`);
    for (const [q, x] of xs.entries()) {
      const z = dropBall(f, x, y, R).toFixed(3);
      g.push(q ? `G1 X${x.toFixed(3)} Z${z}` : `G1 Z${z}`);
    }
  }
  g.push("G0 Z5", "M5");
  return g.join("\n");
}

/** Bohrt der Kugelfräser irgendwo auf den G1-Wegen unter die Zielfläche? Gibt die größte Eindringtiefe zurück */
function gougeCheck(gcode: string, f: HeightField, R: number): { worst: number; minZ: number } {
  const dx = f.w / (f.nx - 1), dy = f.h / (f.ny - 1);
  let x = 0, y = 0, z = 5, worst = 0, minZ = Infinity;
  for (const line of gcode.split("\n")) {
    const m = line.match(/^G([01])\b/);
    if (!m) continue;
    const num = (a: string, d: number) => { const q = line.match(new RegExp(a + "(-?[0-9.]+)")); return q ? +q[1] : d; };
    const nx = num("X", x), ny = num("Y", y), nz = num("Z", z);
    if (m[1] === "1") {
      const n = Math.max(1, Math.ceil(Math.hypot(nx - x, ny - y) / 0.1));
      for (let k = 0; k <= n; k++) {
        const px = x + ((nx - x) * k) / n, py = y + ((ny - y) * k) / n, pz = z + ((nz - z) * k) / n;
        if (pz < minZ) minZ = pz;
        const i0 = Math.max(0, Math.floor((px - R) / dx)), i1 = Math.min(f.nx - 1, Math.ceil((px + R) / dx));
        const j0 = Math.max(0, Math.floor((py - R) / dy)), j1 = Math.min(f.ny - 1, Math.ceil((py + R) / dy));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const d2 = (i * dx - px) ** 2 + (j * dy - py) ** 2;
          if (d2 > R * R) continue;
          worst = Math.max(worst, f.z[j * f.nx + i] - (pz + R - Math.sqrt(R * R - d2)));
        }
      }
    }
    x = nx; y = ny; z = nz;
  }
  return { worst, minZ };
}

test("G-Code gegen das Höhenfeld: nie unter der Zielfläche, nie tiefer als die Relief-Tiefe; Simulation zeigt das Relief", () => {
  const nx = 61, ny = 41, gray = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) gray[j * nx + i] = 0.5 + 0.5 * Math.sin(i / 7) * Math.cos(j / 5);
  const depth = 4;
  const { field } = grayToField(gray, nx, ny, opts({ w: 60, h: 40, nx: 121, ny: 81, depth, smooth: 0.5, fade: 3 }));
  const R = 1.5;
  const gcode = finishGcode(field, R, 0.3);
  const chk = gougeCheck(gcode, field, R);
  assert.ok(chk.worst <= 0.05, `unter dem Ziel: ${chk.worst}`);
  assert.ok(chk.minZ >= -depth, `tiefer als die Relief-Tiefe: ${chk.minZ}`);
  // Probe: ein absichtlich zu tiefer Weg wird erkannt
  assert.ok(gougeCheck("G0 X30 Y20\nG1 Z" + (at(field, 60, 40) - 1).toFixed(3), field, R).worst > 0.5);

  // Materialabtrag aus demselben G-Code: die Fläche ist im Mittel nah am Ziel (auf das Raster der Simulation gerundet)
  const prog = parseGcodeProgram(gcode.split("\n"));
  const c = LiveCarve.create(prog, { tools: [ball(2 * R)], thickness: depth + 3 })!;
  c.setTarget(prog.n, 0);
  for (let k = 0; c.busy && k < 100000; k++) c.advance(50);
  let sum = 0, n = 0;
  for (let j = 0; j < c.ny; j++) for (let i = 0; i < c.nx; i++) {
    const x = c.x0 + (i + 0.5) * c.cell, y = c.y0 + (j + 0.5) * c.cell;
    if (x < 0 || y < 0 || x > field.w || y > field.h) continue;
    const want = at(field, Math.min(120, Math.round(x / 0.5)), Math.min(80, Math.round(y / 0.5)));
    sum += Math.abs(c.h[j * c.nx + i] - want); n++;
  }
  assert.ok(sum / n < 0.2, `Simulation weicht ab: ${sum / n}`);
});
