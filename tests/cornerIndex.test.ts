// Start corner for laser and plasma (cornerIndex in src/plasmaCam.ts): the sharpest corner, and of equally sharp
// corners the first one (Andreas, 28.11.2026). Before, the last digit of the calculation decided between corners that
// are equal on paper – on a regular polygon that could be any of them, and Rust might round it differently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// plasmaCam.ts imports without file endings and JSON without attribute (as under Vite) – the same hooks as rapidAvoidBed.test.ts
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && ctx.parentURL?.includes("/src/") && !/\.\w+$/.test(spec)) {
      const p = pathResolve(dirname(fileURLToPath(ctx.parentURL)), spec);
      if (existsSync(p + ".ts")) return { url: pathToFileURL(p + ".ts").href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.endsWith(".json")) return { format: "module", source: "export default " + readFileSync(fileURLToPath(url), "utf8"), shortCircuit: true };
    if (url.endsWith(".ts") && url.includes("/src/")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
    };
    return next(url, ctx);
  }
});
const g = globalThis as any, store = new Map<string, string>();
g.localStorage ??= { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
g.window ??= { dispatchEvent() {}, addEventListener() {} };
g.CustomEvent ??= class { type: string; constructor(type: string) { this.type = type; } };
g.Event ??= class { type: string; constructor(type: string) { this.type = type; } };
const { cornerIndex, CORNER_TIE } = await import("../src/plasmaCam.ts");

const poly = (n: number, r: number, a0: number) => Array.from({ length: n }, (_, i) => ({ x: 50 + r * Math.cos(a0 + (2 * Math.PI * i) / n), y: 50 + r * Math.sin(a0 + (2 * Math.PI * i) / n) }));

test("equally sharp corners: the first one wins", () => {
  // regular polygons at odd angles: all corners turn by the same angle, the computed values differ only in the last digits
  for (const [n, a0] of [[6, 0.3], [5, 1.234], [8, 0.1], [4, Math.PI / 7], [3, 2.5], [12, 0.77]] as [number, number][]) {
    assert.equal(cornerIndex(poly(n, 20, a0)), 0, `${n} corners from ${a0}`);
  }
});

test("a sharper corner still wins, also later in the list", () => {
  const p = poly(6, 20, 0.3);
  p[4] = { x: p[4].x + 15, y: p[4].y }; // pulled out: sharper there
  assert.equal(cornerIndex(p), 4);
});

test("no corner over 30 degrees: start at the first point", () => {
  assert.equal(cornerIndex(poly(40, 20, 0)), 0);
  assert.ok(CORNER_TIE > 0 && CORNER_TIE < 1e-6);
});
