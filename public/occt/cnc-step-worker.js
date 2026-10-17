/*
 * CNC Craft: STEP -> Dreiecke im eigenen Thread (Web Worker).
 * Nutzt occt-import-js (OpenCascade als WebAssembly, LGPL-2.1 – siehe license.*.txt hier im Ordner).
 * Eingang:  { buffer: Uint8Array, params }
 * Ausgang:  { ok: true, positions: Float32Array (9 Werte je Dreieck) }  oder  { ok: false, error }
 */
importScripts("occt-import-js.js");
let occtReady = null;

onmessage = async function (ev) {
  try {
    if (!occtReady) occtReady = occtimportjs({ locateFile: function (p) { return p; } });
    const occt = await occtReady;
    const result = occt.ReadStepFile(ev.data.buffer, ev.data.params);
    if (!result || !result.success) { postMessage({ ok: false, error: "read" }); return; }
    let total = 0;
    for (const m of result.meshes) total += m.index.array.length;
    const pos = new Float32Array(total * 3);
    let o = 0;
    for (const m of result.meshes) {
      const P = m.attributes.position.array, I = m.index.array;
      for (let i = 0; i < I.length; i++) { const k = I[i] * 3; pos[o++] = P[k]; pos[o++] = P[k + 1]; pos[o++] = P[k + 2]; }
    }
    postMessage({ ok: true, positions: pos }, [pos.buffer]);
  } catch (e) {
    postMessage({ ok: false, error: String((e && e.message) || e) });
  }
};
