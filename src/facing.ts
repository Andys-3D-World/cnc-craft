/**
 * PLANFRÄSEN (Rohteil beidseitig planen gegen Verzug) – nur die Fräsbahn
 *
 * Holz, Kunststoff und Alu-Platten haben innere Spannungen. Nimmt ein großer 3D-Job viel Material
 * von nur einer Seite weg, wirft sich das Teil. Abhilfe: vorher beide Seiten gleich viel planen.
 * Ablauf (Assistent ui/facingDialog.ts): Seite 1 planen → Platte wenden, Z neu nullen → derselbe Job
 * noch einmal für Seite 2. Weil beide Seiten gleich tief geplant werden, ist es zweimal derselbe G-Code.
 *
 * Bahn: Zickzack-Zeilen über die ganze Fläche, in mehreren Tiefen. Jede Tiefe beginnt NEBEN dem Rohteil
 * (Fräsermitte einen Radius + 1 mm außerhalb) – dort taucht der Fräser ins Leere ein, ohne Rampe.
 * Die Zeilen laufen über den Rand hinaus, damit auch die Kanten ganz geplant sind.
 * Mit `bounds` (Opferplatte: das Bett) bleibt die Fräsermitte innerhalb dieser Grenzen – sonst führe sie über
 * die Endschalter hinaus. Der Radius ragt dann trotzdem bis an den Rand (bei Ø 30 mm also 15 mm weiter).
 * Keine Abhängigkeiten (läuft auch in den Tests mit `npm test`).
 */

export interface FacingParams {
  x0: number; y0: number;   // linke untere Ecke der Fläche (mm)
  w: number; h: number;     // Größe der Fläche (mm)
  depth: number;            // so viel wird je Seite abgenommen (mm, > 0)
  stepZ: number;            // Zustellung je Tiefe (mm)
  toolD: number;            // Fräser-Ø (mm)
  stepOver: number;         // seitliche Zustellung als Anteil vom Ø (0.1 … 0.9)
  feed: number; plunge: number;
  safeZ: number;
  dir: "x" | "y";           // Zeilen entlang X oder Y
  bounds?: { x0: number; y0: number; x1: number; y1: number }; // Fräsermitte bleibt hier drin (Bett)
}

export interface FacingResult { lines: string[]; passes: number; rows: number; length: number }

const f3 = (v: number) => String(+v.toFixed(3));

/** Fräsbahn (nur Bewegungen, ohne Kopf/Spindel). Leer bei unsinnigen Werten. */
export function facingPath(p: FacingParams): FacingResult {
  const empty = { lines: [], passes: 0, rows: 0, length: 0 };
  if (!(p.w > 0 && p.h > 0 && p.depth > 0 && p.toolD > 0 && p.stepZ > 0)) return empty;
  const r = p.toolD / 2;
  const step = p.toolD * Math.min(0.9, Math.max(0.1, p.stepOver));
  // entlang "dir" laufen die Zeilen, quer dazu wird zugestellt
  const along = p.dir === "x" ? p.w : p.h, across = p.dir === "x" ? p.h : p.w;
  const B = p.bounds, bx = p.dir === "x";
  const aLo = B ? (bx ? B.x0 : B.y0) : -Infinity, aHi = B ? (bx ? B.x1 : B.y1) : Infinity;
  const cLo = B ? (bx ? B.y0 : B.x0) : -Infinity, cHi = B ? (bx ? B.y1 : B.x1) : Infinity;
  const a0 = Math.max(aLo, (bx ? p.x0 : p.y0) - r - 1), a1 = Math.min(aHi, (bx ? p.x0 : p.y0) + along + r + 1);
  const c0 = Math.max(cLo, bx ? p.y0 : p.x0), c1 = Math.min(cHi, (bx ? p.y0 : p.x0) + across);
  if (!(a1 > a0 && c1 >= c0)) return empty;
  // Zeilen gleichmäßig von Kante zu Kante (Fräsermitte genau auf beiden Kanten)
  const rows = c1 - c0 < 1e-9 ? 1 : Math.max(1, Math.ceil((c1 - c0) / step)) + 1;
  const dc = rows > 1 ? (c1 - c0) / (rows - 1) : 0;
  const passes = Math.max(1, Math.ceil(p.depth / p.stepZ - 1e-9));
  const pt = (a: number, c: number) => (p.dir === "x" ? `X${f3(a)} Y${f3(c)}` : `X${f3(c)} Y${f3(a)}`);
  const L: string[] = [];
  let length = 0;
  for (let k = 1; k <= passes; k++) {
    const z = -Math.min(p.depth, k * p.stepZ);
    L.push(`G0 Z${f3(p.safeZ)}`);
    L.push(`G0 ${pt(a0, c0)}`);
    L.push(`G1 Z${f3(z)} F${Math.round(p.plunge)}`);
    for (let i = 0; i < rows; i++) {
      const c = c0 + i * dc;
      const fwd = i % 2 === 0;
      if (i > 0) { L.push(`G1 ${pt(fwd ? a0 : a1, c)}`); length += dc; }
      L.push(`G1 ${pt(fwd ? a1 : a0, c)}${i === 0 ? ` F${Math.round(p.feed)}` : ""}`);
      length += a1 - a0;
    }
  }
  L.push(`G0 Z${f3(p.safeZ)}`);
  return { lines: L, passes, rows, length };
}
