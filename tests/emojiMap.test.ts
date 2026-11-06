// Tests für den Ersatz von Emojis durch eigene Symbole – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { EMOJI_ICONS, splitEmoji, stripEmoji } from "../src/ui/emojiMap.ts";
import { hasIcon } from "../src/ui/icons.ts";

test("Jedes Emoji zeigt auf ein Symbol, das es wirklich gibt", () => {
  for (const [ch, name] of Object.entries(EMOJI_ICONS)) assert.ok(hasIcon(name), `${ch} → ${name}`);
});

test("Zerlegen: Text bleibt, Emoji wird zum Symbol, auch mit Bunt-Zusatz", () => {
  assert.equal(splitEmoji("nur Text → mit Pfeil ✓"), null);
  assert.deepEqual(splitEmoji("🔥 Plasma"), [{ icon: "flame" }, { text: " Plasma" }]);
  assert.deepEqual(splitEmoji("⚠️ Achtung ⚙️"), [{ icon: "warning" }, { text: " Achtung " }, { icon: "gear" }]);
  assert.deepEqual(splitEmoji("🔎"), [{ icon: "search" }]);
  assert.deepEqual(splitEmoji("〰️x"), [{ icon: "wave" }, { text: "x" }]);
  // zweimal hintereinander liefert dasselbe (der reguläre Ausdruck merkt sich nichts)
  assert.ok(splitEmoji("🔥")); assert.ok(splitEmoji("🔥"));
});

test("Auswahllisten: Emoji fällt weg", () => {
  assert.equal(stripEmoji("🛠️ Fräse"), "Fräse");
  assert.equal(stripEmoji("Suche 🔎"), "Suche");
  assert.equal(stripEmoji("ohne"), "ohne");
});

test("In der App bleibt kein buntes Emoji ohne Symbol übrig", () => {
  const pict = /\p{Extended_Pictographic}/u;
  // Schlichte Zeichen, die zur Schrift gehören
  const keep = new Set([..."↔↕↖↗↘↙↩↺↻⌂⌘⏎⏚■□▢▣▤▥▦▭▲△▸▼▾◉○◎●◐◑◔◜◯★☆♥✓✕✖✗✛✥⬡⭘⌖©®™"]);
  const missing = new Set<string>();
  const scan = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { scan(p); continue; }
      if (!/\.(ts|json)$/.test(e.name) || e.name === "emojiMap.ts") continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const ch of line) if (pict.test(ch) && !EMOJI_ICONS[ch] && !keep.has(ch)) missing.add(ch);
      }
    }
  };
  scan("src");
  assert.deepEqual([...missing], []);
});
