/**
 * WERKZEUG NACHMESSEN WÄHREND LANGER JOBS (Wärmegang) – wo im G-Code gemessen wird
 *
 * Spindel und Z-Achse dehnen sich warm aus; nach Stunden fräst die Maschine ein paar Hundertstel tiefer oder flacher.
 * Statt eine Formel zu raten, wird das Werkzeug regelmäßig neu gemessen (fester Sensor oder Handtaster an einer
 * festen Stelle) und Z um die gemessene Abweichung korrigiert – Ablauf in toolChange.ts (runDrift).
 *
 * cam.ts markiert beim Erzeugen jede sichere Stelle (zwischen zwei Formen, Fräser oben) mit DRIFT_SLOT.
 * Hier wird daraus: am ersten Platz ein Mess-Punkt (Referenz), danach einer, sobald seit dem letzten Mess-Punkt
 * die geschätzte Laufzeit erreicht ist. Alle anderen Plätze fallen weg. Ohne Abhängigkeiten (Tests: `npm test`).
 */

/** Platzhalter-Zeile, die cam.ts an jeder sicheren Stelle einfügt */
export const DRIFT_SLOT = "(#drift-slot#)";

/**
 * @param lines     G-Code-Zeilen mit Platzhaltern
 * @param timeAt    geschätzte Laufzeit in Sekunden bis zu jeder Zeile (gleiche Länge wie lines)
 * @param everyMin  Abstand zwischen zwei Messungen in Minuten
 * @param marker    Zeile für einen Mess-Punkt (z. B. „M0 (Werkzeug nachmessen)“)
 * @returns Zeilen ohne Platzhalter und die Anzahl Mess-Punkte
 */
export function placeDriftPoints(lines: string[], timeAt: number[], everyMin: number, marker: string): { lines: string[]; points: number } {
  const every = Math.max(1, everyMin) * 60;
  const out: string[] = [];
  let last = -Infinity, points = 0;
  lines.forEach((l, i) => {
    if (l !== DRIFT_SLOT) { out.push(l); return; }
    const tNow = timeAt[i] ?? 0;
    if (points === 0 || tNow - last >= every) {
      out.push(marker);
      last = tNow;
      points++;
    }
  });
  return { lines: out, points };
}
