/**
 * Was der Stopp-Knopf tun muss, wenn gerade KEIN Job läuft (Fahrt zum Nullpunkt, Referenzfahrt, Makro, Rahmen …).
 * Nur die Entscheidung, ohne Oberfläche, damit sie sich testen lässt.
 *
 *  Run: erst Feed Hold (bremst kontrolliert, die Position bleibt gültig), dann Reset (löscht die restlichen Befehle)
 *  Hold: schon gebremst: Reset
 *  Jog: Joggen abbrechen, das reicht
 *  Home: Referenzfahrt lässt sich nur mit Reset abbrechen
 *  sonst (Idle, Alarm, unbekannt): nichts schicken
 */
export type StopPlan = "hold-reset" | "reset" | "jog-cancel" | "none";

export function stopPlanFor(state: string): StopPlan {
  const s = (state || "").split(":")[0];
  if (s === "Run") return "hold-reset";
  if (s === "Hold") return "reset";
  if (s === "Jog") return "jog-cancel";
  if (s === "Home") return "reset";
  return "none";
}

/** Kann der Reset kommen? Ja, wenn die Maschine steht (Hold:0) oder die Wartezeit um ist */
export function holdSettled(state: string, waitedMs: number, maxMs = 3000): boolean {
  return state === "Hold:0" || !state.startsWith("Hold") && !state.startsWith("Run") || waitedMs >= maxMs;
}
