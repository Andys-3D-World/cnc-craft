/**
 * G-CODE-PRÜFER (ohne Oberfläche): liest fertigen G-Code und meldet, was an der Maschine gefährlich oder falsch wäre.
 * Kennt nur den Text, nichts vom Programm. Es wird G90 erwartet. Zoll (G20) wird in mm umgerechnet und genauso geprüft
 * (Dateien für LinuxCNC/Mach aus dem Post-Prozessor); die Grenzen (Bett, Oberfläche) bleiben in mm.
 *
 * Prüft: kaputte Zahlen, zu lange Zeilen, Kommentare, Vorschub, Werkzeug an/aus, Eilfahrten im Material
 * und bei eingeschaltetem Laser/Brenner, Bereich des Betts, Ende des Programms.
 *
 * LASER, „cut-power-zero“ (Schneiden mit Leistung 0, z. B. Ebene auf 0 %): Bildgravur fährt mit Absicht mit S0 –
 * vor und nach jeder Zeile über den Rand hinaus und über weiße Stellen in der Zeile. Unterschieden wird am Zug:
 * alle G1-Fahrten in X/Y zwischen zwei Unterbrechungen (Eilfahrt, M-Befehl, Bogen, Z, G91 …). Ein Zug ist eine
 * Gravurzeile, wenn er EINE gerade Strecke in EINER Richtung ist und darin auch mit Leistung gefahren wird; dann
 * sind seine S0-Stücke gewollt. In jedem anderen Zug wird jede S0-Fahrt gemeldet: eine Kontur mit 0 % hat nirgends
 * Leistung, und eine Kontur mit einem S0-Stück ist keine Gerade. Es gibt keine Markierung im G-Code, die die Regel
 * abschaltet – nur die Form zählt, also auch bei G-Code aus anderen Programmen.
 */
export type LintKind = "mill" | "laser" | "plasma";
export interface LintOptions { kind: LintKind; bedW?: number; bedH?: number; sMax?: number; maxLine?: number }
export interface LintIssue { rule: string; line: number; text: string }

/** mm – so weit darf ein Punkt einer Gravurzeile neben ihrer Geraden liegen (Rundung im G-Code: unter 0,002 mm) */
const STRAIGHT_TOL = 0.01;

const WORD = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

export function lintGcode(code: string, o: LintOptions): LintIssue[] {
  const out: LintIssue[] = [];
  const add = (rule: string, line: number, text: string) => { if (out.length < 200) out.push({ rule, line, text: text.slice(0, 80) }); };
  const maxLine = o.maxLine ?? 80, sMax = o.sMax ?? 1000;
  let x: number | null = null, y: number | null = null, z: number | null = null;
  let motion = "", feed = 0, on = false, s = 0, relative = false, cut = false, everOn = false, ended = false, inch = false;
  const cutAt = new Map<string, number>(); // tiefste gefräste Stelle je Punkt
  // Schlüssel je Punkt (auf 0,01 mm); bleibt X/Y gleich (z. B. Eintauchen), wird der letzte wiederverwendet
  let keyX: number | null = NaN, keyY: number | null = NaN, key = "";
  const here = (a: number | null, b: number | null) => {
    if (a !== keyX || b !== keyY) { keyX = a; keyY = b; key = (a ?? 0).toFixed(2) + "," + (b ?? 0).toFixed(2); }
    return key;
  };
  const lines = code.split(/\r?\n/);
  // Wörter der aktuellen Zeile – je Zeile neu gefüllt statt neu angelegt (schneller bei Millionen Zeilen)
  const G: number[] = [], M: number[] = [];
  const hasG = (v: number) => G.includes(v), hasM = (v: number) => M.includes(v);

  // Laser: der laufende Zug (siehe oben). Start, Endpunkte der Fahrten, Zeilen mit S0, ob mit Leistung gefahren wurde
  let sx: number | null = null, sy: number | null = null, powered = false, late = false;
  const px: number[] = [], py: number[] = [], zero: number[] = [];
  /** gerade Strecke in einer Richtung? Gemessen an der Linie Start → Ende (lang, also sicher gegen Rundung) */
  const straight = () => {
    if (sx === null || sy === null) return false;
    const k = px.length - 1, dx = px[k] - sx, dy = py[k] - sy, len = Math.hypot(dx, dy);
    if (!(len > STRAIGHT_TOL)) return false;
    let before = 0;
    for (let i = 0; i <= k; i++) {
      const ax = px[i] - sx, ay = py[i] - sy;
      if (Math.abs(ax * dy - ay * dx) / len > STRAIGHT_TOL) return false; // neben der Linie
      const along = (ax * dx + ay * dy) / len;
      if (along < before - STRAIGHT_TOL) return false;                    // fährt zurück
      before = along;
    }
    return true;
  };
  const endStroke = () => {
    if (!px.length) return;
    if (zero.length && !(powered && straight())) {
      for (const ln of zero) add("cut-power-zero", ln, lines[ln - 1]);
      late = true; // diese Meldungen kommen erst am Ende des Zugs: später nach Zeile ordnen
    }
    px.length = 0; py.length = 0; zero.length = 0; powered = false;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx], n = idx + 1;
    if (/[^\x20-\x7e\t]/.test(raw)) add("not-ascii", n, raw);
    const paren = raw.includes("(") || raw.includes(")");
    // kaputte Werte: im Befehl jede Schreibweise; im Kommentar nur die genaue (dort stehen Wörter wie „Z neu nullen“)
    if (/undefined|NaN|Infinity|\[object/.test(raw) || /undefined|nan|infinity|null/i.test(raw.replace(/\([^)]*\)/g, "").replace(/;.*$/, ""))) add("broken-value", n, raw);
    if (paren) {
      const opens = (raw.match(/\(/g) || []).length, closes = (raw.match(/\)/g) || []).length;
      // verschachtelte Klammern verwirren manche Steuerungen; mehrere Kommentare nacheinander sind in Ordnung
      let depth = 0, nested = false;
      for (const ch of raw) { if (ch === "(") { if (++depth > 1) nested = true; } else if (ch === ")") depth--; }
      if (opens !== closes || nested) add("bad-comment", n, raw);
    }
    let text = paren ? raw.replace(/\([^)]*\)/g, "") : raw;
    if (text.includes(";")) text = text.replace(/;.*$/, "");
    text = text.toUpperCase().trim();
    if (!text || text.startsWith("%")) continue;
    // GRBL zählt Kommentare nicht mit: Grenze gilt für den Befehl selbst
    if (text.length >= maxLine) add("line-too-long", n, raw);
    if (ended) add("after-end", n, raw);

    // Wörter lesen: G und M alle, sonst gilt der erste Wert eines Buchstabens
    G.length = 0; M.length = 0;
    let wF: number | undefined, wS: number | undefined, wX: number | undefined, wY: number | undefined, wZ: number | undefined;
    WORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD.exec(text))) {
      const v = parseFloat(m[2]);
      switch (m[1]) {
        case "G": G.push(v); break;
        case "M": M.push(v); break;
        case "F": if (wF === undefined) wF = v; break;
        case "S": if (wS === undefined) wS = v; break;
        case "X": if (wX === undefined) wX = v; break;
        case "Y": if (wY === undefined) wY = v; break;
        case "Z": if (wZ === undefined) wZ = v; break;
      }
    }

    if (G.length) {
      if (hasG(20)) inch = true;
      if (hasG(21)) inch = false;
      if (hasG(91)) relative = true;
      if (hasG(90)) relative = false;
    }
    if (inch) {
      if (wX !== undefined) wX *= 25.4;
      if (wY !== undefined) wY *= 25.4;
      if (wZ !== undefined) wZ *= 25.4;
    }
    if (wF !== undefined) { feed = wF; if (!(feed > 0)) add("bad-feed", n, raw); }
    if (wS !== undefined) { s = wS; if (s < 0 || (o.kind === "laser" && s > sMax)) add("s-out-of-range", n, raw); }
    if (M.length) {
      endStroke();
      if (hasM(3) || hasM(4)) { on = true; everOn = true; }
      if (hasM(5)) on = false;
      if (hasM(2) || hasM(30)) {
        if (on) add("end-tool-on", n, raw);
        ended = true;
      }
    }
    // Maschinen-Koordinaten und Nullpunkt-Befehle bewegen nicht wie normale Fahrten
    let special = false;
    if (G.length) {
      special = hasG(53) || hasG(10) || hasG(92) || hasG(28) || hasG(30);
      // bei mehreren gilt die höchste Nummer (wie bisher: G0, G1, G2, G3 der Reihe nach geprüft)
      if (hasG(3)) motion = "G3"; else if (hasG(2)) motion = "G2"; else if (hasG(1)) motion = "G1"; else if (hasG(0)) motion = "G0";
    }
    const moves = (wX !== undefined || wY !== undefined || wZ !== undefined) && !special;
    if (!moves || !motion || relative) {
      if (moves) endStroke();
      if (moves && !motion) add("move-without-mode", n, raw);
      continue;
    }
    const nx: number | null = wX !== undefined ? wX : x, ny: number | null = wY !== undefined ? wY : y, nz: number | null = wZ !== undefined ? wZ : z;
    const xyMoves = (wX !== undefined && wX !== x) || (wY !== undefined && wY !== y);

    if (motion !== "G0") {
      if (!(feed > 0)) add("cut-without-feed", n, raw);
      if (o.kind === "mill") {
        if (nz !== null && nz < 0 && !on) add("cut-spindle-off", n, raw);
      } else if (xyMoves) {
        if (!on) add("cut-tool-off", n, raw);
        else if (o.kind === "laser") {
          // nur eine gerade G1-Fahrt in X/Y gehört zum Zug; S0 wird erst am Ende des Zugs beurteilt
          if (motion !== "G1" || nz !== z || nx === null || ny === null) {
            endStroke(); // Bogen oder Fahrt mit Z: keine Gravurzeile
            if (s <= 0) add("cut-power-zero", n, raw);
          } else {
            if (!px.length) { sx = x; sy = y; }
            px.push(nx); py.push(ny);
            if (s > 0) powered = true; else zero.push(n);
          }
        }
        cut = true;
      }
      if (o.kind === "laser" && (!xyMoves || !on)) endStroke(); // nur Z, oder Laser aus: der Zug ist zu Ende
    } else if (o.kind === "mill") {
      // Eilfahrt seitwärts unter der Oberfläche: Werkzeug fährt durchs Material
      if (xyMoves && z !== null && z < -1e-6) add("rapid-in-material", n, raw);
      // nach unten nur dorthin, wo an dieser Stelle schon so tief gefräst wurde (Bohren in Stufen, zweiter Durchgang)
      if (nz !== null && nz < -1e-6 && !(nz >= (cutAt.get(here(nx, ny)) ?? Infinity) - 1e-6)) add("rapid-into-material", n, raw);
    } else if (o.kind === "plasma" && on && xyMoves) {
      add("rapid-torch-on", n, raw);
    } else if (o.kind === "laser") {
      endStroke(); // Eilfahrt: der Zug ist zu Ende
    }
    if (o.bedW && nx !== null && (nx < -0.01 || nx > o.bedW + 0.01)) add("off-bed", n, raw);
    if (o.bedH && ny !== null && (ny < -0.01 || ny > o.bedH + 0.01)) add("off-bed", n, raw);
    if (motion !== "G0" && nz !== null) { const k = here(nx, ny); if (nz < (cutAt.get(k) ?? Infinity)) cutAt.set(k, nz); }
    x = nx; y = ny; z = nz;
  }

  endStroke();
  if (late) out.sort((p, q) => p.line - q.line); // stabil: Meldungen einer Zeile bleiben in ihrer Reihenfolge
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
