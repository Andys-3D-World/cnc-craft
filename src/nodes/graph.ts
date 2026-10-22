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

export interface PortDef { name: string; type: PortType }

/** data = nicht sichtbar (z. B. übernommene Formen), button = Knopf ohne eigenen Wert */
export type ParamKind = "number" | "select" | "check" | "button" | "data";

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
}

export interface RunCtx {
  node: GraphNode;
  /** Hinweis am Knoten (Schlüssel für t()) */
  warn: (key: string, vars?: Record<string, any>) => void;
}

export interface NodeDef {
  type: string;
  cat: "source" | "shape" | "image" | "number" | "output";
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
