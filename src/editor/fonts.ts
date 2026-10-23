/**
 * SCHRIFTEN für das Text-Werkzeug
 *
 * Drei Quellen:
 *   1. Mitgeliefert – freie Schriften (SIL OFL / Apache 2.0) in public/fonts/, Lizenzen liegen daneben
 *   2. System       – jede installierte Schrift; Rust (fonts.rs) listet sie und liefert die Datei
 *   3. Eigene Datei – .ttf/.otf über den Dateidialog (gilt bis zum Neustart)
 *
 * Jede geladene Schrift wird unter einem eigenen, harmlosen Namen ("cncc-…") als FontFace
 * angemeldet. So malt das Text-Werkzeug genau diese Datei – egal, was die WebView selbst kennt.
 * "Relief SingleLine" ist eine Einzellinien-Schrift (SVG-Schrift mit offenen Linien) und wird
 * nicht gemalt, sondern direkt in Linien umgewandelt (singleLine.ts).
 */
import { invoke } from "@tauri-apps/api/core";

export type FontCat = "sans" | "serif" | "script" | "stencil" | "display" | "mono" | "single";

interface Bundled {
  family: string;
  cat: FontCat;
  file: string;          // unter /fonts/
  bold?: string;         // eigene Fett-Datei
  variable?: boolean;    // variable Schrift (enthält alle Gewichte)
}

export const SINGLE_LINE_FONT = "Relief SingleLine";
export const FALLBACK_FONT = "Open Sans";

export const BUNDLED: Bundled[] = [
  { family: "Open Sans", cat: "sans", file: "opensans/OpenSans-Variable.ttf", variable: true },
  { family: "Oswald", cat: "sans", file: "oswald/Oswald-Variable.ttf", variable: true },
  { family: "Josefin Sans", cat: "sans", file: "josefinsans/JosefinSans-Variable.ttf", variable: true },
  { family: "Nunito", cat: "sans", file: "nunito/Nunito-Variable.ttf", variable: true },
  { family: "Lora", cat: "serif", file: "lora/Lora-Variable.ttf", variable: true },
  { family: "Libre Baskerville", cat: "serif", file: "librebaskerville/LibreBaskerville-Variable.ttf", variable: true },
  { family: "Roboto Slab", cat: "serif", file: "robotoslab/RobotoSlab-Variable.ttf", variable: true },
  { family: "Cinzel", cat: "serif", file: "cinzel/Cinzel-Variable.ttf", variable: true },
  { family: "Dancing Script", cat: "script", file: "dancingscript/DancingScript-Variable.ttf", variable: true },
  { family: "Great Vibes", cat: "script", file: "greatvibes/GreatVibes-Regular.ttf" },
  { family: "Pacifico", cat: "script", file: "pacifico/Pacifico-Regular.ttf" },
  { family: "Lobster", cat: "script", file: "lobster/Lobster-Regular.ttf" },
  { family: "Caveat", cat: "script", file: "caveat/Caveat-Variable.ttf", variable: true },
  { family: "Permanent Marker", cat: "script", file: "permanentmarker/PermanentMarker-Regular.ttf" },
  { family: "Allerta Stencil", cat: "stencil", file: "allertastencil/AllertaStencil-Regular.ttf" },
  { family: "Stardos Stencil", cat: "stencil", file: "stardosstencil/StardosStencil-Regular.ttf", bold: "stardosstencil/StardosStencil-Bold.ttf" },
  { family: "Saira Stencil One", cat: "stencil", file: "sairastencilone/SairaStencilOne-Regular.ttf" },
  { family: "Bebas Neue", cat: "display", file: "bebasneue/BebasNeue-Regular.ttf" },
  { family: "Anton", cat: "display", file: "anton/Anton-Regular.ttf" },
  { family: "Bungee", cat: "display", file: "bungee/Bungee-Regular.ttf" },
  { family: "Black Ops One", cat: "display", file: "blackopsone/BlackOpsOne-Regular.ttf" },
  { family: "Righteous", cat: "display", file: "righteous/Righteous-Regular.ttf" },
  { family: "Abril Fatface", cat: "display", file: "abrilfatface/AbrilFatface-Regular.ttf" },
  { family: "Roboto Mono", cat: "mono", file: "robotomono/RobotoMono-Variable.ttf", variable: true },
  { family: "Special Elite", cat: "mono", file: "specialelite/SpecialElite-Regular.ttf" },
  // Einzellinie: Umrissfassung nur für die Vorschau im Namen, die Linien kommen aus der SVG-Schrift
  { family: SINGLE_LINE_FONT, cat: "single", file: "reliefsingleline/ReliefSingleLineOutline-Regular.woff2" }
];

/** Allgemeine CSS-Namen – die WebView kennt sie immer */
const GENERIC = new Set(["sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui"]);

export interface SysFace { family: string; style: string; weight: number; italic: boolean; path: string; index: number; }

/** Ergebnis von resolveFont: welcher Name gemalt wird, oder ob die Schrift fehlt */
export interface ResolvedFont {
  css: string;           // interner Name für ctx.font
  missing: boolean;      // gewünschte Schrift nicht da -> Ersatzschrift
  singleLine: boolean;
}

let counter = 0;
const nextName = () => `cncc-${++counter}`;
const registered = new Map<string, string>(); // Schlüssel (Quelle+Schnitt) -> interner Name
const customFonts = new Set<string>();          // eigene Dateien (Name)
let sysPromise: Promise<Map<string, SysFace[]>> | null = null;

export function customFontNames(): string[] { return [...customFonts]; }

/** Systemschriften (einmal suchen, dann aus dem Speicher). refresh = neu suchen */
export function systemFonts(refresh = false): Promise<Map<string, SysFace[]>> {
  if (!sysPromise || refresh) {
    sysPromise = invoke<SysFace[]>("system_fonts")
      .then(list => {
        const m = new Map<string, SysFace[]>();
        for (const f of list) {
          const arr = m.get(f.family);
          if (arr) arr.push(f); else m.set(f.family, [f]);
        }
        return m;
      })
      .catch(() => new Map<string, SysFace[]>()); // im Browser ohne Tauri: keine Systemschriften
  }
  return sysPromise;
}

async function addFace(key: string, family: string, src: string | ArrayBuffer, desc: FontFaceDescriptors) {
  const face = new FontFace(family, src, desc);
  await face.load();
  document.fonts.add(face);
  registered.set(key, family);
}

/** Mitgelieferte Schrift laden */
async function bundledFont(b: Bundled, bold: boolean): Promise<string> {
  const key = "b:" + b.family;
  let name = registered.get(key);
  if (!name) {
    name = nextName();
    await addFace(key, name, `url("/fonts/${b.file}")`, { weight: b.variable ? "100 900" : "400" });
  }
  if (bold && b.bold && !registered.has(key + ":bold")) {
    await addFace(key + ":bold", name, `url("/fonts/${b.bold}")`, { weight: "700" });
  }
  return name;
}

/** Den Schnitt einer Systemschrift holen, der am besten zu Fett/Kursiv passt */
async function systemFont(faces: SysFace[], bold: boolean, italic: boolean): Promise<string> {
  const want = bold ? 700 : 400;
  const score = (f: SysFace) => Math.abs(f.weight - want) + (f.italic === italic ? 0 : 1000);
  const best = faces.slice().sort((a, b) => score(a) - score(b))[0];
  const famKey = "s:" + best.family;
  let name = registered.get(famKey);
  if (!name) { name = nextName(); registered.set(famKey, name); }
  const key = `${famKey}:${best.path}#${best.index}`;
  if (!registered.has(key)) {
    const data = await invoke<ArrayBuffer>("system_font_data", { path: best.path, index: best.index });
    // Alle Schnitte einer Familie unter einem Namen: die WebView sucht dann selbst den passenden aus
    await addFace(key, name, data, { weight: String(best.weight), style: best.italic ? "italic" : "normal" });
  }
  return name;
}

/** Eigene Schriftdatei anmelden (Name = Dateiname ohne Endung). Wirft, wenn es keine Schrift ist */
export async function addCustomFont(fileName: string, data: ArrayBuffer): Promise<string> {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").trim() || "Font";
  await addFace("u:" + base, nextName(), data, { weight: "400" });
  customFonts.add(base);
  return base;
}

/**
 * Schrift zum Malen bereitstellen. Fehlt sie, kommt die Ersatzschrift (missing = true).
 */
export async function resolveFont(family: string, bold: boolean, italic: boolean): Promise<ResolvedFont> {
  const f = family.trim();
  const low = f.toLowerCase();
  if (GENERIC.has(low)) return { css: f, missing: false, singleLine: false };
  if (low === SINGLE_LINE_FONT.toLowerCase()) return { css: "", missing: false, singleLine: true };
  try {
    const b = BUNDLED.find(x => x.family.toLowerCase() === low);
    if (b) return { css: await bundledFont(b, bold), missing: false, singleLine: false };
    const cu = registered.get("u:" + f);
    if (cu) return { css: cu, missing: false, singleLine: false };
    const sys = await systemFonts();
    const faces = sys.get(f) ?? [...sys.entries()].find(([k]) => k.toLowerCase() === low)?.[1];
    if (faces?.length) return { css: await systemFont(faces, bold, italic), missing: false, singleLine: false };
  } catch { /* Datei kaputt oder nicht lesbar -> Ersatzschrift */ }
  const fb = BUNDLED.find(x => x.family === FALLBACK_FONT)!;
  try { return { css: await bundledFont(fb, bold), missing: true, singleLine: false }; }
  catch { return { css: "sans-serif", missing: true, singleLine: false }; }
}

/** CSS-Schriftname, mit dem die Auswahl einen Schriftnamen in seiner eigenen Schrift zeigt */
export function previewFamily(family: string, source: "bundled" | "system" | "custom"): string {
  if (source === "bundled") {
    const b = BUNDLED.find(x => x.family === family);
    if (!b) return "sans-serif";
    const key = "pv:" + b.family;
    let name = registered.get(key);
    if (!name) {
      name = nextName();
      // Ohne load(): die WebView lädt die Datei erst, wenn der Name sichtbar wird
      document.fonts.add(new FontFace(name, `url("/fonts/${b.file}")`, { weight: b.variable ? "100 900" : "400" }));
      registered.set(key, name);
    }
    return `"${name}", sans-serif`;
  }
  if (source === "custom") {
    const n = registered.get("u:" + family);
    return n ? `"${n}", sans-serif` : "sans-serif";
  }
  // Systemschrift: die WebView kennt installierte Schriften meist schon beim Namen
  return `"${family.replace(/["\\]/g, "")}", sans-serif`;
}
