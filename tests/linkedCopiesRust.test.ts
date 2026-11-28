// Linked copies: TypeScript (src/linkedCopies.ts) and Rust (src-tauri/src/linkedcopies.rs) must keep copies and originals
// in step the same way after every user action (syncLinks), when a project opens or a bed changes (refreshLinks), after a
// generator ran again (relinkRun, with the window's new ids) and when a project file is cleaned (cleanLinks) – the same
// shapes field for field and in the same order, the same counts (blocked, orphaned, changed), the same stamps.
// A fixed random run of edits on originals and copies (move, turn, mirror, node edit, settings, scale, delete, other
// bed …) is recorded step by step. Pinned in fixtures/linkedcopies-cases.json.gz.
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test linkedcopies
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { cleanLinks, controlPoints, linkClones, refreshLinks, relinkRun, settingsKey, shapeIndex, sourceStamp, syncLinks } from "../src/linkedCopies.ts";
import { createArc, createCircle, createPolyline, MM_TO_PIXEL as PX, rotateShape, scaleShape, translateShape } from "../src/shapeTransform.ts";

const file = new URL("./fixtures/linkedcopies-cases.json.gz", import.meta.url);
let seed = 2024;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const R = (a: number, b: number) => +(a + rnd() * (b - a)).toFixed(3);
const clone = (v: any) => JSON.parse(JSON.stringify(v));
let idn = 0;
const nid = () => "s" + (idn++).toString(36);
const withId = (s: any, groupId?: string) => { s.id = nid(); if (groupId) s.groupId = groupId; return s; };
const px = (pts: [number, number][]) => pts.map(([x, y]) => ({ x: x * PX, y: y * PX }));

function part(gid: string): any[] {
  const w = R(20, 60), h = R(10, 40);
  return [
    withId(createPolyline(px([[0, 0], [w, 0], [w, h], [0, h]]), true, "outside", { millingDepth: -6, toolId: "t1" }), gid),
    withId(createCircle(w / 3 * PX, h / 2 * PX, 2 * PX, "inside"), gid),
    withId(createArc(0, h * PX, w * PX, h * PX, w / 2 * PX, (h + 5) * PX), gid),
  ];
}
function copiesOf(srcs: any[], gid: string, place: (s: any) => void): any[] {
  const cs = srcs.map(s => { const c = clone(s); c.id = nid(); c.groupId = gid; return c; });
  linkClones(srcs, cs);
  cs.forEach(place);
  return cs;
}

const syncs: unknown[] = [], refreshes: unknown[] = [], relinks: unknown[] = [];
/** one user step as in history.ts → linked.ts: before = the drawing before, then syncLinks; recorded as the app sends it */
function step(shapes: any[], others: any[][], act: (l: any[]) => void): any[] {
  const before = clone(shapes);
  const now = clone(shapes);
  act(now);
  const input = { shapes: clone(now), before, others: clone(others) };
  const work = clone(now);
  const r = syncLinks(work, before, clone(others));
  syncs.push({ job: { kind: "sync", ...input }, want: { shapes: clone(work), res: r } });
  return work;
}
function refresh(lists: any[][], li: number, same: boolean) {
  const all = clone(lists);
  const list = same ? all[li] : clone(lists[li]);
  const idxLists = same ? all : all.filter((_, i) => i !== li);
  const job = { kind: "refresh", lists: clone(idxLists), same: same ? li : -1, ...(same ? {} : { list: clone(list) }) };
  const changed = refreshLinks(list, shapeIndex(idxLists));
  refreshes.push({ job, want: { list: clone(list), changed } });
}

test("linked copies: pinned result for Rust (linkedcopies-cases.json.gz)", () => {
  for (let run = 0; run < 6; run++) {
    const A = part("gA" + run), B = part("gB" + run);
    let shapes: any[] = [...A, ...B];
    shapes.push(...copiesOf(A, "cA1" + run, c => translateShape(c, 200, 0)));
    shapes.push(...copiesOf(A, "cA2" + run, c => { rotateShape(c, 0, 0, Math.PI / 2); translateShape(c, 0, 300); }));
    shapes.push(...copiesOf(B, "cB1" + run, c => { scaleShape(c, 0, 0, -1, 1); translateShape(c, 500, 50); }));
    const others: any[][] = [copiesOf(A, "oA" + run, c => translateShape(c, 50, -400)), []];
    shapes = step(shapes, others, () => {});                                    // placements are fitted
    for (let k = 0; k < 14; k++) {
      const pick = (f: (s: any) => boolean) => { const l = shapes.filter(f); return l.length ? l[Math.floor(rnd() * l.length)] : null; };
      const orig = (s: any) => !s.link && s.type === "polyline", copy = (s: any) => !!s.link;
      const what = Math.floor(rnd() * 12);
      shapes = step(shapes, others, l => {
        const at = (s: any) => s && l.find(q => q.id === s.id);
        if (what === 0) { const s = at(pick(orig)); if (s) s.points[2] = { x: s.points[2].x + R(-5, 5), y: s.points[2].y + R(-5, 5) }; }
        else if (what === 1) { const g = pick(orig)?.groupId; const dx = R(-30, 30), dy = R(-30, 30); l.filter(s => s.groupId === g).forEach(s => translateShape(s, dx, dy)); }
        else if (what === 2) { const g = pick(orig)?.groupId; l.filter(s => s.groupId === g).forEach(s => rotateShape(s, 10, 10, R(-3, 3))); }
        else if (what === 3) { const s = at(pick(orig)); if (s) s.millingDepth = R(-10, -1); }
        else if (what === 4) { const g = pick(copy)?.groupId; const dx = R(-50, 50); l.filter(s => s.groupId === g).forEach(s => translateShape(s, dx, 3)); }
        else if (what === 5) { const g = pick(copy)?.groupId; l.filter(s => s.groupId === g).forEach(s => scaleShape(s, 0, 0, -1, 1)); }
        else if (what === 6) { const s = at(pick(copy)); if (s) s.millingDepth = -1.25; }                 // not allowed on a copy
        else if (what === 7) { const s = at(pick(copy)); if (s) scaleShape(s, 0, 0, 1.5, 1.5); }          // not rigid
        else if (what === 8) { const s = at(pick(copy)); if (s && s.type === "polyline") s.points[0] = { x: s.points[0].x + 3, y: s.points[0].y }; }
        else if (what === 9) { const s = pick(copy); if (s) { const n = clone(s); n.id = nid(); scaleShape(n, 0, 0, 2, 1); l.push(n); } } // offset-like result keeps a link
        else if (what === 10 && rnd() < 0.3) { const s = pick(orig); if (s) l.splice(l.findIndex(q => q.id === s.id), 1); }               // delete an original
        else { const g = pick(copy)?.groupId; l.filter(s => s.groupId === g).forEach(s => rotateShape(s, 0, 0, Math.PI)); }
      });
    }
    // project opened / bed switched: refresh on its own list, with the original on another bed
    const lists = [shapes, others[0]];
    refresh(lists, 0, true); refresh(lists, 1, true); refresh(lists, 1, false);
    // stamp changed on purpose: the copies must be rebuilt
    const stale = clone(lists);
    for (const l of stale) for (const s of l) if (s.link) s.link.h = "old";
    refresh(stale, 0, true); refresh(stale, 1, true);
  }

  // generator ran again: same parts (new ids) and a different number of parts
  for (const n of [3, 2, 4]) {
    const oldParts = [0, 1, 2].map(i => { const s = withId(createPolyline(px([[i * 10, 0], [i * 10 + 5, 0], [i * 10 + 5, 5]]), true, "outside"), "gg"); s.gen = { i }; return s; });
    const made = Array.from({ length: n }, (_, i) => { const s = withId(createPolyline(px([[i * 10, 0], [i * 10 + 6, 0], [i * 10 + 6, 6]]), true, "outside"), "gn"); s.gen = { i }; return s; });
    const cps = copiesOf(oldParts, "gc", c => translateShape(c, 100, 0));
    const cps2 = copiesOf(oldParts, "gd", c => { rotateShape(c, 0, 0, 1); translateShape(c, 0, 200); });
    const lists = [[...oldParts, ...cps, ...cps2], [...copiesOf(oldParts, "ge", c => translateShape(c, -50, 0))], []];
    const ids: string[] = [];
    const job = { kind: "relink", lists: clone(lists), oldParts: clone(oldParts), made: clone(made) };
    const work = clone(lists);
    relinkRun(work, clone(oldParts), clone(made), () => { const id = "n" + ids.length; ids.push(id); return id; });
    relinks.push({ job: { ...job, ids }, want: clone(work) });
  }

  const dirty = [{ id: "a", link: { of: "b", m: [1, 0, 0, 1, 2, 3], h: "x", extra: 1 } }, { id: "b", link: { of: "b" } }, { id: "c", link: { of: "" } }, { id: "d", link: null },
    { id: "e", link: { of: "x".repeat(61) } }, { id: "f", link: { of: "z", m: [2, 0, 0, 1, 0, 0], h: "y".repeat(41) } }, { id: "g", linkFrame: [0, 1, -1, 0, 5, 5] }, { id: "h", linkFrame: [1, 1, 1, 1, 0, 0] },
    { id: "i", link: { of: "z", m: [0, 1, -1, 0, 1e8, 0] } }, { id: "j", link: 5 }, null, 7, { id: "k", link: { of: 9 } }];
  const cleanCase = { job: { kind: "clean", list: dirty }, want: (() => { const l = clone(dirty); cleanLinks(l); return l; })() };
  const stampShapes = [...part("st"), { id: "u", type: "text", x: 3, textData: { text: "Äö 😀" }, millingDepth: 1e-7, zeta: [1, null, "q"], alpha: { b: 2, a: 1 } },
    { id: "v", type: "circle", x: 1, y: 2, w: "3" }, { id: "w", type: "rect", x: 0, y: 0, w: 10, h: 5, linkFrame: [0, 1, -1, 0, 4, 2], closed: true }];
  const stamps = { job: { kind: "stamp", shapes: stampShapes }, want: stampShapes.map(s => ({ stamp: sourceStamp(s), key: settingsKey(s), cp: controlPoints(s).map(p => ({ x: p.x, y: p.y })) })) };

  assert.ok(syncs.length >= 80 && (syncs as any[]).some(c => c.want.res.blocked) && (syncs as any[]).some(c => c.want.res.orphaned));
  const text = JSON.stringify({ syncs, refreshes, relinks, clean: cleanCase, stamps }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
