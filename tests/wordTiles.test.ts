// Tests für den Wortplättchen-Anhänger – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutWords, bestLayout, roomAspect, parseWords, wordTileOrnament, tileOutline, TILE_GAP, HEART, type TileLayout, type WordTileOptions } from "../src/wordTiles.ts";
import { inRegion, bounds } from "../src/nameConnect.ts";

const opts: WordTileOptions = { shape: "round", d: 90, frame: 4, footer: 30, holeD: 4 };

/** Jede zusammenhängende Reihe (waagerecht/senkrecht) aus ≥ 2 Feldern ist genau ein gelegtes Wort */
function checkCrossword(l: TileLayout) {
  const words = new Set(l.placed.map(p => `${p.dir}:${p.x},${p.y}:${p.word}`));
  for (const d of ["h", "v"] as const) {
    for (const k of l.cells.keys()) {
      const [x, y] = k.split(",").map(Number);
      const px = d === "h" ? x - 1 : x, py = d === "v" ? y - 1 : y;
      if (l.cells.has(`${px},${py}`)) continue; // nicht der Anfang einer Reihe
      let s = "", cx = x, cy = y;
      while (l.cells.has(`${cx},${cy}`)) { s += l.cells.get(`${cx},${cy}`); if (d === "h") cx++; else cy++; }
      if (s.length >= 2) assert.ok(words.has(`${d}:${x},${y}:${s}`), `zufällige Reihe ${s}`);
    }
  }
  // jedes Wort steht so im Raster, wie es heißt
  for (const p of l.placed) for (let i = 0; i < p.word.length; i++)
    assert.equal(l.cells.get(`${p.x + (p.dir === "h" ? i : 0)},${p.y + (p.dir === "v" ? i : 0)}`), p.word[i]);
}

test("Eingabe: Großbuchstaben, ♥, Trennzeichen", () => {
  assert.deepEqual(parseWords("<3 don, Riley\nElesha"), [HEART + "DON", "RILEY", "ELESHA"]);
  assert.deepEqual(parseWords("Grüße\nx\nGroß-Straße"), ["GRÜSSE", "GROSSSTRASSE"]);
});

test("Beispiele: alle Wörter liegen, sauberes Kreuzworträtsel, alles hängt zusammen", () => {
  for (const words of [[HEART + "DON", HEART + "RILEY", "ELESHA"], ["LAGAIL", "BUBBLE", "CASEY"], ["ANNA", "PETER", "LENA", "MAX", "OMA", "OPA"]]) {
    for (const seed of [-1, 0, 1, 2, 3]) {
      // -1 = beste von vielen Anordnungen: dort müssen alle Wörter liegen; einzelne Versuche dürfen eins übrig lassen
      const l = seed < 0 ? bestLayout(words) : layoutWords(words, seed);
      if (seed < 0) assert.deepEqual(l.unplaced, [], `${words}`);
      assert.equal(l.placed.length + l.unplaced.length, words.length);
      checkCrossword(l);
      // zusammenhängend: von einem Feld aus erreicht man alle
      const seen = new Set<string>(), todo = [l.cells.keys().next().value!];
      while (todo.length) {
        const k = todo.pop()!;
        if (seen.has(k) || !l.cells.has(k)) continue;
        seen.add(k);
        const [x, y] = k.split(",").map(Number);
        todo.push(`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`);
      }
      assert.equal(seen.size, l.cells.size);
    }
  }
});

test("Wort ohne gemeinsamen Buchstaben bleibt übrig", () => {
  const l = layoutWords(["ANNA", "BOB"]);
  assert.deepEqual(l.unplaced, ["BOB"]);
});

test("gleicher seed = gleiche Anordnung", () => {
  const a = layoutWords(["ANNA", "PETER", "LENA", "MAX"], 5), b = layoutWords(["ANNA", "PETER", "LENA", "MAX"], 5);
  assert.deepEqual([...a.cells], [...b.cells]);
});

for (const shape of ["round", "rect"] as const) test(`${shape}: Plättchen liegen im Innenraum über dem Fußteil, ohne Überlappung; Platten aus einem Stück`, () => {
  for (const words of [[HEART + "DON", HEART + "RILEY", "ELESHA"], ["LAGAIL", "BUBBLE", "CASEY"], ["MAXIMILIAN"]]) {
    const o = { ...opts, shape };
    const lay = bestLayout(words, roomAspect(o));
    checkCrossword(lay);
    const r = wordTileOrnament(o, lay);
    assert.equal(r.back.length, 1);
    assert.equal(r.front.length, 1);
    assert.equal(r.back[0].length, 2, "Grundplatte: Umriss + Loch");
    // Fußteil liegt unter den Plättchen, Text im Fußteil (im Material des Rahmens)
    const tb = r.textBox;
    for (const [x, y] of [[tb.x0, tb.y0], [tb.x1, tb.y0], [tb.x0, tb.y1], [tb.x1, tb.y1]]) assert.ok(inRegion(r.front, x, y), "Textfeld außerhalb");
    assert.ok(r.tiles.length > 0 && r.tiles[0].s > 6, `Plättchen zu klein: ${r.tiles[0]?.s}`);
    for (const t of r.tiles) for (const [x, y] of tileOutline(t)) {
      assert.ok(inRegion(r.back, x, y), "Plättchen ragt über die Grundplatte");
      assert.ok(!inRegion(r.front, x, y), "Plättchen liegt unter dem Rahmen");
    }
    for (let i = 0; i < r.tiles.length; i++) for (let j = i + 1; j < r.tiles.length; j++) {
      const a = r.tiles[i], b = r.tiles[j];
      const gap = Math.max(Math.abs(a.cx - b.cx), Math.abs(a.cy - b.cy)) - a.s;
      assert.ok(gap >= a.s * TILE_GAP - 1e-6, "Plättchen überlappen");
    }
    // Loch in beiden Teilen an derselben Stelle, mit Rand
    assert.ok(!inRegion(r.back, r.holeAt[0], r.holeAt[1]) && !inRegion(r.front, r.holeAt[0], r.holeAt[1]));
    const b = bounds(r.back);
    assert.ok(Math.abs(b.x1 - b.x0 - 90) < 0.5);
  }
});
