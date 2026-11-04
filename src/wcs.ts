/**
 * KOORDINATENSYSTEME G54–G59 (reine Logik, ohne Oberfläche)
 *
 * GRBL meldet das aktive System nicht im Statusbericht (dort steht nur der Versatz WCO), sondern nur auf $G:
 *   [GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]
 * Wichtig: M2/M30 am Jobende und jeder Reset stellen GRBL still auf G54 zurück.
 * Nullpunkt setzen immer mit P0 (aktives System) – P1 wäre fest G54.
 */
export const WCS_LIST = ["G54", "G55", "G56", "G57", "G58", "G59"] as const;
export type Wcs = typeof WCS_LIST[number];

/** Aktives System aus einer $G-Antwort; "" = keine $G-Antwort oder kein System darin */
export function parseActiveWcs(line: string): Wcs | "" {
  const m = line.trim().match(/^\[GC:(.*)\]$/);
  if (!m) return "";
  const w = m[1].toUpperCase().split(/\s+/).find(g => (WCS_LIST as readonly string[]).includes(g));
  return (w as Wcs) || "";
}

/** Nullpunkt im AKTIVEN System setzen, z. B. zeroCommand("XY") → "G10 L20 P0 X0 Y0" */
export function zeroCommand(axes: string): string {
  return "G10 L20 P0 " + axes.toUpperCase().split("").map(a => a + "0").join(" ");
}

/** Letztes in einer von Hand geschickten Zeile gewähltes System ("" = keins). G54.1 u. Ä. zählen nicht. */
export function wcsInLine(line: string): Wcs | "" {
  const code = line.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase();
  const all = [...code.matchAll(/G\s*0*(5[4-9])(?![.\d])/g)];
  return all.length ? (("G" + all[all.length - 1][1]) as Wcs) : "";
}

/** Setzt diese Zeile das System zurück? (Programmende M2/M30) */
export function lineResetsWcs(line: string): boolean {
  const code = line.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase();
  return /M\s*0*(2|30)(?![.\d])/.test(code);
}

/**
 * Welches System gehört in den Vorspann von „Job fortsetzen“?
 * Hat der Job selbst eins gewählt, gilt das; sonst das gerade aktive. Ist beides unbekannt: "" = gar keins schreiben
 * (früher stand hier fest G54 – bei aktivem G55 wäre der Rest des Jobs an der falschen Stelle gefahren).
 */
export function resumeWcs(inJob: number | null, active: string): string {
  if (inJob !== null) return "G" + inJob;
  return active;
}
