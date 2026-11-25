/** SCHRIFTDATEI LESEN (TTF/OTF): Name, Schnitt, Lizenzangabe und ob deutsche und polnische Buchstaben drin sind. Ohne Oberfläche. */
export interface FontInfo { family: string; style: string; license: string; de: boolean; pl: boolean; variable: boolean }

export function isFontBytes(b: Uint8Array): boolean {
  if (b.length < 100) return false;
  const k = String.fromCharCode(b[0], b[1], b[2], b[3]);
  return k === "wOFF" || k === "wOF2" || k === "OTTO" || k === "true" || k === "\0\x01\0\0";
}

export function readFontInfo(b: Uint8Array): FontInfo | null {
  try {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (tag === "wOFF" || tag === "wOF2") return null; // gepackt: Name kommt aus dem Dateinamen
    const n = dv.getUint16(4), tab = new Map<string, number>();
    for (let i = 0; i < Math.min(n, 100); i++) { const p = 12 + 16 * i; tab.set(String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]), dv.getUint32(p + 8)); }
    const names = new Map<number, string>(), no = tab.get("name");
    if (no !== undefined) {
      const c = dv.getUint16(no + 2), so = no + dv.getUint16(no + 4);
      for (let i = 0; i < Math.min(c, 500); i++) {
        const p = no + 6 + 12 * i, plat = dv.getUint16(p), lang = dv.getUint16(p + 4), id = dv.getUint16(p + 6), len = Math.min(600, dv.getUint16(p + 8)), off = so + dv.getUint16(p + 10);
        if (off + len > b.length) continue;
        let s = "";
        if (plat === 3 || plat === 0) for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(dv.getUint16(off + k));
        else for (let k = 0; k < len; k++) s += String.fromCharCode(b[off + k]);
        if (!names.has(id) || (plat === 3 && lang === 0x409)) names.set(id, s);
      }
    }
    const has = cmapTest(dv, tab.get("cmap"), b.length), all = (s: string) => [...s].every(ch => has(ch.codePointAt(0)!));
    const tidy = (s: string | undefined) => (s || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80);
    return { family: tidy(names.get(16) || names.get(1)), style: tidy(names.get(17) || names.get(2)), license: (names.get(13) || names.get(14) || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 300), de: all("äöüÄÖÜß"), pl: all("ąćęłńóśźżĄŁ"), variable: tab.has("fvar") };
  } catch { return null; }
}

function cmapTest(dv: DataView, o: number | undefined, size: number): (c: number) => boolean {
  if (o === undefined) return () => false;
  const subs: ((c: number) => boolean)[] = [];
  for (let i = 0, n = Math.min(20, dv.getUint16(o + 2)); i < n; i++) {
    const q = o + dv.getUint32(o + 4 + 8 * i + 4);
    if (q + 16 > size) continue;
    const f = dv.getUint16(q);
    if (f === 4) {
      const sc = dv.getUint16(q + 6) / 2;
      subs.push(c => { for (let k = 0; k < sc; k++) { const end = dv.getUint16(q + 14 + 2 * k); if (c <= end) return end < 0xffff && c >= dv.getUint16(q + 16 + 2 * sc + 2 * k); } return false; });
    } else if (f === 12) {
      const g = Math.min(20000, dv.getUint32(q + 12));
      subs.push(c => { for (let k = 0; k < g; k++) { const p = q + 16 + 12 * k; if (c >= dv.getUint32(p) && c <= dv.getUint32(p + 4)) return true; } return false; });
    }
  }
  return c => subs.some(s => s(c));
}

/** Aus einer ZIP (z. B. von Google Fonts) die sinnvollen Schriften wählen: variable statt der vielen einzelnen Schnitte */
export function pickFromZip(names: string[]): string[] {
  const fonts = names.filter(n => /\.(ttf|otf|woff2?)$/i.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n));
  const vari = fonts.filter(n => /variable|\[[^\]]*wght/i.test(n));
  const base = vari.length ? vari : fonts.some(n => !/(^|\/)static\//i.test(n)) ? fonts.filter(n => !/(^|\/)static\//i.test(n)) : fonts;
  return base.slice(0, 40);
}
