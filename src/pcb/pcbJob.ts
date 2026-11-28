/**
 * PLATINE → FORMEN (ohne Oberfläche, Tests in tests/pcb.test.ts)
 *
 * Dateien erkennen und zuordnen, Platinenkontur finden, alles auf das Bett legen (Rückseite gespiegelt) und daraus normale
 * Formen machen: Isolationsbahnen „auf Linie“, Löcher „Bohren“ bzw. „Innen“, Kontur „Außen“ mit Haltestegen.
 */
import { gerberBox, looksLikeGerber, parseGerber, type Box, type GerberFile, type Pt2 } from "./gerber.ts";
import { looksLikeExcellon, parseExcellon, type DrillFile, type Hole, type Slot } from "./excellon.ts";
import type { IsoLine } from "./field.ts";
import { polygonArea, type P } from "../polyOffset.ts";
import { checkImport, importInApp } from "../importers/importRust.ts";

export type Role = "top" | "bottom" | "outline" | "drill" | "ignore";
export interface PcbFile { name: string; role: Role; gerber?: GerberFile; drill?: DrillFile }

/** Rolle aus Datei-Angabe (X2) oder Namen */
export function guessRole(name: string, func: string): Role {
  const f = func.toLowerCase(), n = name.toLowerCase().replace(/^.*[\\/]/, "");
  if (f) {
    if (/^copper,l1,top/.test(f) || /^copper,.*,top/.test(f)) return "top";
    if (/^copper,.*,bot/.test(f)) return "bottom";
    if (/^profile/.test(f)) return "outline";
    if (/^(plated|nonplated)/.test(f)) return "drill";
    return "ignore";
  }
  if (/mask|paste|silk|legend|courtyard|fab\b|\.(gts|gbs|gto|gbo|gtp|gbp|stc|sts|plc|pls|crc|crs)$/.test(n)) return "ignore";
  if (/f[._-]cu|copper[._-]?top|top[._-]?(copper|layer)|\.(gtl|cmp|top)$/.test(n)) return "top";
  if (/b[._-]cu|copper[._-]?bot|bot(tom)?[._-]?(copper|layer)|\.(gbl|sol|bot)$/.test(n)) return "bottom";
  if (/edge[._-]?cuts|outline|profile|board[._-]?shape|\.(gko|gm1|gml|gm3|oln|dim)$/.test(n)) return "outline";
  return "ignore";
}

/** Datei lesen; null = weder Gerber noch Bohrdatei */
export function readPcbFile(name: string, text: string): PcbFile | null {
  // Rust (pcbparse.rs) liest dieselbe Datei im Hintergrund noch einmal und vergleicht (nur in der App)
  if (looksLikeExcellon(text)) { const drill = parseExcellon(text); if (importInApp()) checkImport("pcb_parse", { kind: "drill", text }, structuredClone(drill)); if (drill.holes.length || drill.slots.length) return { name, role: "drill", drill }; return null; }
  if (looksLikeGerber(text)) { const gerber = parseGerber(text); if (importInApp()) checkImport("pcb_parse", { kind: "gerber", text }, structuredClone(gerber)); return { name, role: guessRole(name, gerber.func), gerber }; }
  return null;
}

/** Striche zu geschlossenen Umrissen verbinden (Enden näher als tol); Rest = offene Linien */
export function outlineLoops(lines: Pt2[][], tol = 0.05): { loops: P[][]; open: number } {
  const near = (a: Pt2, b: Pt2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  const pool = lines.filter(l => l.length > 1 && l.some(p => !near(p, l[0]))).map(l => l.slice());
  const loops: Pt2[][] = [];
  let open = 0;
  while (pool.length) {
    let cur = pool.pop()!, grew = true;
    while (grew && !(cur.length > 2 && near(cur[0], cur[cur.length - 1]))) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const l = pool[i], e = cur[cur.length - 1], s = cur[0];
        if (near(e, l[0])) cur = [...cur, ...l.slice(1)];
        else if (near(e, l[l.length - 1])) cur = [...cur, ...l.slice(0, -1).reverse()];
        else if (near(s, l[l.length - 1])) cur = [...l.slice(0, -1), ...cur];
        else if (near(s, l[0])) cur = [...l.slice(1).reverse(), ...cur];
        else continue;
        pool.splice(i, 1); grew = true; break;
      }
    }
    if (cur.length > 3 && near(cur[0], cur[cur.length - 1])) loops.push(cur.slice(0, -1)); else open++;
  }
  const out = loops.map(l => l.map(([x, y]) => ({ x, y }))).filter(l => Math.abs(polygonArea(l)) > 0.01);
  // der größte Umriss zuerst; doppelt gezeichnete nur einmal
  out.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  const box = (l: P[]) => [Math.min(...l.map(p => p.x)), Math.min(...l.map(p => p.y)), Math.max(...l.map(p => p.x)), Math.max(...l.map(p => p.y))];
  return { loops: out.filter((l, i) => { const b = box(l); return !out.some((o, j) => j < i && box(o).every((v, k) => Math.abs(v - b[k]) < 0.02) && Math.abs(Math.abs(polygonArea(o)) - Math.abs(polygonArea(l))) < 0.05); }), open };
}

export interface Board { box: Box; loops: P[][]; open: number; holes: Hole[]; slots: Slot[]; source: "outline" | "content" }
/** Platine aus allen zugeordneten Dateien; null = nichts Brauchbares */
export function boardOf(files: PcbFile[]): Board | null {
  const holes = files.filter(f => f.role === "drill").flatMap(f => f.drill?.holes ?? []), slots = files.filter(f => f.role === "drill").flatMap(f => f.drill?.slots ?? []);
  const { loops, open } = outlineLoops(files.filter(f => f.role === "outline").flatMap(f => f.gerber?.lines ?? []));
  let box: Box | null = null;
  const grow = (b: Box | null) => { if (b) box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : b; };
  if (loops.length) grow({ x0: Math.min(...loops[0].map(p => p.x)), y0: Math.min(...loops[0].map(p => p.y)), x1: Math.max(...loops[0].map(p => p.x)), y1: Math.max(...loops[0].map(p => p.y)) });
  else {
    for (const f of files) if ((f.role === "top" || f.role === "bottom") && f.gerber) grow(gerberBox(f.gerber.objs));
    for (const h of holes) grow({ x0: h.x - h.d / 2, y0: h.y - h.d / 2, x1: h.x + h.d / 2, y1: h.y + h.d / 2 });
  }
  return box ? { box, loops, open, holes, slots, source: loops.length ? "outline" : "content" } : null;
}

/** Liegen die Löcher auf der Platine? Wenn viele daneben liegen, stimmt das Zahlenformat der Bohrdatei nicht */
export function holesOff(b: Board): number {
  const { x0, y0, x1, y1 } = b.box, m = 0.5;
  return b.holes.filter(h => h.x < x0 - m || h.x > x1 + m || h.y < y0 - m || h.y > y1 + m).length;
}

/** Datei-Koordinaten → Bett: Ecke links unten auf (x, y), Rückseite gespiegelt (gewendet um die senkrechte Mittellinie) */
export function placer(box: Box, at: { x: number; y: number }, mirror: boolean): (p: P) => P {
  return p => ({ x: at.x + (mirror ? box.x1 - p.x : p.x - box.x0), y: at.y + p.y - box.y0 });
}

/** Wie wird ein Loch gemacht? drill = Bohrer passt, mill = Fräser kleiner als das Loch, no = geht nicht */
export function holeMode(d: number, tool: { type: string; diameter: number } | null): "drill" | "mill" | "no" {
  if (!tool) return "no";
  if (Math.abs(tool.diameter - d) <= 0.051 && tool.type !== "vbit" && tool.type !== "chamfer") return "drill";
  if (tool.type === "drill") return "no";
  return (tool.type === "endmill" || tool.type === "bullnose" || tool.type === "ball") && tool.diameter < d - 0.05 ? "mill" : "no";
}

/** Werkzeug-Vorschlag für ein Loch: passender Bohrer, sonst gleich großer Fräser, sonst der größte kleinere Fräser */
export function pickHoleTool<T extends { type: string; diameter: number }>(d: number, tools: T[]): T | null {
  const fit = (t: T) => Math.abs(t.diameter - d);
  const drills = tools.filter(t => t.type === "drill" && fit(t) <= 0.051).sort((a, b) => fit(a) - fit(b));
  if (drills[0]) return drills[0];
  const mills = tools.filter(t => t.type === "endmill" && holeMode(d, t) !== "no").sort((a, b) => b.diameter - a.diameter);
  return mills[0] ?? null;
}

export interface Desc { kind: "iso" | "hole" | "slot" | "outline"; type: "circle" | "polyline"; closed: boolean; pts: P[]; r: number; mode: string; depth: number; toolId: string; tabs: boolean; pass: number }

export interface BuildOpts {
  place: (p: P) => P;
  mirror: boolean;
  iso: { lines: IsoLine[]; toolId: string; depth: number } | null;
  /** je Loch-Ø (auf 0,01 mm): Werkzeug */
  drill: { tool: (d: number) => { id: string; type: string; diameter: number } | null; depth: number } | null;
  outline: { tool: { id: string; diameter: number }; depth: number; tabs: boolean } | null;
}

/** Langloch als Vieleck mit runden Enden */
export function slotOutline(pts: [number, number][], d: number): P[] | null {
  if (pts.length !== 2) return null;
  const [a, b] = pts, l = Math.hypot(b[0] - a[0], b[1] - a[1]), r = d / 2;
  if (l < 1e-6) return null;
  const w = Math.atan2(b[1] - a[1], b[0] - a[0]), n = 24, out: P[] = [];
  for (let i = 0; i <= n; i++) { const t = w - Math.PI / 2 + Math.PI * i / n; out.push({ x: b[0] + r * Math.cos(t), y: b[1] + r * Math.sin(t) }); }
  for (let i = 0; i <= n; i++) { const t = w + Math.PI / 2 + Math.PI * i / n; out.push({ x: a[0] + r * Math.cos(t), y: a[1] + r * Math.sin(t) }); }
  return out;
}

/** Alle Formen; skipped = Löcher ohne passendes Werkzeug */
export function buildDescs(b: Board, o: BuildOpts): { descs: Desc[]; skipped: number } {
  const out: Desc[] = [];
  let skipped = 0;
  const M = (pts: P[]) => { const q = pts.map(o.place); return o.mirror ? q.reverse() : q; };
  const add = (d: Partial<Desc> & Pick<Desc, "kind" | "mode" | "depth" | "toolId">) => out.push({ type: "polyline", closed: true, pts: [], r: 0, tabs: false, pass: 0, ...d });
  if (o.iso) for (const l of o.iso.lines) add({ kind: "iso", closed: l.closed, pts: M(l.pts), mode: "on-line", depth: -Math.abs(o.iso.depth), toolId: o.iso.toolId, pass: l.pass });
  if (o.drill) {
    const depth = -Math.abs(o.drill.depth);
    for (const h of b.holes) {
      const t = o.drill.tool(h.d), m = holeMode(h.d, t);
      if (!t || m === "no") { skipped++; continue; }
      add({ kind: "hole", type: "circle", pts: [o.place({ x: h.x, y: h.y })], r: h.d / 2, mode: m === "drill" ? "drill" : "inside", depth, toolId: t.id });
    }
    for (const s of b.slots) {
      const t = o.drill.tool(s.d), m = holeMode(s.d, t), line = s.pts.map(([x, y]) => ({ x, y }));
      // mit einem Bohrer kann man nicht seitlich fräsen
      if (!t || m === "no" || t.type === "drill") { skipped++; continue; }
      const ring = m === "mill" ? slotOutline(s.pts, s.d) : null;
      if (ring) add({ kind: "slot", pts: M(ring), mode: "inside", depth, toolId: t.id });
      else if (m === "drill") add({ kind: "slot", closed: false, pts: line.map(o.place), mode: "on-line", depth, toolId: t.id });
      else skipped++;
    }
  }
  if (o.outline) b.loops.forEach((l, i) => add({ kind: "outline", pts: M(l), mode: i === 0 ? "outside" : "inside", depth: -Math.abs(o.outline!.depth), toolId: o.outline!.tool.id, tabs: i === 0 && o.outline!.tabs }));
  return { descs: out, skipped };
}
