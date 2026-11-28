// Laser test card: TypeScript (src/testCard.ts + src/materialGrid.ts) and Rust (src-tauri/src/testcard.rs) must lay out
// the same card (every field, label, tick, hinge line and its laser values, which panels fit, the scale, the focus refusal)
// and the same helpers (step, wrapText, kerfSlots, kerfFromFit, focusAllowed, scanSpeeds, packPanels). The translated texts
// go along as a key → text map, like the dialog sends them. Pinned in fixtures/testcard-cases.json.gz: each card as hashes
// of 8 parts at a time (numbers rounded to 6 decimals, keys sorted, UTF-8), so a difference shows where it is.
// After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test testcard
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildCard, DEFAULT_CARD, focusAllowed, kerfFromFit, kerfSlots, packPanels, PANEL_IDS, scanSpeeds, wrapText, type TestCardOptions } from "../src/testCard.ts";
import { step } from "../src/materialGrid.ts";

const file = new URL("./fixtures/testcard-cases.json.gz", import.meta.url);
const de: Record<string, string> = JSON.parse(readFileSync(new URL("../src/i18n/lang/de.json", import.meta.url), "utf8"));
const en: Record<string, string> = JSON.parse(readFileSync(new URL("../src/i18n/lang/en.json", import.meta.url), "utf8"));

/** Gleiche Schreibweise wie `canon` in testcard.rs */
const canon = (v: unknown): string => {
  if (typeof v === "number") return v.toFixed(6);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
  }
  return "null";
};
const fnv = (t: string) => { let h = 0x811c9dc5; for (const b of Buffer.from(t, "utf8")) h = Math.imul(h ^ b, 0x01000193) >>> 0; return h; };
const chunks = (items: unknown[]) => { const out: number[] = []; for (let i = 0; i < items.length; i += 8) out.push(fnv(items.slice(i, i + 8).map(canon).join(";"))); return out; };

let seed = 20261128;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const r1 = (a: number, b: number, d = 1) => +(a + rnd() * (b - a)).toFixed(d);

const variants: Partial<TestCardOptions>[] = [
  {},
  { panels: [...PANEL_IDS], zConfirmed: true },
  { panels: [...PANEL_IDS], zConfirmed: false },
  { panels: ["focus"], zConfirmed: true, focusStep: 1, focusSteps: 6 },
  { panels: ["focus"], zConfirmed: true, focusStep: 0.7, focusSteps: 9 },
  { panels: ["focus"], zConfirmed: true, focusStep: 0.25, focusSteps: 2 },
  { panels: ["focus"], zConfirmed: true, focusStep: 1.5, focusSteps: 3 },
  { panels: ["focus"], zConfirmed: true, focusStep: 0.5, focusSteps: 4.5 },
  { panels: ["focus"], zConfirmed: true, focusStep: NaN, focusSteps: NaN },
  { panels: ["focus", "ruler"], zConfirmed: true, focusStep: 0, focusSteps: 5 },
  { cardW: 60, cardH: 50 },
  { cardW: 30, cardH: 30, header: false, outline: false },
  { cardW: 300, cardH: 200, cell: 10 },
  { cardW: 2000, cardH: 2000, cell: 40, panels: [...PANEL_IDS], zConfirmed: true },
  { cell: 3, eCols: 15, eRows: 15, cCols: 15, cRows: 15 },
  { cell: 4.5, eCols: 1, eRows: 1, cCols: 1, cRows: 1 },
  { cell: 7.77, ePMin: 0, ePMax: 0, eSMin: 6000, eSMax: 1000 },
  { thickness: 0, material: "  ", machine: "" },
  { thickness: 0.3, material: "Pappel Sperrholz", machine: "Ortur LM3 ", laserType: "co2", laserW: 55.5 },
  { thickness: 12, material: "Äpfelholz – Ø 3 mm", machine: "Mein \"Laser\"", laserType: "fiber" },
  { thickness: 50, laserType: "other", laserW: 0 },
  { laserType: "nonsense" },
  { iMin: 0.01, iMax: 10, scanMax: 2, kerfMax: 1 },
  { iMin: 0.3, iMax: 0.05, scanMax: 0.01, kerfMax: 0.05 },
  { kerfMax: 0.123, scanMax: 0.777 },
  { cutAir: false, refPower: 0, refSpeed: 1, cutPower: 100, cutSpeed: 100000, textPower: 3, textSpeed: 777 },
  { ePMin: 7.4, ePMax: 93.3, eSMin: 1234, eSMax: 5678, cPMin: 55.5, cPMax: 99.9, cSMin: 101, cSMax: 999 },
  { interval: 0.01 },
  { interval: 10, ePMin: 1, ePMax: 1 },
  { eCols: 4.4, eRows: 2.6, cCols: 3.5 },
  ...PANEL_IDS.map(p => ({ panels: [p], zConfirmed: true })),
  ...PANEL_IDS.map(p => ({ panels: PANEL_IDS.filter(q => q !== p), cardW: 120, cardH: 100 })),
  { panels: [] },
  { panels: ["engrave", "nonsense", "engrave"] }
];
for (let i = 0; i < 60; i++) {
  variants.push({
    cardW: r1(30, 400, 0), cardH: r1(30, 400, 0), thickness: r1(0, 20), laserW: r1(1, 150), laserType: pick(["diode", "co2", "fiber", "other"]),
    header: rnd() < 0.8, outline: rnd() < 0.8, panels: PANEL_IDS.filter(() => rnd() < 0.6),
    ePMin: r1(0, 60), ePMax: r1(40, 100), eCols: Math.round(r1(1, 15)), eSMin: r1(100, 3000, 0), eSMax: r1(2000, 12000, 0), eRows: Math.round(r1(1, 15)),
    interval: r1(0.01, 0.5, 2), cPMin: r1(0, 80), cPMax: r1(50, 100), cCols: Math.round(r1(1, 15)), cSMin: r1(50, 500, 0), cSMax: r1(300, 3000, 0), cRows: Math.round(r1(1, 15)),
    cutAir: rnd() < 0.5, iMin: r1(0.01, 0.2, 3), iMax: r1(0.1, 1, 3), scanMax: r1(0.01, 2, 3), kerfMax: r1(0.05, 1, 3),
    cell: r1(3, 40), focusStep: r1(0, 1.2, 2), focusSteps: Math.round(r1(1, 10)), zConfirmed: rnd() < 0.7, material: pick(["", "MDF", "Birke 4 mm", "Leder"])
  });
}

test("laser test card: pinned result for Rust (testcard-cases.json.gz)", () => {
  const cases = variants.map((v, i) => {
    const o = { ...DEFAULT_CARD, ...v };
    const lang = i % 2 ? en : de;
    const tr: Record<string, string> = {};
    const card = buildCard(o, k => (tr[k] = lang[k] ?? k));
    return { o, tr, want: { items: card.items.length, h: chunks(card.items), placed: card.placed, left: card.left, scale: card.scale, focusRefused: card.focusRefused } };
  });
  // die erste Karte einmal ganz, damit man beim Suchen etwas zum Ansehen hat
  const firstTr: Record<string, string> = {};
  const first = buildCard({ ...DEFAULT_CARD }, k => (firstTr[k] = de[k] ?? k));

  const steps: { a: number; b: number; i: number; n: number; d: number; v: number }[] = [];
  for (let k = 0; k < 300; k++) {
    const a = r1(-50, 6000, pick([0, 1, 2, 3])), b = r1(-50, 6000, pick([0, 1, 2, 3])), n = pick([0, 1, 2, 3, 5, 6, 7, 10, 15]), i = Math.floor(rnd() * Math.max(1, n)), d = pick([0, 1, 2, 3]);
    steps.push({ a, b, i, n, d, v: step(a, b, i, n, d) });
  }
  for (const [a, b, i, n, d] of [[0, 0.3, 1, 7, 3], [0.05, 0.3, 5, 6, 3], [1000, 6000, 2, 5, 0], [20, 100, 3, 6, 1], [0, 1, 3, 6, 3], [1, 2.5, 1, 2, 0], [0, 0.125, 1, 2, 2]])
    steps.push({ a, b, i, n, d, v: step(a, b, i, n, d) });

  const texts = ["", "   ", "Nimm das Feld mit der Farbe, die dir gefällt", "a b c d e f g h i j k l m n o p", "Ein\tsehr  langes\nWort-Wort-Wort-Wort-Wort-Wort-Wort und noch mehr Text",
    "Überall Äpfel – ÖÜß € 😀 emoji 😀 x", ...Object.values(de).filter(s => typeof s === "string").slice(500, 540)];
  const wraps = texts.flatMap(s => [[36, 1.5], [10, 1.5], [100, 2], [3, 3], [60.5, 1.5]].map(([w, h]) => ({ s, w, h, out: wrapText(s, w, h) })));

  const kerfs = [0, 0.01, 0.05, 0.123, 0.3, 0.999, 1, 1.5, 7, -1].flatMap(m => [1, 2, 7, 9].map(n => ({ m, n, out: kerfSlots(m, n) })));
  const fits = [[4, 4], [4, 3.8], [4, 3.333], [4, 5], [4, 3.9995], [4, 0], [10, 3.75]].map(([t, w]) => ({ t, w, k: kerfFromFit(t, w) }));
  const focus = [...variants.map(v => ({ ...DEFAULT_CARD, ...v })), { ...DEFAULT_CARD, zConfirmed: true, focusStep: 1, focusSteps: 6 }, { ...DEFAULT_CARD, zConfirmed: true, focusStep: 0.625, focusSteps: 9 },
    { ...DEFAULT_CARD, zConfirmed: true, focusStep: 1e-9, focusSteps: 9 }, { ...DEFAULT_CARD, zConfirmed: true, focusStep: 0.5, focusSteps: 11 }, { ...DEFAULT_CARD, zConfirmed: true, focusStep: 0.5, focusSteps: 1 }]
    .map(o => ({ o, ok: focusAllowed(o), speeds: scanSpeeds(o) }));

  const packs: { sizes: { id: string; w: number; h: number }[]; W: number; H: number; gap: number; out: unknown }[] = [];
  for (let k = 0; k < 80; k++) {
    const n = Math.floor(rnd() * 13);
    const sizes = Array.from({ length: n }, (_, j) => ({ id: PANEL_IDS[j], w: rnd() < 0.2 ? 36 : r1(5, 120), h: rnd() < 0.3 ? 20 : r1(5, 90) }));
    const W = r1(20, 300), H = r1(20, 300), gap = pick([0, 4, 2.5]);
    packs.push({ sizes, W, H, gap, out: packPanels(sizes as any, W, H, gap) });
  }

  assert.ok(cases.length >= 100);
  const text = JSON.stringify({ cases, first: { o: DEFAULT_CARD, tr: firstTr, card: first }, steps, wraps, kerfs, fits, focus, packs }) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
