/**
 * MASCHINENGRENZEN VOR DEM JOBSTART (GRBL-Familie)
 *
 * Der Job ist in Werkstück-Koordinaten geschrieben. Maschine = Werkstück + WCO (Status-Bericht).
 * Die erlaubte Strecke kommt aus $130/$131/$132.
 *
 * Wo der Bereich liegt, ist NICHT immer gleich:
 *  - normales GRBL: Maschinen-Raum läuft von −Weg bis 0, auch wenn die Achse andersherum referenziert ($23)
 *  - Firmware mit „Nullpunkt an der Referenz“ (HOMING_FORCE_SET_ORIGIN, FluidNC, grblHAL-Option):
 *    bei umgekehrter Achse ($23) von 0 bis +Weg
 * Darum wird das Vorzeichen nie angenommen, sondern aus der aktuellen Position abgeleitet. Lässt sie keinen
 * eindeutigen Schluss zu, gibt es eine Warnung statt eines falschen Ergebnisses.
 * Was immer stimmt: Ein Job, der breiter ist als der Weg, passt nie – egal wo der Nullpunkt liegt.
 *
 * Was nicht zu berechnen ist (G92, G10, anderes G5x, G28/G30, Antasten, G91 aus unbekannter Lage),
 * wird als Hinweis gemeldet; die Fahrten danach zählen nicht, statt falsch zu zählen.
 * Keine Abhängigkeiten (Tests: `npm test`).
 */

export type LimitNote = "offsets" | "wcs" | "homeMove" | "probe" | "tlo" | "relative" | "cycle";

export interface JobExtents {
  /** Werkstück-Koordinaten [X, Y, Z]; used = Achse kommt im Job vor */
  min: number[]; max: number[]; used: boolean[];
  /** Z nach einem Werkzeugwechsel (M0/M1/M6): dort kann Z neu genullt werden → nur Warnung */
  zLater: { min: number; max: number } | null;
  /** G53-Ziele: schon Maschinen-Koordinaten */
  machMin: number[]; machMax: number[]; machUsed: boolean[];
  notes: LimitNote[];
}

export interface ScanStart {
  wpos?: number[];        // aktuelle Werkstück-Position (für relative Fahrten am Anfang)
  wco?: number[];         // Versatz (für relative Fahrten nach G53)
  activeWcs?: string;     // "G54" … ("" = unbekannt)
}

const add = (min: number[], max: number[], used: boolean[], i: number, v: number) => {
  if (!used[i]) { used[i] = true; min[i] = v; max[i] = v; return; }
  if (v < min[i]) min[i] = v;
  if (v > max[i]) max[i] = v;
};

/** Grenzen eines Bogens in seiner Ebene: Mittelpunkt ± Radius zählt nur, wo der Bogen wirklich hinkommt */
export function arcExtents(sa: number, sb: number, ea: number, eb: number, ca: number, cb: number, cw: boolean): number[] {
  const r = Math.hypot(sa - ca, sb - cb);
  let aMin = Math.min(sa, ea), aMax = Math.max(sa, ea), bMin = Math.min(sb, eb), bMax = Math.max(sb, eb);
  const a0 = Math.atan2(sb - cb, sa - ca), a1 = Math.atan2(eb - cb, ea - ca);
  const full = Math.hypot(sa - ea, sb - eb) < 1e-9;
  let sweep = cw ? a0 - a1 : a1 - a0;
  while (sweep < 0) sweep += Math.PI * 2;
  if (full || sweep < 1e-12) sweep = Math.PI * 2;
  for (let q = 0; q < 4; q++) {
    const ang = (q * Math.PI) / 2;
    let d = cw ? a0 - ang : ang - a0;
    while (d < 0) d += Math.PI * 2;
    while (d >= Math.PI * 2) d -= Math.PI * 2;
    if (d > sweep) continue;
    const pa = ca + r * Math.cos(ang), pb = cb + r * Math.sin(ang);
    if (pa < aMin) aMin = pa;
    if (pa > aMax) aMax = pa;
    if (pb < bMin) bMin = pb;
    if (pb > bMax) bMax = pb;
  }
  return [aMin, aMax, bMin, bMax];
}

const WORD = /([A-Z])\s*([-+]?\d*\.?\d+)/g;

/** Alle Ziele im Job, jede Fahrt zählt (auch Eilgang – an den Endschalter fährt auch ein G0) */
export function scanJobExtents(lines: string[], start: ScanStart = {}): JobExtents {
  const min = [0, 0, 0], max = [0, 0, 0], used = [false, false, false];
  const machMin = [0, 0, 0], machMax = [0, 0, 0], machUsed = [false, false, false];
  const notes = new Set<LimitNote>();
  // Position in Werkstück-Koordinaten; NaN = unbekannt (relativ von dort geht nicht)
  const pos = start.wpos ? start.wpos.slice(0, 3) : [NaN, NaN, NaN];
  const blind = [false, false, false]; // Bezug hat sich geändert: nicht mehr zählen
  const wco = start.wco;
  let abs = true, k = 1, motion = 0, plane = 17, later = false;
  let zLater: JobExtents["zLater"] = null;
  const axes = ["X", "Y", "Z"];
  const planeAxes: Record<number, number[]> = { 17: [0, 1, 2], 18: [2, 0, 1], 19: [1, 2, 0] };
  const offLetters: Record<number, string[]> = { 17: ["I", "J"], 18: ["K", "I"], 19: ["J", "K"] };
  let wcs = start.activeWcs || "";
  const count = (i: number, v: number) => {
    if (blind[i]) return;
    if (i === 2 && later) {
      if (!zLater) zLater = { min: v, max: v };
      else { if (v < zLater.min) zLater.min = v; if (v > zLater.max) zLater.max = v; }
      return;
    }
    add(min, max, used, i, v);
  };

  for (const raw of lines) {
    if (!raw) continue;
    let line = raw;
    if (line.indexOf("(") >= 0) line = line.replace(/\([^)]*\)/g, "");
    const semi = line.indexOf(";");
    if (semi >= 0) line = line.slice(0, semi);
    line = line.trim().toUpperCase();
    if (!line || line[0] === "$" || line[0] === "%") continue;

    const w: Record<string, number> = {};
    let g53 = false, skip = false, cycle = false, homeMove = false, probe = false, words = false;
    WORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD.exec(line)) !== null) {
      const letter = m[1], v = parseFloat(m[2]);
      if (letter === "G") {
        const g = Math.round(v * 10);
        if (g === 0 || g === 10 || g === 20 || g === 30) motion = g / 10;
        else if (g === 800) motion = -1;
        else if (g === 900) abs = true;
        else if (g === 910) abs = false;
        else if (g === 200) k = 25.4;
        else if (g === 210) k = 1;
        else if (g === 170 || g === 180 || g === 190) plane = g / 10;
        else if (g === 530) g53 = true;
        else if (g === 40 || g === 281 || g === 301) skip = true;   // warten, Position merken: keine Fahrt
        else if (g === 100 || g === 920 || g === 921 || g === 922 || g === 923) {
          // Nullpunkt wird im Job verschoben
          notes.add("offsets"); blind[0] = blind[1] = blind[2] = true; skip = true;
        } else if (g === 431 || g === 490 || g === 430) {
          notes.add("tlo"); blind[2] = true; skip = true;
        } else if (g === 280 || g === 300) homeMove = true;
        else if (g >= 380 && g < 390) probe = true;
        else if (g >= 540 && g <= 590 && g % 10 === 0) {
          const sys = "G" + g / 10;
          if (sys !== wcs) {
            // Versatz eines anderen Systems ist hier unbekannt
            notes.add("wcs"); blind[0] = blind[1] = blind[2] = true;
            wcs = sys;
          }
        } else if (g === 730 || g === 740 || (g >= 810 && g <= 890)) cycle = true;
      } else if (letter === "M") {
        if (v === 0 || v === 1 || v === 6) later = true;
      } else if (letter !== "N") {
        w[letter] = v;
        if (letter === "X" || letter === "Y" || letter === "Z") words = true;
      }
    }
    if (skip) continue;
    if (cycle) { notes.add("cycle"); blind[0] = blind[1] = blind[2] = true; continue; }
    if (homeMove) {
      // G28/G30: fährt an eine gespeicherte Position, danach ist die Lage hier unbekannt
      notes.add("homeMove");
      pos[0] = pos[1] = pos[2] = NaN;
      continue;
    }
    if (!words) continue;
    if (probe) {
      // Antasten: wo es stoppt, weiß man erst am Ende
      notes.add("probe");
      axes.forEach((a, i) => { if (a in w) pos[i] = NaN; });
      continue;
    }
    if (g53) {
      axes.forEach((a, i) => {
        if (!(a in w)) return;
        const v = w[a] * k;
        add(machMin, machMax, machUsed, i, v);
        pos[i] = wco && !blind[i] ? v - wco[i] : NaN;
      });
      continue;
    }
    if (motion < 0) continue;

    const from = pos.slice();
    let unknown = false;
    const to = axes.map((a, i) => {
      if (!(a in w)) return pos[i];
      const v = w[a] * k;
      if (abs) return v;
      if (isNaN(pos[i])) { notes.add("relative"); unknown = true; return NaN; }
      return pos[i] + v;
    });
    axes.forEach((a, i) => { if (a in w && !isNaN(to[i])) count(i, to[i]); });
    pos[0] = to[0]; pos[1] = to[1]; pos[2] = to[2];
    if (unknown || motion < 2) continue;

    // Bogen: in seiner Ebene kann er über Start und Ziel hinausragen
    const [ia, ib] = planeAxes[plane];
    if (isNaN(from[ia]) || isNaN(from[ib]) || isNaN(to[ia]) || isNaN(to[ib])) { notes.add("relative"); continue; }
    const cw = motion === 2;
    const [la, lb] = offLetters[plane];
    let ca: number, cb: number;
    if ("R" in w && !(la in w) && !(lb in w)) {
      const r = w.R * k, dx = to[ia] - from[ia], dy = to[ib] - from[ib], d = Math.hypot(dx, dy);
      if (d < 1e-9) continue;
      const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
      const sgn = cw === r > 0 ? -1 : 1;
      ca = from[ia] + dx / 2 + (sgn * h * -dy) / d;
      cb = from[ib] + dy / 2 + (sgn * h * dx) / d;
    } else {
      ca = from[ia] + (w[la] || 0) * k;
      cb = from[ib] + (w[lb] || 0) * k;
    }
    // G18 dreht die Richtung (Blick von −Y), GRBL rechnet in (Z, X) → dann stimmt cw wie geschrieben
    const [a0, a1, b0, b1] = arcExtents(from[ia], from[ib], to[ia], to[ib], ca, cb, cw);
    count(ia, a0); count(ia, a1); count(ib, b0); count(ib, b1);
  }
  return { min, max, used, zLater, machMin, machMax, machUsed, notes: [...notes] };
}

export interface LimitEnv {
  /** $130/$131/$132 in mm; NaN oder ≤ 0 = unbekannt */
  travel: number[];
  /** $23 (Bit 0 = X, 1 = Y, 2 = Z) */
  homeDirMask: number;
  /** $27 in mm (Rückzug nach dem Referenzieren) */
  pulloff: number;
  /** Maschine referenziert? Sonst ist die Maschinen-Position nur ein Zählerstand */
  homed: boolean;
  mpos: number[];
  wpos: number[];
  /** Achsen, die nicht geprüft werden (z. B. Drehachse auf dem Y-Motor) */
  skip?: number[];
}

export interface LimitOver {
  axis: "X" | "Y" | "Z";
  /** "+"/"−" = so weit darüber in dieser Richtung, "span" = Job breiter als der Weg */
  kind: "+" | "-" | "span";
  by: number;
}

export interface LimitResult {
  over: LimitOver[];           // sicher zu weit → Start sperren
  zLaterOver: LimitOver[];     // Z nach dem Werkzeugwechsel: nur Warnung
  unknownAxes: ("X" | "Y" | "Z")[]; // Lage nicht prüfbar (ohne die Breite)
  noSettings: ("X" | "Y" | "Z")[];  // $13x fehlt
  notHomed: boolean;
}

/**
 * Erlaubter Maschinen-Bereich einer Achse aus Weg und aktueller Position, oder null, wenn nicht eindeutig.
 * Normal: [−Weg, 0]. Nur mit umgekehrter Achse und positiver Position: [0, +Weg] (Nullpunkt an der Referenz).
 */
export function axisRange(travel: number, mpos: number, inverted: boolean, pulloff = 1): [number, number] | null {
  if (!(travel > 0) || !isFinite(mpos)) return null;
  const tol = Math.max(1, pulloff || 0) + 0.5;
  if (mpos < -travel - tol || mpos > travel + tol) return null;
  if (mpos < -tol) return [-travel, 0];
  if (mpos > tol) return inverted ? [0, travel] : null;
  return inverted ? null : [-travel, 0]; // nahe 0 mit umgekehrter Achse: beide Lagen möglich
}

const EPS = 0.005;
const AXES = ["X", "Y", "Z"] as const;

export function checkLimits(ext: JobExtents, env: LimitEnv): LimitResult {
  const res: LimitResult = { over: [], zLaterOver: [], unknownAxes: [], noSettings: [], notHomed: !env.homed };
  for (let i = 0; i < 3; i++) {
    if (env.skip?.includes(i)) continue;
    const axis = AXES[i];
    const later = i === 2 ? ext.zLater : null;
    if (!ext.used[i] && !ext.machUsed[i] && !later) continue;
    const travel = env.travel[i];
    if (!(travel > 0)) { res.noSettings.push(axis); continue; }
    // Breite des Jobs: gilt ohne Referenz und ohne Vorzeichen
    if (ext.used[i] && ext.max[i] - ext.min[i] > travel + EPS) {
      res.over.push({ axis, kind: "span", by: ext.max[i] - ext.min[i] - travel });
    }
    if (!env.homed) continue;
    const range = axisRange(travel, env.mpos[i], !!((env.homeDirMask >> i) & 1), env.pulloff);
    if (!range) { res.unknownAxes.push(axis); continue; }
    const wco = env.mpos[i] - env.wpos[i];
    const [lo, hi] = range;
    let high = -Infinity, low = Infinity;
    if (ext.used[i]) { high = ext.max[i] + wco; low = ext.min[i] + wco; }
    if (ext.machUsed[i]) { high = Math.max(high, ext.machMax[i]); low = Math.min(low, ext.machMin[i]); }
    if (high > hi + EPS) res.over.push({ axis, kind: "+", by: high - hi });
    if (low < lo - EPS) res.over.push({ axis, kind: "-", by: lo - low });
    if (later) {
      if (later.max + wco > hi + EPS) res.zLaterOver.push({ axis, kind: "+", by: later.max + wco - hi });
      if (later.min + wco < lo - EPS) res.zLaterOver.push({ axis, kind: "-", by: lo - later.min - wco });
    }
  }
  return res;
}
