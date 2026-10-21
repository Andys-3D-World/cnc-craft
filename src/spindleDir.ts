/**
 * SPINDEL-DREHRICHTUNG UMKEHREN
 *
 * Dreht die Spindel bei M3 (rechts) in Wirklichkeit links herum, ist meist die Verkabelung schuld
 * (Gleichstrom-Motor: Plus/Minus vertauscht; Frequenzumrichter: FWD/REV vertauscht oder Parameter).
 * Besser ist es, das an der Maschine zu tauschen. Geht das nicht, vertauscht diese Einstellung M3 und M4
 * überall, wo CNC Craft die Spindel einschaltet (Handsteuerung und erzeugter Fräs-G-Code).
 * Nur Fräse – im GRBL-Lasermodus ist M4 der dynamische Laser.
 */
const KEY = "cnc_craft_spindle_invert";

export function spindleInverted(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function setSpindleInverted(v: boolean) {
  try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* Speicher gesperrt – egal */ }
}

/** M-Befehl für die gewünschte Richtung (M3 = rechts, M4 = links), bei falscher Verkabelung vertauscht */
export function spindleCode(want: "M3" | "M4"): "M3" | "M4" {
  return spindleInverted() ? (want === "M3" ? "M4" : "M3") : want;
}
