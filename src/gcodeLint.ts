/**
 * G-CODE-PRÜFER (ohne Oberfläche): liest fertigen G-Code und meldet, was an der Maschine gefährlich oder falsch wäre.
 * Kennt nur den Text, nichts vom Programm. Maße in mm, es wird G21/G90 erwartet.
 *
 * Prüft: kaputte Zahlen, zu lange Zeilen, Kommentare, Vorschub, Werkzeug an/aus, Eilfahrten im Material
 * und bei eingeschaltetem Laser/Brenner, Bereich des Betts, Ende des Programms.
 */
export type LintKind = "mill" | "laser" | "plasma";
export interface LintOptions { kind: LintKind; bedW?: number; bedH?: number; sMax?: number; maxLine?: number }
export interface LintIssue { rule: string; line: number; text: string }

const WORD = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

export function lintGcode(code: string, o: LintOptions): LintIssue[] {
  const out: LintIssue[] = [];
  const add = (rule: string, line: number, text: string) => { if (out.length < 200) out.push({ rule, line, text: text.slice(0, 80) }); };
  const maxLine = o.maxLine ?? 80, sMax = o.sMax ?? 1000;
  let x: number | null = null, y: number | null = null, z: number | null = null;
  let motion = "", feed = 0, on = false, s = 0, relative = false, cut = false, everOn = false, ended = false, inch = false;
  const cutAt = new Map<string, number>(); // tiefste gefräste Stelle je Punkt
  const here = (a: number | null, b: number | null) => (a ?? 0).toFixed(2) + "," + (b ?? 0).toFixed(2);
  const lines = code.split(/\r?\n/);

  lines.forEach((raw, idx) => {
    const n = idx + 1;
    if (/[^\x20-\x7e\t]/.test(raw)) add("not-ascii", n, raw);
    if (/undefined|NaN|Infinity|null|\[object/i.test(raw)) add("broken-value", n, raw);
    const opens = (raw.match(/\(/g) || []).length, closes = (raw.match(/\)/g) || []).length;
    // verschachtelte Klammern verwirren manche Steuerungen; mehrere Kommentare nacheinander sind in Ordnung
    let depth = 0, nested = false;
    for (const ch of raw) { if (ch === "(") { if (++depth > 1) nested = true; } else if (ch === ")") depth--; }
    if (opens !== closes || nested) add("bad-comment", n, raw);
    const text = raw.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").toUpperCase().trim();
    if (!text || text.startsWith("%")) return;
    // GRBL zählt Kommentare nicht mit: Grenze gilt für den Befehl selbst
    if (text.length >= maxLine) add("line-too-long", n, raw);
    if (ended) add("after-end", n, raw);

    const w: Record<string, number[]> = {};
    WORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD.exec(text))) (w[m[1]] ||= []).push(parseFloat(m[2]));
    const has = (l: string, v: number) => (w[l] || []).includes(v);

    if (has("G", 20)) inch = true;
    if (has("G", 21)) inch = false;
    if (has("G", 91)) relative = true;
    if (has("G", 90)) relative = false;
    if (w.F) { feed = w.F[0]; if (!(feed > 0)) add("bad-feed", n, raw); }
    if (w.S) { s = w.S[0]; if (s < 0 || (o.kind === "laser" && s > sMax)) add("s-out-of-range", n, raw); }
    if (has("M", 3) || has("M", 4)) { on = true; everOn = true; }
    if (has("M", 5)) on = false;
    if (has("M", 2) || has("M", 30)) {
      if (on) add("end-tool-on", n, raw);
      ended = true;
    }
    // Maschinen-Koordinaten und Nullpunkt-Befehle bewegen nicht wie normale Fahrten
    const special = has("G", 53) || has("G", 10) || has("G", 92) || has("G", 28) || has("G", 30);
    for (const g of [0, 1, 2, 3]) if (has("G", g)) motion = "G" + g;
    const moves = (w.X || w.Y || w.Z) && !special;
    if (!moves || !motion || relative || inch) {
      if (moves && !motion) add("move-without-mode", n, raw);
      return;
    }
    const nx = w.X ? w.X[0] : x, ny = w.Y ? w.Y[0] : y, nz = w.Z ? w.Z[0] : z;
    const xyMoves = (w.X && w.X[0] !== x) || (w.Y && w.Y[0] !== y);

    if (motion !== "G0") {
      if (!(feed > 0)) add("cut-without-feed", n, raw);
      if (o.kind === "mill") {
        if (nz !== null && nz < 0 && !on) add("cut-spindle-off", n, raw);
      } else if (xyMoves) {
        if (!on) add("cut-tool-off", n, raw);
        else if (o.kind === "laser" && s <= 0) add("cut-power-zero", n, raw);
        cut = true;
      }
    } else if (o.kind === "mill") {
      // Eilfahrt seitwärts unter der Oberfläche: Werkzeug fährt durchs Material
      if (xyMoves && z !== null && z < -1e-6) add("rapid-in-material", n, raw);
      // nach unten nur dorthin, wo an dieser Stelle schon so tief gefräst wurde (Bohren in Stufen, zweiter Durchgang)
      if (nz !== null && nz < -1e-6 && !(nz >= (cutAt.get(here(nx, ny)) ?? Infinity) - 1e-6)) add("rapid-into-material", n, raw);
    } else if (o.kind === "plasma" && on && xyMoves) {
      add("rapid-torch-on", n, raw);
    }
    if (o.bedW && nx !== null && (nx < -0.01 || nx > o.bedW + 0.01)) add("off-bed", n, raw);
    if (o.bedH && ny !== null && (ny < -0.01 || ny > o.bedH + 0.01)) add("off-bed", n, raw);
    if (motion !== "G0" && nz !== null) { const k = here(nx, ny); if (nz < (cutAt.get(k) ?? Infinity)) cutAt.set(k, nz); }
    x = nx; y = ny; z = nz;
  });

  if (!ended) add("no-end", lines.length, "(no M2/M30)");
  if (on && !ended) add("end-tool-on", lines.length, "(tool still on)");
  if (!everOn && (o.kind !== "mill" || cut)) add("tool-never-on", 1, "(no M3/M4)");
  return out;
}

/** Häufigkeit je Regel – für Übersichten */
export function lintSummary(list: LintIssue[]): Record<string, number> {
  const r: Record<string, number> = {};
  for (const i of list) r[i.rule] = (r[i.rule] || 0) + 1;
  return r;
}
