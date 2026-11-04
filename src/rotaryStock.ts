/**
 * DREHACHSE – Form des Rohteils (ohne Abhängigkeiten → testbar)
 *
 * rund · rechteckig/quadratisch · regelmäßiges Vieleck (Schlüsselweite = Abstand zweier Flächen) · Kegel.
 * Abwicklung: Das blaue Band zeigt die Flächen nebeneinander (u = Weg rundherum, 0 … Umfang). Fläche 1 liegt bei
 * A = 0 oben, die nächste folgt in Richtung +u. Kegel: Band läuft mit dem Durchmesser schmaler/breiter,
 * seine Mitte ist die Linie, die bei A = 0 oben liegt.
 */
export type StockShape = "round" | "rect" | "poly" | "cone";

export interface RotaryStock {
  shape: StockShape;
  diameter: number;           // rund: Ø
  width: number; height: number;  // rechteckig: Fläche 1 ist width breit, height hoch (Abstand oben–unten)
  sides: number; flats: number;   // Vieleck: Anzahl Seiten, Schlüsselweite
  d0: number; d1: number; coneLen: number; // Kegel: Ø am Anfang (entlang = 0), am Ende, Länge
}

export interface Face {
  k: number;        // 0, 1, …
  width: number;
  apothem: number;  // Abstand Achse – Fläche
  angle: number;    // A (Grad), bei dem diese Fläche oben liegt
  start: number; end: number; center: number; // Lage im Band (u)
}

export const isPrism = (s: RotaryStock) => s.shape === "rect" || s.shape === "poly";

/** Flächen in Reihenfolge rundherum (rund und Kegel: keine) */
export function faces(s: RotaryStock): Face[] {
  const list: [number, number][] = [];
  if (s.shape === "rect") list.push([s.width, s.height / 2], [s.height, s.width / 2], [s.width, s.height / 2], [s.height, s.width / 2]);
  else if (s.shape === "poly") {
    const n = Math.max(3, Math.min(12, Math.round(s.sides)));
    for (let k = 0; k < n; k++) list.push([s.flats * Math.tan(Math.PI / n), s.flats / 2]);
  }
  let at = 0;
  return list.map(([width, apothem], k) => {
    const f = { k, width, apothem, angle: (k * 360) / list.length, start: at, end: at + width, center: at + width / 2 };
    at += width;
    return f;
  });
}

/** Weg einmal rundherum (Kegel: am dicksten Ende – so breit ist das Band höchstens) */
export function perimeter(s: RotaryStock): number {
  if (s.shape === "cone") return Math.PI * Math.max(s.d0, s.d1);
  if (s.shape === "round") return Math.PI * s.diameter;
  return faces(s).reduce((a, f) => a + f.width, 0);
}

/** Radius der Stelle, die beim Drehen am weitesten herausragt */
export function cornerRadius(s: RotaryStock): number {
  if (s.shape === "rect") return Math.hypot(s.width, s.height) / 2;
  if (s.shape === "poly") return (s.flats / 2) / Math.cos(Math.PI / Math.max(3, Math.round(s.sides)));
  return s.shape === "cone" ? Math.max(s.d0, s.d1) / 2 : s.diameter / 2;
}

/** Abstand Achse – Z 0: Fläche 1 bzw. Kegel am Anfang bzw. Oberkante des runden Teils */
export function refRadius(s: RotaryStock): number {
  if (isPrism(s)) return faces(s)[0].apothem;
  return s.shape === "cone" ? s.d0 / 2 : s.diameter / 2;
}

/** Bis hierhin (von der Fläche aus gemessen) ist Material bis zur Achse */
export function minRadius(s: RotaryStock): number {
  if (isPrism(s)) return Math.min(...faces(s).map(f => f.apothem));
  return s.shape === "cone" ? Math.min(s.d0, s.d1) / 2 : s.diameter / 2;
}

/** Kegel: Radius an der Stelle entlang der Achse (außerhalb der Länge bleibt es beim Endmaß) */
export function coneRadius(s: RotaryStock, along: number): number {
  const u = Math.max(0, Math.min(1, along / Math.max(1e-9, s.coneLen)));
  return Math.max(0.01, (s.d0 + (s.d1 - s.d0) * u) / 2);
}

/** Kegel: Mitte des Bands (u), liegt bei A = 0 oben */
export const coneCenter = (s: RotaryStock) => perimeter(s) / 2;

/** Fläche zu einer Stelle im Band; shift = Lage der Flächenmitte (auch außerhalb 0 … Umfang, dann um Umfänge versetzt) */
export function faceAt(fs: Face[], u: number): { face: Face; center: number } {
  const P = fs[fs.length - 1].end, m = Math.floor(u / P), w = u - m * P;
  const face = fs.find(f => w < f.end) || fs[fs.length - 1];
  return { face, center: face.center + m * P };
}

/** Querschnitt bei A = 0 (y, z um die Achse): Ecken beim Vieleck, sonst Kreis mit n Punkten */
export function sectionAt(s: RotaryStock, along: number, n = 72): [number, number][] {
  if (isPrism(s)) {
    if (s.shape === "rect") {
      const w = s.width / 2, h = s.height / 2;
      return [[-w, h], [w, h], [w, -h], [-w, -h]];
    }
    const c = Math.max(3, Math.round(s.sides)), r = cornerRadius(s);
    return Array.from({ length: c }, (_, k) => {
      const t = ((k - 0.5) * 2 * Math.PI) / c;
      return [r * Math.sin(t), r * Math.cos(t)] as [number, number];
    });
  }
  const r = s.shape === "cone" ? coneRadius(s, along) : s.diameter / 2;
  return Array.from({ length: n }, (_, k) => {
    const t = (k * 2 * Math.PI) / n;
    return [r * Math.sin(t), r * Math.cos(t)] as [number, number];
  });
}

/** Abstand Achse – Oberfläche in Richtung phi (von +Z nach +Y) – für die Tiefe in der Simulation */
export function surfaceRadius(s: RotaryStock, along: number, phi: number): number {
  if (isPrism(s)) {
    let best = Infinity;
    for (const f of faces(s)) {
      const c = Math.cos(phi - (f.angle * Math.PI) / 180);
      if (c > 1e-6) best = Math.min(best, f.apothem / c);
    }
    return best;
  }
  return s.shape === "cone" ? coneRadius(s, along) : s.diameter / 2;
}
