/**
 * AUFTRAG HIER STARTEN (Rechnung, Tests in tests/jobOrigin.test.ts)
 *
 * Der G-Code bleibt, wie er ist. Stattdessen sagen wir der Maschine: „Die Stelle, an der der Kopf gerade steht, hat im
 * Auftrag die Koordinate X/Y des gewählten Bezugspunkts.“ So stimmen Rahmen, Simulation, gespeicherte Dateien und der
 * Grenzen-Check weiter, und alle wirken gleich wie beim normalen Nullpunkt (dieselbe Art G10 L20, aktives System).
 */
export type JobAnchor = "tl" | "tc" | "tr" | "ml" | "mc" | "mr" | "bl" | "bc" | "br";
export const JOB_ANCHORS: JobAnchor[] = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];

export interface JobBox { x0: number; y0: number; x1: number; y1: number }

/** Bezugspunkt auf dem Rahmen des Auftrags in mm */
export function anchorPoint(b: JobBox, a: JobAnchor): { x: number; y: number } {
  const x = a[1] === "l" ? b.x0 : a[1] === "r" ? b.x1 : (b.x0 + b.x1) / 2;
  const y = a[0] === "b" ? b.y0 : a[0] === "t" ? b.y1 : (b.y0 + b.y1) / 2;
  return { x, y };
}

/** Befehl: die aktuelle Kopfposition bekommt die Koordinate des Bezugspunkts */
export function jobHereCommand(b: JobBox, a: JobAnchor): string {
  const p = anchorPoint(b, a);
  return `G10 L20 P0 X${p.x.toFixed(3)} Y${p.y.toFixed(3)}`;
}

/** Wo der Auftrag danach liegt, gemessen ab der Kopfposition (für die Anzeige) */
export function extentFromHead(b: JobBox, a: JobAnchor): { left: number; right: number; down: number; up: number } {
  const p = anchorPoint(b, a);
  return { left: p.x - b.x0, right: b.x1 - p.x, down: p.y - b.y0, up: b.y1 - p.y };
}
