// Tests for linked copies (copies that follow their original) – run with `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitRigid, compose, invert, applyPt, applyRigid, controlPoints, materialize, placementOf, syncLinks, refreshLinks,
  shapeIndex, linkClones, unlinkShapes, cleanLinks, relinkRun, familyOf, sourceStamp, isLinked, cleanMat, IDENT, type Mat
} from "../src/linkedCopies.ts";
import { createPolyline, createCircle, createArc, cloneShape, translateShape, rotateShape, scaleShape, MM_TO_PIXEL as PX } from "../src/shapeTransform.ts";

const near = (a: number, b: number, tol = 1e-6, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≠ ${b}`);
const px = (pts: [number, number][]) => pts.map(([x, y]) => ({ x: x * PX, y: y * PX }));
const plate = () => createPolyline(px([[0, 0], [40, 0], [40, 20], [0, 20]]), true, "outside", { millingDepth: -6, toolId: "t1" });
const hole = (x: number, y: number) => createCircle(x * PX, y * PX, 3 * PX, "inside");
const samePts = (a: any, b: any, tol = 1e-6) => {
  const p = controlPoints(a), q = controlPoints(b);
  assert.equal(p.length, q.length);
  p.forEach((k, i) => { near(k.x, q[i].x, tol, "x"); near(k.y, q[i].y, tol, "y"); });
};

/** Make linked copies of `src` the way the editor does: clone, new id, link, then move */
function linkedCopy(src: any, place: (s: any) => void): any {
  const c = cloneShape(src);
  c.id = "c" + Math.random().toString(36).slice(2, 8);
  linkClones([src], [c]);
  place(c);
  return c;
}

/** One user step: `act` changes the drawing, then the link sync runs against the state before */
function step(shapes: any[], act: (shapes: any[]) => any[] | void, others: any[][] = []) {
  const before = JSON.parse(JSON.stringify(shapes));
  const next = act(shapes) || shapes;
  const r = syncLinks(next, before, others);
  return { shapes: next, r };
}

test("fitRigid finds move, turn and mirror, and rejects other changes", () => {
  const a = controlPoints(plate());
  const turn: Mat = [Math.cos(0.7), Math.sin(0.7), -Math.sin(0.7), Math.cos(0.7), 33, -12];
  const b = a.map(p => applyPt(turn, p));
  const m = fitRigid(a, b)!;
  turn.forEach((v, i) => near(m[i], v, 1e-9));
  const mir: Mat = compose([1, 0, 0, 1, 5, 7], [-1, 0, 0, 1, 0, 0]);
  const m2 = fitRigid(a, a.map(p => applyPt(mir, p)))!;
  assert.ok(m2[0] * m2[3] - m2[1] * m2[2] < 0, "mirror found");
  assert.equal(fitRigid(a, a.map(p => ({ x: p.x * 1.1, y: p.y }))), null, "scaled is no move");
  assert.equal(fitRigid(a, a.slice(1)), null, "other point count");
  const inv = compose(turn, invert(turn));
  IDENT.forEach((v, i) => near(inv[i], v, 1e-9));
});

test("applyRigid places every shape type like applyPt", () => {
  const m: Mat = compose([1, 0, 0, 1, 20, 30], [Math.cos(1), Math.sin(1), -Math.sin(1), Math.cos(1), 0, 0]);
  for (const s of [plate(), hole(5, 5), createArc(0, 0, 20, 0, 10, 8)]) {
    const c = cloneShape(s);
    applyRigid(c, m);
    const want = controlPoints(s).map(p => applyPt(m, p));
    controlPoints(c).forEach((p, i) => { near(p.x, want[i].x); near(p.y, want[i].y); });
  }
  const mir = compose([1, 0, 0, 1, 50, 0], [-1, 0, 0, 1, 0, 0]);
  const c = cloneShape(plate());
  c.cutDir = "cw";
  applyRigid(c, mir);
  assert.equal(c.cutDir, "ccw", "mirroring turns the hand-set direction");
  controlPoints(c).forEach((p, i) => near(p.x, applyPt(mir, controlPoints(plate())[i]).x));
});

test("editing the original updates every linked copy; each copy keeps its place", () => {
  const src = plate();
  const copies = [1, 2, 3].map(k => linkedCopy(src, c => translateShape(c, 100 * k, 0)));
  copies[2] = linkedCopy(src, c => { rotateShape(c, 0, 0, Math.PI / 2); translateShape(c, 300, 10); });
  let shapes = [src, ...copies];
  ({ shapes } = step(shapes, () => {})); // first sync after creating: placements are fitted
  copies.forEach(c => assert.ok(Array.isArray(c.link.m), "placement stored"));
  // move one corner of the original (node edit)
  const { r } = step(shapes, list => { list[0].points[2] = { x: 50 * PX, y: 25 * PX }; });
  assert.equal(r.blocked, 0);
  assert.ok(r.changed);
  near(copies[0].points[2].x, 50 * PX + 100);
  near(copies[0].points[2].y, 25 * PX);
  // the turned copy: corner turned by 90° about the origin, then moved
  near(copies[2].points[2].x, -25 * PX + 300);
  near(copies[2].points[2].y, 50 * PX + 10);
  // settings follow too
  step(shapes, list => { list[0].millingDepth = -8; list[0].toolId = "t2"; });
  for (const c of copies) { assert.equal(c.millingDepth, -8); assert.equal(c.toolId, "t2"); }
});

test("moving, turning or mirroring the original does not move the copies", () => {
  const src = plate();
  const c = linkedCopy(src, k => translateShape(k, 200, 0));
  const shapes = [src, c];
  step(shapes, () => {});
  const at = cloneShape(c);
  step(shapes, list => { rotateShape(list[0], 40, 20, 0.5); translateShape(list[0], 70, -30); });
  samePts(c, at, 1e-6);
  assert.ok(src.linkFrame, "original keeps its own frame");
  step(shapes, list => { scaleShape(list[0], 0, 0, -1, 1); });
  samePts(c, at, 1e-6);
  // and after that, an edit of the original still lands right on the copy (in the copy's own orientation)
  step(shapes, list => { list[0].millingDepth = -3; });
  samePts(c, at, 1e-6);
  assert.equal(c.millingDepth, -3);
});

test("moving / turning / mirroring a copy is free; changing its shape or settings is blocked", () => {
  const src = plate();
  const c = linkedCopy(src, k => translateShape(k, 200, 0));
  const shapes = [src, c];
  step(shapes, () => {});
  let { r } = step(shapes, list => { rotateShape(list[1], 300, 20, 1.1); scaleShape(list[1], 300, 0, -1, 1); translateShape(list[1], 5, 5); });
  assert.equal(r.blocked, 0);
  const placed = cloneShape(c);
  // now the original changes: the copy follows in its new (turned, mirrored) place
  step(shapes, list => { list[0].points[1] = { x: 45 * PX, y: 0 }; });
  const m = placementOf(src, c)!;
  assert.ok(m, "copy is still an exact moved image of the original");
  assert.ok(Math.abs(c.points[0].x - placed.points[0].x) < 1e-6, "point 0 did not move");
  // node edit on the copy is undone
  const keep = cloneShape(c);
  ({ r } = step(shapes, list => { list[1].points[0] = { x: list[1].points[0].x + 30, y: list[1].points[0].y }; }));
  assert.equal(r.blocked, 1);
  samePts(c, keep, 1e-6);
  // depth set on the copy only: undone
  ({ r } = step(shapes, list => { list[1].millingDepth = -1; }));
  assert.equal(r.blocked, 1);
  assert.equal(c.millingDepth, -6);
  // radius of a linked circle changed on the copy: undone with a note
  const ho = hole(5, 5), hcopy = linkedCopy(ho, k => translateShape(k, 300, 0));
  const two = [ho, hcopy];
  step(two, () => {});
  ({ r } = step(two, list => { list[1].w = list[1].h = 2; }));
  assert.equal(r.blocked, 1);
  assert.equal(hcopy.w, 3 * PX);
  // same setting on original + copy together is fine
  ({ r } = step(shapes, list => { list[0].millingDepth = -2; list[1].millingDepth = -2; }));
  assert.equal(r.blocked, 0);
  assert.equal(c.millingDepth, -2);
});

test("deleting the original turns the copies into normal shapes; unlink makes one copy independent", () => {
  const src = plate();
  const a = linkedCopy(src, k => translateShape(k, 200, 0)), b = linkedCopy(src, k => translateShape(k, 400, 0));
  let shapes = [src, a, b];
  step(shapes, () => {});
  assert.equal(unlinkShapes([a]), 1);
  assert.equal(isLinked(a), false);
  step(shapes, list => { list[0].points[2] = { x: 60 * PX, y: 20 * PX }; });
  assert.notEqual(a.points[2].x, 60 * PX + 200, "unlinked copy stays as it was");
  near(b.points[2].x, 60 * PX + 400);
  const keep = cloneShape(b);
  const res = step(shapes, list => list.filter(s => s !== src));
  assert.equal(res.r.orphaned, 1);
  assert.equal(isLinked(b), false);
  samePts(b, keep);
});

test("a new shape made from a copy (offset, boolean …) does not stay linked", () => {
  const src = plate();
  const c = linkedCopy(src, k => translateShape(k, 200, 0));
  const shapes = [src, c];
  step(shapes, () => {});
  const grown = cloneShape(c);
  grown.id = "new1";
  grown.points = grown.points.map((p: any) => ({ x: p.x * 1.05, y: p.y * 1.05 }));
  const res = step(shapes, list => [...list, grown]);
  assert.equal(isLinked(grown), false);
  assert.equal(res.r.blocked, 0);
  // Ctrl+D of a copy: still a copy of the same original
  const dup = cloneShape(c);
  dup.id = "new2";
  translateShape(dup, 10, 10);
  step(shapes, list => { list.push(dup); });
  assert.equal(dup.link.of, src.id);
});

test("groups: copies keep their own group; circles and arcs follow", () => {
  const parts = [plate(), hole(10, 10), hole(30, 10), createArc(0, 20 * PX, 40 * PX, 20 * PX, 20 * PX, 30 * PX)];
  parts.forEach(p => { p.groupId = "g1"; });
  const copies = parts.map(p => { const c = cloneShape(p); c.id = "c-" + p.id; c.groupId = "g2"; return c; });
  linkClones(parts, copies);
  copies.forEach(c => { rotateShape(c, 20 * PX, 10 * PX, Math.PI); translateShape(c, 0, 100); });
  const shapes = [...parts, ...copies];
  step(shapes, () => {});
  step(shapes, list => { list[1].w = list[1].h = 4 * PX; list[2].x += 4 * PX; });
  assert.equal(copies[1].w, 4 * PX);
  // the group was turned by 180° about (20, 10) mm: hole at (34, 10) → (6, 10), then up 100 px
  near(copies[2].x, 6 * PX);
  near(copies[2].y, 10 * PX + 100);
  assert.ok(copies.every(c => c.groupId === "g2"));
  // the whole original part turned: copies stay; one hole of a copy moved on its own: undone
  const at = copies.map(cloneShape);
  step(shapes, list => { list.slice(0, 4).forEach(p => rotateShape(p, 0, 0, 0.8)); });
  copies.forEach((c, i) => samePts(c, at[i]));
  const r = step(shapes, list => { translateShape(list[5], 10, 0); }).r;
  assert.equal(r.blocked, 1);
  samePts(copies[1], at[1]);
  assert.equal(familyOf(shapes, copies[2]).length, 2);
});

test("save / load round trip: links survive, nothing changes, broken data is cleaned", () => {
  const src = plate();
  const cs = [1, 2].map(k => linkedCopy(src, c => { rotateShape(c, 0, 0, 0.3 * k); translateShape(c, 150 * k, 0); }));
  const shapes = [src, ...cs];
  step(shapes, () => {});
  step(shapes, list => { translateShape(list[0], 3, 3); });
  const file = JSON.stringify(shapes);
  const loaded = JSON.parse(file);
  cleanLinks(loaded);
  assert.equal(refreshLinks(loaded, shapeIndex([loaded])), false, "fresh copies are not touched when opening");
  assert.equal(JSON.stringify(loaded), file);
  // original edited in the file by an older version (no copy update): opening rebuilds the copies
  const old = JSON.parse(file);
  old[0].points[2].x += 10;
  cleanLinks(old);
  assert.equal(refreshLinks(old, shapeIndex([old])), true);
  near(old[1].points[2].x, applyPt(old[1].link.m, applyPt(invert(old[0].linkFrame), old[0].points[2])).x);
  // broken link data
  const bad = [{ ...plate(), link: { of: 5 } }, { ...plate(), link: { of: "x", m: [1, 2, 3, 4, 5, 6] }, linkFrame: "no" }];
  cleanLinks(bad);
  assert.equal(bad[0].link, undefined);
  assert.equal(bad[1].link.m, undefined);
  assert.equal(bad[1].linkFrame, undefined);
  assert.equal(cleanMat([Math.cos(1), Math.sin(1), -Math.sin(1), Math.cos(1), 0, 0]) !== null, true);
});

test("original on another bed: refresh after switching beds, missing original unlinks", () => {
  const src = plate();
  const c = linkedCopy(src, k => translateShape(k, 50, 0));
  step([src, c], () => {});
  const bedA = [src], bedB = [c];
  assert.equal(refreshLinks(bedB, shapeIndex([bedA, bedB])), false);
  const hole = createCircle(10, 10, 4, "inside"), hc = linkedCopy(hole, k => translateShape(k, 50, 0));
  step([hole, hc], () => {});
  bedA.push(hole); bedB.push(hc);
  hole.w = hole.h = 9; // only the radius changes – the centre stays
  src.points[2].x += 20; // edited while bed B was hidden
  assert.equal(refreshLinks(bedB, shapeIndex([bedA, bedB])), true);
  near(c.points[2].x, src.points[2].x + 50);
  assert.equal(hc.w, 9, "new radius reaches the copy on the other bed");
  bedB.pop();
  // moving the copy on bed B with the original only in `others`
  const r = step(bedB, list => { translateShape(list[0], 7, 0); }, [bedA]).r;
  assert.equal(r.blocked, 0);
  near(c.link.m[4], 57);
  assert.equal(refreshLinks(bedB, shapeIndex([bedB])), true);
  assert.equal(isLinked(c), false);
});

test("no links: sync and refresh change nothing at all", () => {
  const shapes = [plate(), hole(5, 5), createArc(0, 0, 20, 0, 10, 8)];
  const before = JSON.stringify(shapes);
  const r = syncLinks(shapes, JSON.parse(before));
  assert.deepEqual(r, { blocked: 0, orphaned: 0, changed: false });
  translateShape(shapes[0], 5, 5);
  const moved = JSON.stringify(shapes);
  syncLinks(shapes, JSON.parse(before));
  assert.equal(JSON.stringify(shapes), moved, "no frame or other field added");
  assert.equal(refreshLinks(shapes, shapeIndex([shapes])), false);
});

test("generator made again: copies follow the new parts (same count keeps ids, other count rebuilds)", () => {
  const run = (w: number, n: number) => Array.from({ length: n }, (_, i) => {
    const p = createPolyline(px([[i * 50, 0], [i * 50 + w, 0], [i * 50 + w, 20], [i * 50, 20]]), true, "outside");
    p.gen = { id: "run", i, n };
    p.groupId = "gA";
    return p;
  });
  const old = run(30, 2);
  const copies = old.map(p => { const c = cloneShape(p); c.id = "c" + p.id; c.groupId = "gB"; delete c.gen; return c; });
  linkClones(old, copies);
  copies.forEach(c => translateShape(c, 0, 200));
  const list = [...old, ...copies];
  step(list, () => {});
  const made = run(35, 2);
  const now = [...made, ...copies];
  relinkRun([now], old, made, () => "n" + Math.random().toString(36).slice(2, 7));
  assert.equal(copies[1].link.of, made[1].id);
  near(copies[1].points[1].x, (50 + 35) * PX);
  near(copies[1].points[1].y, 200);
  const more = run(35, 3);
  const after = [...more, ...copies];
  relinkRun([after], made, more, () => "n" + Math.random().toString(36).slice(2, 7));
  const linked = after.filter(isLinked);
  assert.equal(linked.length, 3, "one placed copy of the run, now with 3 parts");
  assert.ok(linked.every(c => c.groupId && c.groupId === linked[0].groupId));
  near(linked[2].points[0].y, 200);
  assert.ok(!after.includes(copies[0]), "old copy parts replaced");
});

test("stamp ignores moving the original but sees shape and settings", () => {
  const src = plate();
  const c = linkedCopy(src, k => translateShape(k, 50, 0));
  const shapes = [src, c];
  step(shapes, () => {});
  const h = sourceStamp(src);
  step(shapes, list => { rotateShape(list[0], 0, 0, 0.4); });
  assert.equal(sourceStamp(src), h);
  src.millingDepth = -1;
  assert.notEqual(sourceStamp(src), h);
});
