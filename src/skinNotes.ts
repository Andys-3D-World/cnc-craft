/**
 * ONION SKIN – what a finished program says about it (the notes cam.ts writes, see onionSkin.ts).
 * Used by the simulation (material thickness, so the skin shows as material that is left) and the setup sheet.
 * Works in every built-in language and for a program that was saved and loaded again.
 */
import { allBuiltinTexts, ascii, tMm } from "./i18n/i18n";
import { skinFromGcode, skinNotePatterns, type SkinInfo } from "./onionSkin";

export function skinInfo(lines: ArrayLike<string>): SkinInfo | null {
  const texts = (key: string) => [...allBuiltinTexts(key), tMm(key)].map(ascii);
  return skinFromGcode(lines, skinNotePatterns(texts("gc.skin"), texts("gc.skinCut")));
}
