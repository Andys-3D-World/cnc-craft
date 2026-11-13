/**
 * HINTERGRUND-THREAD für die Simulation: liest großen G-Code (gcodeParser.ts), damit das Fenster bei
 * Millionen Zeilen nicht einfriert. Die Zeilen selbst schickt er nicht zurück – die hat das Hauptfenster schon.
 */
import { parseGcodeProgram } from "./gcodeParser";

self.onmessage = (ev: MessageEvent) => {
  const { id, text, opts } = ev.data;
  try {
    const { lines: _lines, ...prog } = parseGcodeProgram(String(text).split("\n"), opts);
    // Zahlenreihen übergeben statt kopieren (jede hat ihren eigenen Speicher)
    const buffers = new Set<ArrayBuffer>();
    for (const v of Object.values(prog)) if (ArrayBuffer.isView(v)) buffers.add(v.buffer as ArrayBuffer);
    (self as any).postMessage({ id, ok: true, prog }, [...buffers]);
  } catch (e) {
    (self as any).postMessage({ id, ok: false, error: String(e) });
  }
};
