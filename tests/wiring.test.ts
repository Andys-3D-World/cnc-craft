// Tests für die Anschlusspläne – laufen mit `npm test`
// Jeder Draht muss auf einen Pin zeigen, den es gibt, und jeder Text-Schlüssel muss in allen Sprachen stehen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Board, Hookup, Part } from "../src/wiring/boards.ts";
import { BOARDS, COMPS, sensorHookup } from "../src/wiring/boards.ts";

const LANGS = ["de", "en", "fr", "es", "it", "nl", "pl"];
const dict: Record<string, Record<string, string>> = Object.fromEntries(
  LANGS.map(l => [l, JSON.parse(readFileSync(new URL(`../src/i18n/lang/${l}.json`, import.meta.url), "utf8"))]));

/** Außenklemmen wie in ui/wiringPage.ts (outerPins) */
function outer(p: Part): string[] {
  if (p.outerPins) return p.outerPins;
  return ({ relay: ["COM", "NO"], extdrv: ["A+", "A−", "B+", "B−", "VCC", "GND"], vfd: ["+24V", "0V", "AVI", "ACM"], lpsu: ["AC L", "AC N", "Anode", "Kathode"] } as Record<string, string[]>)[p.kind] || [];
}

/** alle Verdrahtungen eines Boards, auch mit induktiven Sensoren */
function variants(b: Board): [string, Hookup][] {
  const out: [string, Hookup][] = [];
  for (const c of COMPS) {
    const h = b.hookups[c];
    if (!h) continue;
    out.push([c, h]);
    if ((c === "limits" || c === "probe") && !h.unavailable)
      for (const t of ["npn", "pnp"] as const) for (const v of [5, 12, 24] as const) out.push([`${c}/${t}/${v}`, sensorHookup(b, h, t, v)]);
  }
  return out;
}

test("jeder Draht endet an einem Pin, den es gibt", () => {
  for (const b of BOARDS) for (const [name, h] of variants(b)) {
    const parts = new Map(h.parts.map(p => [p.id, p]));
    for (const p of h.parts) for (const w of p.wires) {
      const where = `${b.id} ${name} ${p.id}.${w.from} → ${w.to}`;
      assert.ok(p.pins.includes(w.from) || outer(p).includes(w.from), "Anfang fehlt: " + where);
      if (w.to.startsWith("@")) {
        const [pid, pin] = w.to.slice(1).split(".");
        const other = parts.get(pid);
        assert.ok(other, "Bauteil fehlt: " + where);
        assert.ok(other.pins.includes(pin) || outer(other).includes(pin), "Bauteil-Pin fehlt: " + where);
      } else {
        const [cid, pin] = w.to.split(".");
        const c = b.conns.find(x => x.id === cid);
        assert.ok(c, "Stecker fehlt: " + where);
        assert.ok(c.pins.some(x => x.k === pin), "Pin fehlt: " + where);
      }
    }
  }
});

test("alle Text-Schlüssel der Anschlusspläne gibt es in allen 7 Sprachen", () => {
  const keys = new Set<string>();
  for (const b of BOARDS) {
    keys.add(b.fw); keys.add(b.source); keys.add("wr.sen.in." + b.inputs);
    for (const [, h] of variants(b)) {
      keys.add("wr.comp." + h.comp);
      if (h.unavailable) keys.add(h.unavailable);
      for (const s of [...h.steps, ...h.notes, ...h.pro]) keys.add(s.k);
      for (const p of h.parts) keys.add("wr.part." + p.kind);
    }
  }
  for (const l of LANGS) for (const k of keys) assert.ok(typeof dict[l][k] === "string" && dict[l][k], `${l}: ${k}`);
});

test("Platzhalter in den Texten sind in allen Sprachen gleich", () => {
  const ph = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join(",");
  for (const k of Object.keys(dict.en).filter(k => k.startsWith("wr."))) {
    for (const l of LANGS) assert.equal(ph(dict[l][k] || ""), ph(dict.en[k]), `${l}: ${k}`);
  }
});
