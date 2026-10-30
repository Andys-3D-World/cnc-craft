// Tests für den Schnell-Leser der 3MF-Dreieckslisten – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMeshLists, numAt } from "../src/importers/meshScan.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const num = (s: string) => { const b = enc(s); return numAt(b, 0, b.length); };

test("numAt liest Zahlen wie parseFloat", () => {
  for (const s of ["0", "1.5", "-50", "49.9199982", "+3", ".25", "-0.0001", "1e3", "2.5E-2", "123456.789", " 7"]) {
    assert.ok(Math.abs(num(s) - parseFloat(s)) <= Math.abs(parseFloat(s)) * 1e-15, s);
  }
  assert.ok(Number.isNaN(num("abc")));
});

test("Listen werden gelesen, Rest-XML bleibt für den DOMParser", () => {
  const xml = `<?xml version="1.0"?><model unit="millimeter"><resources><object id="1"><mesh>
    <vertices>
      <vertex x="1" y="2" z="3"/>
      <vertex z="6" x="4.5" y='5'/>
      <!-- Kommentar -->
      <vertex x="-1e1" y="0" z="0"></vertex>
    </vertices>
    <triangles><triangle v1="0" v2="1" v3="2" pid="1" p1="0"/></triangles>
  </mesh></object></resources><build><item objectid="1"/></build></model>`;
  const r = extractMeshLists(enc(xml));
  assert.deepEqual([...r.verts[0]], [1, 2, 3, 4.5, 5, 6, -10, 0, 0]);
  assert.deepEqual([...r.tris[0]], [0, 1, 2]);
  assert.ok(!r.xml.includes("<vertex "), "Punkte sind aus dem XML entfernt");
  assert.ok(r.xml.includes("<build><item objectid=\"1\"/></build>"));
  assert.ok(r.xml.includes("<vertices>") && r.xml.includes("</vertices>"));
});

test("Namensraum-Präfix und leere Listen halten die Reihenfolge", () => {
  const xml = `<m:model xmlns:m="x"><m:object id="1"><m:mesh><m:vertices/><m:triangles/></m:mesh></m:object>
    <m:object id="2"><m:mesh><m:vertices><m:vertex x="7" y="8" z="9"/></m:vertices>
    <m:triangles><m:triangle v1="0" v2="0" v3="0"/></m:triangles></m:mesh></m:object></m:model>`;
  const r = extractMeshLists(enc(xml));
  assert.equal(r.verts.length, 2);
  assert.equal(r.verts[0].length, 0);
  assert.deepEqual([...r.verts[1]], [7, 8, 9]);
  assert.equal(r.tris.length, 2);
  assert.deepEqual([...r.tris[1]], [0, 0, 0]);
});
