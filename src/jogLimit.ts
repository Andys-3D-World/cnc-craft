/**
 * MANUELLES FAHREN NUR INNERHALB DES BETTS
 *
 * Die Pfeile fahren relativ ($J=G91 …). Ohne Grenze fährt ein 100-mm-Schritt bei einem 205-mm-Bett bis 300 mm –
 * gegen den Endschalter oder den Rahmen. Hier wird jeder Schritt so gekürzt, dass die Werkstück-Position in X/Y
 * im Bett bleibt (0 … Bettgröße, Nullpunkt links unten – wie überall im Programm).
 * Steht die Achse schon außerhalb (Nullpunkt woanders gesetzt), darf sie nur zurück Richtung Bett, nicht weiter weg.
 * Z wird nicht begrenzt. Keine Abhängigkeiten (Tests: `npm test`).
 */

export interface JogClamp { delta: number[]; clamped: number[] } // clamped: Achsen-Index, die gekürzt wurden

/**
 * @param pos    Werkstück-Position [x, y, z] vor dem Schritt
 * @param delta  gewünschter Schritt [dx, dy, dz]
 * @param bed    Bettgröße in mm
 */
export function clampJog(pos: number[], delta: number[], bed: { w: number; h: number }): JogClamp {
  const out = delta.slice(), clamped: number[] = [];
  const max = [bed.w, bed.h];
  for (let i = 0; i < 2; i++) {
    const d = delta[i];
    if (!d || !(max[i] > 0)) continue;
    const p = pos[i], target = p + d;
    let ok = target;
    if (d > 0 && target > max[i]) ok = Math.max(p, max[i]);
    if (d < 0 && target < 0) ok = Math.min(p, 0);
    if (ok !== target) { out[i] = +(ok - p).toFixed(3); clamped.push(i); }
  }
  return { delta: out, clamped };
}
