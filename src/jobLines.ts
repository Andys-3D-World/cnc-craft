/**
 * WELCHE ZEILEN EINER DATEI GEHÖREN ZUM JOB? (ohne Oberfläche, keine Abhängigkeiten)
 *
 * Leerzeilen und reine Kommentarzeilen fallen weg – genau die, von denen auch der Rust-Teil nichts sendet
 * (clean_line in grbl.rs), sonst verrutscht der Fortschritt. Eine Zeile, die mit einem Kommentar ANFÄNGT, aber einen
 * Befehl enthält, gehört dazu: „(hoch) G0 Z5“ wegzulassen hieße, der Fräser bleibt unten.
 */

/** Bleibt ohne Kommentare etwas zum Senden übrig? */
export function hasCommand(line: string): boolean {
  const l = line.trim();
  if (!l || l.startsWith("%") || l.startsWith(";")) return false;
  if (!l.startsWith("(")) return true;
  // nicht geschlossene Klammer: der Rest ist Kommentar (wie bei GRBL)
  return l.replace(/\([^)]*(?:\)|$)/g, "").replace(/;.*$/, "").replace(/%/g, "").trim().length > 0;
}

export function jobLines(lines: string[]): string[] {
  return lines.map(l => l.trim()).filter(hasCommand);
}
