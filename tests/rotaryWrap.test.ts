// Tests für die Drehachsen-Umrechnung (Laser und Fräse) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapGcode, mapSurfaceY, axesToInternal, axesToMachine, type WrapOptions } from "../src/rotaryWrap.ts";

// Ø 360/π mm → Umfang 360 mm → 1 mm rundherum = 1°
const D = 360 / Math.PI;
const A: WrapOptions = { axis: "a", driveDia: D, partDia: D, mmPerRot: 100, depthFeed: false };
const ok = (src: string[], o: WrapOptions = A) => {
  const r = wrapGcode(src, o);
  assert.ok(r.ok, JSON.stringify(r));
  return (r as { lines: string[] }).lines;
};
const num = (line: string, w: string) => { const m = line.match(new RegExp(w + "(-?[\\d.]+)")); return m ? parseFloat(m[1]) : undefined; };

test("Y wird zu A in Grad, Kommentare bleiben", () => {
  const out = ok(["G0 X10 Y90 (Y5 bleibt)", "G1 X20 F600"]);
  assert.equal(out[0], "G0 X10 A90 (Y5 bleibt)");
  assert.equal(mapSurfaceY(180, A), 180);
  assert.equal(mapSurfaceY(50, { ...A, axis: "y", driveDia: 100 / Math.PI }), 100 * 50 / 100);
});

test("Vorschub: reine X-Fahrt bleibt, reine Drehung wird so umgerechnet, dass die Oberfläche stimmt", () => {
  // Ø 20 mm: 1 mm rundherum = 360 / (π·20) ≈ 5,73°
  const o = { ...A, driveDia: 20, partDia: 20 };
  const out = ok(["G0 X0 Y0 Z0", "G1 X10 F600", "G1 Y10"], o);
  assert.equal(num(out[1], "F"), 600);
  assert.equal(num(out[2], "F"), Math.round(600 * 360 / (Math.PI * 20)));
});

test("Fräse: in der Tiefe ist der Weg rundherum kürzer → F passt sich an", () => {
  const o = { ...A, driveDia: 40, partDia: 40, depthFeed: true };
  const flat = ok(["G0 X0 Y0 Z-10", "G1 Y10 F500"], { ...o, depthFeed: false });
  const deep = ok(["G0 X0 Y0 Z-10", "G1 Y10 F500"], o);
  // Radius 20 → 10: halber Weg an der Schneide → doppelter Wert für die Maschine
  assert.ok(Math.abs(num(deep[1], "F")! - num(flat[1], "F")! * 2) <= 2);
});

test("Bogen wird in Geraden zerlegt und landet am richtigen Endpunkt", () => {
  const out = ok(["G0 X0 Y0 Z1", "G1 Z-1 F300", "G2 X20 Y0 I10 J0"]);
  const arc = out.slice(2);
  assert.ok(arc.length >= 20, String(arc.length));
  assert.ok(arc.every(l => l.startsWith("G1 ") && !/[IJ]/.test(l)));
  const last = arc[arc.length - 1];
  assert.equal(num(last, "X"), 20);
  assert.equal(num(last, "A"), 0);
  // G2 von (0,0) um (10,0) im Uhrzeigersinn: geht über Y = +10 (= 10°)
  const maxA = Math.max(...arc.map(l => num(l, "A") ?? 0));
  assert.ok(Math.abs(maxA - 10) < 0.05, String(maxA));
});

test("Bogen mit R und Spirale (Z läuft mit)", () => {
  const out = ok(["G0 X0 Y0 Z0", "G1 F300", "G3 X10 Y10 Z-2 R10"]);
  const last = out[out.length - 1];
  assert.equal(num(last, "X"), 10);
  assert.equal(num(last, "A"), 10);
  assert.equal(num(last, "Z"), -2);
});

test("F wird nur geschrieben, wenn es sich ändert", () => {
  const out = ok(["G0 X0 Y0 Z0", "G1 X10 F800", "G1 X20", "G1 X30 F800"]);
  assert.equal(out.filter(l => /F/.test(l)).length, 1);
});

test("Bohrzyklus behält seinen Vorschub", () => {
  const out = ok(["G0 X0 Y0 Z5", "G81 X5 Y20 Z-3 R1 F120", "G80"]);
  assert.equal(out[1], "G81 X5 A20 Z-3 R1 F120");
});

test("abgelehnt: G91, G20, Bogen außerhalb XY", () => {
  assert.deepEqual(wrapGcode(["G91", "G1 X1 Y1 F100"], A), { ok: false, error: "relative", line: 2 });
  assert.deepEqual(wrapGcode(["G20"], A), { ok: false, error: "inch", line: 1 });
  assert.deepEqual(wrapGcode(["G0 X0 Y0 Z0", "G18 G2 X1 Z1 I1"], A), { ok: false, error: "plane", line: 2 });
});

test("Y-Anschluss: Y bleibt Y, nur umgerechnet", () => {
  const o: WrapOptions = { axis: "y", driveDia: 30, partDia: 80, mmPerRot: 100, depthFeed: false };
  const out = ok(["G0 X0 Y" + (Math.PI * 30)], o);
  assert.equal(out[0], "G0 X0 Y100");
});

test("Laser ohne Z: Vorschub wird trotzdem angepasst, Bögen ohne Z", () => {
  const o = { ...A, driveDia: 20, partDia: 20 };
  const out = ok(["G0 X0 Y0 S0", "F300", "G1 Y10 S1000", "G2 X10 Y0 I5 J-5"], o);
  assert.equal(num(out[2], "F"), Math.round(300 * 360 / (Math.PI * 20)));
  assert.ok(out.slice(3).every(l => !/Z/.test(l)));
});

test("Drehrichtung umkehren: A bekommt ein Minus, Vorschub gleich", () => {
  const n = ok(["G0 X0 Y0 Z0", "G1 Y90 F600"]);
  const r = ok(["G0 X0 Y0 Z0", "G1 Y90 F600"], { ...A, reverse: true });
  assert.equal(num(n[1], "A"), 90);
  assert.equal(num(r[1], "A"), -90);
  assert.equal(num(n[1], "F"), num(r[1], "F"));
});

test("Achse entlang Y: Y bleibt entlang des Teils, X wird zur Drehung (gedreht, nicht gespiegelt)", () => {
  const o = { ...A, along: "y" as const };
  const out = ok(["G0 X0 Y0 Z0", "G1 X90 Y20 F600"], o);
  // Y = entlang (unverändert), X → A; Drehung um +Y (rechte Hand): +X der Zeichnung = −A
  assert.equal(num(out[1], "Y"), 20);
  assert.equal(num(out[1], "A"), -90);
  assert.ok(!/X/.test(out[1]));
  // Bogen wird auch hier zerlegt und landet richtig
  const arc = ok(["G0 X0 Y0 Z0", "G1 F300", "G2 X20 Y0 I10 J0"], o);
  const last = arc[arc.length - 1];
  assert.equal(num(last, "A"), -20);
  assert.equal(num(last, "Y"), 0);
});

test("Achse entlang Y am X-Anschluss: X-Weg positiv wie die Zeichnung", () => {
  const o: WrapOptions = { axis: "y", driveDia: 30, partDia: 80, mmPerRot: 100, depthFeed: false, along: "y" };
  const out = ok(["G0 X" + (Math.PI * 30) + " Y5"], o);
  assert.equal(num(out[0], "X"), 100);
  assert.equal(num(out[0], "Y"), 5);
});

test("intern → Maschine → intern ist wieder dasselbe", () => {
  const src = ["G2 X1 Y-2 I3 J4 (Y9 X8)", "G0 X-5.5"];
  assert.deepEqual(axesToInternal(axesToMachine(src)), src);
});

// ---- Rohteil-Formen ----
const stock = { shape: "rect", diameter: 0, width: 20, height: 40, sides: 6, flats: 30, d0: 40, d1: 20, coneLen: 100 } as const;
const PR: WrapOptions = { axis: "a", driveDia: 1, partDia: 1, mmPerRot: 1, depthFeed: true, stock: { ...stock } };
const job = (u: number) => ["G21", "G90", "G0 Z5", `G0 X10 Y${u}`, "G0 Z1", "G1 Z-1 F300", `G1 X20 Y${u} F800`, "G0 Z5"];

test("Eckig: A nur in sicherer Höhe über der Ecke, Y = Abstand zur Flächenmitte, Z gleicht die Flächen aus", () => {
  // Fläche 1: 20 breit, Abstand Achse 20; Fläche 2: 40 breit, Abstand Achse 10; Ecke √(10²+20²) ≈ 22,36
  const out = ok([...job(10), ...job(40), "G0 X0 Y0"], PR);
  const safe = Math.hypot(10, 20) - 20 + 5;
  out.forEach((l, i) => { if (/^G0 A/.test(l)) assert.ok(Math.abs(num(out[i - 1], "Z")! - safe) < 0.01, out.join("\n")); });
  assert.deepEqual(out.filter(l => /^G0 A/.test(l)).map(l => num(l, "A")), [0, 90, 0]);
  // Fläche 1 Mitte bei 10 → Y0; Tiefe −1 bleibt
  assert.ok(out.includes("G1 X20 Y0 F800"));
  assert.ok(out.includes("G1 Z-1 F300"));
  // Fläche 2 Mitte bei 40 → Y0; 10 mm näher an der Achse → Z −11
  const i2 = out.findIndex(l => /^G0 A90/.test(l));
  assert.ok(out.slice(i2).includes("G1 Z-11 F300"), out.join("\n"));
  // Bögen und Vorschub bleiben
  const arc = ok(["G0 Z5", "G0 X10 Y5", "G1 Z-1 F100", "G2 X20 Y5 I5 J0"], PR);
  assert.equal(arc[arc.length - 1], "G2 X20 Y-5 I5 J0");
});

test("Eckig: Kein Fahren durchs Material beim Drehen, auch nicht beim Rücksprung", () => {
  const out = ok([...job(50), ...job(70), ...job(10)], PR);
  let z = 0;
  for (const l of out) {
    const zz = num(l, "Z"); if (zz !== undefined) z = zz;
    if (/^G0 A/.test(l)) assert.ok(z >= Math.hypot(10, 20) - 20 + 5 - 1e-6, l);
  }
});

test("Eckig: Schnitt über die Kante wird abgelehnt, kleiner Überstand nicht", () => {
  const r = wrapGcode(["G0 Z5", "G0 X0 Y5", "G1 Z-1 F100", "G1 Y45"], PR);
  assert.deepEqual(r, { ok: false, error: "crossing", line: 3 });
  assert.ok(wrapGcode(["G0 Z5", "G0 X0 Y5", "G1 Z-1 F100", "G1 Y23"], PR).ok);
  assert.ok(wrapGcode(["G0 Z5", "G0 X0 Y-3", "G1 Z-1 F100", "G1 Y23"], PR).ok);
});

test("Eckig: Achse entlang Y – X ist quer, Y bleibt, Vieleck mit Schlüsselweite", () => {
  const hex = { ...stock, shape: "poly" as const };
  // Sechskant SW 30: Fläche ≈ 17,32 breit
  const w = 30 * Math.tan(Math.PI / 6);
  const out = ok(["G0 Z5", `G0 X${w * 1.5} Y50`, "G1 Z-1 F100"], { ...PR, stock: hex, along: "y" });
  assert.deepEqual(out.filter(l => /^G0 A/.test(l)).map(l => num(l, "A")), [0, -60]);
  assert.ok(out.includes("G0 X0 Y50"), out.join("\n"));
  // gleiche Flächen: kein Z-Ausgleich
  assert.ok(out.includes("G1 Z-1 F100"));
});

test("Drehrichtung umkehren beim Vieleck", () => {
  const out = ok(job(40), { ...PR, reverse: true });
  assert.deepEqual(out.filter(l => /^G0 A/.test(l)).map(l => num(l, "A")), [0, -90]);
});

test("Kegel: Winkel am örtlichen Durchmesser, Z folgt der Schräge, Mitte des Bands bei A 0", () => {
  const cone = { ...stock, shape: "cone" as const };
  const o: WrapOptions = { axis: "a", driveDia: 1, partDia: 1, mmPerRot: 1, depthFeed: false, stock: cone };
  const yc = Math.PI * 40 / 2;
  // X 0: Radius 20, X 100: Radius 10; 10 mm neben der Mitte
  const atStart = ok([`G0 X0 Y${yc + 10} Z0`], o)[0];
  const atEnd = ok([`G0 X100 Y${yc + 10} Z0`], o)[0];
  assert.ok(Math.abs(num(atStart, "A")! - (10 / 20) * 180 / Math.PI) < 0.01, atStart);
  assert.ok(Math.abs(num(atEnd, "A")! - (10 / 10) * 180 / Math.PI) < 0.01, atEnd);
  assert.equal(num(atStart, "Z"), 0);
  assert.equal(num(atEnd, "Z"), -10);
  // Tiefe kommt dazu
  assert.equal(num(ok([`G0 X100 Y${yc} Z-2`], o)[0], "Z"), -12);
  // Fahrt entlang der Achse neben der Mitte wird geteilt, A ändert sich unterwegs
  const line = ok([`G0 X0 Y${yc + 10} Z-1`, "G1 X100 F600"], o);
  assert.ok(line.length > 50);
  assert.ok(num(line[line.length - 1], "A")! > num(line[1], "A")!);
});

test("Kegel: Achse entlang Y und Y-Anschluss", () => {
  const cone = { ...stock, shape: "cone" as const };
  const yc = Math.PI * 40 / 2;
  const o: WrapOptions = { axis: "a", driveDia: 1, partDia: 1, mmPerRot: 1, depthFeed: false, stock: cone, along: "y" };
  const l = ok([`G0 X${yc + 10} Y100 Z0`], o)[0];
  assert.equal(num(l, "Y"), 100);
  assert.equal(num(l, "Z"), -10);
  // Zeichnung +X neben der Mitte: wie beim Zylinder entlang Y = negatives A
  assert.ok(num(l, "A")! < 0, l);
  const p = ok([`G0 X0 Y${yc + 10 * 2 * Math.PI * 0 + (Math.PI * 40) / 2} Z0`], { ...o, along: "x", axis: "y", mmPerRot: 100 })[0];
  assert.ok(num(p, "Y")! > 0, p);
});
