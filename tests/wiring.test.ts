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

test("Drehbank-Motorregler: seine Klemmen hängen nie direkt an einem CNC-Board, immer an Koppelrelais und Trennwandler", () => {
  let full = 0;
  for (const b of BOARDS) {
    const h = b.hookups.lathe;
    if (!h || b.only || h.unavailable) continue;
    full++;
    const yy = h.parts.find(p => p.kind === "yy")!;
    assert.deepEqual(yy.wires.map(w => w.to).sort(), ["@iso.OUT+", "@iso.OUT−", "@srel.11", "@srel.14"], b.id);
    for (const p of h.parts) for (const w of p.wires) {
      if (p.kind === "yy") continue;
      assert.ok(!["11", "14", "OUT+", "OUT−"].includes(w.from) && !/^@(yy|srel\.1[14]|iso\.OUT)/.test(w.to), `${b.id}: ${p.id}.${w.from} → ${w.to}`);
    }
    assert.ok(h.notes[0].k === "wr.n.yy.hot" && h.steps.some(s => s.k === "wr.s.lat.stop"), b.id);
  }
  assert.equal(full, 16);
  const only = BOARDS.filter(b => b.only);
  assert.deepEqual(only.map(b => [b.id, Object.keys(b.hookups).sort()]), [["yy-600d", ["lathe", "latheHand"]]]);
  assert.equal(only[0].hookups.lathe!.notes[0].k, "wr.n.yy.hot");
});

test("Drehbank-Achsen: jedes GRBL-Board hat X und Z mit Endschalter und Netzteil, nie Y", () => {
  let n = 0;
  for (const b of BOARDS) {
    const h = b.hookups.latheAxes;
    if (b.only || b.maker === "Ruida") { assert.ok(!h, b.id); continue; }
    n++;
    const names = (k: string) => h!.parts.filter(p => p.kind === k).map(p => p.name).sort();
    assert.deepEqual(names("motor"), ["X", "Z"], b.id);
    assert.deepEqual(names("switch"), ["X", "Z"], b.id);
    assert.equal(names("psu").length, 1, b.id);
    assert.equal(new Set(h!.parts.map(p => p.id)).size, h!.parts.length, b.id);
    assert.ok(!h!.settings.some(x => /\$22=1|axes\/y|^y/.test(x)), b.id);
  }
  assert.equal(n, 16);
});

test("Hand/CNC: SV, F und R gehen nur über den Wahlschalter, Hand und CNC treffen sich nirgends", () => {
  const h = BOARDS.find(b => b.id === "yy-600d")!.hookups.latheHand!;
  const to = (pin: string) => h.parts.flatMap(p => p.wires.filter(w => w.to === pin).map(w => p.id + "." + w.from)).sort();
  assert.deepEqual(to("sv.SV"), ["sel.SV"]);
  assert.deepEqual(to("j3.F"), ["sel.F"]);
  assert.deepEqual(to("j3.R"), ["sel.R"]);
  for (const [pin, from] of [["H·SV", "pot.S"], ["H·F", "rsw.F"], ["H·R", "rsw.R"], ["CNC·F", "srel.14"], ["CNC·SV", "iso.OUT+"]]) assert.deepEqual(to("@sel." + pin), [from], pin);
  assert.deepEqual(to("sv.5V"), ["pot.+5V"]);
  assert.equal(h.notes[0].k, "wr.n.yy.hot");
});

test("Werkzeugwechsler: Ventil nur im eigenen 24-V-Kreis, nie am Board; jeder Öffner-Weg geht durch Druckschalter, Frequenz null und Koppelrelais", () => {
  let full = 0;
  for (const b of BOARDS) for (const id of ["atc", "atcDiy"] as const) {
    const h = b.hookups[id];
    if (b.only || b.maker === "Ruida") { assert.ok(!h, b.id); continue; }
    assert.ok(h, b.id);
    if (h.unavailable) { assert.equal(h.parts.length, 0); continue; }
    full++;
    const of = (k: string) => h.parts.filter(p => p.kind === k);
    const w = (k: string) => of(k)[0].wires.map(x => x.from + ">" + x.to).sort();
    for (const k of ["valve", "psw", "vfr", "clamp", "runc", "srel"]) assert.equal(of(k).length, 1, `${b.id} ${k}`);
    assert.deepEqual(w("valve"), ["+>@srel.14", "->@psu.-"], b.id);
    assert.deepEqual(w("psw"), ["1>@psu.+", "2>@vfr.C"], b.id);
    assert.deepEqual(w("vfr"), ["NO>@srel.11"], b.id);
    assert.deepEqual(w("clamp"), ["1>@vfr.RUN", "2>@runc.14"], b.id);
    // Ventilkreis berührt das Board nirgends; Spulenseite und Kontaktseite des Koppelrelais bleiben getrennt
    for (const p of h.parts) for (const x of p.wires) {
      if (["valve", "psw", "vfr", "clamp", "runc"].includes(p.kind)) assert.ok(x.to.startsWith("@"), `${b.id} ${p.id}`);
      if (p.kind !== "valve" && p.kind !== "vfr") assert.ok(!/^@srel\.1[14]$/.test(x.to), `${b.id} ${p.id}`);
    }
    assert.ok(of("srel")[0].wires.every(x => x.from === "A1" || x.from === "A2"), b.id);
    // derselbe Pin wie Kühlung/Spindel darf es nur sein, wenn der Plan das ausdrücklich sagt (grblHAL ohne diese Funktion)
    const out = h.settings.find(x => /digital0_pin/.test(x))?.split(": ")[1];
    if (out) for (const other of ["air", "spindle"] as const) assert.ok(!b.hookups[other]?.settings.some(x => /pin/.test(x) && !/mist_pin/.test(x) && x.endsWith(out)), `${b.id} ${other} ${out}`);
    else assert.ok(h.steps.some(x => x.k === "wr.s.atc.max" || x.k === "wr.s.atc.skr"), b.id);
    assert.equal(h.notes[0].k, "wr.n.atc.hot");
  }
  assert.equal(full, 18);
});
