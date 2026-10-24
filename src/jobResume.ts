/**
 * JOB FORTSETZEN nach einem Abbruch (ab einer gewählten Zeile oder Form)
 *
 * Der G-Code vor der Startzeile wird nur gelesen (nicht gefahren), um den Zustand dort zu kennen:
 * Einheiten, G90/G91, Ebene, Koordinatensystem, Vorschub, Spindel/Laser (M3/M4/M5, S), Kühlung, Position.
 * Daraus entsteht ein Vorspann, der diesen Zustand sicher herstellt:
 *   Fräse:  Z auf sichere Höhe → Spindel an + Hochlaufzeit → Kühlung → XY anfahren → langsam auf Tiefe → Vorschub
 *   Laser:  Laser bleibt aus (S0) → XY anfahren → die erste Zeile bekommt die richtige Leistung (S)
 *   Plasma: nur an Stellen mit Brenner aus (mitten im Schnitt fehlt das Einstechen)
 * Was nicht sicher geht (G91 relativ, G92/G10 im Job), wird abgelehnt.
 * Die Zeilennummern sind die des geladenen Jobs (ohne Kommentarzeilen) – wie in der Simulation.
 */
import { t } from "./i18n/i18n";
import type { MachineMode } from "./machineMode";

export interface ResumeMark { line: number; label: string }

export interface ResumePlan {
  pre: string[];          // Vorspann
  rest: string[];         // Job ab der Startzeile (erste Zeile evtl. ergänzt)
  pos: { x: number | null; y: number | null; z: number | null };
  spindle: string;        // M3 / M4 / M5
  s: number | null; f: number | null;
  toolNote: string;       // letzter Werkzeugwechsel vor der Startzeile ("" = keiner)
}

const PLUNGE = 300;   // höchstens so schnell auf Tiefe (mm/min)
const SPIN_UP = 3;    // Sekunden Hochlaufzeit der Spindel

const strip = (l: string) => l.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase();
const wordsOf = (code: string) => [...code.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)].map(w => [w[1], parseFloat(w[2])] as [string, number]);
const n3 = (v: number) => String(+v.toFixed(3));

/**
 * Vorspann + restlicher Job ab Zeile "from" (0-basiert). Wirft Error mit übersetztem Text, wenn es nicht sicher geht.
 */
export function buildResume(lines: string[], from: number, mode: MachineMode): ResumePlan {
  if (from < 0 || from >= lines.length) throw new Error(t("res.errRange", { n: lines.length }));
  let abs = true, inch = false, plane = 17, wcs = 54, feedMode = 94, motion = 0;
  let f: number | null = null, s: number | null = null, spindle = "M5", toolNote = "";
  const cool = new Set<number>();
  let x: number | null = null, y: number | null = null, z: number | null = null, a: number | null = null;

  for (let i = 0; i < from; i++) {
    const raw = lines[i];
    const code = strip(raw);
    const w = wordsOf(code);
    const gs = w.filter(q => q[0] === "G").map(q => q[1]);
    const ms = w.filter(q => q[0] === "M").map(q => q[1]);
    if (gs.some(g => g === 92 || g === 10)) throw new Error(t("res.errOffset", { n: i + 1 }));
    for (const g of gs) {
      if (g >= 0 && g <= 3 && Number.isInteger(g)) motion = g;
      else if (g === 17 || g === 18 || g === 19) plane = g;
      else if (g === 20) inch = true;
      else if (g === 21) inch = false;
      else if (g === 90) abs = true;
      else if (g === 91) abs = false;
      else if (g >= 54 && g <= 59 && Number.isInteger(g)) wcs = g;
      else if (g === 93 || g === 94) feedMode = g;
      else if (g === 80) motion = -1;
    }
    for (const m of ms) {
      if (m === 3 || m === 4) spindle = "M" + m;
      else if (m === 5) spindle = "M5";
      else if (m === 7 || m === 8) cool.add(m);
      else if (m === 9) cool.clear();
      else if (m === 0 || m === 1 || m === 6) toolNote = (raw.match(/\(([^)]*)\)/) || [])[1] || raw.trim();
    }
    const get = (l: string) => w.find(q => q[0] === l)?.[1];
    if (get("F") !== undefined) f = get("F")!;
    if (get("S") !== undefined) s = get("S")!;
    // Maschinenkoordinaten / Referenzfahrt: Lage danach unbekannt
    if (gs.some(g => g === 53 || g === 28 || g === 30)) { x = y = z = a = null; continue; }
    const X = get("X"), Y = get("Y"), Z = get("Z"), A = get("A");
    if (abs) {
      if (X !== undefined) x = X; if (Y !== undefined) y = Y; if (Z !== undefined) z = Z; if (A !== undefined) a = A;
    } else {
      if (X !== undefined && x !== null) x += X; if (Y !== undefined && y !== null) y += Y;
      if (Z !== undefined && z !== null) z += Z; if (A !== undefined && a !== null) a += A;
    }
  }
  if (!abs) throw new Error(t("res.errRelative"));
  if (mode === "plasma" && spindle !== "M5") throw new Error(t("res.errPlasma"));

  // sichere Höhe: höchstes Z im ganzen Job (meist die Sicherheitshöhe der Leerfahrten), mindestens 1 mm
  let safe = 1;
  for (const l of lines) { const m = strip(l).match(/Z\s*([-+]?(?:\d+\.?\d*|\.\d+))/); if (m) safe = Math.max(safe, parseFloat(m[1])); }

  const pre: string[] = [];
  pre.push(`${inch ? "G20" : "G21"} G90 G${plane} G${wcs} G${feedMode}`);
  const xy = x !== null && y !== null ? `X${n3(x)} Y${n3(y)}${a !== null ? ` A${n3(a)}` : ""}` : "";
  if (mode === "laser") {
    // Laser: Modus an, aber Leistung 0 – erst die nächste Schnittzeile bekommt wieder S
    pre.push(spindle === "M5" ? "M5 S0" : `${spindle} S0`);
    if (cool.size) pre.push([...cool].sort().map(m => "M" + m).join(" "));
    if (xy) pre.push(`G0 ${xy}`);
  } else {
    if (z !== null || mode === "mill") pre.push(`G0 Z${n3(safe)}`);
    if (spindle !== "M5") {
      pre.push(`${spindle}${s !== null ? " S" + n3(s) : ""}`);
      pre.push(`G4 P${SPIN_UP}`);
    }
    if (cool.size) pre.push([...cool].sort().map(m => "M" + m).join(" "));
    if (xy) pre.push(`G0 ${xy}`);
    if (z !== null && z < safe) {
      // Fräse: langsam auf die Tiefe (die Stelle wurde vor dem Abbruch schon gefräst); Plasma: Brenner ist aus
      pre.push(mode === "mill" ? `G1 Z${n3(z)} F${n3(Math.min(f ?? PLUNGE, PLUNGE))}` : `G0 Z${n3(z)}`);
    }
  }
  if (f !== null) pre.push(`G1 F${n3(f)}`);

  // erste Zeile: fehlt die Bewegungsart (modal), ergänzen; Laser: Leistung ergänzen
  const rest = lines.slice(from);
  const first = strip(rest[0]);
  const fw = wordsOf(first);
  const hasAxis = fw.some(q => "XYZA".includes(q[0]));
  const hasMotion = fw.some(q => q[0] === "G" && q[1] >= 0 && q[1] <= 3);
  let line0 = rest[0];
  if (hasAxis && !hasMotion && motion >= 0) line0 = `G${motion} ${line0}`;
  if (mode === "laser" && spindle !== "M5" && s !== null && hasAxis && !fw.some(q => q[0] === "S") && motion !== 0) line0 += ` S${n3(s)}`;
  rest[0] = line0;
  return { pre, rest, pos: { x, y, z }, spindle, s, f, toolNote };
}

/** Kommentarzeilen „(--- Form 3 …)“ / „(--- Ebene 2 …)“ als Sprungziele (Zeilennummern nach dem Filtern) */
export function resumeMarks(content: string): ResumeMark[] {
  const marks: ResumeMark[] = [];
  let n = 0;
  for (const raw of content.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith("%") || l.startsWith(";")) continue;
    if (l.startsWith("(")) {
      const m = l.match(/^\(-{2,}\s*(.*?)\s*-*\)$/);
      if (m && m[1]) marks.push({ line: n, label: m[1].slice(0, 80) });
      continue;
    }
    n++;
  }
  return marks;
}
