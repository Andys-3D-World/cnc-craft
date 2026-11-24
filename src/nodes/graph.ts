/**
 * KNOTENGRAPH – Rechen-Kern (ohne Oberfläche)
 *
 * Ein Graph besteht aus Knoten (Typ + Einstellungen + Platz im Editor) und Verbindungen
 * (Ausgang eines Knotens → Eingang eines anderen). Werte, die durch die Leitungen fließen:
 *   - "shapes": Liste von Formen (wie in app().shapes, Welt-Pixel)
 *   - "image":  eine Bild-Form (type "image" mit img-Einstellungen) oder null
 *   - "number": eine Zahl
 * Jeder Eingang hat höchstens eine Leitung, ein Ausgang beliebig viele. Kreise sind verboten.
 *
 * Gerechnet wird der Reihe nach (erst die Knoten, von denen ein anderer abhängt). Jeder Knoten merkt
 * sich sein Ergebnis zusammen mit einem Schlüssel aus Einstellungen + Eingangs-Schlüsseln – ändert sich
 * nichts davor, wird nicht neu gerechnet. Knoten verändern ihre Eingänge nie (immer erst kopieren).
 */

export type PortType = "shapes" | "image" | "number";

/** need = ohne Leitung an diesem Eingang kommt nichts Sinnvolles heraus (Hinweis am Knoten) */
export interface PortDef { name: string; type: PortType; need?: boolean }

/** data = nicht sichtbar (z. B. übernommene Formen), button = Knopf ohne eigenen Wert, text = freier Text */
export type ParamKind = "number" | "select" | "check" | "button" | "data" | "text";

/** längster Text in einer Text-Einstellung (auch aus fremden Dateien) */
export const MAX_TEXT = 400;

export interface ParamDef {
  key: string;
  kind: ParamKind;
  def: any;
  min?: number; max?: number; step?: number;
  /** feste Auswahl (Werte, Text über t("ng.p.<key>.<wert>")) oder dynamisch (fertiger Text) */
  options?: string[] | (() => { value: string; label: string }[]);
  /** Zahl lässt sich auch über einen Eingang (Typ number) setzen */
  port?: boolean;
  /** nur zeigen, wenn diese Bedingung zutrifft */
  when?: (p: Record<string, any>) => boolean;
  /** Beschriftung: Schlüssel für t() – fehlt er, gilt "ng.p.<key>" */
  label?: string;
}

export interface RunCtx {
  node: GraphNode;
  /** Hinweis am Knoten (Schlüssel für t()) */
  warn: (key: string, vars?: Record<string, any>) => void;
}

export interface NodeDef {
  type: string;
  cat: "source" | "gen" | "shape" | "image" | "number" | "output";
  icon: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  /** Quelle, die sich von außen ändern kann (Formen auf dem Bett): Schlüssel aus dem aktuellen Stand */
  sourceKey?: (p: Record<string, any>) => string;
  run: (inp: Record<string, any>, p: Record<string, any>, ctx: RunCtx) => Record<string, any> | Promise<Record<string, any>>;
}

export interface GraphNode { id: string; type: string; x: number; y: number; params: Record<string, any> }
export interface GraphLink { from: string; out: string; to: string; inp: string }
export interface Graph { nodes: GraphNode[]; links: GraphLink[] }

export interface NodeResult { key: string; out: Record<string, any>; warn?: { key: string; vars?: Record<string, any> }; error?: string; ms: number }

const defs = new Map<string, NodeDef>();
export function registerNode(d: NodeDef) { defs.set(d.type, d); }
export function nodeDef(type: string): NodeDef | undefined { return defs.get(type); }
export function allNodeDefs(): NodeDef[] { return [...defs.values()]; }

export function newNodeId(): string { return "n" + Math.random().toString(36).slice(2, 9); }

/** Neuer Knoten mit Standard-Einstellungen */
export function createNode(type: string, x: number, y: number): GraphNode | null {
  const d = defs.get(type);
  if (!d) return null;
  const params: Record<string, any> = {};
  for (const p of d.params) if (p.kind !== "button") params[p.key] = structuredClone(p.def);
  return { id: newNodeId(), type, x, y, params };
}

/** Eingänge eines Knotens: feste + Zahlen-Eingänge für Einstellungen mit port */
export function nodeInputs(d: NodeDef): PortDef[] {
  return [...d.inputs, ...d.params.filter(p => p.port).map(p => ({ name: p.key, type: "number" as PortType }))];
}

export function portType(g: Graph, nodeId: string, port: string, dir: "in" | "out"): PortType | null {
  const n = g.nodes.find(x => x.id === nodeId);
  const d = n && defs.get(n.type);
  if (!d) return null;
  const list = dir === "in" ? nodeInputs(d) : d.outputs;
  return list.find(p => p.name === port)?.type || null;
}

/** Würde die Leitung from → to einen Kreis schließen? (von to aus kommt man schon zu from) */
export function makesCycle(g: Graph, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const l of g.links) if (l.from === id) stack.push(l.to);
  }
  return false;
}

/** Leitung setzen (ersetzt eine alte am selben Eingang). false = Typ passt nicht oder Kreis */
export function connect(g: Graph, from: string, out: string, to: string, inp: string): boolean {
  const a = portType(g, from, out, "out"), b = portType(g, to, inp, "in");
  if (!a || a !== b || makesCycle(g, from, to)) return false;
  g.links = g.links.filter(l => !(l.to === to && l.inp === inp));
  g.links.push({ from, out, to, inp });
  return true;
}

/** Erster freier Eingang von `to`, der zum Ausgang passt (sonst der erste passende, auch wenn er belegt ist) */
export function fittingInput(g: Graph, from: string, out: string, to: string): string | null {
  const ty = portType(g, from, out, "out");
  const n = g.nodes.find(x => x.id === to);
  const d = n && defs.get(n.type);
  if (!ty || !d || makesCycle(g, from, to)) return null;
  const fits = nodeInputs(d).filter(p => p.type === ty);
  const free = fits.find(p => !g.links.some(l => l.to === to && l.inp === p.name));
  return (free || fits[0])?.name ?? null;
}

/**
 * Neuen Knoten hinter einen vorhandenen hängen: der erste Ausgang von `after`, zu dem der neue einen Eingang hat,
 * wird verbunden. Ging dieser Ausgang bisher an genau einen Knoten und gibt der neue denselben Typ wieder aus,
 * kommt der neue dazwischen (Quelle → neu → Rest). Der Knoten muss schon in g.nodes stehen.
 * Ergebnis: null = passt nicht, sonst { moved } = Knoten, der jetzt hinter dem neuen hängt (oder null).
 */
export function attachAfter(g: Graph, after: string, node: GraphNode): { moved: string | null } | null {
  const a = g.nodes.find(x => x.id === after);
  const da = a && defs.get(a.type), dn = defs.get(node.type);
  if (!a || !da || !dn || a.id === node.id) return null;
  for (const o of da.outputs) {
    // feste Eingänge zuerst – Zahlen-Eingänge der Einstellungen nur, wenn sonst nichts passt
    const inp = [...dn.inputs, ...nodeInputs(dn).slice(dn.inputs.length)].find(p => p.type === o.type);
    if (!inp) continue;
    const old = g.links.filter(l => l.from === a.id && l.out === o.name);
    if (!connect(g, a.id, o.name, node.id, inp.name)) continue;
    const back = dn.outputs.find(p => p.type === o.type);
    if (old.length === 1 && back) {
      const l = old[0];
      // connect ersetzt die alte Leitung am selben Eingang
      if (connect(g, node.id, back.name, l.to, l.inp)) return { moved: l.to };
    }
    return { moved: null };
  }
  return null;
}

/**
 * Neuen Knoten vor einen vorhandenen hängen: sein erster Ausgang geht an einen noch freien, passenden Eingang
 * von `before` (z. B. Rechteck → freier Eingang „Formen“ der Ausgabe).
 */
export function attachBefore(g: Graph, before: string, node: GraphNode): boolean {
  const b = g.nodes.find(x => x.id === before);
  const db = b && defs.get(b.type), dn = defs.get(node.type);
  if (!b || !db || !dn || b.id === node.id) return false;
  for (const o of dn.outputs) {
    const free = db.inputs.find(p => p.type === o.type && !g.links.some(l => l.to === b.id && l.inp === p.name));
    if (free && connect(g, node.id, o.name, b.id, free.name)) return true;
  }
  return false;
}

/** Alle Knoten, die (über Leitungen) hinter diesem hängen – der Knoten selbst zählt mit */
export function downstream(g: Graph, id: string): Set<string> {
  const seen = new Set<string>(), stack = [id];
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    for (const l of g.links) if (l.from === x) stack.push(l.to);
  }
  return seen;
}

/**
 * Eingänge, an denen noch eine Leitung fehlt: alle mit `need`, und der erste feste Eingang,
 * wenn an keinem festen Eingang etwas hängt. Leer = nichts zu melden.
 */
export function missingInputs(g: Graph, n: GraphNode): string[] {
  const d = defs.get(n.type);
  if (!d || !d.inputs.length) return [];
  const has = (name: string) => g.links.some(l => l.to === n.id && l.inp === name);
  const out = d.inputs.filter(p => p.need && !has(p.name)).map(p => p.name);
  if (!out.length && !d.inputs.some(p => has(p.name))) out.push(d.inputs[0].name);
  return out;
}

/** Kopie eines Knotens (ohne Leitungen), etwas versetzt */
export function cloneNode(n: GraphNode): GraphNode {
  return { ...n, params: paramsCopy(n), id: newNodeId(), x: n.x + 30, y: n.y + 30 };
}

/** Einstellungen kopieren; große übernommene Daten (kind "data") bleiben dieselbe Liste – sie werden nie verändert */
function paramsCopy(n: GraphNode): Record<string, any> {
  const d = defs.get(n.type), out: Record<string, any> = {};
  for (const [k, v] of Object.entries(n.params)) {
    out[k] = d?.params.find(p => p.key === k)?.kind === "data" ? v : v && typeof v === "object" ? structuredClone(v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------
// Rückgängig / Wiederholen
// ---------------------------------------------------------------------

type Snap = { nodes: GraphNode[]; links: GraphLink[] };
const snap = (g: Graph): Snap => ({ nodes: g.nodes.map(n => ({ ...n, params: paramsCopy(n) })), links: g.links.map(l => ({ ...l })) });

/**
 * Merkt sich Stände des Graphen. mark() VOR einer Änderung aufrufen; mit gleichem `tag` kurz hintereinander
 * (z. B. Tippen in einem Feld) zählt nur der erste Aufruf.
 */
export class GraphHistory {
  private undoList: Snap[] = [];
  private redoList: Snap[] = [];
  private lastTag = "";
  private lastAt = 0;
  private max: number;
  constructor(max = 60) { this.max = max; }

  mark(g: Graph, tag = "", now = Date.now()) {
    if (tag && tag === this.lastTag && now - this.lastAt < 1200) { this.lastAt = now; return; }
    this.lastTag = tag; this.lastAt = now;
    this.undoList.push(snap(g));
    if (this.undoList.length > this.max) this.undoList.shift();
    this.redoList = [];
  }
  canUndo() { return this.undoList.length > 0; }
  canRedo() { return this.redoList.length > 0; }
  undo(g: Graph): boolean { return this.swap(g, this.undoList, this.redoList); }
  redo(g: Graph): boolean { return this.swap(g, this.redoList, this.undoList); }

  private swap(g: Graph, from: Snap[], to: Snap[]): boolean {
    const s = from.pop();
    if (!s) return false;
    to.push(snap(g));
    g.nodes = s.nodes; g.links = s.links;
    this.lastTag = "";
    return true;
  }
}

export function removeNode(g: Graph, id: string) {
  g.nodes = g.nodes.filter(n => n.id !== id);
  g.links = g.links.filter(l => l.from !== id && l.to !== id);
}

/** Reihenfolge: jeder Knoten nach allen, von denen er abhängt */
export function order(g: Graph): GraphNode[] {
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const done = new Set<string>(), out: GraphNode[] = [];
  const visit = (id: string, path: Set<string>) => {
    if (done.has(id) || path.has(id)) return;
    path.add(id);
    for (const l of g.links) if (l.to === id) visit(l.from, path);
    path.delete(id);
    done.add(id);
    const n = byId.get(id);
    if (n) out.push(n);
  };
  for (const n of g.nodes) visit(n.id, new Set());
  return out;
}

/** Leerer Wert je Typ (offener Eingang) */
function empty(t: PortType): any { return t === "shapes" ? [] : t === "image" ? null : undefined; }

/**
 * Den ganzen Graphen rechnen. cache wird von Aufruf zu Aufruf weitergegeben (Knoten-ID → Ergebnis).
 * Ein Fehler in einem Knoten hält den Rest nicht auf – dahinter kommen dann leere Werte an.
 */
export async function evaluate(g: Graph, cache: Map<string, NodeResult>): Promise<Map<string, NodeResult>> {
  const res = new Map<string, NodeResult>();
  for (const n of order(g)) {
    const d = defs.get(n.type);
    if (!d) continue;
    const inp: Record<string, any> = {};
    const keys: string[] = [];
    for (const p of nodeInputs(d)) {
      const l = g.links.find(x => x.to === n.id && x.inp === p.name);
      const src = l && res.get(l.from);
      inp[p.name] = src && !src.error && l ? src.out[l.out] ?? empty(p.type) : empty(p.type);
      keys.push(src && l ? `${l.from}.${l.out}:${src.key}` : "-");
    }
    // Zahlen-Eingänge ersetzen die Einstellung
    const params = { ...n.params };
    for (const p of d.params) if (p.port && typeof inp[p.key] === "number" && Number.isFinite(inp[p.key])) params[p.key] = inp[p.key];
    const key = hash(JSON.stringify([n.type, params, keys, d.sourceKey ? d.sourceKey(params) : ""]));
    const old = cache.get(n.id);
    if (old && old.key === key) { res.set(n.id, old); continue; }
    let warn: NodeResult["warn"];
    const t0 = performance.now();
    try {
      const out = await d.run(inp, params, { node: n, warn: (k, v) => { warn = { key: k, vars: v }; } });
      res.set(n.id, { key, out, warn, ms: performance.now() - t0 });
    } catch (e: any) {
      res.set(n.id, { key, out: {}, error: String(e?.message || e), ms: performance.now() - t0 });
    }
  }
  cache.clear();
  for (const [k, v] of res) cache.set(k, v);
  return res;
}

/** Kurzer Schlüssel aus einem langen Text (FNV-1a, zwei Varianten für weniger Zufallstreffer) */
export function hash(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/** Gespeicherten Graphen prüfen (unbekannte Knoten und kaputte Leitungen fallen weg) */
export function sanitizeGraph(x: any): Graph {
  const g: Graph = { nodes: [], links: [] };
  if (!x || typeof x !== "object") return g;
  for (const n of Array.isArray(x.nodes) ? x.nodes : []) {
    const d = n && typeof n.type === "string" && defs.get(n.type);
    if (!d || typeof n.id !== "string" || !/^[\w-]{1,40}$/.test(n.id) || g.nodes.some(q => q.id === n.id)) continue;
    const params: Record<string, any> = {};
    for (const p of d.params) {
      if (p.kind === "button") continue;
      const v = n.params?.[p.key];
      if (p.kind === "number") params[p.key] = Number.isFinite(+v) && v !== null && v !== "" ? +v : p.def;
      else if (p.kind === "check") params[p.key] = typeof v === "boolean" ? v : p.def;
      else if (p.kind === "text") params[p.key] = typeof v === "string" ? v.slice(0, MAX_TEXT) : p.def;
      else params[p.key] = v !== undefined && typeof v === typeof p.def ? structuredClone(v) : structuredClone(p.def);
    }
    g.nodes.push({ id: n.id, type: n.type, x: +n.x || 0, y: +n.y || 0, params });
  }
  for (const l of Array.isArray(x.links) ? x.links : []) {
    if (l && typeof l.from === "string" && typeof l.to === "string" && typeof l.out === "string" && typeof l.inp === "string") {
      connect(g, l.from, l.out, l.to, l.inp);
    }
  }
  return g;
}
