// Shape basics: TypeScript (src/shapeTransform.ts) and Rust (src-tauri/src/shapes.rs) must move, scale, mirror, turn,
// shear and convert every kind of shape the same way – including Bézier nodes, text on a path, cut direction, extra
// fields of points and shapes – and give the same paths, bounds, closed flag, click distances, point-in-path and area.
// Pinned in fixtures/shapes-cases.json.gz; `cargo test shapes` compares (numbers to 1e-9).
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test shapes
import { test } from "node:test";
import { shapeInfo } from "../src/editor/shapeRust.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  cloneShape, convertToPolyline, distanceToShape, groupBounds, isClosedShape, makeEllipsePoints, makePolygonPoints, makeRectPoints,
  pathArea, pointInPath, rotateShape, updatePolylineBounds, scaleShape, shapeBounds, shapeToPaths, shearShape, translateShape, type Pt
} from "../src/shapeTransform.ts";

const file = new URL("./fixtures/shapes-cases.json.gz", import.meta.url);
let seed = 99;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const R = (a: number, b: number) => +(a + rnd() * (b - a)).toFixed(3);
const P = (x: number, y: number) => ({ x, y });
// lange Zahlenlisten als Anzahl und Prüfsumme (auf 6 Stellen gerundet), wie in boxRust.test.ts
const fnv = (t: string) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0; return h; };
const flat = (v: unknown): number[] | null => {
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) { const out: number[] = []; for (const e of v) { const f = flat(e); if (!f) return null; out.push(...f); } return out; }
  if (v && typeof v === "object") { const out: number[] = []; for (const k of Object.keys(v).sort()) { const f = flat((v as Record<string, unknown>)[k]); if (!f) return null; out.push(...f); } return out; }
  return null;
};
const digest = (v: unknown): unknown => {
  if (Array.isArray(v)) { const f = flat(v); return f && f.length > 64 ? { n: f.length, h: fnv(f.map(x => x.toFixed(6)).join(",")) } : v.map(digest); }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, digest(x)]));
  return v;
};

const shapes: any[] = [
  { id: "p1", type: "polyline", points: [P(0, 0), P(40, 0), P(40, 20), P(0, 20)], closed: true, x: 0, y: 0, w: 40, h: 20, rotation: 0, millingMode: "outside", cutDir: "cw" },
  { id: "p2", type: "polyline", points: [{ x: 1, y: 2, t: 7 }, { x: 5, y: 9 }, { x: 12, y: -3 }], closed: false, x: 1, y: -3, w: 11, h: 12, rotation: 15, groupId: "g" },
  { id: "p3", type: "polyline", points: [P(0, 0), P(10, 0), P(10, 10)], closed: 1, cutDir: "ccw",
    bez: [{ x: 0, y: 0, ho: P(3, 1) }, { x: 10, y: 0, hi: P(7, -1), ho: P(11, 3), smooth: true }, { x: 10, y: 10, hi: P(9, 7), extra: 5 }] },
  { id: "p4", type: "polyline", points: [P(0, 0), P(30, 5)], closed: false, textPath: { pts: [P(0, 0), P(15, 3), P(30, 5)], offset: 2 }, textData: { text: "Hi", size: 10 } },
  { id: "p5", type: "polyline", points: [], closed: true },
  { id: "c1", type: "circle", x: 50, y: 40, w: 12, h: 12, rotation: 0, millingMode: "outside" },
  { id: "c2", type: "circle", x: -5, y: 3.5, w: -0.01, h: -0.01 },
  { id: "c3", type: "circle", x: 0, y: 0, w: 400, h: 400, cutDir: "cw" },
  { id: "r1", type: "rect", x: 10, y: 10, w: 30, h: 20, rotation: 0 },
  { id: "r2", type: "rect", x: 10, y: 10, w: -30, h: -20, cutDir: "ccw" },
  { id: "a1", type: "arc", x: 0, y: 0, w: 20, h: 0, midX: 10, midY: 10 },
  { id: "a2", type: "arc", x: 0, y: 0, w: 20, h: 0, midX: 10, midY: -10 },
  { id: "a3", type: "arc", x: 5, y: 5, w: 10, h: 10, midX: 10.01, midY: 10 },          // almost straight: no arc
  { id: "a4", type: "arc", x: 100, y: -20, w: -3, h: 40, midX: 130, midY: 0 },
  { id: "a5", type: "arc", x: 0, y: 0, w: 0.01, h: 0, midX: 0.005, midY: 0.003 },     // tiny radius
  { id: "l1", type: "line", x: 3, y: 4, w: 20, h: -7 },
  { id: "i1", type: "image", points: [P(0, 0), P(50, 0), P(50, 30), P(0, 30)], x: 0, y: 0, w: 50, h: 30, src: "data:image/png;base64,AAAA" },
  { id: "t1", type: "text", x: 5, y: 6, w: 10, h: 4 },
  { id: "u1", type: "path", x: 1, y: 1, w: -4, h: 9 },
  { id: "n1", type: "polyline", points: [P(0, 0), P(NaN, 4), P(8, 8)], closed: true },
  { id: "m1", type: "circle", x: 1, y: 2 },                                            // no radius
];
for (let k = 0; k < 14; k++) {
  const n = 2 + Math.floor(rnd() * 12), pts: Pt[] = [];
  for (let i = 0; i < n; i++) pts.push(P(R(-200, 200), R(-200, 200)));
  const s: any = { id: "rp" + k, type: "polyline", points: pts, closed: rnd() < 0.6, x: 0, y: 0, w: 0, h: 0 };
  if (rnd() < 0.3) s.bez = pts.map(p => ({ x: p.x, y: p.y, hi: P(p.x - 1, p.y), ho: P(p.x + 1, p.y + 0.5), ...(rnd() < 0.5 ? { smooth: true } : {}) }));
  if (rnd() < 0.3) s.cutDir = rnd() < 0.5 ? "cw" : "ccw";
  shapes.push(s);
  shapes.push({ id: "ra" + k, type: "arc", x: R(-50, 50), y: R(-50, 50), w: R(-80, 80), h: R(-80, 80), midX: R(-50, 50), midY: R(-50, 50) });
  shapes.push({ id: "rc" + k, type: "circle", x: R(-50, 50), y: R(-50, 50), w: R(0.005, 60), h: 0 });
}
const ops: any[] = [
  { kind: "translate", dx: 7.5, dy: -3.25 }, { kind: "translate", dx: 0, dy: 0 },
  { kind: "scale", ox: 10, oy: 5, sx: -1, sy: 1 }, { kind: "scale", ox: 10, oy: 5, sx: 1, sy: -1 }, { kind: "scale", ox: 0, oy: 0, sx: 2, sy: 2 },
  { kind: "scale", ox: 3, oy: -4, sx: 1.5, sy: 0.5 }, { kind: "scale", ox: 0, oy: 0, sx: -2, sy: -2 }, { kind: "scale", ox: 1, oy: 1, sx: 1, sy: 1 + 1e-10 },
  { kind: "rotate", cx: 10, cy: 5, angle: Math.PI / 2 }, { kind: "rotate", cx: 10, cy: 5, angle: -Math.PI / 2 }, { kind: "rotate", cx: -3, cy: 8, angle: 0.3 },
  { kind: "rotate", cx: 0, cy: 0, angle: Math.PI },
  { kind: "shear", cx: 0, cy: 0, shx: 0.25, shy: 0 }, { kind: "shear", cx: 5, cy: 5, shx: 2, shy: 1 }, { kind: "polyline" },
];

test("shape basics: pinned result for Rust (shapes-cases.json.gz)", () => {
  const transforms = ops.map(op => {
    const out = shapes.filter(s => !(op.kind === "shear" && (s.type === "image" || s.type === "text" || s.type === "path"))).map(s => {
      const c = cloneShape(s);
      if (op.kind === "translate") translateShape(c, op.dx, op.dy);
      else if (op.kind === "scale") scaleShape(c, op.ox, op.oy, op.sx, op.sy);
      else if (op.kind === "rotate") rotateShape(c, op.cx, op.cy, op.angle);
      else if (op.kind === "shear") shearShape(c, op.cx, op.cy, op.shx, op.shy);
      else convertToPolyline(c);
      return { before: s, after: c };
    });
    return { op, shapes: out.map(x => x.before), want: digest(JSON.parse(JSON.stringify(out.map(x => x.after)))) };
  });
  const xy = (ps: Pt[]) => ps.map(p => ({ x: p.x, y: p.y }));
  // Umriss-Box einer Polylinie ohne x/y/w/h hieße im Fenster teils undefined: für diesen Teil erst die Box setzen
  const info = shapes.map(s0 => {
    const s = s0.type === "polyline" && s0.x === undefined ? (() => { const c = cloneShape(s0); updatePolylineBounds(c); return cloneShape(c); })() : s0;   // wie nach dem Speichern: ∞ wird null
    const at = [P(0, 0), P(12, 7), P(-40, 60), P(50, 52)];
    return { s, paths: digest(JSON.parse(JSON.stringify(shapeToPaths(s).map(p => ({ pts: xy(p.pts), closed: p.closed }))))), bounds: shapeBounds(s), closed: isClosedShape(s), dist: at.map(p => distanceToShape(p.x, p.y, s)) };
  });
  const groups = [shapes.slice(0, 5), shapes.slice(5, 12), shapes.slice(15, 20), [shapes[17]], [], shapes];
  const makers = {
    rect: [[0, 0, 10, 5, 0], [0, 0, 10, 5, 2], [10, 5, 0, 0, 100], [0, 0, 10, 5, 1e-7], [0, 0, 0.5, 40, 3], [0, 0, 10, 5, NaN]].map(a => ({ a, out: digest(JSON.parse(JSON.stringify((makeRectPoints as any)(...a)))) })),
    ellipse: [[0, 0, 5, 5], [1, 2, 300, 10], [0, 0, -3, 0.001], [0, 0, 0.01, 0.01]].map(a => ({ a, out: digest((makeEllipsePoints as any)(...a)) })),
    polygon: [[0, 0, 10, 6, 0], [5, 5, 3, 2, 1], [0, 0, 1, 7.5, -0.3], [0, 0, 2, 12.4, 3]].map(a => ({ a, out: (makePolygonPoints as any)(...a) }))
  };
  const loops = [[P(0, 0), P(10, 0), P(10, 10), P(0, 10)], [P(0, 0), P(10, 10), P(10, 0), P(0, 10)], [P(5, 0), P(10, 10), P(0, 10)], [], [P(1, 1)]];
  const inside = loops.flatMap(l => [P(5, 5), P(0, 0), P(10, 5), P(-1, 5), P(5, 10), P(2, 8)].map(p => ({ l, p, in: pointInPath(p.x, p.y, l) })));
  const areas = loops.map(l => ({ l, a: pathArea(l) }));
  assert.ok(transforms.length === ops.length);
  // so wie beim Spiegeln/Drehen im Fenster: die Formen nach dem Speichern (JSON), Stelle = Mitte der Auswahl
  const infos = [shapes.slice(0, 12), shapes.slice(12, 21), shapes.slice(21), [shapes[0]], shapes].flatMap(g => {
    const c = JSON.parse(JSON.stringify(g));
    return [[0, 0], [20, 10], [5.5, -3]].map(([x, y]) => ({ shapes: c, x, y, want: JSON.parse(JSON.stringify(shapeInfo(c, x, y))) }));
  });
  const text = JSON.stringify({ transforms, info, infos, groups: groups.map(g => ({ g, b: groupBounds(g) })), makers, inside, areas }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
