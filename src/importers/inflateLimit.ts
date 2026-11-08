/**
 * ENTPACKEN MIT OBERGRENZE
 *
 * PDF-Seiten und .tools-Dateien sind mit „deflate“ gepackt. Eine präparierte Datei von wenigen KB kann sich auf
 * mehrere GB aufblähen und das Programm einfrieren. Deshalb wird Stück für Stück gelesen und oberhalb der Grenze
 * abgebrochen (Fehler „too-big“), bevor der Speicher voll ist.
 */

export const INFLATE_MAX = 64 * 1024 * 1024;

export async function inflateLimited(data: Uint8Array, format: "deflate" | "deflate-raw", max = INFLATE_MAX): Promise<Uint8Array> {
  const DS = (globalThis as any).DecompressionStream;
  if (!DS) throw new Error("no-inflate");
  const reader = (new Blob([data.slice()]).stream().pipeThrough(new DS(format)) as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("too-big");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
