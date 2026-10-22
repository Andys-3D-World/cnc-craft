/**
 * KNOTENGRAPH SPEICHERN: der aktuelle Graph (gehört zum Projekt), eigene Vorlagen und Vorlagen-Dateien
 *
 *  - Projekt (.cncc): Feld `nodeGraph` – mit den übernommenen Formen der Quell-Knoten
 *  - zwischendurch: localStorage cnc_craft_nodegraph (bleibt bis zum nächsten Öffnen/Neustart)
 *  - Vorlagen (eigene in localStorage cnc_craft_nodegraph_tpl, Dateien *.cncgraph): nur der Ablauf –
 *    übernommene Formen werden weggelassen, damit Vorlagen klein bleiben und zu jedem Motiv passen
 */
import { Graph, connect, createNode, sanitizeGraph } from "./graph";
import { registerAllNodes } from "./nodeDefs";

const KEY = "cnc_craft_nodegraph";
const TPL_KEY = "cnc_craft_nodegraph_tpl";
export const GRAPH_FILE_FORMAT = "cnc-craft-nodegraph";

let graph: Graph | null = null;

/** Startpunkt: Quelle → Ausgabe */
export function defaultGraph(): Graph {
  registerAllNodes();
  const g: Graph = { nodes: [], links: [] };
  const a = createNode("source", 40, 60)!, b = createNode("output", 420, 60)!;
  g.nodes.push(a, b);
  connect(g, a.id, "shapes", b.id, "shapes");
  connect(g, a.id, "image", b.id, "image");
  return g;
}

export function currentGraph(): Graph {
  if (graph) return graph;
  registerAllNodes();
  try { graph = sanitizeGraph(JSON.parse(localStorage.getItem(KEY) || "null")); } catch { graph = { nodes: [], links: [] }; }
  if (!graph.nodes.length) graph = defaultGraph();
  return graph;
}

/** Graph ersetzen (Projekt geöffnet, Vorlage geladen) */
export function setGraph(g: Graph) {
  graph = g;
  rememberGraph();
}

export function rememberGraph() {
  try { localStorage.setItem(KEY, JSON.stringify(graph)); } catch { /* zu groß (Bilder) – bleibt dann nur im Speicher */ }
}

/** Ist das nur der leere Startpunkt (dann nicht ins Projekt schreiben)? */
function isDefault(g: Graph): boolean {
  return g.nodes.length <= 2 && g.nodes.every(n => (n.type === "source" && !(n.params.shapes || []).length) || n.type === "output");
}

/** Fürs Projekt: der Graph oder undefined, wenn nichts gebaut wurde */
export function graphForProject(): Graph | undefined {
  const g = currentGraph();
  return isDefault(g) ? undefined : g;
}

/** Aus dem Projekt: ohne Graph → wieder der leere Startpunkt (der Graph gehört zum Projekt) */
export function loadProjectGraph(x: any) {
  registerAllNodes();
  const g = sanitizeGraph(x);
  setGraph(g.nodes.length ? g : defaultGraph());
}

/** Kopie ohne übernommene Formen (für Vorlagen) */
export function recipeOf(g: Graph): Graph {
  return JSON.parse(JSON.stringify({ ...g, nodes: g.nodes.map(n => n.type === "source" ? { ...n, params: { ...n.params, shapes: [] } } : n) }));
}

// ---------------------------------------------------------------------
// Eigene Vorlagen
// ---------------------------------------------------------------------

export interface Recipe { name: string; graph: Graph }

export function ownRecipes(): Recipe[] {
  registerAllNodes();
  try {
    const list = JSON.parse(localStorage.getItem(TPL_KEY) || "[]");
    if (!Array.isArray(list)) return [];
    return list.filter(r => r && typeof r.name === "string").map(r => ({ name: r.name.slice(0, 80), graph: sanitizeGraph(r.graph) }));
  } catch { return []; }
}

function writeRecipes(list: Recipe[]): boolean {
  try { localStorage.setItem(TPL_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

/** Gleicher Name ersetzt die alte Vorlage */
export function saveRecipe(name: string, g: Graph): boolean {
  const list = ownRecipes().filter(r => r.name !== name);
  list.push({ name: name.slice(0, 80), graph: recipeOf(g) });
  list.sort((a, b) => a.name.localeCompare(b.name));
  return writeRecipes(list);
}

export function deleteRecipe(name: string) {
  writeRecipes(ownRecipes().filter(r => r.name !== name));
}

// ---------------------------------------------------------------------
// Vorlagen-Datei
// ---------------------------------------------------------------------

export function recipeFileText(name: string, g: Graph): string {
  return JSON.stringify({ format: GRAPH_FILE_FORMAT, version: 1, name: name.slice(0, 80), graph: recipeOf(g) }, null, 1);
}

/** Datei lesen; null = keine (gültige) Vorlagen-Datei */
export function parseRecipeFile(text: string): Recipe | null {
  registerAllNodes();
  let d: any;
  try { d = JSON.parse(text); } catch { return null; }
  if (d?.format !== GRAPH_FILE_FORMAT || !d.graph) return null;
  const g = sanitizeGraph(d.graph);
  if (!g.nodes.length) return null;
  return { name: typeof d.name === "string" ? d.name.slice(0, 80) : "", graph: g };
}
