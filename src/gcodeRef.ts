/**
 * G-CODE NACHSCHLAGEN (ohne Oberfläche): welche Befehle es gibt, welche GRBL kennt und wie eine Zeile eingefärbt wird.
 * Die Texte stehen in den Sprachdateien unter „gref.<Kennung>“.
 *
 * Stand GRBL 1.1:  yes = kennt GRBL   conv = kennt GRBL nicht, CNC Craft wandelt es um oder hält selbst an
 *                  no = kennt GRBL nicht (grblHAL, FluidNC oder große Steuerungen können manches davon)
 */
export type RefSupport = "yes" | "conv" | "no";
export interface RefEntry { id: string; code: string; group: "move" | "plane" | "pos" | "cycle" | "tool" | "m" | "word"; support: RefSupport; example?: string }

const E = (code: string, group: RefEntry["group"], support: RefSupport = "yes", example?: string, id = code.replace(/[^A-Za-z0-9]/g, "_")): RefEntry => ({ id, code, group, support, example });

export const GCODE_REF: RefEntry[] = [
  E("G0", "move", "yes", "G0 X10 Y20"), E("G1", "move", "yes", "G1 X50 F600"), E("G2", "move", "yes", "G2 X20 Y0 I10 J0"),
  E("G3", "move", "yes", "G3 X20 Y0 R10"), E("G4", "move", "yes", "G4 P2"), E("G38.2", "move", "yes", "G38.2 Z-20 F100"),
  E("G17", "plane"), E("G18", "plane"), E("G19", "plane"), E("G20", "plane"), E("G21", "plane"),
  E("G90", "plane"), E("G91", "plane"), E("G90.1", "plane", "no"), E("G91.1", "plane"), E("G93", "plane"), E("G94", "plane"),
  E("G10", "pos", "yes", "G10 L20 P1 X0 Y0"), E("G28", "pos"), E("G30", "pos"), E("G53", "pos", "yes", "G53 G0 Z0"),
  E("G54", "pos"), E("G92", "pos", "yes", "G92 X0 Y0"), E("G92.1", "pos"),
  E("G73", "cycle", "conv"), E("G81", "cycle", "conv", "G98 G81 X10 Y10 Z-5 R2 F100"), E("G82", "cycle", "conv"), E("G83", "cycle", "conv", "G83 Z-20 R2 Q3 F100"),
  E("G84", "cycle", "conv"), E("G85", "cycle", "conv"), E("G80", "cycle"), E("G98", "cycle", "conv"), E("G99", "cycle", "conv"),
  E("G40", "tool"), E("G41", "tool", "no"), E("G42", "tool", "no"), E("G43", "tool", "no"), E("G43.1", "tool"), E("G49", "tool"),
  E("G61", "tool"), E("G64", "tool", "no"), E("G68", "tool", "no"),
  E("M0", "m"), E("M1", "m"), E("M2", "m"), E("M3", "m", "yes", "M3 S12000"), E("M4", "m"), E("M5", "m"), E("M6", "m", "conv", "M6 T2"),
  E("M7", "m"), E("M8", "m"), E("M9", "m"), E("M30", "m"), E("M98", "m", "no"), E("M99", "m", "no"),
  E("X", "word"), E("Y", "word"), E("Z", "word"), E("A", "word", "no"), E("I", "word"), E("J", "word"), E("K", "word"), E("R", "word"),
  E("F", "word", "yes", "F800"), E("S", "word", "yes", "S12000"), E("T", "word", "yes", "T1"), E("P", "word"), E("Q", "word"), E("L", "word"), E("N", "word", "yes", "N100"),
  E("( )", "word", "yes", "(text)", "comment")
];
const BY_CODE = new Map(GCODE_REF.map(r => [r.code, r]));

/** Eintrag zu einem Wort der Zeile: „G01“ → G1, „G55“ → G54, „X12.5“ → X (null = unbekannt) */
export function refFor(letter: string, value: string): RefEntry | null {
  const L = letter.toUpperCase();
  if (L === "G" || L === "M") {
    const v = parseFloat(value);
    if (!Number.isFinite(v)) return null;
    let code = L + String(+v.toFixed(1));
    if (L === "G" && v >= 54 && v < 60) code = "G54";
    if (L === "G" && v > 38 && v < 39) code = "G38.2";
    return BY_CODE.get(code) ?? null;
  }
  return BY_CODE.get(L) ?? null;
}

export type TokenKind = "g0" | "g" | "m" | "axis" | "arc" | "feed" | "tool" | "word" | "comment" | "text";
export interface Token { text: string; kind: TokenKind; letter?: string; value?: string }

const KIND: Record<string, TokenKind> = { X: "axis", Y: "axis", Z: "axis", A: "axis", B: "axis", C: "axis", I: "arc", J: "arc", K: "arc", R: "arc", F: "feed", S: "feed", T: "tool" };

/** Zeile in Stücke zerlegen – aneinandergehängt ergeben sie wieder genau die Zeile */
export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  if (line.startsWith("$") || line.startsWith("%")) return line ? [{ text: line, kind: "text" }] : [];
  const re = /\([^)]*(?:\)|$)|;.*$|([A-Za-z])(\s*)([-+]?(?:\d+\.?\d*|\.\d+))|[^A-Za-z(;]+|[A-Za-z]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const s = m[0];
    if (s[0] === "(" || s[0] === ";") out.push({ text: s, kind: "comment" });
    else if (m[1]) {
      const L = m[1].toUpperCase();
      const kind: TokenKind = L === "G" ? (parseFloat(m[3]) === 0 ? "g0" : "g") : L === "M" ? "m" : KIND[L] ?? "word";
      out.push({ text: s, kind, letter: L, value: m[3] });
    } else out.push({ text: s, kind: "text" });
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Eingefärbte Zeile als HTML. G-Code ist fremder Text: jedes Stück läuft durch esc(). tip = Erklärung zum Eintrag */
export function lineHtml(line: string, tip: (r: RefEntry) => string): string {
  return tokenize(line).map(k => {
    if (k.kind === "text") return esc(k.text);
    const r = k.letter ? refFor(k.letter, k.value ?? "") : null;
    return `<i class="gc gc-${k.kind}"${r ? ` data-tip="${esc(tip(r))}"` : ""}>${esc(k.text)}</i>`;
  }).join("");
}
