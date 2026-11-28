// STL reading and slicing: TypeScript (src/stlMesh.ts) and Rust (src-tauri/src/stlslice.rs) must read the same
// triangles, weld the same corners, find the same automatic height and cut the same outlines and holes.
// This test builds models, pins what the TypeScript gives in fixtures/stlslice-cases.json.gz;
// `cargo test stlslice` compares the Rust result (numbers to 1e-9, the rest exactly).
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test stlslice
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { readStl, stlCheck, viewCoords, weldMesh, meshFromPositions, type StlView } from "../src/stlMesh.ts";

const file = new URL("./fixtures/stlslice-cases.json.gz", import.meta.url);
type V = [number, number, number];
type Tri = [V, V, V];

// ---- models as triangle lists ----
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, inward = false): Tri[] => {
  const v: V[] = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return f.map(t => (inward ? [v[t[0]], v[t[2]], v[t[1]]] : [v[t[0]], v[t[1]], v[t[2]]]) as Tri);
};
/** closed prism over a polygon (counter-clockwise), from z0 to z1 */
const prism = (poly: [number, number][], z0: number, z1: number, inward = false): Tri[] => {
  const out: Tri[] = [];
  const n = poly.length, c = poly.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const q: Tri[] = [[[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1]], [[a[0], a[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]],
      [[c[0], c[1], z0], [b[0], b[1], z0], [a[0], a[1], z0]], [[c[0], c[1], z1], [a[0], a[1], z1], [b[0], b[1], z1]]];
    for (const t of q) out.push(inward ? [t[0], t[2], t[1]] : t);
  }
  return out;
};
const circle = (cx: number, cy: number, r: number, n: number): [number, number][] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
const sphere = (r: number, nu: number, nv: number): Tri[] => {
  const p = (i: number, j: number): V => { const th = (Math.PI * j) / nv, ph = (2 * Math.PI * i) / nu; return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)]; };
  const out: Tri[] = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
    if (j > 0) out.push([a, d, b]);
    if (j < nv - 1) out.push([b, d, c]);
  }
  return out;
};
const move = (ts: Tri[], dx: number, dy: number, dz: number): Tri[] => ts.map(t => t.map(v => [v[0] + dx, v[1] + dy, v[2] + dz]) as Tri);

// ---- files ----
const ascii = (ts: Tri[], eol = "\n", fmt = (n: number) => String(n)) => Buffer.from("solid model" + eol + ts.map(t => `facet normal 0 0 0${eol}outer loop${eol}${t.map(v => `vertex ${v.map(fmt).join(" ")}`).join(eol)}${eol}endloop${eol}endfacet`).join(eol) + eol + "endsolid model" + eol);
const binary = (ts: Tri[], head = "binary", extra = 0, declared = ts.length) => {
  const b = Buffer.alloc(84 + ts.length * 50 + extra);
  b.write(head, 0, "latin1");
  b.writeUInt32LE(declared, 80);
  ts.forEach((t, i) => t.forEach((v, k) => v.forEach((x, j) => b.writeFloatLE(x, 84 + i * 50 + 12 + k * 12 + j * 4))));
  return b;
};
const positions = (ts: Tri[]) => { const f = new Float32Array(ts.length * 9); ts.forEach((t, i) => t.forEach((v, k) => v.forEach((x, j) => (f[i * 9 + k * 3 + j] = x)))); return Buffer.from(f.buffer); };

const files: Buffer[] = [];
const cases: { name: string; file: number; head: { source: string; view: StlView; height: number } }[] = [];
const addFile = (b: Buffer) => (files.push(b), files.length - 1);
/** cut at fractions of the height span in a view (or an absolute height) */
const add = (name: string, f: number, source: "stl" | "positions", views: StlView[], at: (number | { abs: number })[]) => {
  const raw = files[f];
  const mesh = source === "stl" ? readStl(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length) as ArrayBuffer) : meshFromPositions(new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)), "3mf");
  for (const view of views) for (const a of at) {
    let height = 0;
    if ("error" in mesh) height = 0;
    else if (typeof a === "number") { const vc = viewCoords(weldMesh(mesh), view); height = vc.minW + (vc.maxW - vc.minW) * a; }
    else height = a.abs;
    cases.push({ name: `${name}, ${view} at ${typeof a === "number" ? a : "h " + a.abs}`, file: f, head: { source, view, height } });
  }
};
const ALL: StlView[] = ["top", "bottom", "front", "back", "left", "right"];

const CUBE = box(0, 0, 0, 10, 20, 30);
add("cube ascii", addFile(ascii(CUBE)), "stl", ALL, [0.5]);
add("cube binary", addFile(binary(CUBE)), "stl", ["top", "front"], [0.25, 0, 1, { abs: 30 }, { abs: -5 }]);
add("cube binary with a solid header", addFile(binary(CUBE, "solid facet name")), "stl", ["top"], [0.5]);
add("cube binary with extra bytes", addFile(binary(CUBE, "hello", 7)), "stl", ["top"], [0.5]);
add("cube binary declares too many", addFile(binary(CUBE, "x", 0, 99)), "stl", ["top"], [0.5]);
add("cube as positions (3MF)", addFile(positions(CUBE)), "positions", ["left"], [0.3]);
const TUBE = [...prism(circle(0, 0, 20, 48), 0, 15), ...prism(circle(0, 0, 8, 32), 0, 15, true)];
add("tube with a hole", addFile(binary(TUBE)), "stl", ["top", "front"], [0.5, 0.01]);
const NEST = [...box(0, 0, 0, 100, 100, 10), ...box(10, 10, 0, 90, 90, 10, true), ...box(20, 20, 0, 80, 80, 10), ...box(30, 30, 0, 70, 70, 10, true)];
add("boxes in holes in boxes", addFile(binary(NEST)), "stl", ["top"], [0.5]);
const SPH = sphere(25, 64, 32);
add("sphere", addFile(binary(SPH)), "stl", ["top", "right"], [0.5, 0.1, 0.97]);
const L = prism([[0, 0], [40, 0], [40, 10], [10, 10], [10, 30], [0, 30]], 0, 5);
add("L shape", addFile(ascii(L, "\r\n")), "stl", ["top", "back", "bottom"], [0.5]);
const TWO = [...move(box(0, 0, 0, 10, 10, 10), 0, 0, 0), ...move(sphere(5, 24, 12), 30, 5, 5), ...move(prism(circle(0, 0, 4, 6), 0, 20), 60, 5, 0)];
add("several parts", addFile(binary(TWO)), "stl", ["top", "front"], [0.5, 0.75]);
// leaky: one triangle of a side missing, and a gap of 0.02 mm (stitched)
const LEAK = CUBE.filter((_, i) => i !== 7);
add("cube with a missing triangle", addFile(binary(LEAK)), "stl", ["top", "front"], [0.5]);
const GAP = [...box(0, 0, 0, 10, 10, 10).slice(0, 6), ...move(box(0, 0, 0, 10, 10, 10).slice(6), 0.02, 0, 0)];
add("cube with a small gap", addFile(binary(GAP)), "stl", ["top"], [0.5]);
const STAIR = [...box(0, 0, 0, 30, 30, 5), ...box(0, 0, 5, 20, 20, 10), ...box(0, 0, 10, 10, 10, 15)];
add("stairs, cut on a face", addFile(binary(STAIR)), "stl", ["top"], [{ abs: 5 }, { abs: 10 }, { abs: 7.5 }, 0.5]);
add("big sphere (height index)", addFile(binary(sphere(40, 160, 80))), "stl", ["top", "front"], [0.42]);
add("scientific numbers and tabs", addFile(ascii(box(0, 0, 0, 1.5e1, 2e1, 3.25), "\n", n => (n === 0 ? "-0.0e0" : n.toExponential(3)))), "stl", ["top"], [0.5]);
add("odd text numbers", addFile(Buffer.from("solid x\nfacet normal 0 0 1\nouter loop\n vertex\t0 0 0\n  vertex 10. +5 .5e1\nvertex 1e1 1-0 7\nvertex 1 2\nvertex x 3 4\nvertexvertex 0 0 1\nendloop\nendfacet\nendsolid\n")), "stl", ["top"], [0.5]);
add("minus zero welds with zero", addFile(binary([[[0, 0, 0], [10, 0, 0], [0, 10, 10]], [[-0, -0, -0], [0, 10, 10], [-10, 0, 0]], [[10, 0, 0], [0, -10, 5], [0, 0, 0]]])), "stl", ["top"], [0.5]);
add("degenerate triangles", addFile(binary([...CUBE, [[1, 1, 1], [1, 1, 1], [1, 1, 1]], [[0, 0, 0], [5, 0, 0], [10, 0, 0]]])), "stl", ["top"], [0.5]);
add("thin plate (one bin)", addFile(binary(box(0, 0, 0, 50, 50, 0.4))), "stl", ["top", "front"], [0.5]);
add("flat model", addFile(binary([[[0, 0, 0], [10, 0, 0], [0, 10, 0]]])), "stl", ["top"], [0.5]);
add("too small", addFile(Buffer.from("solid x")), "stl", ["top"], [0.5]);
add("14 bytes", addFile(Buffer.from("solid 12345678")), "stl", ["top"], [0.5]);
// text STL whose bytes 80..83 read as "1 triangle": still text because it starts with "solid" and has "facet"
const looksBinary = (lead: string) => { const t = ascii(CUBE); const b = Buffer.concat([Buffer.from(lead), t]); b.write("\x01\x00\x00\x00", 80, "latin1"); return b; };
add("text that looks binary", addFile(looksBinary("")), "stl", ["top"], [0.5]);
add("text that looks binary, space before solid", addFile(looksBinary("\n \t")), "stl", ["top"], [0.5]);
add("binary named solid without facet, extra bytes", addFile(binary(CUBE, "solid only a name", 9)), "stl", ["top"], [0.5]);
add("text: vertex glued to a number, far fourth corner", addFile(Buffer.from("solid x\nfacet\nvertex 0 0 0\nvertex 4 0 0\nvertex9 9 9\nvertex 0 4 3\nvertex 100 100 100\nendsolid\n")), "stl", ["top"], [0.5]);
add("triangular prism", addFile(binary(prism([[0, 0], [30, 0], [10, 20]], 0, 10))), "stl", ["top", "front"], [0.5]);
add("tiny box beside a big one", addFile(binary([...box(0, 0, 0, 20, 20, 5), ...box(30, 0, 0, 30.05, 0.05, 5), ...box(40, 0, 0, 40.2, 0.2, 5)])), "stl", ["top"], [0.5]);
add("tightly nested", addFile(binary([...box(0, 0, 0, 10, 10, 5), ...box(0.5, 0.5, 0, 9.5, 9.5, 5, true), ...box(1, 1, 0, 9, 9, 5), ...box(1.5, 1.5, 0, 8.5, 8.5, 5, true)])), "stl", ["top"], [0.5]);
add("cup: solid bottom, tube on top", addFile(binary([...prism(circle(0, 0, 20, 40), 0, 10), ...prism(circle(0, 0, 20, 40), 10, 20), ...prism(circle(0, 0, 15, 40), 10, 20, true)])), "stl", ["top"], [0.25, 0.75]);
add("text without triangles", addFile(Buffer.from("solid empty\nendsolid empty\n")), "stl", ["top"], [0.5]);
add("binary with no triangle data", addFile(binary([], "x", 30, 0)), "stl", ["top"], [0.5]);

test("STL reading and slicing: pinned result for Rust (stlslice-cases.json.gz)", () => {
  const built = cases.map(c => {
    const raw = files[c.file];
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length) as ArrayBuffer;
    const mesh = c.head.source === "stl" ? readStl(ab) : meshFromPositions(new Float32Array(ab), "3mf");
    const want = "error" in mesh ? { error: mesh.error } : stlCheck(mesh, c.head.view, c.head.height);
    return { ...c, want };
  });
  const text = JSON.stringify({ files: files.map(f => f.toString("hex")), cases: built }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
