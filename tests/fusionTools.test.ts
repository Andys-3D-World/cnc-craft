// Tests für den Import von Fusion-360-Werkzeugbibliotheken – laufen mit `npm test`
// (eigene Beispieldaten im Fusion-Format, keine fremden Bibliotheken)
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { fusionToTools, isFusionLibrary, unzipJson } from "../src/fusionTools.ts";

const lib = {
  version: 21,
  data: [
    {
      type: "flat end mill", unit: "millimeters", guid: "aaa-1", description: "6 mm Schaftfräser", BMC: "carbide",
      geometry: { DC: 6, SFDM: 6, LCF: 20, OAL: 60, NOF: 3 },
      "start-values": { presets: [
        { name: "Holz", n: 18000, v_f: 1500, v_f_plunge: 400 },
        { name: "Aluminium", n: 20000, v_f: 600, v_f_plunge: 150, "use-stepdown": true, stepdown: 0.5 },
      ] },
    },
    {
      type: "thread mill", unit: "millimeters", guid: "tm-8", description: "Einzahn M8", BMC: "carbide",
      geometry: { DC: 6.5, SFDM: 8, LCF: 24, OAL: 60, NOF: 3, NT: 1, TP: 1.25, "shoulder-length": 24, "thread-profile-angle": 60 },
      shaft: { segments: [{ height: 3, "lower-diameter": 4.7, "upper-diameter": 8 }] },
    },
    {
      type: "chamfer mill", unit: "inches", guid: "ch-1", description: "", BMC: "hss",
      geometry: { DC: 0.5, SFDM: 0.25, NOF: 2, TA: 45, "tip-diameter": 0.04 },
      "start-values": { presets: [{ name: "Default", n: 10000, v_f: 20 }] },
    },
    { type: "holder", guid: "h-1", geometry: {} },
    { type: "tap right hand", guid: "tap", geometry: { DC: 8 } },
  ],
};

test("erkennt Fusion-Bibliotheken", () => {
  assert.ok(isFusionLibrary(lib));
  assert.ok(!isFusionLibrary({ format: "cnc-craft-library", tools: { tools: [] } }));
  assert.ok(!isFusionLibrary([{ diameter: 3 }]));
});

test("Fräser, Einzahn-Gewindefräser und Fase (Zoll) werden übernommen, Halter/Gewindebohrer übersprungen", () => {
  const r = fusionToTools(lib, "alu");
  assert.equal(r.tools.length, 3);
  assert.equal(r.skipped, 2);
  const [em, tm, ch] = r.tools;
  assert.equal(em.type, "endmill");
  assert.equal(em.id, "f-aaa-1");
  // passende Vorlage zum Material „alu“
  assert.equal(em.rpm, 20000);
  assert.equal(em.feedrate, 600);
  assert.equal(em.stepZ, 0.5);
  assert.match(em.notes, /Holz: S18000 F1500/);
  assert.equal(tm.type, "threadmill");
  assert.equal(tm.threadSingle, true);
  assert.equal(tm.neckDia, 4.7);
  assert.equal(tm.fluteLen, 24);
  assert.equal(tm.pitch, 1.25);
  assert.equal(ch.type, "chamfer");
  assert.equal(ch.angle, 90);
  assert.equal(ch.diameter, 12.7);
  assert.ok(Math.abs(ch.tipDia - 1.016) < 1e-9);
  assert.equal(ch.feedrate, 508);
  assert.equal(ch.toolMat, "hss");
  assert.equal(ch.name, "chamfer mill Ø12.7");
});

test("ohne passendes Material: erste Vorlage", () => {
  assert.equal(fusionToTools(lib, "steel").tools[0].rpm, 18000);
});

/** kleine ZIP-Datei bauen (eine Datei, Deflate) */
function zip(name: string, text: string): Uint8Array {
  const data = Buffer.from(text, "utf8"), comp = deflateRawSync(data), nm = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + nm.length + comp.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nm.length, 12); end.writeUInt32LE(cdOff, 16);
  return new Uint8Array(Buffer.concat([local, nm, comp, cd, nm, end]));
}

test(".tools (ZIP) entpacken", async () => {
  const text = JSON.stringify(lib);
  assert.equal(await unzipJson(zip("tools.json", text)), text);
  await assert.rejects(unzipJson(new Uint8Array([1, 2, 3])), /lib-invalid/);
});
