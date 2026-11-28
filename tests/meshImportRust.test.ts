// 3MF and OBJ reading: the shared cases in fixtures/meshimport-cases.json.gz come from tests/fixtures/meshimport-make.js
// (it runs in the preview, because parse3mf needs the browser's DOMParser). `cargo test meshimport` checks that
// src-tauri/src/meshimport.rs reads the same. Here, on every test run, the OBJ cases are read again with
// src/importers/objParse.ts – so a change there that is not in the fixture shows up at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseObjBytes, ObjError } from "../src/importers/objParse.ts";
import { meshFromPositions, meshSummary } from "../src/stlMesh.ts";

const cases: { name: string; kind: string; file: string; want: Record<string, unknown> }[] =
  JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/meshimport-cases.json.gz", import.meta.url))).toString());

test("3MF/OBJ fixture: enough cases of both kinds", () => {
  assert.ok(cases.filter(c => c.kind === "3mf").length >= 25);
  assert.ok(cases.filter(c => c.kind === "obj").length >= 15);
});

test("OBJ cases still read the same in objParse.ts (else run meshimport-make.js again)", () => {
  for (const c of cases.filter(c => c.kind === "obj")) {
    const bytes = new Uint8Array(Buffer.from(c.file, "hex"));
    let got: unknown;
    try { got = meshSummary(meshFromPositions(parseObjBytes(bytes).positions, "obj")); }
    catch (e) { got = { error: e instanceof ObjError ? e.code : "refused" }; }
    assert.deepEqual(JSON.parse(JSON.stringify(got)), c.want, c.name);
  }
});
