// Tests for "re-import a drawing" (matching and applying) – run with `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { planReimport, countKinds, stampImport, cleanImp, candidates, fitSimilar, type Plan } from "../src/reimportMatch.ts";
import { applyPlan, defaultChoices, type Choices } from "../src/reimportApply.ts";
import { linkClones, syncLinks, isLinked, applyPt, type Mat } from "../src/linkedCopies.ts";
import { createPolyline, createCircle, cloneShape, translateShape, rotateShape, scaleShape, newId, shapeToPaths, MM_TO_PIXEL as PX } from "../src/shapeTransform.ts";
import { joinPaths } from "../src/importers/common.ts";

const near = (a: number, b: number, tol = 1e-3, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≠ ${b}`);

// ---------------------------------------------------------------- small "CAD program"
interface E { k?: string; l?: string; g?: string; c?: [number, number, number]; p?: [number, number][]; open?: boolean; d?: number; mode?: string }

/** Shapes as the importer makes them, in the file frame */
function file(es: E[], run = "new", withRecord = true): any[] {
  return es.map(e => {
    const s = e.c ? createCircle(e.c[0] * PX, e.c[1] * PX, e.c[2] * PX, e.mode ?? "inside")
      : createPolyline(e.p!.map(([x, y]) => ({ x: x * PX, y: y * PX })), !e.open, e.mode ?? (e.open ? "on-line" : "outside"));
    if (e.g) s.groupId = e.g;
    s.source = "plate.dxf";
    if (e.d !== undefined) s.millingDepth = e.d;
    if (withRecord) stampImport(s, null, { f: run, k: e.k ? [e.k] : undefined, l: e.l, d: e.d });
    return s;
  });
}
/** Imported into the project (own ids and groups) */
function imported(es: E[], o: { run?: string; record?: boolean; at?: [number, number] } = {}): any[] {
  const run = o.run ?? "r1";
  const list = file(es, run, o.record !== false);
  const groups = new Map<string, string>();
  for (const s of list) {
    if (s.groupId) { if (!groups.has(s.groupId)) groups.set(s.groupId, "part-" + newId()); s.groupId = groups.get(s.groupId); }
    if (o.at) translateShape(s, o.at[0] * PX, o.at[1] * PX);
  }
  return list;
}
const rect = (x: number, y: number, w: number, h: number): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
/** Plate with an unsymmetric corner and four holes */
const plate = (): E[] => [
  { g: "A", k: "10", p: [[0, 0], [100, 0], [100, 60], [20, 60], [0, 40]] },
  { g: "A", k: "11", c: [10, 10, 2.5] }, { g: "A", k: "12", c: [90, 10, 2.5] },
  { g: "A", k: "13", c: [90, 50, 2.5] }, { g: "A", k: "14", c: [30, 50, 2.5] }
];
const settings = { millingMode: "inside", millingDepth: -6.5, toolId: "t7", tabMode: "auto", tabN: 4, tabLen: 5, tabH: 1, ops: [{ mode: "chamfer", depth: -0.5 }], laserLayerId: "L3", cutData: { feed: 900 } };
const plan = (lists: any[][], es: E[] | any[], o: any = {}): Plan =>
  planReimport(lists.map(shapes => ({ shapes })), es.length && (es[0] as any).type ? es : file(es as E[]), { source: "plate.dxf", ...o });
const run = (lists: any[][], p: Plan, c: Partial<Choices> = {}) => applyPlan(lists, p, { ...defaultChoices(p), ...c }, "plate.dxf");
const holes = (l: any[]) => l.filter(s => s.type === "circle").map(s => [s.x / PX, s.y / PX, s.w / PX].map(v => Math.round(v * 100) / 100));
const strip = (s: any) => { const { imp, ...r } = s; return r; };

for (const record of [true, false]) {
  const tag = record ? "with record" : "old project";

  test(`${tag}: same file again changes nothing`, () => {
    const l = imported(plate(), { record });
    const p = plan([l], plate());
    assert.deepEqual(countKinds(p), { same: 5, changed: 0, new: 0, gone: 0, edited: 0, unclear: 0 });
    assert.equal(p.different, false);
    const r = run([l], p);
    assert.deepEqual(r.lists[0].map(strip), l.map(strip));
    assert.ok(r.lists[0].every(s => cleanImp(s.imp)), "record is there afterwards");
  });

  test(`${tag}: hole moved and another one larger – settings stay`, () => {
    const l = imported(plate(), { record });
    l.forEach((s, i) => Object.assign(s, cloneShape(settings), { toolId: "t" + i }));
    const es = plate();
    es[2].c = [85, 12, 2.5]; es[4].c = [30, 50, 4];
    const p = plan([l], es);
    const n = countKinds(p);
    assert.equal(n.same, 3); assert.equal(n.changed, 2); assert.equal(n.new + n.gone + n.unclear, 0);
    const mv = p.items.find(i => i.moved)!; near(mv.moved!, Math.hypot(5, 2), 0.01);
    const sz = p.items.find(i => i.size)!; near(sz.size![0], 5, 0.01); near(sz.size![1], 8, 0.01);
    const r = run([l], p);
    assert.deepEqual(holes(r.lists[0]), [[10, 10, 2.5], [85, 12, 2.5], [90, 50, 2.5], [30, 50, 4]]);
    r.lists[0].forEach((s, i) => {
      for (const k of Object.keys(settings)) if (k !== "toolId") assert.deepEqual(s[k], (settings as any)[k], k);
      assert.equal(s.toolId, "t" + i);
      assert.equal(s.id, l[i].id); assert.equal(s.groupId, l[i].groupId);
    });
    assert.deepEqual(l[2].x, 180, "the lists given are not changed");
  });

  for (const [name, place] of [
    ["moved", (s: any) => translateShape(s, 37, -12.4)],
    ["turned", (s: any) => { rotateShape(s, 50, 20, 0.7123); translateShape(s, 40, 300); }],
    ["mirrored and turned", (s: any) => { scaleShape(s, 33, 0, -1, 1); rotateShape(s, 5, 9, -2.2); }]
  ] as [string, (s: any) => void][]) {
    test(`${tag}: part ${name} on the bed`, () => {
      const l = imported(plate(), { record });
      l.forEach(place);
      const es = plate();
      es[2].c = [85, 12, 3];
      es.push({ g: "A", k: "15", c: [50, 30, 6] });
      const p = plan([l], es);
      const n = countKinds(p);
      assert.deepEqual([n.same, n.changed, n.new, n.gone, n.unclear], [4, 1, 1, 0, 0]);
      const r = run([l], p);
      // the result is the new drawing, placed the same way
      const want = file(es);
      want.forEach(place);
      assert.equal(r.lists[0].length, 6);
      for (const w of want.filter(s => s.type === "circle")) {
        const hit = r.lists[0].find(s => s.type === "circle" && Math.hypot(s.x - w.x, s.y - w.y) < 0.02 && Math.abs(s.w - w.w) < 1e-6);
        assert.ok(hit, "hole at its place");
        assert.equal(hit.groupId, l[0].groupId);
      }
    });
  }

  test(`${tag}: new hole takes no settings from others`, () => {
    const l = imported(plate(), { record });
    l.forEach(s => Object.assign(s, cloneShape(settings)));
    const es = plate();
    es.push({ g: "A", k: "20", c: [60, 30, 2.5] });
    const r = run([l], plan([l], es));
    const nu = r.lists[0].find(s => !l.some(o => o.id === s.id))!;
    assert.equal(nu.millingDepth, -2); assert.equal(nu.toolId, undefined); assert.equal(nu.ops, undefined); assert.equal(nu.tabN, undefined);
    assert.equal(nu.millingMode, "inside"); assert.equal(nu.groupId, l[0].groupId); assert.equal(nu.source, "plate.dxf");
  });

  test(`${tag}: a removed hole is "gone"; removed by default only when it is certain`, () => {
    const l = imported(plate(), { record });
    const p = plan([l], plate().filter(e => e.k !== "13"));
    assert.equal(countKinds(p).gone, 1);
    assert.equal(defaultChoices(p).gone, record);
    assert.equal(run([l], p, { gone: true }).lists[0].length, 4);
    assert.equal(run([l], p, { gone: false }).lists[0].length, 5);
  });

  test(`${tag}: part on two beds (copy) – both follow`, () => {
    const a = imported(plate(), { record }), b = a.map(s => ({ ...cloneShape(s), id: newId(), groupId: "g2" }));
    b.forEach(s => { rotateShape(s, 0, 0, Math.PI / 2); translateShape(s, 300, 20); });
    const es = plate(); es[1].c = [12, 12, 2.5];
    const p = plan([a, b], es);
    assert.equal(countKinds(p).changed, 2); assert.equal(countKinds(p).same, 8);
    const r = run([a, b], p);
    assert.deepEqual(holes(r.lists[0])[0], [12, 12, 2.5]);
    near(r.lists[1][1].x, -24 + 300); near(r.lists[1][1].y, 24 + 20);
    // only one of the two
    const part = run([a, b], p, { skip: new Set([1]) });
    assert.deepEqual(part.changed, [true, false]);
  });

  test(`${tag}: copies on the same bed`, () => {
    const a = imported(plate(), { record });
    const b = a.map(s => ({ ...cloneShape(s), id: newId(), groupId: "g2" }));
    b.forEach(s => translateShape(s, 0, 160));
    const es = plate(); es[3].c = [88, 48, 2.5]; es.push({ g: "A", k: "77", c: [50, 20, 1] });
    const l = [...a, ...b];
    const p = plan([l], es);
    const n = countKinds(p);
    assert.deepEqual([n.same, n.changed, n.new, n.gone, n.unclear], [8, 2, 2, 0, 0]);
    const r = run([l], p);
    const small = r.lists[0].filter(s => s.type === "circle" && s.w === 2);
    assert.equal(small.length, 2);
    assert.deepEqual(new Set(small.map(s => s.groupId)), new Set([a[0].groupId, "g2"]));
  });

  test(`${tag}: a completely different file says so`, () => {
    const l = imported(plate(), { record });
    const p = plan([l], [{ g: "Z", p: [[0, 0], [300, 0], [150, 260]] }, { g: "Y", p: rect(500, 500, 7, 3) }, { g: "X", c: [900, 4, 33] }]);
    assert.equal(p.different, true);
    assert.deepEqual(run([l], p).lists[0].map(strip), l.map(strip), "nothing by default");
  });

  test(`${tag}: unit changed in the file (mm read as inch)`, () => {
    const l = imported(plate(), { record });
    l.forEach(s => translateShape(s, 11, 7));
    const es = plate();
    const big = file(es).map(s => { scaleShape(s, 0, 0, 25.4, 25.4); stampImport(s, null, { f: "n" }); return s; });
    const p = plan([l], big);
    near(p.unitFactor, 25.4);
    assert.equal(countKinds(p).same, 5);
    const keep = run([l], p);
    assert.deepEqual(keep.lists[0].map(strip), l.map(strip), "size as before: nothing changes");
    const g = plan([l], big, { unit: "file" });
    assert.equal(countKinds(g).changed, 5);
    const grown = run([l], g).lists[0];
    near(grown[1].w, 2.5 * PX * 25.4); near(grown[1].x, 11 + 10 * PX * 25.4, 0.01);
  });

  test(`${tag}: equal holes that could be either one are unclear and stay`, () => {
    const es: E[] = [{ g: "A", p: [[0, 0], [100, 0], [100, 60], [20, 60], [0, 40]] }, { g: "A", c: [50, 30, 3] }, { g: "A", c: [10, 10, 1] }, { g: "A", c: [90, 20, 1] }];
    const l = imported(es, { record });
    // the one hole is gone, two holes at the same distance came
    const nu = [...es]; nu.splice(1, 1, { g: "A", c: [40, 30, 3] }, { g: "A", c: [60, 30, 3] });
    const p = plan([l], nu);
    const u = p.items.filter(i => i.kind === "unclear");
    assert.equal(u.length, 1);
    assert.equal(u[0].cands!.length, 2);
    const r = run([l], p);
    assert.deepEqual(holes(r.lists[0]), holes(l), "nothing guessed");
    const pick = run([l], p, { unclear: new Map([[u[0].id, u[0].cands![0]]]), openNew: true });
    assert.equal(holes(pick.lists[0]).filter(h => h[2] === 3).length, 2);
    assert.ok(pick.lists[0].some(s => s.id === l[1].id));
  });

  test(`${tag}: outline changed, holes stay – outline keeps tabs and depth`, () => {
    const l = imported(plate(), { record });
    Object.assign(l[0], { tabMode: "manual", tabPts: [0.1], cutStart: 0.05, millingDepth: -8 });
    const es = plate(); es[0].p = [[0, 0], [120, 0], [120, 60], [20, 60], [0, 40]];
    const p = plan([l], es);
    const n = countKinds(p);
    assert.deepEqual([n.same, n.changed, n.unclear], [4, 1, 0]);
    const s = run([l], p).lists[0][0];
    assert.equal(s.millingDepth, -8); assert.equal(s.w, 240);
    // tab and start point keep their place on the lower edge
    const before = shapeToPaths(l[0])[0].pts, len = (pts: any[]) => pts.reduce((a, q, i) => a + Math.hypot(q.x - pts[(i + 1) % pts.length].x, q.y - pts[(i + 1) % pts.length].y), 0);
    near(s.tabPts[0] * len(shapeToPaths(s)[0].pts), 0.1 * len(before), 1e-6);
    near(s.cutStart * len(shapeToPaths(s)[0].pts), 0.05 * len(before), 1e-6);
  });
}

// ---------------------------------------------------------------- only with the record

test("drawing moved in the file (new origin): parts stay on the bed", () => {
  const l = imported(plate());
  l.forEach(s => translateShape(s, 60, 60));
  const es = plate().map(e => e.c ? { ...e, c: [e.c[0] + 200, e.c[1] - 33, e.c[2]] as [number, number, number] } : { ...e, p: e.p!.map(([x, y]) => [x + 200, y - 33] as [number, number]) });
  es[4].c![2] = 3;
  const p = plan([l], es);
  assert.equal(p.clusters[0].movedInFile, true);
  assert.deepEqual([countKinds(p).same, countKinds(p).changed], [4, 1]);
  const r = run([l], p).lists[0];
  near(r[4].x, 30 * PX + 60); near(r[4].w, 3 * PX);
  // and once more: the new record fits
  const q = plan([r], es);
  assert.equal(countKinds(q).same, 5); assert.equal(q.clusters[0].movedInFile, false);
});

test("hole pattern without outline: a hole moved in the file is a change", () => {
  const es: E[] = [0, 1, 2, 3, 4].map(i => ({ g: "g" + i, c: [i * 20, i * i * 3, 2] as [number, number, number] }));
  const l = imported(es);
  l.forEach(s => { rotateShape(s, 10, 10, 0.9); translateShape(s, 100, 0); });
  const nu = es.map(e => ({ ...e })); nu[2] = { g: "g2", c: [41, 14, 2] };
  const p = plan([l], nu);
  assert.equal(p.clusters.length, 1);
  assert.deepEqual([countKinds(p).same, countKinds(p).changed, countKinds(p).new, countKinds(p).gone], [4, 1, 0, 0]);
});

test("old project, hole pattern: moved hole is a change, not an unchanged one at another place", () => {
  const es: E[] = [0, 1, 2, 3, 4].map(i => ({ g: "g" + i, c: [i * 20, i * i * 3, 2] as [number, number, number] }));
  const l = imported(es, { record: false });
  const nu = es.map(e => ({ ...e })); nu[2] = { g: "g2", c: [41, 14, 2] };
  const p = plan([l], nu);
  assert.deepEqual([countKinds(p).same, countKinds(p).changed, countKinds(p).new, countKinds(p).gone], [4, 1, 0, 0]);
});

test("several parts arranged on the bed, one of them changed", () => {
  const es: E[] = [...plate(), { g: "B", p: [[200, 0], [260, 0], [260, 30], [230, 45], [200, 30]] }, { g: "B", c: [210, 10, 4] }, { g: "B", c: [250, 10, 4] }];
  for (const record of [true, false]) {
    const l = imported(es, { record });
    l.slice(5).forEach(s => { rotateShape(s, 0, 0, 1.1); translateShape(s, 50, 90); });
    const nu = es.map(e => ({ ...e })); nu[6] = { g: "B", c: [215, 11, 4] }; nu.push({ g: "B", c: [230, 20, 1] });
    const p = plan([l], nu);
    const n = countKinds(p);
    assert.deepEqual([n.same, n.changed, n.new, n.gone, n.unclear], [7, 1, 1, 0, 0], "record " + record);
    const r = run([l], p).lists[0];
    const want = createCircle(230 * PX, 20 * PX, PX); rotateShape(want, 0, 0, 1.1); translateShape(want, 50, 90);
    assert.ok(r.some(s => s.type === "circle" && Math.hypot(s.x - want.x, s.y - want.y) < 0.01 && s.w === PX));
  }
});

test("part moved in the file while the user arranged the parts: stays on the bed", () => {
  const es: E[] = [...plate(), { g: "B", p: [[200, 0], [260, 0], [260, 30], [230, 45], [200, 30]] }, { g: "B", c: [210, 10, 4] }];
  const l = imported(es);
  l.slice(5).forEach(s => translateShape(s, -80, 200));
  const nu = es.map(e => ({ ...e })); nu[5] = { g: "B", p: es[5].p!.map(([x, y]) => [x + 9, y + 1]) }; nu[6] = { g: "B", c: [219, 11, 4] };
  const p = plan([l], nu);
  assert.equal(countKinds(p).same, 7);
  assert.equal(p.clusters.filter(c => c.movedInFile).length, 1);
});

test("same file imported twice: two clusters, each can be left out", () => {
  const a = imported(plate(), { run: "r1" }), b = imported(plate(), { run: "r2", at: [0, 100] });
  const es = plate(); es[1].c = [10, 10, 3];
  const l = [...a, ...b];
  const p = plan([l], es);
  assert.equal(p.clusters.length, 2); assert.equal(countKinds(p).changed, 2);
  const second = p.clusters.findIndex(c => c.ids.includes(b[0].id));
  const r = run([l], p, { skip: new Set([second]) }).lists[0];
  assert.equal(r.find(s => s.id === a[1].id).w, 6); assert.equal(r.find(s => s.id === b[1].id).w, 5);
  // even exactly on top of each other
  const c = imported(plate(), { run: "r1" });
  const q = plan([[...a, ...c]], es);
  assert.deepEqual([countKinds(q).same, countKinds(q).changed, countKinds(q).gone], [8, 2, 0]);
});

test("a hole deleted on purpose comes back only when wanted", () => {
  const l = imported(plate()).filter((_, i) => i !== 3);
  const p = plan([l], plate());
  const nu = p.items.filter(i => i.kind === "new");
  assert.equal(nu.length, 1);
  assert.equal(run([l], p).lists[0].length, 5);
  assert.equal(run([l], p, { off: new Set([nu[0].id]) }).lists[0].length, 4);
});

test("scaled in CNC Craft: new geometry is scaled the same", () => {
  const l = imported(plate());
  l.forEach(s => scaleShape(s, 0, 0, 2, 2));
  const es = plate(); es[2].c = [80, 10, 2.5];
  const p = plan([l], es);
  assert.deepEqual([countKinds(p).same, countKinds(p).changed], [4, 1]);
  const r = run([l], p).lists[0];
  near(r[2].x, 160 * PX); near(r[2].w, 5 * PX);
});

test("edited in CNC Craft: kept when the file did not change it, asked when it did", () => {
  const l = imported(plate());
  l[1].w = l[1].h = 3.3 * PX;                                    // hole made larger by hand
  let p = plan([l], plate());
  assert.deepEqual([countKinds(p).same, countKinds(p).edited, countKinds(p).changed], [4, 1, 0]);
  assert.deepEqual(run([l], p).lists[0].map(strip), l.map(strip));
  const es = plate(); es[1].c = [11, 10, 2.5];
  p = plan([l], es);
  const u = p.items.filter(i => i.kind === "unclear");
  assert.equal(u.length, 1); assert.equal(u[0].conflict, true);
  assert.equal(run([l], p).lists[0][1].w, 3.3 * PX, "own edit stays");
  assert.equal(run([l], p, { unclear: new Map([[u[0].id, u[0].cands![0]]]) }).lists[0][1].w, 5);
});

test("hole moved by hand in its part: stays where the user put it, is not inserted a second time", () => {
  const l = imported(plate());
  translateShape(l[4], 7, 3);
  const es = plate(); es.push({ g: "A", c: [50, 30, 1] });
  const p = plan([l], es);
  const n = countKinds(p);
  assert.deepEqual([n.same, n.changed, n.new, n.gone], [5, 0, 1, 0]);
  assert.equal(run([l], p).lists[0].length, 6);
});

test("stable handles decide where geometry cannot", () => {
  const grid: E[] = [{ g: "A", k: "1", p: [[0, 0], [100, 0], [100, 60], [20, 60], [0, 40]] },
    ...[0, 1, 2, 3].map(i => ({ g: "A", k: "h" + i, c: [20 + i * 10, 20, 2] as [number, number, number] })), { g: "A", k: "z", c: [90, 50, 5] }];
  const l = imported(grid);
  l.forEach((s, i) => { s.toolId = "t" + i; });
  const nu = grid.map(e => ({ ...e }));
  for (let i = 1; i <= 4; i++) nu[i] = { ...nu[i], c: [nu[i].c![0] + 5, 25, 2] };
  const p = plan([l], nu);
  assert.equal(p.keysUsed, true);
  assert.equal(countKinds(p).changed, 4);
  const r = run([l], p).lists[0];
  assert.deepEqual(r.slice(1, 5).map(s => [s.x / PX, s.toolId]), [[25, "t1"], [35, "t2"], [45, "t3"], [55, "t4"]]);
  // handles numbered anew: not trusted, and the shifted grid is not guessed
  const anew = nu.map((e, i) => ({ ...e, k: "n" + ((i + 3) % 6) }));
  const q = plan([l], anew);
  assert.equal(q.keysUsed, false);
  // handles that exist but belong to other shapes now
  const swap = plate(); const ks = ["11", "12", "13", "14"];
  swap.slice(1).forEach((e, i) => { e.k = ks[(i + 1) % 4]; });
  swap[4].c = [35, 50, 2.5];
  const t = plan([imported(plate())], swap);
  assert.equal(t.keysUsed, false);
  assert.deepEqual([countKinds(t).same, countKinds(t).changed], [4, 1]);
});

test("layers: a changed shape is not taken for one of another layer", () => {
  const es: E[] = [{ g: "A", l: "CUT", p: rect(0, 0, 100, 60) }, { g: "A", l: "CUT", c: [20, 20, 3] }, { g: "A", l: "ENGRAVE", c: [40, 20, 3] }, { g: "A", l: "ENGRAVE", c: [70, 40, 3] }];
  const l = imported(es);
  const nu = es.map(e => ({ ...e }));
  nu[1] = { ...nu[1], c: [44, 24, 3] }; nu[2] = { ...nu[2], c: [24, 24, 3] };
  const p = plan([l], nu);
  const ch = p.items.filter(i => i.kind === "changed");
  assert.equal(ch.length, 2);
  for (const i of ch) assert.equal(l.find(s => s.id === i.oldId).imp.l, p.fresh[i.nu!].imp.l);
});

test("same handle on another layer far away is not the same shape", () => {
  const es = plate(); es[4] = { g: "A", k: "14", l: "ENGRAVE", c: [30, 50, 2.5] };
  const l = imported(es);
  const nu = plate(); nu[4] = { g: "A", k: "14", c: [60, 10, 2.5] };
  const p = plan([l], nu);
  assert.equal(p.keysUsed, true);
  assert.deepEqual([countKinds(p).same, countKinds(p).changed, countKinds(p).new, countKinds(p).gone], [4, 0, 1, 1]);
});

test("depth from the model follows as long as nobody set another one", () => {
  const es: E[] = [{ g: "A", p: rect(0, 0, 80, 50), d: -10 }, { g: "A", p: rect(10, 10, 20, 20), d: -3, mode: "pocket" }, { g: "A", p: rect(45, 12, 20, 22), d: -3, mode: "pocket" }];
  const l = imported(es);
  l[2].millingDepth = -5;
  const nu = es.map(e => ({ ...e })); nu[1].d = -4; nu[2].d = -4;
  const p = plan([l], nu);
  assert.equal(countKinds(p).changed, 1);
  const r = run([l], p).lists[0];
  assert.equal(r[1].millingDepth, -4); assert.equal(r[2].millingDepth, -5);
});

test("linked copies follow: changed, new and removed shapes", () => {
  const l = imported(plate());
  const copy = l.map(s => ({ ...cloneShape(s), id: newId(), groupId: "gc" }));
  linkClones(l, copy);
  copy.forEach(s => { rotateShape(s, 0, 0, Math.PI); translateShape(s, 400, 300); });
  const all = [...l, ...copy];
  syncLinks(all, l, []);
  assert.ok(copy.every(isLinked));
  const es = plate().filter(e => e.k !== "13"); es[1].c = [12, 12, 2]; es.push({ g: "A", k: "30", c: [60, 20, 5] });
  const p = plan([all], es);
  assert.equal(p.clusters.length, 1, "copies are not matched themselves");
  const r = run([all], p);
  const cp = r.lists[0].filter(isLinked);
  assert.equal(r.lists[0].length, 10); assert.equal(cp.length, 5);
  assert.ok(cp.some(s => Math.hypot(s.x - (400 - 24), s.y - (300 - 24)) < 1e-6 && Math.abs(s.w - 4) < 1e-9));
  assert.ok(cp.some(s => Math.hypot(s.x - (400 - 120), s.y - (300 - 40)) < 1e-6 && s.w === 10 && s.groupId === "gc"));
  // consistent: the next user action changes nothing
  const after = cloneShape(r.lists[0]);
  const s = syncLinks(r.lists[0], after, []);
  assert.equal(s.blocked + s.orphaned, 0);
});

test("ambiguous placement in an old project: symmetric holes without outline change nothing silently", () => {
  const es: E[] = [{ g: "A", c: [0, 0, 5] }, { g: "A", c: [0, 0, 12] }];
  const l = imported(es, { record: false, at: [50, 50] });
  const p = plan([l], [...es, { g: "A", c: [20, 0, 1] }]);
  assert.equal(countKinds(p).same, 2);
  assert.equal(countKinds(p).new, 0);
  assert.equal(p.openNew.length, 1);
});

test("records from a project file are checked", () => {
  assert.equal(cleanImp(null), null);
  assert.equal(cleanImp({ f: "a", r: [1, "x"], i: [0], n: 3, len: 1, area: 1 }), null);
  assert.equal(cleanImp({ f: "a", r: [1, 2], i: [0, 1], n: 3, len: 1, area: 1 }), null);
  assert.equal(cleanImp({ f: "a", r: [1, 2], i: [0], n: 3, len: NaN, area: 1 }), null);
  const c = cleanImp({ f: "a", r: [1, 2], i: [0], n: 3, len: 1, area: 1, k: ["b", 5, "x".repeat(500)], l: "y".repeat(999), m: { v: "<b>", h: 1, p: 100 }, evil: 1 })!;
  assert.deepEqual(Object.keys(c).sort(), ["area", "f", "i", "k", "l", "len", "n", "r"]);
  assert.equal(c.k!.length, 2); assert.ok(c.k!.every(k => k.length <= 60)); assert.equal(c.l!.length, 120);
  const broken = imported(plate()); broken[1].imp = { f: 7 }; broken[2].imp = "x";
  assert.equal(countKinds(plan([broken], plate())).same, 5);
});

test("images, linked copies and generator shapes do not take part", () => {
  const l: any[] = imported(plate());
  l.push({ ...cloneShape(l[1]), id: "x", link: { of: l[1].id } }, { ...cloneShape(l[1]), id: "y", gen: { i: 0 } }, { id: "z", type: "image", source: "plate.dxf", points: [] });
  assert.equal(candidates(l, "plate.dxf").length, 5);
  assert.equal(candidates(l, "other.dxf").length, 0);
});

test("fitSimilar: move, turn, mirror, scale", () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 3, y: 7 }];
  for (const m of [[1, 0, 0, 1, 5, 6], [0, 2, -2, 0, 1, 1], [-1, 0, 0, 1, 9, 9]] as Mat[]) {
    const f = fitSimilar(pts, pts.map(p => applyPt(m, p)), 1e-6)!;
    f.forEach((v, i) => near(v, m[i], 1e-9));
  }
  assert.equal(fitSimilar(pts, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 3, y: 9 }], 0.01), null);
});

test("large drawing stays fast", () => {
  const es: E[] = [];
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) es.push({ g: `g${i}-${j}`, c: [i * 7 + (j % 3), j * 9, 2 + ((i * j) % 5) * 0.1] });
  for (const record of [true, false]) {
    const l = imported(es, { record });
    l.forEach(s => { rotateShape(s, 0, 0, 0.3); });
    const nu = es.map(e => ({ ...e })); nu[700] = { ...nu[700], c: [nu[700].c![0] + 1, nu[700].c![1], 2] };
    const t0 = performance.now();
    const p = plan([l], nu);
    const ms = performance.now() - t0;
    assert.equal(countKinds(p).same, 1599, "record " + record); assert.equal(countKinds(p).changed, 1);
    assert.ok(ms < 8000, `${ms} ms`);
  }
});

test("joining lines keeps handles and layer, geometry as before", () => {
  const seg = (a: [number, number], b: [number, number], key?: string, layer?: string): any => ({ pts: [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }], closed: false, ...(key ? { keys: [key], layer } : {}) });
  const c: [number, number][] = [[0, 0], [10, 0], [10, 5], [0, 5]];
  const plain = joinPaths(c.map((p, i) => seg(p, c[(i + 1) % 4])), 0.01);
  const tagged = joinPaths(c.map((p, i) => seg(p, c[(i + 1) % 4], "E" + i, "CUT")), 0.01);
  assert.deepEqual(tagged.map(p => ({ pts: p.pts, closed: p.closed })), plain.map(p => ({ pts: p.pts, closed: p.closed })));
  assert.deepEqual([...tagged[0].keys!].sort(), ["E0", "E1", "E2", "E3"]);
  assert.equal(tagged[0].layer, "CUT");
  assert.equal(plain[0].keys, undefined);
});
