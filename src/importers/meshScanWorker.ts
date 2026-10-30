/**
 * HINTERGRUND-THREAD für große 3MF-Dateien: liest die Dreiecks-Listen einer Modell-Datei (siehe meshScan.ts)
 * und schickt sie ohne Kopieren zurück. So bleibt das Fenster bedienbar, und mehrere Dateien laufen gleichzeitig.
 */
import { extractMeshLists } from "./meshScan";

self.onmessage = (ev: MessageEvent<Uint8Array>) => {
  try {
    const lists = extractMeshLists(ev.data);
    const transfer = [...lists.verts.map(a => a.buffer), ...lists.tris.map(a => a.buffer)];
    (self as any).postMessage({ ok: true, lists }, transfer);
  } catch (e) {
    (self as any).postMessage({ ok: false, error: String(e) });
  }
};
