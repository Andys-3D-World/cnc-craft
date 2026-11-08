// Entpacken mit Obergrenze (PDF-Seiten, .tools-Dateien) – läuft mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateLimited } from "../src/importers/inflateLimit.ts";

async function pack(data: Uint8Array, format: "deflate" | "deflate-raw"): Promise<Uint8Array> {
  const s = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

test("normale Daten kommen unverändert heraus", async () => {
  const text = new TextEncoder().encode("0 0 m 10 10 l S\n".repeat(500));
  for (const f of ["deflate", "deflate-raw"] as const) {
    const out = await inflateLimited(await pack(text, f), f);
    assert.deepEqual(out, text);
  }
});

test("aufgeblähte Datei bricht an der Grenze ab, statt den Speicher zu füllen", async () => {
  // 8 MB Nullen werden zu wenigen KB – Grenze hier 1 MB
  const bomb = await pack(new Uint8Array(8 * 1024 * 1024), "deflate");
  assert.ok(bomb.length < 64 * 1024);
  await assert.rejects(inflateLimited(bomb, "deflate", 1024 * 1024), /too-big/);
});

test("kaputte Daten werfen einen Fehler", async () => {
  await assert.rejects(inflateLimited(new Uint8Array([1, 2, 3, 4, 5]), "deflate"));
});
