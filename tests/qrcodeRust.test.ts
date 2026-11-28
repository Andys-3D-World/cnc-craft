// QR code: TypeScript (encodeQr, qrOutlines in src/editor/qrcode.ts) and Rust (src-tauri/src/qrencode.rs) must give the
// same version, the same modules and the same outlines in the same order. This test encodes many texts (short, long,
// umlauts, emoji, Wi-Fi and web addresses, right at the size limits) with every error correction level and pins the
// result in fixtures/qrcode-cases.json.gz (small codes as rows of 0/1 and flat x,y lists, every code as a hash);
// `cargo test qrencode` compares. After a wanted change:  UPDATE_FIXTURES=1 npm test  then  cd src-tauri && cargo test qrencode
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { encodeQr, penalty, qrOutlines, type QrEcc } from "../src/editor/qrcode.ts";

const file = new URL("./fixtures/qrcode-cases.json.gz", import.meta.url);
const penaltyFile = new URL("./fixtures/qrpenalty-cases.json.gz", import.meta.url);
const texts = [
  "", "A", "Hello", "https://github.com/Andys-3D-World/cnc-craft", "WIFI:T:WPA;S:Werkstatt;P:geheim123;;",
  "Grüße aus der Werkstatt – Fräse, Laser & Plasma", "😀🔧⚙️", "0123456789".repeat(3), "x".repeat(100),
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6), "BEGIN:VCARD\nVERSION:3.0\nN:Muster;Max\nEND:VCARD",
  "\u0000\u0001\u007f", "ß".repeat(70), "y".repeat(500), "z".repeat(1200), "w".repeat(2331), "v".repeat(2953), "u".repeat(2954),
];
// right at the limits between two versions (bytes that just fit, and one more)
for (const n of [17, 18, 32, 33, 53, 54, 78, 79, 106, 107, 134, 135, 154, 155, 192, 193, 230, 231, 271, 272]) texts.push("q".repeat(n));
let seed = 5;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let k = 0; k < 12; k++) texts.push(Array.from({ length: 1 + Math.floor(rnd() * 400) }, () => String.fromCharCode(32 + Math.floor(rnd() * 300))).join(""));

/** FNV-1a, 32 bit, over the characters (all ASCII here) */
const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; return h; };

test("QR code: pinned result for Rust (qrcode-cases.json.gz)", () => {
  const cases: { text: string; ecc: QrEcc; want: unknown }[] = [];
  for (const text of texts) for (const ecc of ["L", "M", "Q", "H"] as QrEcc[]) {
    const q = encodeQr(text, ecc);
    // small codes in full (for readable differences), every code also as a hash: modules and outlines hardly compress
    let want = null;
    if (q) {
      const rows = q.modules.map(r => r.map(b => (b ? "1" : "0")).join(""));
      const loops = qrOutlines(q.modules).map(l => l.flatMap(p => [p.x, p.y]));
      const small = q.version <= 6;
      want = { version: q.version, size: q.size, rows: small ? rows : null, outlines: small ? loops : null,
        rowsHash: fnv(rows.join("\n")), outlinesHash: fnv(loops.map(l => l.join(",")).join(";")) };
    }
    cases.push({ text, ecc, want });
  }
  const versions = new Set(cases.map(c => (c.want as { version?: number } | null)?.version ?? 0));
  assert.ok(versions.has(0) && versions.has(1) && versions.has(40) && versions.size > 25, [...versions].join(","));
  const text = JSON.stringify(cases) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(file)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});

// the mask is chosen by penalty points: small differences there would only rarely change a whole code, so the points
// themselves are pinned for matrices made to hit every rule at its edges (runs of 5, finder patterns at both ends,
// 2×2 blocks, the dark/light ratio)
test("QR code: penalty points pinned for Rust (qrpenalty-cases.json.gz)", () => {
  const mats: string[][] = [];
  const add = (m: boolean[][]) => mats.push(m.map(r => r.map(b => (b ? "1" : "0")).join("")));
  for (const n of [21, 25, 29, 33, 41, 57]) for (const dens of [0.1, 0.3, 0.5, 0.7, 0.9]) add(Array.from({ length: n }, () => Array.from({ length: n }, () => rnd() < dens)));
  const finder = [true, false, true, true, true, false, true];
  for (const n of [21, 22]) for (let at = 0; at + 7 <= n; at++) {
    const m = Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => (y === 5 && x >= at && x < at + 7 ? finder[x - at] : y === 9 ? (x + y) % 2 === 0 : false)));
    add(m);
    add(m.map((r, y) => r.map((_, x) => m[x][y])));
  }
  // finder pattern right at the end with something dark in front: only the light modules behind it count
  for (const n of [21, 25]) {
    const m = Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => (y === 3 && x >= n - 11 && x < n - 4 ? finder[x - (n - 11)] : y === 3 && x === n - 12)));
    add(m);
    add(m.map((r, y) => r.map((_, x) => m[x][y])));
  }
  for (let k = 0; k <= 21 * 21; k += 37) add(Array.from({ length: 21 }, (_, y) => Array.from({ length: 21 }, (_, x) => y * 21 + x < k)));
  const cases = mats.map(rows => ({ rows, want: penalty(rows.map(r => [...r].map(c => c === "1"))) }));
  const text = JSON.stringify(cases) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(penaltyFile, gzipSync(text, { level: 9 }));
  assert.equal(gunzipSync(readFileSync(penaltyFile)).toString(), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
