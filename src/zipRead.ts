/** ZIP lesen: passende Dateien entpacken, mit Grenzen für Anzahl und Größe (eine präparierte Datei darf den Speicher nicht füllen) */
import { inflateLimited } from "./importers/inflateLimit.ts";

export interface ZipEntry { name: string; data: Uint8Array }
export async function unzipFiles(bytes: Uint8Array, want: (name: string) => boolean, o: { maxFiles?: number; maxFile?: number; maxTotal?: number } = {}): Promise<ZipEntry[]> {
  const { maxFiles = 200, maxFile = 20 * 1024 * 1024, maxTotal = 100 * 1024 * 1024 } = o;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u16 = (p: number) => dv.getUint16(p, true), u32 = (p: number) => dv.getUint32(p, true);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip-invalid");
  const out: ZipEntry[] = [];
  let p = u32(eocd + 16), total = 0;
  for (let e = 0, n = u16(eocd + 10); e < n && p + 46 <= bytes.length && out.length < maxFiles; e++) {
    if (u32(p) !== 0x02014b50) break;
    const flags = u16(p + 8), method = u16(p + 10), size = u32(p + 20), nl = u16(p + 28), local = u32(p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + u16(p + 30) + u16(p + 32);
    if ((flags & 1) || name.endsWith("/") || !want(name) || local + 30 > bytes.length || u32(local) !== 0x04034b50) continue;
    const start = local + 30 + u16(local + 26) + u16(local + 28), raw = bytes.subarray(start, start + size);
    if (raw.length !== size || size > maxFile) continue;
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) { try { data = await inflateLimited(raw, "deflate-raw", maxFile); } catch { continue; } }
    else continue;
    total += data.length;
    if (total > maxTotal) throw new Error("too-big");
    out.push({ name, data });
  }
  return out;
}
