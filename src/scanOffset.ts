/**
 * VERSATZ BEIM HIN- UND ZURÜCKFAHREN (Laser, Füllen und Bildgravur)
 *
 * Beim Gravieren zündet der Laser immer ein kleines Stück zu spät. Fährt er abwechselnd hin und zurück, liegen die Linien
 * der beiden Richtungen deshalb versetzt: Kanten werden ausgefranst, feine Linien doppelt. Abhilfe: jede Zeile um den halben
 * Versatz entgegen ihrer Fahrtrichtung schieben – so kommen beide Richtungen zusammen und das Bild bleibt an seinem Platz.
 *
 * Die Werte misst die Testkarte auf der eigenen Maschine, je Geschwindigkeit eine Stützstelle. Dazwischen wird gerade
 * gerechnet, außerhalb gilt der Randwert. 0 oder keine Werte = alles wie vorher (es wird dann nichts gerechnet).
 * Ohne Laufzeit-Importe, damit die Tests direkt laufen.
 */
export interface ScanPoint { speed: number; mm: number }

export const SCAN_MAX_MM = 2;

/** Werte aus Datei oder Eingabe prüfen: nach Geschwindigkeit sortiert, jede Geschwindigkeit nur einmal */
export function cleanScanPoints(raw: any): ScanPoint[] {
  if (!Array.isArray(raw)) return [];
  const by = new Map<number, number>();
  for (const p of raw.slice(0, 50)) {
    const speed = Number(p?.speed), mm = Number(p?.mm);
    if (Number.isFinite(speed) && speed > 0 && speed <= 100000 && Number.isFinite(mm)) by.set(speed, Math.max(-SCAN_MAX_MM, Math.min(SCAN_MAX_MM, mm)));
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([speed, mm]) => ({ speed, mm }));
}

/** Versatz in mm bei dieser Geschwindigkeit */
export function scanOffsetAt(points: ScanPoint[] | undefined, speed: number): number {
  if (!points || !points.length) return 0;
  if (speed <= points[0].speed) return points[0].mm;
  for (let i = 1; i < points.length; i++) {
    if (speed <= points[i].speed) {
      const a = points[i - 1], b = points[i];
      return a.mm + ((b.mm - a.mm) * (speed - a.speed)) / (b.speed - a.speed);
    }
  }
  return points[points.length - 1].mm;
}

/** Strecke [x0, y0, x1, y1] um den halben Versatz entgegen der Fahrtrichtung schieben */
export function shiftSeg(seg: number[], mm: number): number[] {
  const dx = seg[2] - seg[0], dy = seg[3] - seg[1], len = Math.hypot(dx, dy);
  if (!mm || !len) return seg;
  const sx = (dx / len) * (mm / 2), sy = (dy / len) * (mm / 2);
  return [seg[0] - sx, seg[1] - sy, seg[2] - sx, seg[3] - sy];
}

/** Eingabefeld „Geschwindigkeit:mm, …“ lesen und schreiben */
export function parseScanText(text: string): ScanPoint[] {
  const out: { speed: number; mm: number }[] = [];
  for (const part of text.split(/[,;\n]+/)) {
    const m = /^\s*([\d.]+)\s*[:=]\s*(-?[\d.]+)\s*$/.exec(part);
    if (m) out.push({ speed: parseFloat(m[1]), mm: parseFloat(m[2]) });
  }
  return cleanScanPoints(out);
}

export function formatScanText(points: ScanPoint[] | undefined): string {
  return (points || []).map(p => `${p.speed}:${+p.mm.toFixed(3)}`).join(", ");
}
