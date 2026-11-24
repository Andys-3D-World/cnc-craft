/**
 * PRÜFUNG GELADENER G-CODE-DATEIEN (ohne Oberfläche)
 *
 * lintGcode ist für den eigenen G-Code gemacht. In fremden Dateien ist manches Absicht, was dort ein Fehler wäre
 * (Spindel von Hand geschaltet, Z0 auf der Opferplatte, Bohrzyklen, Leerfahrten mit G1). Darum zählen hier nur die
 * Regeln, die unabhängig vom Programm stimmen. Wer etwas ergänzt: eine Regel darf bei richtigem G-Code nie anschlagen.
 */
import { lintGcode, type LintIssue, type LintOptions } from "./gcodeLint.ts";

/** Regeln, die auch für fremden G-Code gelten */
export const FILE_RULES = new Set(["broken-value", "bad-comment", "cut-without-feed", "s-out-of-range", "rapid-torch-on", "end-tool-on"]);

const bare = (l: string) => l.replace(/\([^)]*(?:\)|$)/g, "").replace(/;.*$/, "");

/** Auffälliges in den Zeilen des geladenen Jobs (line = 1-basiert wie in der Anzeige) */
export function checkFileLines(lines: string[], o: LintOptions): LintIssue[] {
  return lintGcode(lines.join("\n"), o).filter(i => {
    if (!FILE_RULES.has(i.rule)) return false;
    // M2/M30 schaltet Spindel und Laser aus: nur ein Programm ganz ohne M5 und ohne Ende lässt sie wirklich an
    if (i.rule === "end-tool-on") return i.text.startsWith("(tool still on");
    // im Kommentar ist „Infinity“ oder „NaN“ nur ein Wort
    if (i.rule === "broken-value") return /undefined|nan|infinity|null|\[object/i.test(bare(lines[i.line - 1] ?? ""));
    return true;
  });
}
