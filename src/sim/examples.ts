/**
 * BEISPIELPROGRAMME UND BAUSTEINE (ohne Oberfläche)
 * Beispiele sind nur zum Ansehen in der Simulation: sie werden nie von selbst zum Job. Material 60 × 40 mm, Z0 oben.
 */
export interface Example { id: string; lines: string[] }

const head = (dia: number) => [`(D=${dia} mm)`, "G21 G90 G17", "M3 S12000", "G4 P2", "G0 Z5"];
const tail = ["G0 Z5", "M5", "M30"];
const f = (v: number) => String(+v.toFixed(3));

function contour(): string[] {
  const out = [...head(3), "G0 X8.5 Y8.5"];
  for (const z of [-1, -2, -3]) out.push(`G1 Z${z} F150`, "G1 X51.5 F600", "G1 Y31.5", "G1 X8.5", "G1 Y8.5");
  return [...out, ...tail];
}
function arcs(): string[] {
  return [...head(3), "G0 X20 Y10", "G1 Z-1 F150", "G1 X40 F600", "G3 X50 Y20 I0 J10", "G1 Y20.5", "G3 X40 Y30.5 I-10 J0", "G1 X20", "G3 X10 Y20.5 R10", "G1 Y20", "G3 X20 Y10 R10", ...tail];
}
function drilling(): string[] {
  return [...head(3).map(l => l.startsWith("(") ? "(Drill D=3 mm)" : l), "G98 G81 X10 Y10 Z-4 R1 F100", "X30", "X50", "G83 X10 Y30 Z-8 R1 Q2 F100", "X30", "X50", "G80", ...tail];
}
function boltCircle(): string[] {
  const out = [...head(3)];
  for (let k = 0; k < 6; k++) {
    const a = k * Math.PI / 3, x = 30 + 14 * Math.cos(a), y = 20 + 14 * Math.sin(a);
    out.push(`G0 X${f(x + 1)} Y${f(y)}`, "G1 Z0 F150", `G3 X${f(x + 1)} Y${f(y)} I-1 J0 Z-1.5 F300`, `G3 X${f(x + 1)} Y${f(y)} I-1 J0 Z-3`, `G3 X${f(x + 1)} Y${f(y)} I-1 J0`, `G1 X${f(x)} Y${f(y)}`, "G0 Z5");
  }
  return [...out, "M5", "M30"];
}
function pocket(): string[] {
  const out = [...head(6)];
  let z = 0;
  out.push("G0 X30 Y20", "G1 Z0.5 F150");
  for (const next of [-1.5, -3]) {
    out.push(`G1 Z${next} F100`);
    for (const r of [2, 4, 6, 8, 10]) out.push(`G1 X${30 + r} F500`, `G2 X${30 + r} Y20 I${-r} J0`);
    out.push("G1 X30"); z = next;
  }
  void z;
  return [...out, ...tail];
}
function dome(): string[] {
  const out = [...head(6).map(l => l.startsWith("(") ? "(Ball D=6 mm)" : l), "G0 X10 Y10", "G1 Z0 F200"];
  for (let k = 0; k <= 10; k++) {
    const y = 10 + k * 2, fwd = k % 2 === 0;
    // flache Mulde: Bogen mit R 45 durch die X/Z-Ebene, tiefster Punkt in der Mitte
    out.push(`G18 ${fwd ? "G2 X50" : "G3 X10"} Z0 R45 F500`);
    if (k < 10) out.push(`G17 G1 Y${y + 2}`);
  }
  return [...out, "G17", ...tail];
}

export const EXAMPLES: Example[] = [
  { id: "contour", lines: contour() }, { id: "arcs", lines: arcs() }, { id: "drilling", lines: drilling() },
  { id: "boltCircle", lines: boltCircle() }, { id: "pocket", lines: pocket() }, { id: "dome", lines: dome() }
];

/** Bausteine zum Einfügen im Editor. Zahlen sind Platzhalter: nach dem Einfügen prüfen */
export const SNIPPETS: Example[] = [
  { id: "head", lines: ["G21 G90 G17", "G0 Z5", "M3 S12000", "G4 P3"] },
  { id: "lift", lines: ["G0 Z5"] },
  { id: "tool", lines: ["G0 Z20", "M5", "M6 T2", "M3 S12000", "G4 P3"] },
  { id: "drill", lines: ["G98 G81 X0 Y0 Z-5 R2 F100", "X20", "G80"] },
  { id: "circle", lines: ["G1 X10 Y0 F500", "G2 X10 Y0 I-10 J0"] },
  { id: "end", lines: ["G0 Z5", "M5", "G0 X0 Y0", "M30"] }
];
