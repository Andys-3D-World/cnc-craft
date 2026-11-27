// sin, cos, tan, acos, asin, atan, atan2, pow as node calculated them on the developer's Mac, bit by bit (fixtures/jsmath.json).
// `cargo test jsmath` checks that src-tauri/src/jsmath.rs (libm) is never more than one last digit away from these.
// node itself may differ by one last digit on another processor, so this test allows the same.
// To write the file again:  UPDATE_FIXTURES=1 npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("./fixtures/jsmath.json", import.meta.url);
const hex = (v: number) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b.toString("hex"); };

function table() {
  let s = 2463534242;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const out: Record<string, [string, string, string][]> = {};
  const one = (name: string, f: (a: number) => number, make: () => number, fixed: number[]) => {
    out[name] = [...fixed, ...Array.from({ length: 500 }, make)].map(a => [hex(a), hex(0), hex(f(a))]);
  };
  const angle = () => { const k = rnd(); return k < 0.6 ? (rnd() - 0.5) * 4 * Math.PI : k < 0.8 ? (rnd() - 0.5) * 1e-3 : k < 0.95 ? (rnd() - 0.5) * 2000 : (rnd() - 0.5) * 1e9; };
  const unit = () => { const k = rnd(); return k < 0.7 ? rnd() * 2 - 1 : k < 0.85 ? 1 - rnd() * 1e-6 : rnd() * 1e-6 - 1; };
  const special = [0, -0, 1, -1, 0.5, Math.PI, Math.PI / 2, Math.PI / 4, 2 * Math.PI, 1e-10, 1e300];
  one("sin", Math.sin, angle, special);
  one("cos", Math.cos, angle, special);
  one("tan", Math.tan, angle, special);
  one("acos", Math.acos, unit, [0, -0, 1, -1, 0.5, -0.5, 1 - 1e-12, 0.999999]);
  one("asin", Math.asin, unit, [0, -0, 1, -1, 0.5, -0.5]);
  one("atan", Math.atan, () => (rnd() - 0.5) * (rnd() < 0.5 ? 4 : 1e6), [0, -0, 1, -1, 1e300, -1e300]);
  const pairs: [number, number][] = [[0, 0], [0, -0], [-0, -0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1e-300, 1e300]];
  for (let i = 0; i < 500; i++) { const m = rnd() < 0.5 ? 1 : 1e-6; pairs.push([(rnd() - 0.5) * 200 * m, (rnd() - 0.5) * 200]); }
  out.atan2 = pairs.map(([y, x]) => [hex(y), hex(x), hex(Math.atan2(y, x))]);
  // powers as the image adjustment uses them: brightness 0…1 to the power 1 / gamma
  const pw: [number, number][] = [[0, 0.5], [1, 0.5], [0.5, 1], [0.25, 0.5], [0, 0], [1, 10], [2, 0.5], [0.5, 1 / 0.55]];
  for (let i = 0; i < 1500; i++) pw.push([rnd() < 0.8 ? Math.fround(rnd()) : rnd() * 3, rnd() < 0.5 ? 1 / (0.1 + rnd() * 2.9) : rnd() * 10]);
  out.pow = pw.map(([x, y]) => [hex(x), hex(y), hex(Math.pow(x, y))]);
  return out;
}

test("sin, cos, tan, acos, asin, atan, atan2, pow are at most one last digit away from the pinned numbers", () => {
  const now = table();
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, JSON.stringify(now).replace(/\],\[/g, "],\n[") + "\n");
  const pinned: typeof now = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(now), Object.keys(pinned));
  const int = (h: string) => BigInt("0x" + h);
  for (const name of Object.keys(now)) {
    assert.equal(now[name].length, pinned[name].length, name);
    now[name].forEach((row, i) => {
      assert.deepEqual(row.slice(0, 2), pinned[name][i].slice(0, 2), `${name} input ${i}`);
      const d = int(row[2]) - int(pinned[name][i][2]);
      assert.ok(d >= -1n && d <= 1n, `${name} value ${i}: ${row[2]} / ${pinned[name][i][2]}`);
    });
  }
});
