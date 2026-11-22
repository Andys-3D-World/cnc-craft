// Tests for two-sided milling (mirroring, dowel pins, depths of both sides) – run with `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSetup, cleanSetup, cloneSetup, flipLine, mirrorPoint, mirrorShape, remapBackShape, defaultPins, pinIssues, pinCut,
  depthIssues, otherSideDepth, throughDepth, pinMargin, MAX_PINS, type TwoSidedSetup, type Removal, type PinObstacle,
} from "../src/twoSided.ts";
import { shapeBounds } from "../src/shapeTransform.ts";

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

/** Stock 200 × 100 mm, lower-left corner at X20 Y10 → right edge X220, back edge Y110, centre X120 Y60 */
function setup(flip: "lr" | "fb"): TwoSidedSetup {
  const s = defaultSetup();
  s.on = true; s.flip = flip; s.stock = { x: 20, y: 10, w: 200, h: 100 }; s.thickness = 18; s.pinDia = 6;
  s.pins = defaultPins(s, []);
  return s;
}

// ---------------------------------------------------------------------
// Mirroring – coordinates worked out by hand
// ---------------------------------------------------------------------

test("turning line: left-right runs along Y through the stock centre, front-back along X", () => {
  assert.deepEqual(flipLine(setup("lr")), { along: "y", at: 120 });
  assert.deepEqual(flipLine(setup("fb")), { along: "x", at: 60 });
});

test("left-right: a point 10 mm from the left edge ends 10 mm from the right edge, Y stays", () => {
  // front: X30 = 10 mm right of the left edge (X20). Turned like a book page that edge is now at X220 → X210
  assert.deepEqual(mirrorPoint({ x: 30, y: 25 }, setup("lr")), { x: 210, y: 25 });
  assert.deepEqual(mirrorPoint({ x: 120, y: 77 }, setup("lr")), { x: 120, y: 77 }); // on the line: stays
  assert.deepEqual(mirrorPoint({ x: 220, y: 10 }, setup("lr")), { x: 20, y: 10 });   // right corner → left corner
});

test("front-back: a point 15 mm from the front edge ends 15 mm from the back edge, X stays", () => {
  // front: Y25 = 15 mm behind the front edge (Y10). Turned over towards the back that edge is at Y110 → Y95
  assert.deepEqual(mirrorPoint({ x: 30, y: 25 }, setup("fb")), { x: 30, y: 95 });
  assert.deepEqual(mirrorPoint({ x: 44, y: 60 }, setup("fb")), { x: 44, y: 60 });
  assert.deepEqual(mirrorPoint({ x: 20, y: 110 }, setup("fb")), { x: 20, y: 10 });
});

test("turning twice gives the same point again", () => {
  for (const f of ["lr", "fb"] as const) {
    const p = mirrorPoint(mirrorPoint({ x: 33.3, y: 71.25 }, setup(f)), setup(f));
    near(p.x, 33.3); near(p.y, 71.25);
  }
});

// shapes are stored in world pixels: 1 mm = 2 px
const circle = () => ({ id: "c", type: "circle", x: 60, y: 50, w: 10, h: 10, millingMode: "pocket" });           // centre X30 Y25, r 5 mm
const rect = () => ({ id: "r", type: "polyline", closed: true, cutDir: "ccw", points: [{ x: 60, y: 40 }, { x: 140, y: 40 }, { x: 140, y: 80 }, { x: 60, y: 80 }] }); // X30…70, Y20…40
const arc = () => ({ id: "a", type: "arc", x: 80, y: 40, w: 40, h: 0, midX: 100, midY: 60 });                   // X40 Y20 → X60 Y20 over X50 Y30

test("left-right: shapes land at the hand-worked places", () => {
  const s = setup("lr");
  const c = mirrorShape(circle(), s);
  assert.deepEqual([c.x, c.y, c.w], [420, 50, 10]);                      // centre X210 Y25, radius unchanged
  const r = mirrorShape(rect(), s);
  assert.deepEqual(r.points, [{ x: 420, y: 40 }, { x: 340, y: 40 }, { x: 340, y: 80 }, { x: 420, y: 80 }]); // X210…170, Y20…40
  assert.equal(r.cutDir, "cw");                                          // mirrored: the hand-set direction turns round
  const a = mirrorShape(arc(), s);
  assert.deepEqual([a.x, a.y, a.x + a.w, a.y + a.h, a.midX, a.midY], [400, 40, 360, 40, 380, 60]); // X200 Y20 → X180 Y20 over X190 Y30
});

test("front-back: shapes land at the hand-worked places", () => {
  const s = setup("fb");
  const c = mirrorShape(circle(), s);
  assert.deepEqual([c.x, c.y, c.w], [60, 190, 10]);                      // centre X30 Y95
  const r = mirrorShape(rect(), s);
  assert.deepEqual(r.points, [{ x: 60, y: 200 }, { x: 140, y: 200 }, { x: 140, y: 160 }, { x: 60, y: 160 }]); // X30…70, Y100…80
  const a = mirrorShape(arc(), s);
  assert.deepEqual([a.x, a.y, a.x + a.w, a.y + a.h, a.midX, a.midY], [80, 200, 120, 200, 100, 180]); // X40 Y100 → X60 Y100 over X50 Y90
});

test("a pocket keeps its distance to the stock edges it was measured from", () => {
  // pocket X30…70: 10 mm from the left edge, 150 mm from the right edge. After left-right: 150 from the left, 10 from the right
  const b = shapeBounds(mirrorShape(rect(), setup("lr")))!;
  near(b.minX / 2 - 20, 150); near(220 - b.maxX / 2, 10);
  near(b.minY / 2, 20); near(b.maxY / 2, 40);
});

test("changing the setup keeps back shapes at the same place of the part", () => {
  const a = setup("lr"), b = setup("fb");
  // front feature at X30 Y25 → as back shape under "lr" at X210 Y25; under "fb" it must be at X30 Y95
  const back = mirrorShape(circle(), a);
  remapBackShape(back, a, b);
  assert.deepEqual([back.x, back.y], [60, 190]);
  // stock moved 10 mm to the right: line X120 → X130, the back shape moves 20 mm
  const moved = cloneSetup(a); moved.stock.x = 30;
  const back2 = mirrorShape(circle(), a);
  remapBackShape(back2, a, moved);
  assert.deepEqual([back2.x, back2.y], [460, 50]);                       // X230 = 2·130 − 30
  // nothing changes when the line stays
  const same = mirrorShape(circle(), a), before = JSON.stringify(same);
  remapBackShape(same, a, cloneSetup(a));
  assert.equal(JSON.stringify(same), before);
});

// ---------------------------------------------------------------------
// Dowel pins
// ---------------------------------------------------------------------

test("default pins: two on the turning line, inside the stock, away from the edge", () => {
  const lr = setup("lr"), m = pinMargin(6);
  assert.deepEqual(lr.pins, [{ x: 120, y: 10 + m }, { x: 120, y: 110 - m }]);
  const fb = setup("fb");
  assert.deepEqual(fb.pins, [{ x: 20 + m, y: 60 }, { x: 220 - m, y: 60 }]);
  assert.deepEqual(pinIssues(lr, [], { w: 300, h: 300 }), []);
  assert.deepEqual(pinIssues(fb, [], { w: 300, h: 300 }), []);
});

test("default pins move to the corners when a part covers the turning line", () => {
  const s = setup("lr");
  const pins = defaultPins(s, [{ minX: 60, minY: 12, maxX: 180, maxY: 108 }]);
  assert.equal(pins.length, 4);
  s.pins = pins;
  assert.deepEqual(pinIssues(s, [], null), []);                          // mirrored pairs: fits after turning
});

test("pins that are not mirrored are reported, each one by number", () => {
  const s = setup("lr");
  s.pins = [{ x: 40, y: 30 }, { x: 200, y: 30 }, { x: 60, y: 90 }];     // 1 and 2 are partners, 3 has none
  assert.deepEqual(pinIssues(s, [], null), [{ code: "asym", pin: 3 }]);
  s.pins = [{ x: 40, y: 30 }, { x: 200, y: 30.5 }];                      // half a millimetre off
  assert.deepEqual(pinIssues(s, [], null).map(i => i.code), ["asym", "asym"]);
  // the same pair is fine for left-right but wrong for front-back
  const fb = setup("fb");
  fb.pins = [{ x: 40, y: 30 }, { x: 200, y: 30 }];
  assert.deepEqual(pinIssues(fb, [], null).map(i => i.code), ["asym", "asym"]);
});

test("pins outside the stock or the bed are reported", () => {
  const s = setup("lr");
  s.pins = [{ x: 120, y: 12 }, { x: 120, y: 108 }];                      // 3 mm radius: Y12 reaches Y9, outside (edge Y10)
  assert.deepEqual(pinIssues(s, [], null), [{ code: "offStock", pin: 1 }, { code: "offStock", pin: 2 }]);
  const t2 = setup("lr");
  assert.deepEqual(pinIssues(t2, [], { w: 300, h: 100 }), [{ code: "offBed", pin: 2 }]); // pin 2 at Y101 on a 100 mm bed
});

test("pins inside a part or in a cut are reported – also where the hole lies after turning", () => {
  const s = setup("lr");
  const part: PinObstacle = { pts: [{ x: 100, y: 15 }, { x: 140, y: 15 }, { x: 140, y: 40 }, { x: 100, y: 40 }], closed: true, grow: 3 };
  assert.deepEqual(pinIssues(s, [part], null), [{ code: "inPart", pin: 1 }]);
  // a cut line passing 4 mm beside the pin with a 6 mm cutter (grow 3): 3 + 3 > 4
  const line: PinObstacle = { pts: [{ x: 124, y: 80 }, { x: 124, y: 109 }], closed: false, grow: 3 };
  assert.deepEqual(pinIssues(s, [line], null), [{ code: "inPart", pin: 2 }]);
  // pair pins: the part only covers the mirrored place of pin 1 (= pin 2), both holes are in it after turning
  s.pins = [{ x: 40, y: 60 }, { x: 200, y: 60 }];
  const right: PinObstacle = { pts: [{ x: 190, y: 50 }, { x: 210, y: 50 }, { x: 210, y: 70 }, { x: 190, y: 70 }], closed: true, grow: 0 };
  assert.deepEqual(pinIssues(s, [right], null), [{ code: "inPart", pin: 1 }, { code: "inPart", pin: 2 }]);
});

test("one pin, or pins all at one spot, do not line anything up", () => {
  const s = setup("lr");
  s.pins = [{ x: 120, y: 60 }];
  assert.deepEqual(pinIssues(s, [], null), [{ code: "few", pin: 0 }]);
  s.pins = [{ x: 120, y: 55 }, { x: 120, y: 65 }];
  assert.deepEqual(pinIssues(s, [], null), [{ code: "close", pin: 0 }]);
  s.pinsOn = false;
  assert.deepEqual(pinIssues(s, [], null), []);
});

test("how the pin hole is cut depends on the tool", () => {
  assert.equal(pinCut(6, 6, false), "drill");       // same diameter: straight down
  assert.equal(pinCut(6, 6.03, true), "drill");
  assert.equal(pinCut(6, 4, false), "inside");      // circle path, no core left (6 < 2·4)
  assert.equal(pinCut(6, 3, false), "inside");      // 6 = 2·3: the cutter just reaches the centre
  assert.equal(pinCut(8, 3, false), "pocket");      // 8 > 2·3: a core would stay → clear it
  assert.equal(pinCut(6, 8, false), "tooBig");
  assert.equal(pinCut(6, 3, true), "tooBig");       // a 3 mm drill cannot make a 6 mm hole
});

test("setup from a file is cleaned", () => {
  assert.equal(cleanSetup(null), null);
  const s = cleanSetup({ on: true, flip: "<b>", stock: { x: "7", y: null, w: -5, h: 1e9 }, thickness: "abc", zRef: "x", pinDia: 0, pinDepth: 999,
    pins: [{ x: 1, y: 2 }, { x: "n", y: 2 }, null, ...Array.from({ length: 30 }, (_, i) => ({ x: i, y: i }))], pinToolId: 5 })!;
  assert.equal(s.flip, "lr");
  assert.deepEqual(s.stock, { x: 7, y: 0, w: 1, h: 1e5 });
  assert.equal(s.thickness, 18);
  assert.equal(s.zRef, "spoil");
  assert.equal(s.pinDia, 0.5);
  assert.equal(s.pinDepth, 100);
  assert.equal(s.pins.length, MAX_PINS);
  assert.equal(s.pinToolId, undefined);
});

// ---------------------------------------------------------------------
// Depths of both sides (all cuts in the front frame, thickness 18 mm)
// ---------------------------------------------------------------------

const T = 18;
const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const area = (side: "front" | "back", n: number, pts: { x: number; y: number }[], depth: number): Removal =>
  ({ side, n, kind: "area", pts, closed: true, depth, width: 0, outline: false, tabH: 0 });
const outline = (side: "front" | "back", n: number, depth: number, tabH = 0, pts = sq(40, 20, 160, 90)): Removal =>
  ({ side, n, kind: "groove", pts, closed: true, depth, width: 6, outline: true, tabH });

test("pocket front, pocket back, through outline from the back: nothing to report", () => {
  const list = [area("front", 1, sq(50, 30, 90, 60), 5), area("back", 1, sq(100, 30, 150, 60), 6), outline("back", 2, 18.2, 1.5)];
  assert.deepEqual(depthIssues(list, T), []);
  // even when the pockets lie over each other: 5 + 6 = 11 of 18, 7 mm stay
  list[1] = area("back", 1, sq(60, 35, 120, 55), 6);
  assert.deepEqual(depthIssues(list, T), []);
});

test("two pockets that meet inside the material are reported", () => {
  const f = area("front", 1, sq(50, 30, 90, 60), 10), b = area("back", 3, sq(60, 35, 120, 55), 8);
  assert.deepEqual(depthIssues([f, b], T), [{ code: "through", front: 1, back: 3, left: 0 }]);
  b.depth = 7.8;                                                         // 0.2 mm skin
  const thin = depthIssues([f, b], T);
  assert.equal(thin[0].code, "thin"); near(thin[0].left, 0.2, 1e-9);
  b.depth = 7;                                                           // 1 mm left: fine
  assert.deepEqual(depthIssues([f, b], T), []);
  // side by side, not touching: no matter how deep
  assert.deepEqual(depthIssues([area("front", 1, sq(50, 30, 90, 60), 12), area("back", 1, sq(100, 30, 150, 60), 12)], T), []);
  // a small pocket fully inside a big one is found too
  assert.equal(depthIssues([area("front", 1, sq(50, 30, 150, 80), 10), area("back", 1, sq(90, 50, 100, 60), 9)], T)[0].code, "through");
});

test("the front must not cut a part free without tabs", () => {
  assert.deepEqual(depthIssues([outline("front", 4, 18)], T), [{ code: "looseFront", front: 4, back: 0, left: 0 }]);
  assert.deepEqual(depthIssues([outline("front", 4, 18, 1.5)], T), []);  // tabs hold it
  assert.deepEqual(depthIssues([outline("front", 4, 12)], T), []);       // not through
  assert.deepEqual(depthIssues([outline("back", 4, 18.2)], T), []);      // from the back that is the normal last cut
});

test("the same outline from both sides: loose without tabs, fine with tabs", () => {
  // 10 from the front + 8.2 from the back = 18.2 → through, 0.2 overlap
  assert.deepEqual(depthIssues([outline("front", 1, 10), outline("back", 2, 8.2)], T), [{ code: "loose", front: 1, back: 2, left: 0 }]);
  assert.deepEqual(depthIssues([outline("front", 1, 10), outline("back", 2, 8.2, 1.5)], T), []);  // 1.3 mm of the tabs stay
  assert.deepEqual(depthIssues([outline("front", 1, 10, 1.5), outline("back", 2, 8.2)], T), []);  // tabs left by the front count too
  // overlap 1.4 mm eats a 1.5 mm tab down to 0.1
  const eaten = depthIssues([outline("front", 1, 10), outline("back", 2, 9.4, 1.5)], T);
  assert.equal(eaten[0].code, "tabsThin"); near(eaten[0].left, 0.1, 1e-9);
  // not yet through: 10 + 7.8 → 0.2 mm skin all around
  assert.equal(depthIssues([outline("front", 1, 10), outline("back", 2, 7.8)], T)[0].code, "thin");
  // back outline with a 3 mm cutter instead of 6: still the same contour
  const thinTool = outline("back", 2, 8.2); thinTool.width = 3;
  assert.equal(depthIssues([outline("front", 1, 10), thinTool], T)[0].code, "loose");
});

test("through cut from the back subtracts what the front already removed", () => {
  near(throughDepth(18, 0), 18.2);
  near(throughDepth(18, 10), 8.2);          // front cut 10 deep: 8 left + 0.2 extra
  near(throughDepth(18, 25), 0.2);          // front already through
  near(throughDepth(18, 10, 0), 8);
  const back = outline("back", 2, 1);
  near(otherSideDepth(back, [outline("front", 1, 10), area("front", 2, sq(50, 30, 90, 60), 5), back]), 10);
  // a pocket that only touches part of the outline does not count
  near(otherSideDepth(back, [area("front", 2, sq(30, 10, 60, 40), 5)]), 0);
  // a facing pass over everything does
  near(otherSideDepth(back, [area("front", 3, sq(0, 0, 250, 150), 2)]), 2);
});

// ---------------------------------------------------------------------
// Texts: the notes at the top of both programs must pass the G-code check in every language
// ---------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { lintGcode } from "../src/gcodeLint.ts";

test("G-code notes of two-sided milling are clean in all 7 languages", () => {
  const langs = ["de", "en", "fr", "es", "it", "nl", "pl"];
  const en = JSON.parse(readFileSync(new URL("../src/i18n/lang/en.json", import.meta.url), "utf8"));
  const keys = Object.keys(en).filter(k => k.startsWith("two.") || k.startsWith("sheet.two."));
  assert.ok(keys.length > 100);
  for (const l of langs) {
    const d = JSON.parse(readFileSync(new URL(`../src/i18n/lang/${l}.json`, import.meta.url), "utf8"));
    for (const k of keys) assert.equal(typeof d[k], "string", `${l}: ${k} is missing`);
    for (const k of keys.filter(x => x.startsWith("two.gc."))) {
      for (const turn of [d["two.gc.turnLr"], d["two.gc.turnFb"]]) {
        const text = d[k].replace("{turn}", turn).replace("{n}", "2").replace("{d}", "6").replace("{depth}", "8").replace("{t}", "18");
        const issues = lintGcode(`(${text})\nG21\nM30`, { kind: "mill" }).map(i => i.rule);
        assert.deepEqual(issues, [], `${l}: ${k} → ${text}`);
        assert.ok(text.length <= 75, `${l}: ${k} is too long`);
      }
    }
  }
});
