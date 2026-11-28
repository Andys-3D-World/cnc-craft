// Makes tests/fixtures/meshimport-cases.json.gz: small 3MF and OBJ files and what src/importers/meshImport.ts reads
// from them (number of triangles, size, checksum of all corners – meshSummary in src/stlMesh.ts) or that it refuses
// them. `cargo test meshimport` then checks that src-tauri/src/meshimport.rs reads the same.
// parse3mf needs the browser's DOMParser, so this runs in the preview:
//   1. start the preview (vite) fresh
//   2. in the page:  await (await import("/tests/fixtures/meshimport-make.js")).make()   → returns the JSON text
//      (let the page post it to a small local receiver, it is large)
//   3. save it as tests/fixtures/meshimport-cases.json and pack it:  gzip -9 -n tests/fixtures/meshimport-cases.json
// tests/meshImportRust.test.ts checks the OBJ cases again in node on every test run.
// Run it again whenever meshImport.ts, meshScan.ts or objParse.ts changes.
export async function make() {
  const { parse3mf } = await import("/src/importers/meshImport.ts");
  const { parseObjBytes, ObjError } = await import("/src/importers/objParse.ts");
  const { meshSummary, meshFromPositions } = await import("/src/stlMesh.ts");
  const enc = s => new TextEncoder().encode(s);
  const deflate = async b => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  /** ZIP: files = [[name, text|bytes, deflate?]] */
  const zip = async files => {
    const parts = [], central = [];
    let off = 0;
    for (const [name, content, pack] of files) {
      const raw = typeof content === "string" ? enc(content) : content;
      const data = pack ? await deflate(raw) : raw;
      const nb = enc(name);
      const lh = new Uint8Array(30 + nb.length), dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(8, pack ? 8 : 0, true);
      dv.setUint32(18, data.length, true); dv.setUint32(22, raw.length, true); dv.setUint16(26, nb.length, true);
      lh.set(nb, 30);
      const ch = new Uint8Array(46 + nb.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, pack ? 8 : 0, true);
      cv.setUint32(20, data.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, nb.length, true); cv.setUint32(42, off, true);
      ch.set(nb, 46);
      parts.push(lh, data); central.push(ch);
      off += lh.length + data.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
    const all = [...parts, ...central, end];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let k = 0; for (const p of all) { out.set(p, k); k += p.length; }
    return out;
  };
  const RELS = (target = "/3D/3dmodel.model", type = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel") =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="${target}" Id="rel0" Type="${type}"/></Relationships>`;
  const NS = `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"`;
  const PNS = `xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"`;
  const cubeMesh = (s = 10, pre = "") => `<${pre}mesh><${pre}vertices>` +
    [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]].map(v => `<${pre}vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join("") +
    `</${pre}vertices><${pre}triangles>` +
    [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]].map(t => `<${pre}triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join("") +
    `</${pre}triangles></${pre}mesh>`;
  const model = (body, unit = "millimeter", extra = "") => `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="${unit}" xml:lang="en-US" ${NS} ${extra}>\n<resources>${body}</resources>`;
  const simple = (unit = "millimeter", build = `<build><item objectid="1"/></build>`) => model(`<object id="1" type="model">${cubeMesh()}</object>`, unit) + build + `</model>`;
  const grid = (n) => {
    let v = "", t = "";
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) v += `<vertex x="${(i * 0.37).toFixed(3)}" y="${(j * 0.41).toFixed(3)}" z="${(Math.sin(i * 0.3) * Math.cos(j * 0.2) * 2 + 3).toFixed(5)}"/>`;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1; t += `<triangle v1="${a}" v2="${b}" v3="${c}"/><triangle v1="${a}" v2="${c}" v3="${d}"/>`; }
    return model(`<object id="7"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`) + `<build><item objectid="7"/></build></model>`;
  };

  const cases = [];
  const add3mf = async (name, files) => cases.push({ name, kind: "3mf", bytes: await zip(files) });
  const addObj = (name, text) => cases.push({ name, kind: "obj", bytes: typeof text === "string" ? enc(text) : text });

  await add3mf("cube, stored", [["_rels/.rels", RELS()], ["3D/3dmodel.model", simple()]]);
  await add3mf("cube, deflated", [["_rels/.rels", RELS(), true], ["3D/3dmodel.model", simple(), true]]);
  for (const u of ["inch", "micron", "centimeter", "meter", "foot", "MILLIMETER", "furlong", ""]) await add3mf(`cube, unit ${u || "empty"}`, [["3D/3dmodel.model", simple(u)]]);
  await add3mf("prefixed names", [["3D/3dmodel.model", `<?xml version="1.0"?><m:model unit="millimeter" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><m:resources><m:object id="1">${cubeMesh(5, "m:")}</m:object></m:resources><m:build><m:item objectid="1"/></m:build></m:model>`]]);
  await add3mf("two objects and transforms", [["3D/3dmodel.model", model(`<object id="1">${cubeMesh(10)}</object><object id="2">${cubeMesh(4)}</object>`) +
    `<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 20 0 0"/><item objectid="2" transform="0.7071 0.7071 0 -0.7071 0.7071 0 0 0 1 5 5 2.5"/><item objectid="1" transform="2 0 0 0 0.5 0 0 0 1 -30 0 0"/></build></model>`]]);
  await add3mf("components with transforms", [["3D/3dmodel.model", model(`<object id="1">${cubeMesh(2)}</object><object id="2"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 3 0 0"/><component objectid="1" transform="0 1 0 -1 0 0 0 0 1 0 6 0"/></components></object><object id="3"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 2 0 0 1"/><component objectid="1"/></components></object>`) +
    `<build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 10 10 0"/></build></model>`]]);
  const objFile = model(`<object id="5">${cubeMesh(3)}</object><object id="6"><components><component objectid="5" transform="1 0 0 0 1 0 0 0 1 0 0 3"/></components></object>`, "millimeter", PNS) + `<build/></model>`;
  await add3mf("production extension, parts in own files", [["_rels/.rels", RELS()], ["3D/3dmodel.model", model(`<object id="1"><components><component p:path="/3D/Objects/part.model" objectid="5"/><component p:path="/3D/Objects/part.model" objectid="6" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object>`, "inch", PNS) + `<build><item objectid="1" p:path="/3D/3dmodel.model"/><item objectid="6" p:path="/3D/Objects/PART.model" transform="1 0 0 0 1 0 0 0 1 0 20 0"/></build></model>`, true], ["3D/Objects/part.model", objFile, true]]);
  await add3mf("production prefix bound to another name", [["3D/3dmodel.model", model(`<object id="1"><components><component prod:path="/3D/b.model" objectid="9"/></components></object>`, "millimeter", `xmlns:prod="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"`) + `<build><item objectid="1"/></build></model>`], ["3D/b.model", model(`<object id="9">${cubeMesh(1)}</object>`) + `</model>`]]);
  await add3mf("no rels: first model file", [["Metadata/thumb.png", "x"], ["3D/Second.model", simple("centimeter")], ["3D/3dmodel.model", simple("inch")]]);
  await add3mf("rels points to a missing file", [["_rels/.rels", RELS("/3D/missing.model")], ["3D/real.model", simple()]]);
  await add3mf("rels type in other case, target with slash and capitals", [["_rels/.rels", `<Relationships><Relationship Id="a" Type="http://x/thumbnail" Target="/thumb.png"/><relationship ContentType="x" TYPE="HTTP://SCHEMAS/3DMODEL" target="/3D/MAIN.MODEL"/></Relationships>`], ["3d/main.model", simple("micron")], ["3D/other.model", simple()]]);
  await add3mf("no build items: all objects with a mesh", [["3D/3dmodel.model", model(`<object id="a">${cubeMesh(2)}</object><object id="b"><components><component objectid="a"/></components></object><object id="c">${cubeMesh(1)}</object>`) + `</model>`]]);
  await add3mf("same object id twice", [["3D/3dmodel.model", model(`<object id="1">${cubeMesh(2)}</object><object id="2">${cubeMesh(9)}</object><object id="1">${cubeMesh(5)}</object>`) + `</model>`]]);
  await add3mf("bad triangle numbers", [["3D/3dmodel.model", model(`<object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="9"/><triangle v1="-1" v2="1" v3="2"/><triangle v1="1.7" v2="2.2" v3="3"/><triangle v1="3" v2="1"/><triangle v1="0" v2="2" v3="3" p1="5" pid="2"/></triangles></mesh></object>`) + `<build><item objectid="1"/></build></model>`]]);
  await add3mf("vertex numbers", [["3D/3dmodel.model", model(`<object id="1"><mesh><vertices><vertex x="1.25e1" y='-0' z=" 3"/><vertex x="123456789012345678901" y="0.12345678901234567891" z="1e400"/><vertex y="7" x = "2.5" /><vertex x="-.5" y="+4." z="1e-25"/><vertex x="abc" y="1E2" z="0.000000000000000000000001"/><vertex x="99999999999999999999e-30" y="5" z="6" extra="1"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="3" v2="4" v3="5"/></triangles></mesh></object>`) + `<build><item objectid="1"/></build></model>`]]);
  await add3mf("odd transforms", [["3D/3dmodel.model", model(`<object id="1">${cubeMesh(2)}</object>`) + `<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 5"/><item objectid="1" transform="  1 0 0\n0 1 0\t0 0 1 0x10 .5 1e1 "/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 1e400 0 0"/><item objectid="1" transform=""/><item objectid="1" transform="+2 0 0 0 2. 0 0 0 2 -0 0 0"/></build></model>`]]);
  await add3mf("comments, CDATA and entities", [["3D/3dmodel.model", `<?xml version="1.0"?><!-- <vertices> in a comment is not read by the browser --><model unit="millimeter" ${NS} ${PNS}><metadata name="Title"><![CDATA[a <b> & c]]></metadata><resources><object id="o&amp;1"><!-- note -->${cubeMesh(2)}</object><object id="x"><components><component objectid="z" p:path="/3D/a&amp;b.model"/></components></object></resources><build><item objectid="o&amp;1"/><item objectid="x"/></build></model>`], ["3D/a&b.model", model(`<object id="z">${cubeMesh(1)}</object>`) + `</model>`]]);
  await add3mf("entities and CDATA", [["3D/3dmodel.model", `<?xml version="1.0"?><!-- just a note --><model unit="millimeter" ${NS} ${PNS}><metadata name="Title"><![CDATA[a <b> & c]]></metadata><resources><object id="o&amp;1&#x41;"><!-- note -->${cubeMesh(2)}</object><object id="x"><components><component objectid="z" p:path="/3D/a&amp;b.model" transform="1&#32;0 0 0 1 0 0 0 1 4 0 0"/></components></object></resources><build><item objectid="o&amp;1A"/><item objectid="x"/></build></model>`], ["3D/a&b.model", model(`<object id="z">${cubeMesh(1)}</object>`) + `</model>`]]);
  await add3mf("object with mesh and components", [["3D/3dmodel.model", model(`<object id="1">${cubeMesh(1)}</object><object id="2">${cubeMesh(3)}<components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 9 9 9"/></components></object>`) + `<build><item objectid="2"/></build></model>`]]);
  await add3mf("component that contains itself", [["3D/3dmodel.model", model(`<object id="1">${cubeMesh(1)}<components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 1 0 0"/></components></object>`) + `<build><item objectid="1"/></build></model>`]]);
  await add3mf("empty lists: no triangles", [["3D/3dmodel.model", model(`<object id="1"><mesh><vertices/><triangles></triangles></mesh></object>`) + `<build><item objectid="1"/></build></model>`]]);
  await add3mf("broken XML", [["3D/3dmodel.model", model(`<object id="1">${cubeMesh(1)}</objekt>`) + `</model>`]]);
  await add3mf("missing part file", [["3D/3dmodel.model", model(`<object id="1"><components><component p:path="/3D/none.model" objectid="2"/></components></object>`, "millimeter", PNS) + `<build><item objectid="1"/></build></model>`]]);
  await add3mf("single quotes", [["3D/3dmodel.model", model(`<object id="1"><mesh><vertices><vertex x='1' y='4' z='2'/><vertex x="5" y='0' z="0"/><vertex x='0' y="6" z='0'/></vertices><triangles><triangle v1='0' v2="1" v3='2'/></triangles></mesh></object>`) + `<build><item objectid="1"/></build></model>`]]);
  await add3mf("empty vertex list before a real one", [["3D/3dmodel.model", model(`<object id="1"><mesh><vertices/><triangles/></mesh></object><object id="2">${cubeMesh(4)}</object>`) + `<build><item objectid="1"/><item objectid="2"/></build></model>`]]);
  await add3mf("tab in a path", [["3D/3dmodel.model", model(`<object id="1"><components><component p:path="/3D/a	b.model" objectid="2"/></components></object>`, "millimeter", PNS) + `<build><item objectid="1"/></build></model>`], ["3D/a b.model", model(`<object id="2">${cubeMesh(2)}</object>`) + `</model>`]]);
  await add3mf("namespace declared on the component", [["3D/3dmodel.model", model(`<object id="1"><components><component xmlns:q="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" q:path="/3D/c.model" objectid="3"/></components></object>`) + `<build><item objectid="1"/></build></model>`], ["3D/c.model", model(`<object id="3">${cubeMesh(3)}</object>`) + `</model>`]]);
  await add3mf("unit in capitals", [["3D/3dmodel.model", simple("INCH")]]);
  await add3mf("object with two meshes", [["3D/3dmodel.model", model(`<object id="1">${cubeMesh(2)}${cubeMesh(7)}</object>`) + `<build><item objectid="1"/></build></model>`]]);
  await add3mf("transform with 13 numbers", [["3D/3dmodel.model", model(`<object id="1">${cubeMesh(2)}</object>`) + `<build><item objectid="1" transform="2 0 0 0 2 0 0 0 2 1 1 1 9"/></build></model>`]]);
  await add3mf("rels: thumbnail first, model second", [["_rels/.rels", `<Relationships><Relationship Type="http://x/thumbnail" Target="/thumb.png"/><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/second.model"/></Relationships>`], ["thumb.png", "not xml at all"], ["3D/first.model", simple("inch")], ["3D/second.model", simple("micron")]]);
  await add3mf("model ending in capitals", [["3D/3DMODEL.MODEL", simple("centimeter")]]);
  await add3mf("height field 60 x 60 (7,200 triangles)", [["3D/3dmodel.model", grid(60), true]]);
  cases.push({ name: "not a zip", kind: "3mf", bytes: enc("hello, this is not a 3mf file at all") });
  const z = await zip([["3D/3dmodel.model", simple(), true]]);
  cases.push({ name: "deflated data cut short", kind: "3mf", bytes: (() => { const b = z.slice(); const dv = new DataView(b.buffer); const cd = dv.getUint32(b.length - 6, true); dv.setUint32(cd + 20, dv.getUint32(cd + 20, true) - 40, true); return b; })() });

  addObj("triangle", "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  addObj("quad and pentagon fanned", "v 0 0 0\nv 2 0 0\nv 2 2 0\nv 0 2 0\nv 1 3 1\nf 1 2 3 4\nf 1 2 3 5 4\n");
  addObj("negative numbers, slashes, normals and textures", "# comment\nmtllib a.mtl\no part\nv 0 0 0\nv 1 0 0\nv 1 1 0\nvt 0 0\nvn 0 0 1\ng side\nusemtl red\nf -3/1/1 -2/1/1 -1/1/1\nv 0 1 2\nf 1//1 3//1 4//1\ns off\n");
  addObj("line continuation, tabs and CRLF", "v\t0 0 \\\n 0\r\nv 1 \\\r\n0 0\r\nv 0 1 0 1.0\r\nf 1 \\\n2 3\r\n");
  addObj("odd numbers", "v 1e2 -.5 +3\nv 0.000001 1234567890123456789e-15 7.\nv -0 0 0\nf 1 2 3\n");
  addObj("skipped faces", "v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nf 1 2\nf 1 1 2\nf 1 2 2 3\nf 1 2 3 1 4\nf\n");
  addObj("plus sign and big index", "v 0 0 0\nv 1 0 0\nv 0 1 0\nf +1 +2 +3\n");
  addObj("vertex lines without space are other things", "vx 1 2 3\nv 0 0 0\nv 1 0 0\nv 0 1 0\nfo 1 2 3\nf 1 2 3\n");
  addObj("backslash right after v", "v\\\n0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  addObj("index one past the end", "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n");
  addObj("bad number", "v 0 0 0\nv 1 0\nv 0 1 0\nf 1 2 3\n");
  addObj("bad number text", "v 0 0 x\nf 1 2 3\n");
  addObj("too far", "v 2e9 0 0\nv 0 0 0\nv 1 1 1\nf 1 2 3\n");
  addObj("infinite", "v 1e400 0 0\nv 0 0 0\nv 1 1 1\nf 1 2 3\n");
  addObj("index zero", "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2\n");
  addObj("index with letters", "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2x 3\n");
  addObj("index past the end", "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 2 9\n");
  addObj("negative past the start", "v 0 0 0\nf -1 -2 -3\n");
  addObj("no faces", "v 0 0 0\nv 1 0 0\n");
  addObj("no vertices", "# nothing\nf 1 2 3\n");
  addObj("empty", "");
  {
    let t = "";
    for (let j = 0; j <= 40; j++) for (let i = 0; i <= 40; i++) t += `v ${i * 0.5} ${j * 0.5} ${(Math.sin(i / 5) * Math.cos(j / 7)).toFixed(6)}\n`;
    for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) { const a = j * 41 + i + 1; t += `f ${a} ${a + 1} ${a + 42} ${a + 41}\n`; }
    addObj("surface 40 x 40 quads", t);
  }

  const out = [];
  for (const c of cases) {
    let want;
    try {
      const mesh = c.kind === "3mf" ? await parse3mf(c.bytes) : meshFromPositions(parseObjBytes(c.bytes).positions, "obj");
      want = meshSummary(mesh);
    } catch (e) {
      want = { error: e instanceof ObjError ? e.code : "refused" };
    }
    out.push({ name: c.name, kind: c.kind, file: [...c.bytes].map(x => x.toString(16).padStart(2, "0")).join(""), want });
  }
  return JSON.stringify(out) + "\n";
}
