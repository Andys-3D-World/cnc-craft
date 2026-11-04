// Tests für Arc Fitting – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitArcs, clampArcTol } from "../src/arcFit.ts";

const head = "G21\nG90\nG0 X0 Y0\nG1 Z-1 F300\nG1 F1000\n";
const f3 = (v: number) => v.toFixed(3);

/** Bogen aus kleinen Geraden. Start bei Winkel a0, Sweep positiv = gegen den Uhrzeigersinn */
function chord(cx: number, cy: number, r: number, a0: number, sweep: number, n: number) {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push({ x: +f3(cx + r * Math.cos(a)), y: +f3(cy + r * Math.sin(a)) });
  }
  return pts;
}
const asG1 = (pts: { x: number; y: number }[]) => pts.map(p => `G1 X${f3(p.x)} Y${f3(p.y)}`).join("\n");

/** Was die Maschine fährt, fein abgetastet (Bögen genau) */
function trace(g: string) {
  const out: { x: number; y: number }[] = [];
  let x = 0, y = 0;
  for (const l of g.split("\n")) {
    const m = l.match(/^G([0123])\b/);
    if (!m) continue;
    const X = l.match(/X(-?[\d.]+)/), Y = l.match(/Y(-?[\d.]+)/), I = l.match(/I(-?[\d.]+)/), J = l.match(/J(-?[\d.]+)/);
    const nx = X ? +X[1] : x, ny = Y ? +Y[1] : y;
    if (m[1] === "2" || m[1] === "3") {
      const cx = x + +I![1], cy = y + +J![1], r = Math.hypot(x - cx, y - cy);
      let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
      if (m[1] === "3") { while (a1 <= a0) a1 += 2 * Math.PI; } else { while (a1 >= a0) a1 -= 2 * Math.PI; }
      for (let k = 1; k <= 200; k++) { const a = a0 + (a1 - a0) * k / 200; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
    } else {
      for (let k = 1; k <= 20; k++) out.push({ x: x + (nx - x) * k / 20, y: y + (ny - y) * k / 20 });
    }
    x = nx; y = ny;
  }
  return out;
}
const segDist = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const f = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(a.x + dx * f - p.x, a.y + dy * f - p.y);
};
/** Größter Abstand der neuen Bahn zur alten (in beide Richtungen) */
function deviation(a: string, b: string) {
  const ta = trace(a), tb = trace(b);
  const one = (s: typeof ta, q: typeof ta) => Math.max(...s.filter((_, i) => i % 3 === 0).map(p => {
    let d = Infinity;
    for (let i = 1; i < q.length; i++) d = Math.min(d, segDist(p, q[i - 1], q[i]));
    return d;
  }));
  return Math.max(one(ta, tb), one(tb, ta));
}

test("Viertelkreis gegen den Uhrzeigersinn wird ein G3 mit richtigem I/J", () => {
  const pts = chord(50, 50, 10, 0, Math.PI / 2, 40);
  const r = fitArcs(`G0 X${f3(pts[0].x)} Y${f3(pts[0].y)}\n${asG1(pts.slice(1))}`);
  const l = r.gcode.split("\n");
  assert.equal(l.length, 2);
  assert.match(l[1], /^G3 X50\.000 Y60\.000 I-10\.000 J0\.000$/);
  assert.equal(r.arcs, 1);
});

test("Im Uhrzeigersinn wird G2", () => {
  const pts = chord(0, 0, 20, Math.PI / 2, -Math.PI / 2, 60);
  const r = fitArcs(`G0 X0 Y20\n${asG1(pts.slice(1))}`);
  assert.match(r.gcode.split("\n")[1], /^G2 X20\.000 Y0\.000 I0\.000 J-20\.000$/);
});

test("Geraden bleiben Geraden (auch viele kurze hintereinander)", () => {
  const g = "G0 X0 Y0\n" + Array.from({ length: 50 }, (_, i) => `G1 X${(i + 1).toFixed(3)} Y${((i + 1) * 0.5).toFixed(3)}`).join("\n");
  const r = fitArcs(g);
  assert.equal(r.gcode, g);
  assert.equal(r.arcs, 0);
});

test("Zu wenige Punkte: kein Bogen", () => {
  const pts = chord(0, 0, 10, 0, 0.5, 3);
  const g = `G0 X${f3(pts[0].x)} Y${f3(pts[0].y)}\n${asG1(pts.slice(1))}`;
  assert.equal(fitArcs(g).gcode, g);
});

test("Vieleck mit großer Abweichung (Achteck) bleibt eckig", () => {
  const pts = chord(0, 0, 50, 0, 2 * Math.PI, 8);
  const g = `G0 X${f3(pts[0].x)} Y${f3(pts[0].y)}\n${asG1(pts.slice(1))}`;
  assert.equal(fitArcs(g).gcode, g);
});

test("Rechteck mit Ecke bleibt unverändert", () => {
  const g = "G0 X0 Y0\nG1 X10.000 Y0.000\nG1 X20.000 Y0.000\nG1 X30.000 Y0.000\nG1 X30.000 Y10.000\nG1 X30.000 Y20.000\nG1 X30.000 Y30.000";
  assert.equal(fitArcs(g).gcode, g);
});

test("Voller Kreis: mehrere Bögen, Ende genau am Anfang, kaum Zeilen", () => {
  const pts = chord(10, 10, 15, 0, 2 * Math.PI, 180);
  const g = `G0 X${f3(pts[0].x)} Y${f3(pts[0].y)}\n${asG1(pts.slice(1))}`;
  const r = fitArcs(g);
  assert.ok(r.arcs >= 2 && r.arcs <= 3, `Bögen ${r.arcs}`);
  assert.ok(r.after <= 4);
  const last = r.gcode.split("\n").pop()!;
  assert.ok(last.includes(`X${f3(pts[0].x)} Y${f3(pts[0].y)}`));
  assert.ok(deviation(g, r.gcode) <= 0.01 + 1e-6);
});

test("Die neue Bahn weicht nie mehr als die Toleranz ab (Gerade-Bogen-Gerade, verschiedene Radien)", () => {
  for (const [R, n] of [[2, 16], [5, 24], [30, 60], [200, 120]] as const) for (const tol of [0.005, 0.01, 0.05]) {
    const arc = chord(R, 0, R, Math.PI, -Math.PI / 2, n);
    const g = `G0 X-10.000 Y0.000\nG1 X-5.000 Y0.000\nG1 X0.000 Y0.000\n${asG1(arc.slice(1))}\nG1 X${f3(R + 5)} Y${f3(R)}\nG1 X${f3(R + 10)} Y${f3(R)}`;
    const r = fitArcs(g, tol);
    const d = deviation(g, r.gcode);
    assert.ok(d <= tol + 1e-3, `R${R} tol ${tol}: ${d}`);
  }
});

test("Kurvenform mit wechselnder Krümmung (Ellipse) bleibt innerhalb der Toleranz", () => {
  const pts = Array.from({ length: 300 }, (_, i) => { const a = i / 300 * 2 * Math.PI; return { x: +f3(40 * Math.cos(a)), y: +f3(15 * Math.sin(a)) }; });
  const g = `G0 X40.000 Y0.000\n${asG1(pts.slice(1))}`;
  const r = fitArcs(g, 0.01);
  assert.ok(r.after < r.before / 3, `${r.before} → ${r.after}`);
  assert.ok(deviation(g, r.gcode) <= 0.011);
});

test("Sehr fein aufgelöste Kurve wird trotzdem zusammengefasst", () => {
  const pts = Array.from({ length: 2000 }, (_, i) => { const a = i / 2000 * 2 * Math.PI; return { x: +f3(61.5 * Math.cos(a)), y: +f3(36.5 * Math.sin(a)) }; });
  const g = `G0 X61.500 Y0.000\n${asG1(pts.slice(1))}`;
  const r = fitArcs(g, 0.01);
  assert.ok(r.after < 200, `${r.before} → ${r.after}`);
  assert.ok(deviation(g, r.gcode) <= 0.012);
});

test("Lange gerade Strecke aus sehr vielen Punkten ist schnell und bleibt unverändert", () => {
  const g = "G0 X0 Y0\n" + Array.from({ length: 20000 }, (_, i) => `G1 X${((i + 1) * 0.01).toFixed(3)} Y0.000`).join("\n");
  const t0 = Date.now();
  assert.equal(fitArcs(g).gcode, g);
  assert.ok(Date.now() - t0 < 5000);
});

test("Z-Änderung, Kommentar und andere Zeilen trennen den Bogen", () => {
  const a = chord(0, 0, 10, 0, 1, 12), b = chord(0, 0, 10, 1, 1, 12);
  const g = `G0 X10.000 Y0.000\n${asG1(a.slice(1))}\nG1 Z-2.000 F300\n${asG1(b.slice(1))}`;
  const l = fitArcs(g).gcode.split("\n");
  assert.equal(l.length, 4);
  assert.match(l[1], /^G[23] /);
  assert.equal(l[2], "G1 Z-2.000 F300");
  assert.match(l[3], /^G[23] /);
  const withComment = `G0 X10.000 Y0.000\n${asG1(a.slice(1))}\n(Form 2)\n${asG1(b.slice(1))}`;
  assert.ok(fitArcs(withComment).gcode.split("\n").includes("(Form 2)"));
});

test("Zeilen mit Z werden nie Teil eines Bogens", () => {
  const pts = chord(0, 0, 10, 0, 1, 12);
  const g = "G0 X10.000 Y0.000\n" + pts.slice(1).map((p, i) => `G1 X${f3(p.x)} Y${f3(p.y)} Z${f3(-i * 0.01)}`).join("\n");
  assert.equal(fitArcs(g).gcode, g);
});

test("Vorschub bleibt: F-Zeile nur am Anfang, Wechsel trennt", () => {
  const a = chord(0, 0, 10, 0, 1, 12), b = chord(0, 0, 10, 1, 1, 12);
  const la = asG1(a.slice(1)).split("\n"), lb = asG1(b.slice(1)).split("\n");
  la[0] += " F800"; lb[0] += " F400";
  const l = fitArcs(`G0 X10.000 Y0.000\n${la.join("\n")}\n${lb.join("\n")}`).gcode.split("\n");
  assert.equal(l.length, 3);
  assert.ok(l[1].endsWith(" F800"));
  assert.ok(l[2].endsWith(" F400"));
});

test("Relativ, Zoll, andere Ebene: der Rest bleibt unverändert", () => {
  const pts = chord(0, 0, 10, 0, 1, 12);
  const body = asG1(pts.slice(1));
  for (const stop of ["G91", "G20", "G18", "G19", "G92 X0 Y0"]) {
    const g = `G0 X10.000 Y0.000\n${stop}\n${body}`;
    assert.equal(fitArcs(g).gcode, g, stop);
  }
});

test("Ohne bekannte Position: die erste Zeile bleibt, ab da ist die Lage bekannt; G53 macht sie wieder unbekannt", () => {
  const pts = chord(0, 0, 10, 0, 1, 12);
  const l = fitArcs(asG1(pts)).gcode.split("\n");
  assert.equal(l[0], asG1(pts).split("\n")[0]);
  assert.match(l[1], /^G[23] /);
  const afterG53 = `G53 G0 X1 Y1\n${asG1(pts)}`;
  assert.equal(fitArcs(afterG53).gcode.split("\n")[1], asG1(pts).split("\n")[0]);
});

test("Radius passt so genau, dass GRBL nicht mit Fehler 33 abbricht", () => {
  const pts = chord(123.456, 78.9, 7.77, 0.3, 2, 60);
  const r = fitArcs(`G0 X${f3(pts[0].x)} Y${f3(pts[0].y)}\n${asG1(pts.slice(1))}`);
  let x = pts[0].x, y = pts[0].y;
  for (const l of r.gcode.split("\n").slice(1)) {
    const X = +l.match(/X(-?[\d.]+)/)![1], Y = +l.match(/Y(-?[\d.]+)/)![1], I = +l.match(/I(-?[\d.]+)/)![1], J = +l.match(/J(-?[\d.]+)/)![1];
    assert.ok(Math.abs(Math.hypot(I, J) - Math.hypot(x + I - X, y + J - Y)) <= 0.005);
    x = X; y = Y;
  }
});

test("Zählt Zeilen und begrenzt die Toleranz", () => {
  const pts = chord(0, 0, 10, 0, 1.5, 40);
  const r = fitArcs(head + `G1 X${f3(pts[0].x)} Y${f3(pts[0].y)}\n${asG1(pts.slice(1))}`);
  assert.ok(r.after < r.before);
  assert.equal(clampArcTol(5), 0.1);
  assert.equal(clampArcTol(0), 0.001);
});
