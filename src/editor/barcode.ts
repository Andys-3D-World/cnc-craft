/**
 * BARCODES (own small encoder, no foreign library): Code 128 (text, digits paired) and EAN-13.
 * Result: bar positions in modules from the left. Quiet zones are not part of it.
 */
export interface Bars { width: number; bars: { x: number; w: number }[]; text: string }

/** Widths bar/space/bar/space/bar/space per symbol; 103–105 = start A/B/C, 106 = stop (7 widths) */
export const CODE128 = ("212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 " +
  "311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 " +
  "231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 " +
  "221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 " +
  "411131 211412 211214 211232 2331112").split(" ");

/** Widths starting with a bar → bars */
function fromWidths(widths: number[], text: string): Bars {
  const bars: Bars["bars"] = [];
  let x = 0;
  widths.forEach((w, i) => { if (i % 2 === 0) bars.push({ x, w }); x += w; });
  return { width: x, bars, text };
}

/** Symbol values with start and check symbol, without stop. null = not possible (empty, not ASCII 32–126, too long) */
export function code128Values(text: string): number[] | null {
  if (!text || text.length > 60 || /[^\x20-\x7e]/.test(text)) return null;
  const digits = (i: number) => /^\d*/.exec(text.slice(i))![0].length;
  const out: number[] = [];
  let i = 0, set: "B" | "C" = digits(0) >= 4 || (text.length === 2 && digits(0) === 2) ? "C" : "B";
  out.push(set === "C" ? 105 : 104);
  while (i < text.length) {
    const run = digits(i);
    if (set === "B" && run >= 4 && (run >= 6 || i + run === text.length)) {
      if (run % 2) { out.push(text.charCodeAt(i++) - 32); continue; } // odd run: one digit in B, then pairs
      out.push(99); set = "C"; continue;
    }
    if (set === "C") {
      if (run >= 2) { out.push(parseInt(text.slice(i, i + 2), 10)); i += 2; continue; }
      out.push(100); set = "B"; continue;
    }
    out.push(text.charCodeAt(i++) - 32);
  }
  out.push(out.reduce((s, v, k) => s + v * Math.max(1, k), 0) % 103);
  return out;
}

export function code128(text: string): Bars | null {
  const v = code128Values(text);
  return v ? fromWidths([...v, 106].flatMap(k => [...CODE128[k]].map(Number)), text) : null;
}

const EAN_L = ["3211", "2221", "2122", "1411", "1132", "1231", "1114", "1312", "1213", "3112"];
const EAN_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

export function eanCheck(d12: string): number {
  return (10 - [...d12].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0) % 10) % 10;
}

/** 12 digits (the check digit is added) or 13 digits with the right check digit. null = wrong */
export function ean13(text: string): Bars | null {
  const d = text.replace(/[\s-]/g, "");
  if (!/^\d{12,13}$/.test(d)) return null;
  const full = d.slice(0, 12) + eanCheck(d.slice(0, 12));
  if (d.length === 13 && d !== full) return null;
  const par = EAN_PARITY[Number(full[0])], rev = (s: string) => [...s].reverse().join("");
  // L starts with a space, G is the mirrored R code (also starts with a space), R has the widths of L but starts with a bar
  const left = [...full.slice(1, 7)].map((c, i) => (par[i] === "L" ? EAN_L[+c] : rev(EAN_L[+c]))).join("");
  const right = [...full.slice(7)].map(c => EAN_L[+c]).join("");
  return fromWidths([..."111" + left + "11111" + right + "111"].map(Number), full);
}
