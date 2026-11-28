/**
 * NACHBEARBEITUNG DES G-CODES IN RUST, MIT DEM TYPESCRIPT GEPRÜFT
 *
 * Nach dem G-Code der Formen laufen in cam.ts noch Schritte über den fertigen Text: Bogen-Glättung (arcFit.ts),
 * Sperrzonen (keepOut.ts), Drehachse (rotaryWrap.ts). Jeder hat einen Zwilling in Rust (src-tauri/src/…). Solange das
 * TypeScript daneben mitrechnet, gilt wie beim Fräs-G-Code: das Ergebnis aus Rust zählt nur, wenn es Zeichen für
 * Zeichen dasselbe ist. cam.ts merkt sich deshalb jeden Schritt (Eingabe, Einstellungen, Ergebnis), und checkPost()
 * lässt Rust dieselben Schritte rechnen. Weicht etwas ab, bleibt es beim Text aus dem TypeScript und ein Hinweis bittet
 * darum, das zu melden. Vorschau im Browser und Tests: ohne Rust, nichts wird geprüft.
 */

export interface PostStep { cmd: string; args: Record<string, unknown>; result: unknown }

let rec: PostStep[] | null = null;

/** Ab jetzt die Schritte merken (generateGcodeFull in cam.ts schaltet das um finish() herum ein) */
export function recordPost() { rec = []; }
/** Ein Schritt ist gelaufen: Befehl in Rust, seine Angaben, was das TypeScript ergeben hat */
export function notePost(cmd: string, args: Record<string, unknown>, result: unknown) { rec?.push({ cmd, args, result }); }
/** Die gemerkten Schritte holen und das Merken beenden */
export function takePost(): PostStep[] { const r = rec || []; rec = null; return r; }

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Gleich bis in jedes Feld (Reihenfolge der Felder egal; fehlendes Feld = undefined) */
export function sameDeep(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => sameDeep(v, (b as unknown[])[i]));
  const ka = Object.keys(a).filter(k => (a as any)[k] !== undefined), kb = Object.keys(b).filter(k => (b as any)[k] !== undefined);
  return ka.length === kb.length && ka.every(k => sameDeep((a as any)[k], (b as any)[k]));
}

/** Wo sich zwei Ergebnisse unterscheiden (für die Konsole): erste abweichende G-Code-Zeile oder das Feld */
export function firstDiff(ts: any, rust: any): string {
  if (typeof ts?.gcode === "string" && typeof rust?.gcode === "string" && ts.gcode !== rust.gcode) {
    const a = ts.gcode.split("\n"), b = rust.gcode.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `line ${i + 1}: Rust "${b[i] ?? "<end>"}", TypeScript "${a[i] ?? "<end>"}"`;
  }
  for (const k of new Set([...Object.keys(ts ?? {}), ...Object.keys(rust ?? {})])) if (!sameDeep(ts?.[k], rust?.[k])) return `${k}: Rust ${JSON.stringify(rust?.[k])?.slice(0, 200)}, TypeScript ${JSON.stringify(ts?.[k])?.slice(0, 200)}`;
  return "different";
}

/** Zeilen eines Ergebnisses (gcode als Text oder lines als Liste), null = keine */
const linesOf = (r: any): string[] | null => typeof r?.gcode === "string" ? r.gcode.split("\n") : Array.isArray(r?.lines) ? r.lines : null;

/**
 * Nur die letzte Stelle anders? Bögen brauchen Sinus/Kosinus, und deren letzte Stelle kann zwischen dem Fenster und
 * Rust abweichen; liegt eine Zahl genau an einer Rundungsgrenze, steht dann z. B. X12.3456 statt X12.3457 da. Das ist
 * kein Fehler (beide Bahnen sind gleich gut), aber nicht derselbe Text: verwendet wird das TypeScript, ohne Hinweis.
 * Antwort: Zahl solcher Zeilen, 0 = die Ergebnisse unterscheiden sich wirklich (oder gar nicht).
 */
export function nearLines(ts: unknown, rust: unknown): number {
  const a = linesOf(ts), b = linesOf(rust);
  if (!a || !b || a.length !== b.length) return 0;
  // alles außer dem Text muss genau gleich sein
  const rest = (r: any) => ({ ...r, gcode: undefined, lines: undefined });
  if (!sameDeep(rest(ts), rest(rust))) return 0;
  let near = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const p = a[i].split(" "), q = b[i].split(" ");
    if (p.length !== q.length) return 0;
    for (let k = 0; k < p.length; k++) {
      if (p[k] === q[k]) continue;
      const x = Number(p[k].slice(1)), y = Number(q[k].slice(1));
      if (p[k][0] !== q[k][0] || !/^[A-Za-z]$/.test(p[k][0] ?? "") || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
      // eine Einheit der dritten Stelle; der gerundete Vorschub (ganze Zahl) darf um 1 abweichen
      if (Math.abs(x - y) > (p[k][0].toUpperCase() === "F" ? 1 : 0.0011)) return 0;
    }
    near++;
  }
  // höchstens eine von 200 Zeilen – mehr wäre kein Rundungszufall
  return near * 200 <= Math.max(200, a.length) ? near : 0;
}

/** Wo der letzte checkPost() stand: "" = nichts zu prüfen, "rust" = alle Schritte gleich, sonst der Grund */
export let lastPostSource = "";

/**
 * Rust dieselben Schritte rechnen lassen. Antwort: null = alles gleich (oder nichts zu prüfen / kein Rust),
 * sonst die erste Abweichung als Text. Ein Fehler beim Aufruf selbst ist keine Abweichung (Rust hat nichts gerechnet).
 */
export async function checkPost(steps: PostStep[]): Promise<string | null> {
  lastPostSource = "";
  if (!steps.length) return null;
  if (!IN_TAURI) { lastPostSource = "TypeScript: not in the app"; return null; }
  const { invoke } = await import("@tauri-apps/api/core");
  for (const s of steps) {
    let rust: unknown;
    try { rust = await invoke(s.cmd, s.args); } catch (e) { lastPostSource = `TypeScript: ${s.cmd} failed (${String(e)})`; console.warn("post step:", lastPostSource); return null; }
    if (!sameDeep(s.result, rust)) {
      const near = nearLines(s.result, rust), d = `${s.cmd} – ${firstDiff(s.result, rust)}`;
      lastPostSource = "TypeScript: " + (near ? `${near} line(s) differ in the last digit – ` : "") + d;
      if (near) { console.info("post step:", lastPostSource); return null; }
      return d;
    }
  }
  lastPostSource = "rust";
  return null;
}
