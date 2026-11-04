/**
 * MAKROS – eigene G-Code-Knöpfe (reine Logik, ohne Oberfläche)
 *
 * Name und G-Code sind Nutzertext bzw. kommen aus importierten Dateien: Namen nie in innerHTML,
 * und alles Eingelesene läuft durch sanitizeMacros. Importierte Makros gelten als „noch nie bestätigt“.
 */
export interface Macro {
  id: string;
  name: string;
  gcode: string;
  /** Hat der Nutzer diesen Inhalt schon einmal zum Ausführen bestätigt? */
  confirmed: boolean;
}

export const MACRO_MAX = 50;
export const MACRO_NAME_MAX = 40;
export const MACRO_GCODE_MAX = 4000;
export const MACRO_LINE_MAX = 70; // GRBL nimmt höchstens 80 Zeichen pro Zeile
export const MACRO_FORMAT = "cnc-craft-macros";

/** Zu sendende Zeilen: ohne Kommentare und Leerzeilen. $- und [ESP-Zeilen bleiben unverändert (Werte können ; oder ( enthalten) */
export function macroLines(gcode: string): string[] {
  return gcode.split(/\r?\n/)
    .map(l => {
      const s = l.trim();
      return s.startsWith("$") || s.startsWith("[") ? s : s.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").replace(/\s+/g, " ").trim();
    })
    .filter(l => l.length > 0);
}

export type MacroProblem = "" | "empty" | "chars" | "long" | "size";

/** Lässt sich der G-Code so verschicken? GRBL fängt ? ! ~ und Bytes ≥ 0x80 unterwegs ab – die Zeile käme verstümmelt an */
export function macroProblem(gcode: string): { problem: MacroProblem; line: string } {
  if (gcode.length > MACRO_GCODE_MAX) return { problem: "size", line: "" };
  const lines = macroLines(gcode);
  if (!lines.length) return { problem: "empty", line: "" };
  for (const l of lines) {
    if (/[?!~\u0000-\u001f\u007f-￿]/.test(l)) return { problem: "chars", line: l };
    if (l.length > MACRO_LINE_MAX) return { problem: "long", line: l };
  }
  return { problem: "", line: "" };
}

export interface MacroContext {
  connected: boolean;
  state: string;
  jobActive: boolean;
  busy: boolean;
}
export type MacroBlock = "" | "noConn" | "job" | "alarm" | "busy" | "state";

/** Warum darf gerade kein Makro laufen? Während eines Jobs auch dann nicht, wenn er pausiert ist. */
export function macroBlock(c: MacroContext): MacroBlock {
  if (!c.connected) return "noConn";
  if (c.jobActive) return "job";
  if (c.state === "Alarm") return "alarm";
  if (c.busy) return "busy";
  if (c.state && c.state !== "Idle") return "state";
  return "";
}

const cleanName = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MACRO_NAME_MAX);

/** Gespeicherte oder importierte Daten prüfen. `fromFile`: nichts gilt als bestätigt, neue Kennungen */
export function sanitizeMacros(raw: unknown, fromFile: boolean, newId: () => string): Macro[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: Macro[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    if (out.length >= MACRO_MAX) break;
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const name = cleanName(o.name);
    const gcode = typeof o.gcode === "string" ? o.gcode.replace(/\r\n/g, "\n").slice(0, MACRO_GCODE_MAX) : "";
    if (!name || !gcode.trim()) continue;
    let id = !fromFile && typeof o.id === "string" && /^[\w-]{1,40}$/.test(o.id) ? o.id : "";
    if (!id || seen.has(id)) id = newId();
    seen.add(id);
    out.push({ id, name, gcode, confirmed: !fromFile && o.confirmed === true });
  }
  return out;
}

export function buildMacroFile(list: Macro[], app = "CNC Craft"): string {
  return JSON.stringify({ format: MACRO_FORMAT, version: 1, app, macros: list.map(m => ({ name: m.name, gcode: m.gcode })) }, null, 2);
}

/** Datei lesen; wirft Error("invalid"), wenn es keine Makro-Datei ist */
export function parseMacroFile(text: string, newId: () => string): Macro[] {
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error("invalid"); }
  if (!j || j.format !== MACRO_FORMAT || !Array.isArray(j.macros)) throw new Error("invalid");
  return sanitizeMacros(j.macros, true, newId);
}
