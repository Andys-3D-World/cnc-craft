// Tests for the onion skin (router): passes, the last cut, combinations and the notes in the G-code – run with `npm test`
// All depths are worked out by hand in the comments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  skinSettings, skinFits, skinRole, depthPasses, skinPlan, skinFeed, skinNotePatterns, skinFromGcode,
  SKIN_DEFAULT, SKIN_MIN, SKIN_MAX, SKIN_FEED_MIN, type SkinSettings,
} from "../src/onionSkin.ts";
import { depthIssues, type Removal } from "../src/twoSided.ts";
import { lintGcode } from "../src/gcodeLint.ts";

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const nearAll = (a: number[], b: number[]) => { assert.equal(a.length, b.length, `${a} vs ${b}`); a.forEach((v, i) => near(v, b[i])); };
const stay = (h = 0.3): SkinSettings => ({ h, cut: false, feed: 0 });
const cut = (h = 0.3, feed = 0): SkinSettings => ({ h, cut: true, feed });

const square = { type: "polyline", closed: true, points: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }] };

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

test("off by default: a shape without skinH has no onion skin (old projects)", () => {
  assert.equal(skinSettings({}), null);
  assert.equal(skinSettings(null), null);
  assert.equal(skinSettings({ skinCut: true, skinFeed: 300 }), null);   // the last cut alone means nothing
  assert.equal(skinSettings({ skinH: 0 }), null);                        // a skin of 0 is "off"
  assert.equal(skinSettings({ skinH: -1 }), null);
  assert.equal(skinSettings({ skinH: "abc" }), null);
  assert.equal(skinSettings({ skinH: null }), null);
});

test("settings from project files are cleaned and limited", () => {
  assert.deepEqual(skinSettings({ skinH: 0.3 }), { h: 0.3, cut: false, feed: 0 });
  assert.deepEqual(skinSettings({ skinH: "0.5", skinCut: true, skinFeed: "250" }), { h: 0.5, cut: true, feed: 250 });
  assert.equal(skinSettings({ skinH: 99 })!.h, SKIN_MAX);
  assert.equal(skinSettings({ skinH: 0.001 })!.h, SKIN_MIN);
  assert.equal(skinSettings({ skinH: 0.3, skinCut: "yes" })!.cut, false);  // only a real true counts
  assert.equal(skinSettings({ skinH: 0.3, skinFeed: 1 })!.feed, SKIN_FEED_MIN);
  assert.equal(skinSettings({ skinH: 0.3, skinFeed: -5 })!.feed, 0);
  assert.equal(SKIN_DEFAULT, 0.3);
});

// ---------------------------------------------------------------------
// Passes – numbers by hand
// ---------------------------------------------------------------------

test("depth passes without a skin are the scheme the router always used", () => {
  nearAll(depthPasses(-6, 2), [-2, -4, -6]);
  nearAll(depthPasses(-5, 2), [-2, -4, -5]);          // the last pass takes what is left
  nearAll(depthPasses(-1, 1.5), [-1]);
  assert.deepEqual(depthPasses(0, 2), [0]);
  assert.deepEqual(depthPasses(0.5, 2), [0.5]);
});

test("6 mm material, 2 mm per pass, 0.3 mm skin: passes -2 / -4 / -5.7, the skin stays", () => {
  // underside at -6; skin 0.3 → deepest pass at -(6 - 0.3) = -5.7; full 2 mm steps above it
  const { plan, problem } = skinPlan(-6, 2, stay(0.3));
  assert.equal(problem, null);
  nearAll(plan!.passes, [-2, -4, -5.7]);
  near(plan!.floor, -5.7);
  near(plan!.through, -6);
  near(plan!.stock, 6);
  near(plan!.skin, 0.3);
  assert.deepEqual(plan!.final, []);                  // no last cut asked for
  near(Math.min(...plan!.passes), -(6 - 0.3));        // deepest Z = thickness minus skin
});

test("the same cut with the skin cut at the end: one last pass from -5.7 down to -6", () => {
  const { plan } = skinPlan(-6, 2, cut(0.3));
  nearAll(plan!.passes, [-2, -4, -5.7]);
  nearAll(plan!.final, [-6]);
});

test("12 mm plywood, 2.5 mm per pass, 0.5 mm skin: -2.5 / -5 / -7.5 / -10 / -11.5, then -12", () => {
  // 12 - 0.5 = 11.5; steps of 2.5: 2.5, 5, 7.5, 10 and the rest of 1.5 down to 11.5
  const { plan } = skinPlan(-12, 2.5, cut(0.5));
  nearAll(plan!.passes, [-2.5, -5, -7.5, -10, -11.5]);
  nearAll(plan!.final, [-12]);
});

test("18 mm, 3 mm per pass, 0.3 mm skin: five full passes and one of 2.7 mm", () => {
  const { plan } = skinPlan(-18, 3, stay(0.3));
  nearAll(plan!.passes, [-3, -6, -9, -12, -15, -17.7]);
});

test("no tiny extra pass: 6.3 mm with 0.3 mm skin ends exactly on the third 2 mm step", () => {
  const { plan } = skinPlan(-6.3, 2, stay(0.3));
  nearAll(plan!.passes, [-2, -4, -6]);
});

test("a cut shallower than one step: 3 mm material, 5 mm per pass, 0.3 mm skin → one pass at -2.7", () => {
  const { plan } = skinPlan(-3, 5, cut(0.3));
  nearAll(plan!.passes, [-2.7]);
  nearAll(plan!.final, [-3]);
});

test("the cutter never goes below the shape's cut depth, and the skin is never thinner than asked", () => {
  for (const depth of [-1, -3, -6, -6.35, -12.7, -18, -19.05, -40]) {
    for (const step of [0.5, 1, 1.5, 2, 3, 6.35]) {
      for (const h of [0.05, 0.1, 0.3, 0.3048, 0.5, 1, 2.5]) {
        const { plan } = skinPlan(depth, step, cut(h));
        if (!plan) { assert.ok(h >= -depth - 0.011, `${depth}/${step}/${h}`); continue; }
        const all = [...plan.passes, ...plan.final];
        assert.ok(Math.min(...all) >= depth - 1e-9, `deeper than the depth: ${depth}/${step}/${h}`);
        near(all[all.length - 1], depth);                                  // the last cut ends on the depth
        assert.ok(plan.passes.every(z => z >= plan.floor - 1e-9));           // normal passes stay on the skin
        assert.ok(plan.skin >= h - 1e-9 && plan.skin <= h + 0.01 + 1e-9, `skin ${plan.skin} for ${h}`);
        // every step, normal or last, is at most one depth step
        let prev = 0;
        for (const z of all) { assert.ok(prev - z <= step + 1e-9, `step too deep: ${depth}/${step}/${h}`); assert.ok(z < prev); prev = z; }
      }
    }
  }
});

test("inch values: 1/4 in material, 0.012 in skin – the floor is rounded towards the thicker skin", () => {
  // 6.35 mm − 0.3048 mm = 6.0452 → rounded up to -6.04 (a circle's depth is written with two decimals)
  const { plan } = skinPlan(-6.35, 2, stay(0.3048));
  near(plan!.floor, -6.04);
  near(plan!.skin, 0.31);
  nearAll(plan!.passes, [-2, -4, -6, -6.04]);
});

// ---------------------------------------------------------------------
// Combinations that make no sense
// ---------------------------------------------------------------------

test("skin as thick as the cut is deep: nothing to cut, the shape is left out", () => {
  assert.deepEqual(skinPlan(-0.3, 1, stay(0.3)), { plan: null, problem: "tooThick" });
  assert.deepEqual(skinPlan(-0.2, 1, stay(0.3)), { plan: null, problem: "tooThick" });
  assert.deepEqual(skinPlan(0, 1, stay(0.3)), { plan: null, problem: "tooThick" });
  assert.deepEqual(skinPlan(1, 1, stay(0.3)), { plan: null, problem: "tooThick" });
  // 0.4 deep, 0.3 skin: 0.1 mm is still cut
  nearAll(skinPlan(-0.4, 1, stay(0.3)).plan!.passes, [-0.1]);
});

test("skin thicker than one depth step: a note, and the last cut goes down in steps", () => {
  // 6 mm, 1 mm per pass, 2.5 mm skin: floor -3.5 → -1 / -2 / -3 / -3.5; last cut -4.5 / -5.5 / -6
  const r = skinPlan(-6, 1, cut(2.5));
  assert.equal(r.problem, "thick");
  nearAll(r.plan!.passes, [-1, -2, -3, -3.5]);
  nearAll(r.plan!.final, [-4.5, -5.5, -6]);
  assert.equal(skinPlan(-6, 2, cut(2)).problem, null);   // exactly one step is fine
});

// ---------------------------------------------------------------------
// Two-sided milling: the real thickness is known
// ---------------------------------------------------------------------

test("two-sided: the skin is measured from the real underside, not from the over-deep 'cut through' depth", () => {
  // stock 18 mm, 'cut through' sets the depth to 18.2. Skin 0.3 → floor -17.7 (not -17.9); last cut to -18.2
  const { plan, problem } = skinPlan(-18.2, 3, cut(0.3), 18);
  assert.equal(problem, null);
  near(plan!.floor, -17.7);
  near(plan!.stock, 18);
  near(plan!.skin, 0.3);
  nearAll(plan!.passes, [-3, -6, -9, -12, -15, -17.7]);
  nearAll(plan!.final, [-18.2]);
});

test("two-sided: the other side already cut 10 of 18 mm there → 8 mm are left, the skin sits at -7.7", () => {
  const { plan } = skinPlan(-8.2, 3, stay(0.3), 8);
  near(plan!.floor, -7.7);
  nearAll(plan!.passes, [-3, -6, -7.7]);
});

test("two-sided: a skin on a cut that does not go through is refused (cut as always, with a warning)", () => {
  assert.deepEqual(skinPlan(-10, 3, stay(0.3), 18), { plan: null, problem: "notThrough" });
  assert.equal(skinPlan(-17.99, 3, stay(0.3), 18).problem, "notThrough");
  assert.equal(skinPlan(-18, 3, stay(0.3), 18).problem, null);
});

const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const outline = (side: "front" | "back", n: number, depth: number, extra: Partial<Removal> = {}): Removal =>
  ({ side, n, kind: "groove", pts: sq(40, 20, 160, 90), closed: true, depth, width: 6, outline: true, tabH: 0, ...extra });

test("two-sided: an outline held by its skin is not 'loose' – cut through without tabs it is", () => {
  const T = 18;
  assert.deepEqual(depthIssues([outline("front", 1, 18.2)], T), [{ code: "looseFront", front: 1, back: 0, left: 0 }]);
  // with a 0.3 mm skin that stays the front cut ends at 17.7
  assert.deepEqual(depthIssues([outline("front", 1, 17.7, { skin: 0.3 })], T), []);
});

test("two-sided: the wanted skin between two cuts is not reported as 'thin', a damaged one is", () => {
  const T = 18;
  // front 10 mm, back to 7.7 (skin 0.3 measured from the 8 mm that are left): 0.3 mm stay on purpose
  assert.deepEqual(depthIssues([outline("front", 1, 10), outline("back", 2, 7.7, { skin: 0.3 })], T), []);
  // the front cuts 0.1 mm deeper than planned: only 0.2 mm of the skin is left → reported
  const r = depthIssues([outline("front", 1, 10.1), outline("back", 2, 7.7, { skin: 0.3 })], T);
  assert.equal(r.length, 1);
  assert.equal(r[0].code, "thin");
  near(r[0].left, 0.2, 1e-6);
});

// ---------------------------------------------------------------------
// Which cut gets the skin
// ---------------------------------------------------------------------

test("only closed shapes cut outside or inside can have a skin", () => {
  assert.equal(skinFits({ ...square, millingMode: "outside" }), true);
  assert.equal(skinFits({ ...square }), true);                              // no mode = outside
  assert.equal(skinFits({ ...square, millingMode: "inside" }), true);       // the waste piece in a hole is held too
  assert.equal(skinFits({ type: "circle", millingMode: "inside" }), true);
  assert.equal(skinFits({ ...square, millingMode: "pocket" }), false);
  assert.equal(skinFits({ ...square, millingMode: "drill" }), false);
  assert.equal(skinFits({ ...square, millingMode: "on-line" }), false);
  assert.equal(skinFits({ ...square, closed: false, millingMode: "outside" }), false);
  assert.equal(skinFits({ type: "line", millingMode: "outside" }), false);
  assert.equal(skinFits({ type: "arc", millingMode: "outside" }), false);
  // a pocket that is also cut out by a further operation
  assert.equal(skinFits({ ...square, millingMode: "pocket", ops: [{ kind: "outside", depth: -6 }] }), true);
});

test("role of a cut: skin, plain, or a skin that does nothing", () => {
  assert.equal(skinRole({ ...square, millingMode: "outside", millingDepth: -6 }), "plain");               // no skin set
  assert.equal(skinRole({ ...square, millingMode: "outside", millingDepth: -6, skinH: 0.3 }), "skin");
  assert.equal(skinRole({ ...square, millingMode: "inside", millingDepth: -6, skinH: 0.3 }), "skin");
  assert.equal(skinRole({ ...square, millingMode: "pocket", millingDepth: -3, skinH: 0.3 }), "ignored");
  assert.equal(skinRole({ ...square, closed: false, millingMode: "outside", skinH: 0.3 }), "ignored");
  assert.equal(skinRole({ type: "line", skinH: 0.3 }), "ignored");
  // rest machining of a shape never gets a skin of its own
  assert.equal(skinRole({ restOf: {}, millingMode: "inside", skinH: 0.3 }), "plain");
});

test("several operations on one shape: only the contour that goes through gets the skin", () => {
  // pocket 3 mm, chamfer, then cut out 6 mm deep – as copies like ops.ts makes them
  const base = { ...square, millingMode: "pocket", millingDepth: -3, skinH: 0.3, ops: [{ kind: "chamfer", depth: -1 }, { kind: "outside", depth: -6 }] };
  assert.equal(skinRole(base), "plain");                                             // the pocket itself: no skin, no warning
  assert.equal(skinRole({ ...base, opOf: base, millingMode: "chamfer", millingDepth: -1 }), "plain");
  assert.equal(skinRole({ ...base, opOf: base, millingMode: "outside", millingDepth: -6 }), "skin");
  // a step: outside 3 mm deep first, then outside 6 mm deep. Only the deep one goes through
  const step = { ...square, millingMode: "outside", millingDepth: -3, skinH: 0.3, ops: [{ kind: "outside", depth: -6 }] };
  assert.equal(skinRole(step), "plain");
  assert.equal(skinRole({ ...step, opOf: step, millingMode: "outside", millingDepth: -6 }), "skin");
  // two contours of the same depth (rough and fine cutter): both must leave the skin, or the second cuts through
  const twice = { ...square, millingMode: "outside", millingDepth: -6, skinH: 0.3, ops: [{ kind: "outside", depth: -6 }] };
  assert.equal(skinRole(twice), "skin");
  assert.equal(skinRole({ ...twice, opOf: twice, millingMode: "outside", millingDepth: -6 }), "skin");
});

// ---------------------------------------------------------------------
// Feed of the last cut
// ---------------------------------------------------------------------

test("feed of the last cut: half the normal feed, or the wish – never faster than normal", () => {
  assert.equal(skinFeed(cut(0.3), 800), 400);
  assert.equal(skinFeed(cut(0.3, 250), 800), 250);
  assert.equal(skinFeed(cut(0.3, 2000), 800), 800);    // a wish above the normal feed is capped
  assert.equal(skinFeed(cut(0.3), 15), SKIN_FEED_MIN);  // not slower than the lowest feed …
  assert.equal(skinFeed(cut(0.3), 6), 6);               // … unless the normal feed itself is slower
});

// ---------------------------------------------------------------------
// Notes in the G-code: clean for the checker and readable again, in all 7 languages
// ---------------------------------------------------------------------

const LANGS = ["de", "en", "fr", "es", "it", "nl", "pl"];
const lang = (l: string) => JSON.parse(readFileSync(new URL(`../src/i18n/lang/${l}.json`, import.meta.url), "utf8"));
const KEYS = ["rp.skin", "rp.skinTip", "rp.skinCut", "rp.skinCutTip", "rp.skinFeed", "rp.skinFeedTip", "rp.skinAuto",
  "gc.skin", "gc.skinCutAll", "gc.skinCut", "gcw.skinTooThick", "gcw.skinNotThrough", "gcw.skinThick", "gcw.skinIgnored",
  "sheet.skin", "sheet.skinStay", "sheet.skinCut"];
const fill = (s: string, p: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => p[k] ?? `{${k}}`);

test("all texts exist in all 7 languages with the same placeholders", () => {
  const en = lang("en");
  for (const l of LANGS) {
    const d = lang(l);
    for (const k of KEYS) {
      assert.equal(typeof d[k], "string", `${l}: ${k} is missing`);
      const ph = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join();
      assert.equal(ph(d[k]), ph(en[k]), `${l}: ${k} placeholders`);
    }
    // lengths convert with the unit switch only when the label names the unit
    assert.ok(d["rp.skin"].includes("(mm)"), `${l}: rp.skin`);
    assert.ok(d["rp.skinFeed"].includes("(mm/min)"), `${l}: rp.skinFeed`);
  }
});

test("G-code notes are plain ASCII, short and pass the G-code check in all 7 languages", () => {
  for (const l of LANGS) {
    const d = lang(l);
    const notes = [fill(d["gc.skin"], { h: "0.30", t: "18.00" }), d["gc.skinCutAll"], fill(d["gc.skinCut"], { n: "123" })];
    for (const text of notes) {
      assert.deepEqual(lintGcode(`(${text})\nG21\nM30`, { kind: "mill" }).map(i => i.rule), [], `${l}: ${text}`);
      assert.ok(text.length <= 75, `${l}: too long: ${text}`);
    }
    // the heading of a last cut is a "(--- … ---)" marker: the setup sheet lists it as an operation of its own
    assert.match(`(${notes[2]})`, /^\(-{2,}\s*.*?\s*-*\)$/);
  }
});

test("the simulation and the setup sheet read the skin back from a program in any language", () => {
  const pats = skinNotePatterns(LANGS.map(l => lang(l)["gc.skin"]), LANGS.map(l => lang(l)["gc.skinCut"]));
  for (const l of LANGS) {
    const d = lang(l);
    const program = [
      "G21", "G90",
      `(${fill(d["gc.shape"], { n: "1", type: "CIRCLE", mode: "inside" })})`,
      `(${fill(d["gc.skin"], { h: "0.30", t: "6.00" })})`,
      "G1 Z-5.700 F300",
      `(${fill(d["gc.shape"], { n: "2", type: "POLYLINE", mode: "outside" })})`,
      `(${fill(d["gc.skin"], { h: "0.50", t: "12.00" })})`,
      "G1 Z-11.500 F300",
      `(${d["gc.skinCutAll"]})`,
      `(${fill(d["gc.skinCut"], { n: "2" })})`,
      "G1 Z-12.000 F150",
      "M30",
    ];
    assert.deepEqual(skinFromGcode(program, pats), { stock: 12, hMin: 0.3, hMax: 0.5, shapes: 2, cut: 1 }, l);
  }
  // a program without a skin, and other comments with numbers
  assert.equal(skinFromGcode(["G21", "(tool: end mill, diameter 6.0 mm)", "G1 Z-6.000 F300", "M30"], pats), null);
  assert.equal(skinFromGcode([], pats), null);
});

// ---------------------------------------------------------------------
// Setup sheet
// ---------------------------------------------------------------------

import { sheetHtml } from "../src/setupSheet.ts";

test("setup sheet: the onion skin has its own row, only when there is one, and foreign text stays harmless", () => {
  const base = {
    title: "t", date: "d", tools: [], toolsNote: "", stock: "300 × 300", partSize: "", time: "", timeBasis: "", zero: "", zeroZ: "", wcs: "",
    ops: [], changes: [], warnings: [], zones: [], svg: ""
  };
  const tr = (k: string) => k;
  assert.ok(!sheetHtml(base, tr).includes("sheet.skin"));
  const html = sheetHtml({ ...base, skin: "0.30 mm stay <b>" }, tr);
  assert.ok(html.includes("<th>sheet.skin</th><td>0.30 mm stay &lt;b&gt;</td>"));
  // two-sided: the row belongs to the side whose program leaves the skin
  const side = (name: string, skin?: string) => ({ name, time: "", partSize: "", tools: [], ops: [], changes: [], warnings: [], svg: "", ...(skin ? { skin } : {}) });
  const two = sheetHtml({ ...base, two: { rows: [], pins: [], steps: [], sides: [side("FRONT", "0.30 mm stay"), side("BACK")] } }, tr);
  assert.equal((two.match(/sheet\.skin/g) || []).length, 1);
  assert.ok(two.indexOf("sheet.skin") > two.indexOf("FRONT") && two.indexOf("sheet.skin") < two.indexOf("BACK"));
});
