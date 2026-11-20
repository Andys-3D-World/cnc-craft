/**
 * EINHEITEN: Millimeter oder Zoll – nur für die Anzeige und die Eingabe.
 *
 * Im Programm ist und bleibt alles Millimeter: Formen, Projektdateien, CAM, G-Code (G21), Jog-Befehle,
 * Maschinen-Einstellungen. Umgerechnet wird nur ganz außen, wenn eine Zahl gezeigt oder getippt wird.
 * Diese Datei ist die einzige Stelle, die rechnet (keine Oberfläche, deshalb mit `npm test` prüfbar).
 *
 * Grundregel: Zahl und Einheit werden immer zusammen umgestellt – oder gar nicht. Was nicht umgestellt wird,
 * bleibt in mm und es steht auch „mm“ dran. Nie „in“ neben einer Millimeter-Zahl.
 *
 *  fmtLen(12.7)            -> "12.70" / "0.5000"         nur die Zahl
 *  fmtLenU(12.7)           -> "12.70 mm" / "0.5000 in"   Zahl mit Einheit
 *  fmtFeed(1000)           -> "1000 mm/min" / "39.37 in/min"
 *  parseLen("1 1/2")       -> 38.1 (mm), auch "0.25in", "6mm", "1/4", "0,5"
 *  unitName("mm/min")      -> "mm/min" / "in/min"
 */
export type Unit = "mm" | "in";
/** Was für eine Größe: Länge, Vorschub oder Geschwindigkeit. Alle rechnen mit 25,4 */
export type UnitKind = "mm" | "mm/min" | "mm/s";

export const MM_PER_IN = 25.4;
export const UNIT_KINDS: UnitKind[] = ["mm", "mm/min", "mm/s"];

let unit: Unit = "mm";
const listeners = new Set<(u: Unit) => void>();

export function getUnit(): Unit { return unit; }
export function isInch(): boolean { return unit === "in"; }

/** Einheit wechseln (nur merken und Bescheid sagen – gespeichert wird in unitSetting.ts) */
export function setUnit(u: Unit) {
  const next: Unit = u === "in" ? "in" : "mm";
  if (next === unit) return;
  unit = next;
  for (const fn of Array.from(listeners)) fn(unit);
}

export function onUnitChange(fn: (u: Unit) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Name der Einheit zum Anzeigen: "mm" -> "in", "mm/min" -> "in/min", "mm/s" -> "in/s" */
export function unitName(kind: UnitKind = "mm", u: Unit = unit): string {
  return u === "in" ? "in" + kind.slice(2) : kind;
}

/** Auf 6 Stellen runden: nimmt das Rauschen der Rechnung weg (0,1 in = 2,54 mm, nicht 2,5399999) */
function round6(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** mm -> Zahl in der gewählten Einheit */
export function toDisplay(mm: number, u: Unit = unit): number {
  return u === "in" ? mm / MM_PER_IN : mm;
}

/** Zahl in der gewählten Einheit -> mm */
export function fromDisplay(v: number, u: Unit = unit): number {
  return u === "in" ? round6(v * MM_PER_IN) : v;
}

/** Zoll braucht zwei Stellen mehr als mm, um gleich genau zu sein (0,01 mm ≈ 0,0004 in) */
export function inchDecimals(mmDecimals: number): number {
  return Math.max(0, Math.min(5, Math.round(mmDecimals) + 2));
}

/** Länge als Zahl: decimals gilt für mm, Zoll bekommt automatisch zwei Stellen mehr */
export function fmtLen(mm: number, decimals = 2, u: Unit = unit): string {
  if (!Number.isFinite(mm)) return String(mm);
  return u === "in" ? (mm / MM_PER_IN).toFixed(inchDecimals(decimals)) : mm.toFixed(decimals);
}

/** Wie fmtLen, aber ohne überflüssige Nullen am Ende ("12.5" statt "12.50") */
export function fmtLenShort(mm: number, decimals = 2, u: Unit = unit): string {
  if (!Number.isFinite(mm)) return String(mm);
  return String(Number(fmtLen(mm, decimals, u)));
}

/** Länge mit Einheit: "12.70 mm" / "0.5000 in" */
export function fmtLenU(mm: number, decimals = 2, u: Unit = unit): string {
  return `${fmtLen(mm, decimals, u)} ${unitName("mm", u)}`;
}

/** Durchmesser für Listen: "Ø3" wie bisher, bei Zoll mit Einheit "Ø0.125 in" (sonst wäre unklar, was gemeint ist) */
export function fmtDia(mm: number, u: Unit = unit): string {
  return u === "in" ? `Ø${fmtLenShort(mm, 2, u)} in` : `Ø${String(Math.round(mm * 100) / 100)}`;
}

/** Lange Strecke: "12.34 m" / "40.49 ft" */
export function fmtLong(mm: number, u: Unit = unit): string {
  return u === "in" ? `${(mm / 304.8).toFixed(2)} ft` : `${(mm / 1000).toFixed(2)} m`;
}

/** Vorschub mit Einheit: "1000 mm/min" / "39.37 in/min" */
export function fmtFeed(mmPerMin: number, decimals = 0, u: Unit = unit): string {
  return `${fmtLen(mmPerMin, decimals, u)} ${unitName("mm/min", u)}`;
}

/** Geschwindigkeit mit Einheit: "100 mm/s" / "3.94 in/s" */
export function fmtSpeed(mmPerSec: number, decimals = 0, u: Unit = unit): string {
  return `${fmtLen(mmPerSec, decimals, u)} ${unitName("mm/s", u)}`;
}

const NUM = String.raw`(?:\d+(?:[.,]\d*)?|[.,]\d+)`;
const RE_PLAIN = new RegExp(`^([+-]?)(${NUM})$`);
const RE_FRAC = new RegExp(`^([+-]?)(?:(\\d+)[ -]+)?(\\d+)\\s*/\\s*(\\d+)$`);
const RE_SUFFIX = /\s*(mm|cm|inch|in|zoll|"|″|'')$/i;

function num(s: string): number {
  return Number(s.replace(",", "."));
}

/**
 * Getippte Länge lesen -> Millimeter (NaN, wenn es keine Zahl ist).
 * Ohne Angabe gilt die gewählte Einheit. Verstanden wird:
 *   12.5   12,5   -3   .5        Zahl mit Punkt oder Komma
 *   1/4    1 1/2  1-1/2          Brüche (praktisch bei Zoll)
 *   0.25in 0.25"  6mm  2cm       Einheit dahinter gewinnt immer
 */
export function parseLen(text: string, u: Unit = unit): number {
  let s = String(text ?? "").trim();
  if (!s) return NaN;
  let factor = u === "in" ? MM_PER_IN : 1;
  const m = RE_SUFFIX.exec(s);
  if (m) {
    const k = m[1].toLowerCase();
    factor = k === "mm" ? 1 : k === "cm" ? 10 : MM_PER_IN;
    s = s.slice(0, m.index).trim();
  }
  let v = NaN;
  const p = RE_PLAIN.exec(s);
  if (p) v = num(p[2]) * (p[1] === "-" ? -1 : 1);
  else {
    const f = RE_FRAC.exec(s);
    if (f && Number(f[4]) > 0) v = (Number(f[2] || 0) + Number(f[3]) / Number(f[4])) * (f[1] === "-" ? -1 : 1);
  }
  if (!Number.isFinite(v)) return NaN;
  return factor === 1 ? v : round6(v * factor);
}

/** Millimeter als Text, wie ihn die Felder speichern: kurz, mit Punkt, ohne Exponent */
export function mmText(mm: number): string {
  return Number.isFinite(mm) ? String(round6(mm)) : "";
}

/** Stellen, mit denen ein Feld Zoll zeigt (0,0001 in = 0,0025 mm) */
export const FIELD_INCH_DECIMALS = 4;

/**
 * Inhalt eines Millimeter-Feldes -> Text, der angezeigt wird.
 * Leer bleibt leer; was keine Zahl ist, bleibt, wie es ist.
 */
export function mmToField(mmStr: string, u: Unit = unit): string {
  if (u !== "in") return mmStr;
  const s = String(mmStr ?? "").trim();
  if (!s) return "";
  const v = Number(s);
  if (!Number.isFinite(v)) return mmStr;
  return String(Number((v / MM_PER_IN).toFixed(FIELD_INCH_DECIMALS)));
}

/** Getippter Feld-Text -> Millimeter als Text ("" = ungültig, wie bei einem leeren Zahlenfeld) */
export function fieldToMm(text: string, u: Unit = unit): string {
  return mmText(parseLen(text, u));
}

/**
 * Schrittweite der Pfeiltasten: aus dem mm-Schritt wird ein runder Zoll-Schritt
 * (1 mm -> 0.05 in, 0.5 -> 0.025, 0.1 -> 0.005, 10 -> 0.5, 100 -> 5).
 */
export function inchStep(stepMm: number): number {
  const want = (stepMm > 0 && Number.isFinite(stepMm) ? stepMm : 1) / MM_PER_IN * 1.3;
  let best = 0.0001;
  for (let e = -4; e <= 4; e++) for (const m of [1, 2.5, 5]) {
    const c = m * Math.pow(10, e);
    if (c <= want && c > best) best = c;
  }
  return Number(best.toPrecision(3));
}

/** Wert der GRBL-Einstellung $13: 1 = die Steuerung meldet in Zoll (CNC Craft braucht mm, also $13=0) */
export function reportsInches(value: string | undefined | null): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "" && Number(value) === 1;
}

/**
 * Schrittweiten der Jog-Knöpfe – immer in Millimetern, denn nur mm gehen zur Maschine ($J=G21 …).
 * mm: 0,1 / 1 / 10 / 100 mm.  Zoll: 0.001 / 0.01 / 0.1 / 1 in (= 0,0254 / 0,254 / 2,54 / 25,4 mm).
 */
export function jogStepsMm(u: Unit = unit): number[] {
  return u === "in" ? [0.0254, 0.254, 2.54, 25.4] : [0.1, 1, 10, 100];
}

/**
 * Welcher Jog-Knopf nach dem Umschalten der Einheit gewählt ist: der größte Schritt, der nicht größer ist als der
 * bisherige (1 in = 25,4 mm -> 10 mm, nicht 100 mm). So macht das Umschalten nie unbemerkt einen größeren Sprung.
 * Gibt es keinen kleineren, bleibt nur der kleinste.
 */
export function jogStepIndex(prevMm: number, u: Unit = unit): number {
  const steps = jogStepsMm(u);
  let idx = 0;
  steps.forEach((s, i) => { if (s <= prevMm + 1e-9) idx = i; });
  return idx;
}

/** Beschriftung der Jog-Knöpfe (wie bisher: nur zwei tragen die Einheit, damit es in die Zeile passt) */
export function jogStepLabels(u: Unit = unit): string[] {
  return u === "in" ? ["0.001", "0.01", "0.1in", "1in"] : ["0.1", "1mm", "10mm", "100"];
}

/**
 * Für HTML-Vorlagen: das Zahlenfeld in diesem Stück als Länge markieren (data-unit), wenn die Beschriftung keine
 * Einheit nennt. Mit "(mm)" in der Beschriftung ist das nicht nötig – dann erkennt unitFields.ts das Feld selbst.
 */
export function asLength(html: string, kind: UnitKind = "mm"): string {
  return html.replace(/<input /g, `<input data-unit="${kind}" `);
}

/* ---------------------------------------------------------------- Texte */

/** Nachkommastellen einer Zahl, wie sie geschrieben wurde ("12,50" -> 2) */
function decimalsOf(s: string): number {
  const i = s.search(/[.,]/);
  return i < 0 ? 0 : s.length - i - 1;
}

/** Eine fertig formatierte mm-Zahl ("600", "12,5") nach Zoll – oder null, wenn es keine schlichte Zahl ist */
export function convertNumberText(value: string | number): string | null {
  const s = String(value).trim();
  if (!/^[+\-−]?\d+(?:[.,]\d+)?$/.test(s)) return null;
  const v = Number(s.replace("−", "-").replace(",", "."));
  if (!Number.isFinite(v)) return null;
  // zwei Stellen mehr als in mm, aber mindestens drei gültige Ziffern (3 mm -> 0.118, nicht 0.12)
  const inch = v / MM_PER_IN;
  let d = inchDecimals(decimalsOf(s));
  if (inch !== 0) d = Math.max(d, Math.min(5, 2 - Math.floor(Math.log10(Math.abs(inch)))));
  const out = String(Number(inch.toFixed(d)));
  return s.includes(",") ? out.replace(".", ",") : out;
}

// Ein Glied: Platzhalter, davor höchstens ein kurzes Zeichen wie "X ", "Ø", "⌀ "
const PART = String.raw`(?:[A-Za-zØ⌀]{1,2}\s*)?\{\w+\}`;
// Zwischen den Gliedern: "×", " x ", Bereich mit "–"/"-" oder "…"
const SEP = String.raw`(?:\s*×\s*|\s+x\s+|\s*…\s*|[–-])`;
// Einheit dahinter: "mm", "mm/min", "mm/s" oder "mm/<Wort>" (pro Durchgang, pro Zahn …) – nicht mm², mm/s², mmHg
const RE_GROUP = new RegExp(`(${PART}(?:${SEP}${PART})*)(\\s*)mm(\\/[A-Za-zÀ-ÿ]+)?(?![\\w²³/])`, "g");

/**
 * Meldungs-Vorlage für die gewählte Einheit umstellen: "{w} × {h} mm" -> "23.62 × 15.75 in".
 * Umgestellt wird nur, wo Platzhalter direkt vor der Einheit stehen und alle Werte schlichte Zahlen sind –
 * sonst bleibt die ganze Stelle in mm. Feste Zahlen im Text ("z. B. 0,2 mm") bleiben immer in mm.
 * Die umgestellten Platzhalter sind danach schon eingesetzt, der Rest bleibt für t().
 */
export function unitTemplate(tpl: string, params: Record<string, string | number> | undefined, u: Unit = unit): string {
  if (u !== "in" || !params || tpl.indexOf("mm") < 0) return tpl;
  return tpl.replace(RE_GROUP, (all: string, group: string, gap: string, suffix: string | undefined, at: number) => {
    // Die Kette geht links weiter mit etwas, das wir nicht verstehen ("… × {z} mm"): lieber nichts umstellen
    const before = tpl.slice(0, at);
    if (/×\s*$/.test(before) || /[}\d][–-]$/.test(before)) return all;
    const names = Array.from(group.matchAll(/\{(\w+)\}/g)).map(m => m[1]);
    const conv: Record<string, string> = {};
    for (const n of names) {
      if (!(n in params)) return all;
      const c = convertNumberText(params[n]);
      if (c === null) return all;
      conv[n] = c;
    }
    return group.replace(/\{(\w+)\}/g, (_m, n: string) => conv[n]) + gap + "in" + (suffix || "");
  });
}

/**
 * Einheit in einer Beschriftung umstellen: "Breite (mm)" -> "Breite (in)", "mm/min" -> "in/min".
 * Nur Einheiten ohne Zahl davor – feste Werte im Text bleiben, wie sie sind.
 * Gibt null zurück, wenn im Text keine Einheit steht.
 */
export function unitLabel(text: string, u: Unit = unit): string | null {
  const whole = /^(\s*)mm(\/min|\/s)?(\s*)$/.exec(text);
  if (whole) return u === "in" ? `${whole[1]}in${whole[2] || ""}${whole[3]}` : text;
  if (!/[(\[]mm(\/min|\/s)?(?=[)\],;])/.test(text)) return null;
  if (u !== "in") return text;
  return text.replace(/([(\[])mm(\/min|\/s)?(?=[)\],;])/g, (_m, open: string, suffix: string | undefined) => `${open}in${suffix || ""}`);
}

/** Welche Größe eine Beschriftung nennt ("(mm/min)" -> "mm/min"); null = keine oder mehrere verschiedene */
export function labelKind(text: string): UnitKind | null {
  const found = new Set<UnitKind>();
  const whole = /^\s*mm(\/min|\/s)?\s*$/.exec(text);
  if (whole) found.add(("mm" + (whole[1] || "")) as UnitKind);
  for (const m of text.matchAll(/[(\[]mm(\/min|\/s)?(?=[)\],;])/g)) found.add(("mm" + (m[1] || "")) as UnitKind);
  return found.size === 1 ? Array.from(found)[0] : null;
}
