/**
 * BEFEHLSZEILE – nur Lesen der Eingabe, ohne Oberfläche (mit `npm test` prüfbar). Die Zeile selbst: cmdLine.ts
 *
 * Punkte (Zahlen in der eingestellten Einheit, gerechnet und mit Einheit wie bei den Feldern an der Maus):
 *   100,50      absolut (X,Y) – wie unten in der Statuszeile
 *   100;50      dasselbe; mit Semikolon darf das Komma die Dezimalstelle sein: 12,5;7,5
 *   100 50      dasselbe mit Leerzeichen
 *   @30,0       relativ zum letzten Punkt
 *   @100<45     relativ: 100 lang unter 45° (0° = rechts, gegen den Uhrzeigersinn)
 *   100<45      absolut polar vom Nullpunkt der Zeichnung
 *   80          80 weiter in Richtung Maus (nur wenn es einen letzten Punkt gibt)
 *
 * Befehle: englische Kurzformen wie in vielen CAD-Programmen (L, REC, C …), Groß-/Kleinschreibung egal.
 */
import { typedAngle, typedLen } from "./typedValues.ts";

export interface XY { x: number; y: number }

export type CmdName =
  | "line" | "rect" | "circle" | "ellipse" | "polygon" | "star" | "slot" | "ring" | "arc" | "arcCenter" | "text" | "measure"
  | "move" | "copy" | "rotate" | "erase" | "undo" | "redo" | "offset" | "corner" | "chamfer" | "extend" | "extrude" | "body" | "join" | "explode" | "stretch" | "scale" | "ortho" | "trim" | "mirror" | "zoom" | "select" | "help";

const ALIASES: Record<string, CmdName> = {
  l: "line", line: "line", pl: "line", pline: "line",
  rec: "rect", rect: "rect", rectangle: "rect", rectang: "rect",
  c: "circle", ci: "circle", circle: "circle",
  el: "ellipse", ellipse: "ellipse",
  pol: "polygon", polygon: "polygon",
  star: "star", slot: "slot", ring: "ring", donut: "ring",
  a: "arc", arc: "arc", arcc: "arcCenter", arccenter: "arcCenter",
  t: "text", text: "text", dt: "text", mtext: "text",
  di: "measure", dist: "measure", measure: "measure",
  m: "move", move: "move",
  co: "copy", cp: "copy", copy: "copy",
  ro: "rotate", rotate: "rotate",
  e: "erase", erase: "erase", del: "erase", delete: "erase",
  u: "undo", undo: "undo", redo: "redo",
  o: "offset", offset: "offset",
  f: "corner", fillet: "corner", cha: "chamfer", chamfer: "chamfer",
  ex: "extend", extend: "extend",
  ext: "extrude", extrude: "extrude", body: "body", bodies: "body",
  j: "join", join: "join", x: "explode", explode: "explode", s: "stretch", stretch: "stretch",
  sc: "scale", scale: "scale", ortho: "ortho",
  tr: "trim", trim: "trim",
  mi: "mirror", mirror: "mirror",
  z: "zoom", zoom: "zoom",
  v: "select", select: "select",
  "?": "help", help: "help"
};

/** Befehlswort -> Befehl (null = unbekannt). Ein vorangestellter Unterstrich ist erlaubt (_LINE) */
export function parseCommand(word: string): CmdName | null {
  const w = String(word ?? "").trim().toLowerCase().replace(/^_/, "");
  return ALIASES[w] ?? null;
}

/** Bedingungen (Werkzeug „Bedingung“): Wort -> Art, null = kein Bedingungs-Wort */
export type ConWord = "h" | "v" | "par" | "perp" | "eq" | "len" | "ang" | "coin" | "on" | "fix" | "tan" | "conc";
export function parseConKind(word: string): ConWord | null {
  const w = String(word ?? "").trim().toLowerCase().replace(/^_/, "");
  const map: Record<string, ConWord> = {
    hor: "h", horizontal: "h", ver: "v", vertical: "v", par: "par", parallel: "par", perp: "perp", perpendicular: "perp",
    eq: "eq", equal: "eq", len: "len", length: "len", coin: "coin", coincident: "coin",
    ang: "ang", angle: "ang", on: "on", fix: "fix", tan: "tan", tangent: "tan", conc: "conc", concentric: "conc"
  };
  return map[w] ?? null;
}

/** Alle Kurzformen eines Befehls (für die Hilfe) */
export function aliasesOf(cmd: CmdName): string[] {
  return Object.keys(ALIASES).filter(k => ALIASES[k] === cmd).map(k => k.toUpperCase());
}

/** Zwei Zahlen trennen: „;“ zuerst (dann darf das Komma Dezimalzeichen sein), sonst „,“, sonst Leerzeichen */
function splitPair(s: string): [string, string] | null {
  for (const sep of [";", ",", /\s+/] as (string | RegExp)[]) {
    const parts = s.split(sep as any).map(p => p.trim()).filter(p => p !== "");
    if (parts.length === 2) return [parts[0], parts[1]];
    if (typeof sep === "string" && s.includes(sep)) return null; // Trennzeichen da, aber nicht genau zwei Teile
  }
  return null;
}

/**
 * Getippten Punkt lesen. Ergebnis in Millimetern, null = kein Punkt.
 * last: letzter Punkt (mm) für @ und reine Längen; mouseDir: Richtung zur Maus (Bogenmaß) für reine Längen
 */
export function parsePoint(text: string, last: XY | null, mouseDir: number | null, inch: boolean): XY | null {
  let s = String(text ?? "").trim();
  if (!s) return null;
  let rel = false;
  if (s.startsWith("@")) { rel = true; s = s.slice(1).trim(); }
  if (rel && !last) return null;
  const base = rel ? last! : { x: 0, y: 0 };
  if (rel && !s) return { ...last! }; // „@“ allein = letzter Punkt

  const lt = s.indexOf("<");
  if (lt >= 0) {
    const len = typedLen(s.slice(0, lt), inch), ang = typedAngle(s.slice(lt + 1));
    if (!Number.isFinite(len) || !Number.isFinite(ang)) return null;
    const a = (ang * Math.PI) / 180;
    return { x: base.x + len * Math.cos(a), y: base.y + len * Math.sin(a) };
  }

  const pair = splitPair(s);
  if (pair) {
    const x = typedLen(pair[0], inch), y = typedLen(pair[1], inch);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: base.x + x, y: base.y + y };
  }

  // eine einzelne Zahl: so weit in Richtung Maus (nur mit letztem Punkt)
  if (rel || !last || mouseDir === null) return null;
  const len = typedLen(s, inch);
  if (!Number.isFinite(len)) return null;
  return { x: last.x + len * Math.cos(mouseDir), y: last.y + len * Math.sin(mouseDir) };
}
