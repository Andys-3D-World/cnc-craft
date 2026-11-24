/**
 * MITGELIEFERTE VORLAGEN für den Knotengraph – fertige Abläufe zum Ausprobieren und Abwandeln.
 * Name t("ng.tpl.<id>"), Beschreibung t("ng.tpl.<id>.d").
 */
import { Graph, GraphNode, connect, createNode } from "./graph";
import { registerAllNodes } from "./nodeDefs";

interface Builder { add: (type: string, x: number, y: number, params?: Record<string, any>) => GraphNode; link: (a: GraphNode, out: string, b: GraphNode, inp: string) => void }

function build(fn: (b: Builder) => void): Graph {
  registerAllNodes();
  const g: Graph = { nodes: [], links: [] };
  fn({
    add: (type, x, y, params = {}) => { const n = createNode(type, x, y)!; Object.assign(n.params, params); g.nodes.push(n); return n; },
    link: (a, out, b, inp) => { connect(g, a.id, out, b.id, inp); }
  });
  return g;
}

export const RECIPES: { id: string; icon: string; make: () => Graph }[] = [
  {
    // Untersetzer: Kreis → 3 × 2 Kopien
    id: "coasters", icon: "◯",
    make: () => build(({ add, link }) => {
      const c = add("circle", 40, 40, { d: 90 });
      const a = add("array", 300, 40, { cols: 3, rows: 2, gapX: 6, gapY: 6 });
      const o = add("output", 560, 40);
      link(c, "shapes", a, "shapes"); link(a, "shapes", o, "shapes");
    })
  },
  {
    // Schild mit zwei Löchern zum Aufhängen
    id: "sign", icon: "▭",
    make: () => build(({ add, link }) => {
      const r = add("rect", 40, 40, { w: 120, h: 60, r: 6 });
      const c = add("circle", 40, 330, { d: 6 });
      const p1 = add("place", 300, 260, { x: 10, y: 50, anchor: "c" });
      const p2 = add("place", 300, 480, { x: 110, y: 50, anchor: "c" });
      const m = add("merge", 560, 330);
      const b = add("boolean", 800, 120, { op: "subtract" });
      const o = add("output", 1040, 120);
      link(c, "shapes", p1, "shapes"); link(c, "shapes", p2, "shapes");
      link(p1, "shapes", m, "a"); link(p2, "shapes", m, "b");
      link(r, "shapes", b, "a"); link(m, "shapes", b, "b"); link(b, "shapes", o, "shapes");
    })
  },
  {
    // Namensschild: Text → Rahmen drumherum (der Rahmen wächst mit dem Text)
    id: "nameTag", icon: "🔤",
    make: () => build(({ add, link }) => {
      const tx = add("text", 40, 40, { text: "Anna", size: 20 });
      const f = add("frame", 300, 40, { margin: 8, r: 5 });
      const o = add("output", 560, 40);
      link(tx, "shapes", f, "shapes"); link(f, "shapes", o, "shapes");
    })
  },
  {
    // Blume: Kreis → 8 Kopien im Kreis → zu einem Umriss verbinden
    id: "flower", icon: "✿",
    make: () => build(({ add, link }) => {
      const c = add("circle", 40, 40, { d: 30 });
      const p = add("polar", 300, 40, { count: 8, radius: 22 });
      const b = add("boolean", 560, 40, { op: "union" });
      const o = add("output", 820, 40);
      link(c, "shapes", p, "shapes"); link(p, "shapes", b, "a"); link(b, "shapes", o, "shapes");
    })
  },
  {
    // Nahtlinie: abgerundetes Rechteck + perforierte Linie 4 mm innen
    id: "stitch", icon: "┄",
    make: () => build(({ add, link }) => {
      const r = add("rect", 40, 40, { w: 100, h: 60, r: 8 });
      const off = add("offset", 300, 200, { dist: 4, dir: "in" });
      const pf = add("perforate", 560, 200, { cut: 3, bridge: 2 });
      const m = add("merge", 820, 40);
      const o = add("output", 1080, 40);
      link(r, "shapes", off, "shapes"); link(off, "shapes", pf, "shapes");
      link(pf, "shapes", m, "a"); link(r, "shapes", m, "b"); link(m, "shapes", o, "shapes");
    })
  },
  {
    // Mandala-Untersetzer: Mandala → 2 × 2 Kopien
    id: "mandalaSet", icon: "❂",
    make: () => build(({ add, link }) => {
      const m = add("mandala", 40, 40, { d: 90, rings: 3 });
      const a = add("array", 300, 40, { cols: 2, rows: 2, gapX: 6, gapY: 6 });
      const o = add("output", 560, 40);
      link(m, "shapes", a, "shapes"); link(a, "shapes", o, "shapes");
    })
  },
  {
    // Sterne auf einem Kreis verteilt (der Kreis bleibt als Linie dabei)
    id: "starRing", icon: "★",
    make: () => build(({ add, link }) => {
      const st = add("star", 40, 40, { d: 12 });
      const c = add("circle", 40, 330, { d: 100 });
      const p = add("onPath", 300, 120, { count: 12, keepPath: true });
      const o = add("output", 560, 120);
      link(st, "shapes", p, "shapes"); link(c, "shapes", p, "path"); link(p, "shapes", o, "shapes");
    })
  },
  {
    // Foto auf Schiefer / dunklem Material: umkehren, Mitten heller, fein gerastert
    id: "slate", icon: "🪨",
    make: () => build(({ add, link }) => {
      const s = add("source", 40, 40);
      const a = add("adjust", 300, 40, { invert: true, contrast: 15, sharpen: 30 });
      const c = add("curve", 560, 40, { mids: 15 });
      const e = add("engrave", 820, 40, { method: "jarvis", interval: 0.1 });
      const o = add("output", 1080, 40);
      link(s, "image", a, "image"); link(a, "image", c, "image"); link(c, "image", e, "image"); link(e, "image", o, "image");
    })
  },
  {
    // Foto rund ausschneiden: Bild 80 mm breit, nur im Kreis graviert, Kreis als Schnittkontur dazu
    id: "photoRound", icon: "◎",
    make: () => build(({ add, link }) => {
      const s = add("source", 40, 40);
      const bg = add("bgRemove", 300, 40, { tol: 20 });
      const e = add("engrave", 560, 40, { method: "jarvis", interval: 0.1 });
      const z = add("imgSize", 820, 40, { w: 80, x: 0, y: 0 });
      const c = add("circle", 560, 380, { d: 76 });
      const p = add("place", 820, 380, { x: 40, y: 40, anchor: "c" });
      const m = add("mask", 1080, 120);
      const o = add("output", 1340, 120);
      link(s, "image", bg, "image"); link(bg, "image", e, "image"); link(e, "image", z, "image");
      link(c, "shapes", p, "shapes"); link(z, "image", m, "image"); link(p, "shapes", m, "shapes");
      link(m, "image", o, "image"); link(p, "shapes", o, "shapes");
    })
  },
  {
    // Teile eng aufs Bett legen (die Originale werden ersetzt)
    id: "nest", icon: "🧩",
    make: () => build(({ add, link }) => {
      const s = add("source", 40, 40);
      const n = add("nest", 300, 40, { gap: 3, margin: 5, rotate: "90" });
      const o = add("output", 560, 40, { removeSrc: true });
      link(s, "shapes", n, "shapes"); link(n, "shapes", o, "shapes");
    })
  },
  {
    // Großes Motiv in Kacheln, jede auf ihrem Bett
    id: "tiles", icon: "▤",
    make: () => build(({ add, link }) => {
      const s = add("source", 40, 40);
      const t = add("tiles", 300, 40, { w: 300, h: 300, toBeds: true });
      const o = add("output", 560, 40, { removeSrc: true });
      link(s, "shapes", t, "shapes"); link(t, "shapes", o, "shapes");
    })
  }
];
