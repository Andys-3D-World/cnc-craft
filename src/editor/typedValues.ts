/**
 * GETIPPTE MASSE BEIM ZEICHNEN – nur die Rechnung, ohne Oberfläche (mit `npm test` prüfbar)
 *
 * Während eine Linie, ein Rechteck, eine Ellipse … gezeichnet wird, kann man Zahlen tippen (typedBox.ts zeigt die
 * Felder an der Maus). Ein getipptes Feld ist „gesperrt“: es gilt statt der Maus. Leere Felder folgen weiter der Maus.
 *
 *   Linie                  Länge, Winkel     Winkel in Grad, 0° = nach rechts, gegen den Uhrzeigersinn
 *   Rechteck/Ellipse/Langloch  Breite, Höhe   die Richtung (links/rechts, oben/unten) bestimmt die Maus
 *   Polygon/Stern/Ring     Durchmesser, Winkel
 *   Kreis                  Durchmesser (von der Mitte aus)
 *
 * Getippt werden darf auch gerechnet: „100/3“, „2*(40+5)“, „12,5“. Eine Einheit dahinter gewinnt immer
 * („10mm“, „2cm“, „0.5in“, „1/2"“), sonst gilt die eingestellte Einheit. Kein eval – eigener kleiner Rechner.
 */
export interface P { x: number; y: number }

export type FieldKind = "len" | "angle";
/** key = Übersetzungs-Schlüssel der Feld-Beschriftung */
export interface FieldSpec { key: string; kind: FieldKind }

const LEN_ANGLE: FieldSpec[] = [{ key: "typed.len", kind: "len" }, { key: "typed.angle", kind: "angle" }];
const W_H: FieldSpec[] = [{ key: "typed.w", kind: "len" }, { key: "typed.h", kind: "len" }];
const DIA_ANGLE: FieldSpec[] = [{ key: "typed.dia", kind: "len" }, { key: "typed.angle", kind: "angle" }];
const DIA: FieldSpec[] = [{ key: "typed.dia", kind: "len" }];

/** Welche Felder ein Werkzeug hat – null: kein Tippen möglich */
export function fieldsFor(tool: string): FieldSpec[] | null {
  switch (tool) {
    case "line": return LEN_ANGLE;
    case "rect": case "ellipse": case "slot": return W_H;
    case "polygon": case "star": case "ring": return DIA_ANGLE;
    case "circle": return DIA;
    default: return null;
  }
}

// ---------------------------------------------------------------------
// Kleiner Rechner: + - * / Klammern, Vorzeichen, Komma oder Punkt
// ---------------------------------------------------------------------

/** Rechenausdruck auswerten, NaN bei Fehler */
export function calc(text: string): number {
  const s = String(text ?? "").replace(/\s+/g, "").replace(/,/g, ".").replace(/[×x]/gi, "*").replace(/[÷:]/g, "/");
  if (!s || s.length > 200) return NaN;
  let i = 0;
  const peek = () => s[i];
  function num(): number {
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) return NaN;
    i += m[0].length;
    return Number(m[0]);
  }
  function factor(): number {
    const c = peek();
    if (c === "-") { i++; return -factor(); }
    if (c === "+") { i++; return factor(); }
    if (c === "(") {
      i++;
      const v = expr();
      if (peek() !== ")") return NaN;
      i++;
      return v;
    }
    return num();
  }
  function term(): number {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = s[i++];
      const r = factor();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const v = expr();
  return i === s.length && Number.isFinite(v) ? v : NaN;
}

const MM_PER_IN = 25.4;
const RE_UNIT = /(mm|cm|in|inch|")\s*$/i;
const RE_MIXED = /^\s*(-?)(\d+)[\s-]+(\d+)\s*\/\s*(\d+)\s*$/; // 1 1/2   1-1/2

/** Getippte Länge -> Millimeter (NaN = keine Zahl). inch: eingestellte Einheit ist Zoll */
export function typedLen(text: string, inch: boolean): number {
  let s = String(text ?? "").trim();
  if (!s) return NaN;
  let factor = inch ? MM_PER_IN : 1;
  const u = RE_UNIT.exec(s);
  if (u) {
    const k = u[1].toLowerCase();
    factor = k === "mm" ? 1 : k === "cm" ? 10 : MM_PER_IN;
    s = s.slice(0, u.index).trim();
  }
  const m = RE_MIXED.exec(s);
  const v = m && Number(m[4]) > 0 ? (Number(m[2]) + Number(m[3]) / Number(m[4])) * (m[1] ? -1 : 1) : calc(s);
  return Number.isFinite(v) ? v * factor : NaN;
}

/** Getippter Winkel in Grad (NaN = keine Zahl), „°“ dahinter erlaubt */
export function typedAngle(text: string): number {
  return calc(String(text ?? "").replace(/°|deg\s*$/gi, ""));
}

// ---------------------------------------------------------------------
// Gesperrte Werte auf den Mauspunkt anwenden
// ---------------------------------------------------------------------

/** a = erstes Feld, b = zweites Feld. Längen schon in Zeichen-Einheiten, Winkel in Grad. Fehlt ein Wert, gilt die Maus */
export interface Lock { a?: number; b?: number }

const RAD = Math.PI / 180;

/**
 * Den Punkt berechnen, den die Maus mit den getippten Werten ergibt.
 * from: letzter Linienpunkt bzw. Startpunkt (Ecke oder Mitte); fromCenter: Rechteck/Ellipse von der Mitte (Strg/Alt)
 */
export function lockPoint(tool: string, from: P, mouse: P, lock: Lock, fromCenter = false): P {
  const dx = mouse.x - from.x, dy = mouse.y - from.y;
  const hasA = lock.a !== undefined && Number.isFinite(lock.a);
  const hasB = lock.b !== undefined && Number.isFinite(lock.b);
  if (!hasA && !hasB) return { ...mouse };

  if (tool === "line" || tool === "polygon" || tool === "star" || tool === "ring" || tool === "circle") {
    const mouseAng = dx || dy ? Math.atan2(dy, dx) : 0;
    const ang = hasB ? lock.b! * RAD : mouseAng;
    let len: number;
    if (tool === "line") {
      // nur Winkel getippt: Länge = Maus auf die Richtung projiziert (kann auch rückwärts gehen)
      len = hasA ? lock.a! : dx * Math.cos(ang) + dy * Math.sin(ang);
    } else {
      len = hasA ? lock.a! / 2 : Math.hypot(dx, dy);
    }
    return { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
  }

  // Rechteck, Ellipse, Langloch: Breite/Höhe, die Maus gibt nur die Richtung vor
  const k = fromCenter ? 0.5 : 1;
  const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
  return {
    x: from.x + (hasA ? sx * lock.a! * k : dx),
    y: from.y + (hasB ? sy * lock.b! * k : dy)
  };
}
