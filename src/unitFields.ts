/**
 * ZAHLENFELDER IN ZOLL
 *
 * Alle Felder im Programm rechnen in Millimetern, und das bleibt so. Ist Zoll gewählt, setzt sich diese Schicht
 * vor die Längen-Felder: Du siehst und tippst Zoll, der übrige Code liest und schreibt über `feld.value` weiter
 * Millimeter. So muss keine der vielen Stellen selbst umrechnen – und es kann keine vergessen, zurückzurechnen.
 *
 * Im mm-Modus ist die Schicht komplett aus: kein Feld wird angefasst, nichts wird beobachtet.
 *
 * Welche Felder?
 *   - `data-unit="mm"` / `"mm/min"` / `"mm/s"` am Feld: ausdrücklich eine Länge / ein Vorschub / eine Geschwindigkeit
 *   - ohne Angabe: ein Zahlenfeld, in dessen Zeile (label, .prop-row, .dlg-row, .te-row, .dlg-num) genau eine
 *     Einheit steht – "(mm)", "(mm/min)" oder ein eigenes Element mit nur "mm" – und sonst kein Zahlenfeld
 *   - `data-unit="none"`: ausdrücklich keine Länge (Anzahl, Winkel, Prozent …)
 *   - `data-unit-scope="none"` an einem Bereich: dort wird nichts umgestellt (z. B. die $$-Liste der Steuerung)
 *
 * Sicherheitsregel: Feld und Beschriftung werden zusammen umgestellt oder gar nicht. Steht in der Zeile eine Einheit,
 * die nicht mit umgestellt werden kann (weil dort noch ein anderes Zahlenfeld steht), bleibt das Feld in mm.
 *
 * Genauigkeit: der mm-Wert bleibt unverändert im Feld gespeichert, angezeigt wird er mit 4 Stellen in Zoll.
 * Hin- und Herschalten ändert deshalb nichts. Getippt werden kann auch "1/4", "1 1/2", "0.25in" oder "6mm".
 */
import {
  getUnit, onUnitChange, mmToField, fieldToMm, mmText, inchStep, unitLabel, labelKind, MM_PER_IN, UNIT_KINDS, type UnitKind
} from "./units";

const ROW = "label, .prop-row, .dlg-row, .te-row, .dlg-num";
const SKIP_TEXT = new Set(["SELECT", "OPTION", "TEXTAREA", "SCRIPT", "STYLE", "INPUT", "BUTTON"]);
/** So nah dran gilt ein zurückgeschriebener Wert als „derselbe, nur gerundet“ (0,005 mm ≈ 0,0002 in) */
const ECHO_MM = 0.00501;

interface Bound {
  kind: UnitKind;
  type: string;
  inputMode: string | null;
  placeholder: string | null;
  /** was der Code zuletzt hineingeschrieben hat (mm) und was dafür im Feld steht */
  lastMm: string;
  lastShown: string;
  /** was zuletzt getippt wurde: mm-Wert und der Text dazu (damit ein gerundetes Zurückschreiben die Eingabe nicht verändert) */
  userMm: number | null;
  userShown: string;
  onKey: (e: KeyboardEvent) => void;
  onBlur: () => void;
}

const nativeValue = typeof HTMLInputElement !== "undefined" ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") : undefined;
const rawGet = (el: HTMLInputElement): string => nativeValue!.get!.call(el);
const rawSet = (el: HTMLInputElement, v: string) => nativeValue!.set!.call(el, v);

/** Sehr alte Systeme kennen WeakRef nicht: dann einfach fest merken (nur im Zoll-Modus) */
interface Ref<T extends object> { deref(): T | undefined }
const ref = <T extends object>(v: T): Ref<T> => typeof WeakRef !== "undefined" ? new WeakRef(v) : { deref: () => v };

/** Die äußerste Zeile, in der ein Element steht (Beschriftung + Feld + Einheit) */
function rowOf(el: Element | null): HTMLElement | null {
  let row: HTMLElement | null = null;
  for (let r = el?.closest<HTMLElement>(ROW) || null; r; r = r.parentElement?.closest<HTMLElement>(ROW) || null) row = r;
  return row;
}

const bound = new WeakMap<HTMLInputElement, Bound>();
const labels = new WeakMap<Text, { orig: string; conv: string }>();
/** Zum Zurückstellen: alles, was gerade umgestellt ist (schwach gemerkt, damit geschlossene Fenster verschwinden können) */
let inputs: Ref<HTMLInputElement>[] = [];
let texts: Ref<Text>[] = [];
let observer: MutationObserver | null = null;
let on = false;

function kindOf(v: string | null | undefined): UnitKind | null {
  return v && (UNIT_KINDS as string[]).includes(v) ? (v as UnitKind) : null;
}

/** Zahlenfelder in einem Bereich, die als Länge zählen könnten (ohne die ausdrücklich ausgenommenen) */
function numberInputs(scope: Element): HTMLInputElement[] {
  return Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="number"], input[data-unit-on]'))
    .filter(i => i.getAttribute("data-unit") !== "none");
}

function textNodes(scope: Element): Text[] {
  const out: Text[] = [];
  const walk = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const p = (n as Text).parentElement;
    if (p && !SKIP_TEXT.has(p.tagName) && !p.closest("select, textarea")) out.push(n as Text);
  }
  return out;
}

/** Text einer Beschriftung, wie er in mm hieß (auch wenn er gerade umgestellt ist) */
function origText(n: Text): string {
  const l = labels.get(n);
  return l && l.conv === n.data ? l.orig : n.data;
}

/** Einheiten, die in einem Bereich stehen */
function kindsIn(scope: Element): Set<UnitKind> {
  const found = new Set<UnitKind>();
  for (const n of textNodes(scope)) {
    const txt = origText(n);
    if (txt.indexOf("mm") < 0) continue;
    const k = labelKind(txt);
    if (k) found.add(k);
    else if (unitLabel(txt, "in") !== null) { found.add("mm"); found.add("mm/min"); } // mehrere verschiedene in einem Text
  }
  return found;
}

/** Wird dieses Feld umgestellt? Gibt die Größe zurück oder null */
function decide(el: HTMLInputElement): UnitKind | null {
  if (el.closest('[data-unit-scope="none"]')) return null;
  const tag = el.getAttribute("data-unit");
  if (tag === "none") return null;
  const explicit = kindOf(tag);
  if (!explicit && el.type !== "number") return null;
  const row = rowOf(el);
  if (!row) return explicit;
  // andere Zahlenfelder in der Zeile, die nicht selbst als Länge markiert sind
  const strangers = numberInputs(row).filter(i => i !== el && !kindOf(i.getAttribute("data-unit")) && !bound.has(i));
  const kinds = kindsIn(row);
  if (explicit) {
    // Steht eine Einheit in der Zeile, die wegen eines fremden Feldes nicht mit umgestellt werden darf: Feld bleibt mm
    if (strangers.length && kinds.size) return null;
    return explicit;
  }
  if (strangers.length || kinds.size !== 1) return null;
  return Array.from(kinds)[0];
}

/** Einheiten in der Zeile eines Feldes umstellen ("(mm)" -> "(in)") – nur wenn alle Zahlenfelder der Zeile umgestellt sind */
function convertRow(row: Element) {
  if (numberInputs(row).some(i => !bound.has(i))) return;
  row.setAttribute("data-unit-row", "in");
  // Hinweis-Texte der Zeile: "(mm)" ohne Zahl davor mit umstellen (das Original bleibt in data-tip-mm)
  for (const el of [row, ...Array.from(row.querySelectorAll("[data-tip]"))]) {
    const tip = el.getAttribute("data-tip");
    const conv = tip && tip.indexOf("mm") >= 0 ? unitLabel(tip, "in") : null;
    if (conv !== null && conv !== tip) { el.setAttribute("data-tip-mm", tip!); el.setAttribute("data-tip", conv); }
  }
  for (const n of textNodes(row)) {
    const known = labels.get(n);
    if (known && known.conv === n.data) continue;
    const conv = unitLabel(n.data, "in");
    if (conv === null || conv === n.data) continue;
    labels.set(n, { orig: n.data, conv });
    texts.push(ref(n));
    n.data = conv;
  }
}

function bind(el: HTMLInputElement, kind: UnitKind) {
  const mm = rawGet(el);
  const st: Bound = {
    kind, type: el.type, inputMode: el.getAttribute("inputmode"), placeholder: el.getAttribute("placeholder"),
    lastMm: mm, lastShown: mmToField(mm, "in"), userMm: null, userShown: "",
    onKey: e => stepKey(el, st, e),
    onBlur: () => { if (rawGet(el) !== st.lastShown && rawGet(el).trim() !== "" && fieldToMm(rawGet(el), "in") === "") rawSet(el, st.lastShown); },
  };
  el.type = "text";
  el.setAttribute("inputmode", "decimal");
  el.setAttribute("data-unit-on", kind);
  rawSet(el, st.lastShown);
  // gerade geöffnetes, markiertes Feld (z. B. Maß bearbeiten): wieder alles markieren
  if (document.activeElement === el) el.select();
  if (st.placeholder) {
    const ph = unitLabel(st.placeholder, "in") ?? (/^-?\d+(?:\.\d+)?$/.test(st.placeholder.trim()) ? mmToField(st.placeholder.trim(), "in") : null);
    if (ph !== null) el.setAttribute("placeholder", ph);
  }
  Object.defineProperty(el, "value", {
    configurable: true, enumerable: true,
    get() {
      const raw = rawGet(el);
      if (raw === st.lastShown) return st.lastMm;
      const typed = fieldToMm(raw, "in");
      if (typed !== "") { st.userMm = Number(typed); st.userShown = raw; }
      return typed;
    },
    set(v: unknown) {
      const s = v === null || v === undefined ? "" : String(v);
      const n = s.trim() === "" ? NaN : Number(s);
      st.lastMm = s;
      // Der Code schreibt das Getippte gerundet zurück (z. B. "8.47" für 8,46582): die Eingabe bleibt stehen
      if (st.userMm !== null && Number.isFinite(n) && Math.abs(n - st.userMm) <= ECHO_MM) st.lastShown = st.userShown;
      else { st.userMm = null; st.lastShown = mmToField(s, "in"); }
      rawSet(el, st.lastShown);
    },
  });
  Object.defineProperty(el, "valueAsNumber", {
    configurable: true, enumerable: true,
    get() { const v = el.value; return v === "" ? NaN : Number(v); },
    set(n: number) { el.value = Number.isFinite(n) ? String(n) : ""; },
  });
  el.addEventListener("keydown", st.onKey);
  el.addEventListener("blur", st.onBlur);
  bound.set(el, st);
  inputs.push(ref(el));
}

function unbind(el: HTMLInputElement) {
  const st = bound.get(el);
  if (!st) return;
  const raw = rawGet(el);
  const mm = raw === st.lastShown ? st.lastMm : (fieldToMm(raw, "in") || st.lastMm);
  delete (el as any).value;
  delete (el as any).valueAsNumber;
  el.removeEventListener("keydown", st.onKey);
  el.removeEventListener("blur", st.onBlur);
  el.type = st.type;
  if (st.inputMode === null) el.removeAttribute("inputmode"); else el.setAttribute("inputmode", st.inputMode);
  if (st.placeholder === null) el.removeAttribute("placeholder"); else el.setAttribute("placeholder", st.placeholder);
  el.removeAttribute("data-unit-on");
  rawSet(el, mm);
  bound.delete(el);
}

/** Pfeil hoch/runter wie bei einem Zahlenfeld, aber in runden Zoll-Schritten (Umschalt = 10-fach) */
function stepKey(el: HTMLInputElement, st: Bound, e: KeyboardEvent) {
  if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.altKey || e.ctrlKey || e.metaKey || el.readOnly || el.disabled) return;
  const attr = (name: string) => { const v = parseFloat(el.getAttribute(name) || ""); return Number.isFinite(v) ? v : NaN; };
  const step = inchStep(attr("step")) * (e.shiftKey ? 10 : 1);
  const cur = Number(el.value);
  const k = (Number.isFinite(cur) ? cur : 0) / MM_PER_IN / step;
  const next = e.key === "ArrowUp" ? Math.floor(k + 1e-6) + 1 : Math.ceil(k - 1e-6) - 1;
  let mm = Number((next * step).toFixed(6)) * MM_PER_IN;
  const min = attr("min"), max = attr("max");
  if (Number.isFinite(max)) mm = Math.min(max, mm);
  if (Number.isFinite(min)) mm = Math.max(min, mm);
  e.preventDefault();
  st.userMm = null;
  el.value = mmText(mm);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function tryBind(el: HTMLInputElement) {
  if (bound.has(el)) return;
  const kind = decide(el);
  if (!kind) return;
  bind(el, kind);
  const row = rowOf(el);
  if (row) convertRow(row);
}

function scan(root: ParentNode) {
  if (root instanceof HTMLInputElement) { tryBind(root); return; }
  root.querySelectorAll<HTMLInputElement>('input[type="number"], input[data-unit]').forEach(tryBind);
}

function refresh(records: MutationRecord[]) {
  const roots = new Set<Element>(), rows = new Set<Element>();
  for (const m of records) {
    const target = m.target.nodeType === 1 ? (m.target as Element) : m.target.parentElement;
    if (m.type === "childList") m.addedNodes.forEach(n => { if (n.nodeType === 1) roots.add(n as Element); });
    const row = rowOf(target);
    if (row) rows.add(row);
  }
  roots.forEach(scan);
  // Beschriftung neu gesetzt (z. B. Sprache gewechselt): wieder umstellen; und Felder, deren Beschriftung erst jetzt da ist
  rows.forEach(row => {
    row.querySelectorAll<HTMLInputElement>('input[type="number"], input[data-unit]').forEach(tryBind);
    if (row.hasAttribute("data-unit-row") || numberInputs(row).some(i => bound.has(i))) convertRow(row);
  });
}

function enable() {
  if (on || typeof document === "undefined" || !nativeValue) return;
  on = true;
  scan(document);
  observer = new MutationObserver(refresh);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-tip"] });
}

function disable() {
  if (!on) return;
  on = false;
  observer?.disconnect();
  observer = null;
  for (const r of inputs) { const el = r.deref(); if (el) unbind(el); }
  for (const r of texts) {
    const n = r.deref(), l = n && labels.get(n);
    if (n && l) { if (n.data === l.conv) n.data = l.orig; labels.delete(n); }
  }
  inputs = [];
  texts = [];
  document.querySelectorAll("[data-unit-row]").forEach(e => e.removeAttribute("data-unit-row"));
  document.querySelectorAll("[data-tip-mm]").forEach(e => {
    // nur zurückstellen, wenn der Hinweis seither nicht neu gesetzt wurde (Sprachwechsel)
    if (unitLabel(e.getAttribute("data-tip-mm")!, "in") === e.getAttribute("data-tip")) e.setAttribute("data-tip", e.getAttribute("data-tip-mm")!);
    e.removeAttribute("data-tip-mm");
  });
}

/** Einmal beim Start aufrufen: stellt die Felder um, sobald Zoll gewählt ist */
export function initUnitFields() {
  onUnitChange(u => { if (u === "in") enable(); else disable(); });
  if (getUnit() === "in") enable();
  // tote Merker ab und zu wegräumen (nur im Zoll-Modus gibt es welche)
  setInterval(() => {
    if (!on) return;
    inputs = inputs.filter(r => r.deref());
    texts = texts.filter(r => r.deref());
  }, 60000);
}

/**
 * Prüfhilfe: alle sichtbaren Zahlenfelder mit ihrem Zustand – zum Nachsehen, welche Felder (noch) in mm sind.
 * converted = zeigt Zoll, unit = Einheit laut Beschriftung der Zeile.
 */
export function unitAudit(root: ParentNode = document): { id: string; converted: boolean; kind: string; row: string; shown: string; mm: string }[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input[type="number"], input[data-unit-on]')).map(el => {
    const row = rowOf(el) || el.parentElement;
    return {
      id: el.id || el.name || el.className, converted: bound.has(el), kind: bound.get(el)?.kind || el.getAttribute("data-unit") || "",
      row: (row?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70), shown: rawGet(el), mm: el.value,
    };
  });
}
