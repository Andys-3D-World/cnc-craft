// Checked post steps (src/camPost.ts): what counts as "the same result" between the TypeScript and Rust
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameDeep, firstDiff, nearLines, recordPost, notePost, takePost, checkPost } from "../src/camPost.ts";

test("steps are only remembered while recording", () => {
  notePost("a", {}, 1);
  assert.deepEqual(takePost(), []);
  recordPost();
  notePost("post_keepouts", { gcode: "G0 X0" }, { gcode: "G0 X0", raised: 0 });
  notePost("post_rotary", { lines: [] }, { ok: true, lines: [] });
  assert.deepEqual(takePost().map(s => s.cmd), ["post_keepouts", "post_rotary"]);
  notePost("b", {}, 2);
  assert.deepEqual(takePost(), []);
});

test("same result: every field, order of fields does not matter, missing and undefined are the same", () => {
  assert.ok(sameDeep({ gcode: "a\nb", raised: 2, hits: [{ zone: 0, label: "x", line: 3, kind: "cut" }], unsure: false },
    { unsure: false, hits: [{ kind: "cut", line: 3, label: "x", zone: 0 }], raised: 2, gcode: "a\nb" }));
  assert.ok(sameDeep({ ok: true, lines: ["a"], extra: undefined }, { ok: true, lines: ["a"] }));
  assert.ok(!sameDeep({ ok: true, lines: ["a"] }, { ok: true, lines: ["a", "b"] }));
  assert.ok(!sameDeep({ ok: false, error: "arc", line: 3 }, { ok: false, error: "arc", line: 4 }));
  assert.ok(!sameDeep({ raised: 1 }, { raised: "1" }));
  assert.ok(!sameDeep([1, 2], { 0: 1, 1: 2 }));
  assert.ok(sameDeep(NaN, NaN) && !sameDeep(null, undefined) && !sameDeep(0, null));
});

test("the first difference names the line or the field", () => {
  assert.equal(firstDiff({ gcode: "a\nb\nc" }, { gcode: "a\nx\nc" }), 'line 2: Rust "x", TypeScript "b"');
  assert.equal(firstDiff({ gcode: "a" }, { gcode: "a\nb" }), 'line 2: Rust "b", TypeScript "<end>"');
  assert.match(firstDiff({ gcode: "a", raised: 1 }, { gcode: "a", raised: 2 }), /^raised: Rust 2, TypeScript 1$/);
});

test("only the last digit differs: counted, but a real difference is never passed off as that", () => {
  const ts = { ok: true, lines: ["G1 X1.2345 A10.0001 F600", "G1 X2 A20", ...Array(300).fill("G1 X0")] };
  const rust = (l: string[]) => ({ ok: true, lines: [...l, ...Array(300).fill("G1 X0")] });
  assert.equal(nearLines(ts, rust(["G1 X1.2346 A10.0001 F601", "G1 X2 A20"])), 1);
  assert.equal(nearLines(ts, rust(["G1 X1.2345 A10.0001 F600", "G1 X2 A20"])), 0, "identical is not 'near'");
  assert.equal(nearLines(ts, rust(["G1 X1.2365 A10.0001 F600", "G1 X2 A20"])), 0, "two thousandths");
  assert.equal(nearLines(ts, rust(["G0 X1.2345 A10.0001 F600", "G1 X2 A20"])), 0, "another command");
  assert.equal(nearLines(ts, rust(["G1 Y1.2346 A10.0001 F600", "G1 X2 A20"])), 0, "another axis");
  assert.equal(nearLines(ts, rust(["G1 X1.2346 A10.0001", "G1 X2 A20"])), 0, "a word is missing");
  assert.equal(nearLines(ts, { ok: true, lines: ts.lines.slice(1) }), 0, "another number of lines");
  assert.equal(nearLines({ gcode: "G1 X1.000", raised: 1 }, { gcode: "G1 X1.001", raised: 2 }), 0, "another field differs");
  assert.equal(nearLines({ gcode: "G1 X1.000\nG1 X2.000" }, { gcode: "G1 X1.001\nG1 X2.001" }), 0, "too many lines for a coincidence");
  assert.equal(nearLines({ gcode: ["G1 X1.000", ...Array(250).fill("G0 Z5")].join("\n") }, { gcode: ["G1 X1.001", ...Array(250).fill("G0 Z5")].join("\n") }), 1);
});

test("without the app nothing is checked and nothing is reported", async () => {
  assert.equal(await checkPost([]), null);
  assert.equal(await checkPost([{ cmd: "post_keepouts", args: {}, result: { gcode: "" } }]), null);
});
