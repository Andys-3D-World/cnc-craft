/**
 * ANHALTEN IN DER SIMULATION (ohne Oberfläche): Einzelsatz, Haltepunkte und M0/M1.
 * Betrifft nur das Abspielen auf dem Bildschirm – an der Maschine ändert sich nichts.
 */
import { firstMoveOfLine, moveAtTime, timeBeforeLine, MOVE_RAPID, type SimProgram } from "./gcodeParser.ts";

export interface StopRules { single: boolean; breaks: ReadonlySet<number>; halts: readonly number[] }
export interface Stop { time: number; line: number; why: "single" | "break" | "halt" }

/** so nah an einer Stelle gilt sie als erreicht (die Anzeige steht gern ein Haar davor) */
const EPS = 1e-5;

/** Zeilen mit M0/M1 (auch mit Leerzeichen und führender Null) */
export function haltLines(lines: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.indexOf("M") < 0 && l.indexOf("m") < 0) continue;
    if (/M\s*0*[01](?![\d.])/i.test(l.replace(/\([^)]*(?:\)|$)/g, "").replace(/;.*$/, ""))) out.push(i);
  }
  return out;
}

/** Erste Stelle nach `from` (bis `to`), an der angehalten wird. Ein Haltepunkt hält VOR seiner Zeile */
export function nextStop(p: SimProgram, from: number, to: number, r: StopRules): Stop | null {
  let best: Stop | null = null;
  const take = (time: number, line: number, why: Stop["why"]) => {
    if (time > from + EPS && time <= to && (!best || time < best.time)) best = { time, line, why };
  };
  for (const l of r.breaks) if (l >= 0 && l < p.lines.length) take(timeBeforeLine(p, l), l, "break");
  for (const l of r.halts) take(timeBeforeLine(p, l), l, "halt");
  if (r.single && p.n) {
    let i = moveAtTime(p, from + EPS);
    const cur = p.line[i];
    while (i < p.n && p.line[i] === cur) i++;
    take(i < p.n ? p.t0[i] : p.totalTime, i < p.n ? p.line[i] : cur, "single");
  }
  return best;
}

/** Zeit am Ende der nächsten (dir 1) oder vorigen (dir −1) Zeile mit Bewegung */
export function stepLine(p: SimProgram, now: number, dir: 1 | -1): number {
  if (!p.n) return 0;
  let i = moveAtTime(p, now);
  if (dir > 0) {
    if (now > EPS) { const cur = p.line[i]; while (i < p.n && p.line[i] === cur) i++; }
    if (i >= p.n) return p.totalTime;
    const l = p.line[i];
    while (i + 1 < p.n && p.line[i + 1] === l) i++;
    return Math.max(p.t0[i], p.t0[i] + p.dur[i] - 1e-6);
  }
  const first = firstMoveOfLine(p, p.line[i]);
  return first > 0 ? Math.max(0, p.t0[first] - 1e-6) : 0;
}

/** Zeit mit Vorschub-Regler: Eilgänge bleiben, alles andere wird durch den Faktor geteilt */
export function scaledTime(p: SimProgram, factor: number): number {
  let rapid = 0;
  for (let i = 0; i < p.n; i++) if (p.type[i] === MOVE_RAPID) rapid += p.dur[i];
  return rapid + (p.totalTime - rapid) / Math.max(0.01, factor);
}
