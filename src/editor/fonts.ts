/**
 * SCHRIFTEN für das Text-Werkzeug
 *
 * Drei Quellen:
 *   1. Mitgeliefert – freie Schriften (SIL OFL / Apache 2.0) in public/fonts/, Lizenzen liegen daneben
 *   2. System       – jede installierte Schrift; Rust (fonts.rs) listet sie und liefert die Datei
 *   3. Eigene Dateien – .ttf/.otf/.woff oder eine ZIP; Rust (user_fonts.rs) bewahrt sie dauerhaft auf
 *
 * Jede geladene Schrift wird unter einem eigenen, harmlosen Namen ("cncc-…") als FontFace
 * angemeldet. So malt das Text-Werkzeug genau diese Datei – egal, was die WebView selbst kennt.
 * "Relief SingleLine" ist eine Einzellinien-Schrift (SVG-Schrift mit offenen Linien) und wird
 * nicht gemalt, sondern direkt in Linien umgewandelt (singleLine.ts).
 */
import { invoke } from "@tauri-apps/api/core";
import { isFontBytes, pickFromZip, readFontInfo } from "./fontFile";
import { unzipFiles } from "../zipRead";

export type FontCat = "sans" | "serif" | "script" | "stencil" | "display" | "mono" | "single";

interface Bundled {
  family: string;
  cat: FontCat;
  file: string;          // unter /fonts/
  bold?: string;         // eigene Fett-Datei
  variable?: boolean;    // variable Schrift (enthält alle Gewichte)
  apache?: boolean;      // Apache-Lizenz (LICENSE.txt) statt OFL (OFL.txt)
  noPl?: boolean;        // ohne polnische Buchstaben
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
  { family: "Roboto Slab", cat: "serif", file: "robotoslab/RobotoSlab-Variable.ttf", variable: true, apache: true },
  { family: "Cinzel", cat: "serif", file: "cinzel/Cinzel-Variable.ttf", variable: true },
  { family: "Dancing Script", cat: "script", file: "dancingscript/DancingScript-Variable.ttf", variable: true },
  { family: "Great Vibes", cat: "script", file: "greatvibes/GreatVibes-Regular.ttf" },
  { family: "Pacifico", cat: "script", file: "pacifico/Pacifico-Regular.ttf" },
  { family: "Lobster", cat: "script", file: "lobster/Lobster-Regular.ttf" },
  { family: "Caveat", cat: "script", file: "caveat/Caveat-Variable.ttf", variable: true },
  { family: "Permanent Marker", cat: "script", file: "permanentmarker/PermanentMarker-Regular.ttf", apache: true, noPl: true },
  { family: "Allerta Stencil", cat: "stencil", file: "allertastencil/AllertaStencil-Regular.ttf", noPl: true },
  { family: "Stardos Stencil", cat: "stencil", file: "stardosstencil/StardosStencil-Regular.ttf", bold: "stardosstencil/StardosStencil-Bold.ttf", noPl: true },
  { family: "Saira Stencil One", cat: "stencil", file: "sairastencilone/SairaStencilOne-Regular.ttf" },
  { family: "Bebas Neue", cat: "display", file: "bebasneue/BebasNeue-Regular.ttf" },
  { family: "Anton", cat: "display", file: "anton/Anton-Regular.ttf" },
  { family: "Bungee", cat: "display", file: "bungee/Bungee-Regular.ttf" },
  { family: "Black Ops One", cat: "display", file: "blackopsone/BlackOpsOne-Regular.ttf" },
  { family: "Righteous", cat: "display", file: "righteous/Righteous-Regular.ttf" },
  { family: "Abril Fatface", cat: "display", file: "abrilfatface/AbrilFatface-Regular.ttf" },
  { family: "Roboto Mono", cat: "mono", file: "robotomono/RobotoMono-Variable.ttf", variable: true },
  { family: "Special Elite", cat: "mono", file: "specialelite/SpecialElite-Regular.ttf", apache: true },
  // ab 0.4.11 dazugekommen: ausgesucht zum Fräsen und Lasern (Google Fonts, jede mit Lizenzdatei im Ordner)
  { family: "Archivo Black", cat: "sans", file: "archivoblack/ArchivoBlack-Regular.ttf" },
  { family: "Barlow", cat: "sans", file: "barlow/Barlow-Regular.ttf", bold: "barlow/Barlow-Bold.ttf" },
  { family: "Barlow Condensed", cat: "sans", file: "barlowcondensed/BarlowCondensed-Regular.ttf" },
  { family: "Comfortaa", cat: "sans", file: "comfortaa/Comfortaa-Variable.ttf", variable: true },
  { family: "Exo 2", cat: "sans", file: "exo2/Exo2-Variable.ttf", variable: true },
  { family: "Fredoka", cat: "sans", file: "fredoka/Fredoka-Variable.ttf", variable: true, noPl: true },
  { family: "Jost", cat: "sans", file: "jost/Jost-Variable.ttf", variable: true },
  { family: "League Spartan", cat: "sans", file: "leaguespartan/LeagueSpartan-Variable.ttf", variable: true },
  { family: "Lexend", cat: "sans", file: "lexend/Lexend-Variable.ttf", variable: true },
  { family: "Outfit", cat: "sans", file: "outfit/Outfit-Variable.ttf", variable: true },
  { family: "Passion One", cat: "sans", file: "passionone/PassionOne-Regular.ttf", bold: "passionone/PassionOne-Bold.ttf", noPl: true },
  { family: "Poppins", cat: "sans", file: "poppins/Poppins-Regular.ttf", bold: "poppins/Poppins-Bold.ttf" },
  { family: "Quicksand", cat: "sans", file: "quicksand/Quicksand-Variable.ttf", variable: true },
  { family: "Raleway", cat: "sans", file: "raleway/Raleway-Variable.ttf", variable: true },
  { family: "Russo One", cat: "sans", file: "russoone/RussoOne-Regular.ttf" },
  { family: "Titillium Web", cat: "sans", file: "titilliumweb/TitilliumWeb-Regular.ttf", bold: "titilliumweb/TitilliumWeb-Bold.ttf" },
  { family: "Urbanist", cat: "sans", file: "urbanist/Urbanist-Variable.ttf", variable: true, noPl: true },
  { family: "Varela Round", cat: "sans", file: "varelaround/VarelaRound-Regular.ttf" },
  { family: "Alfa Slab One", cat: "serif", file: "alfaslabone/AlfaSlabOne-Regular.ttf" },
  { family: "Almendra", cat: "serif", file: "almendra/Almendra-Regular.ttf" },
  { family: "Arvo", cat: "serif", file: "arvo/Arvo-Regular.ttf", bold: "arvo/Arvo-Bold.ttf", noPl: true },
  { family: "Cinzel Decorative", cat: "serif", file: "cinzeldecorative/CinzelDecorative-Regular.ttf", bold: "cinzeldecorative/CinzelDecorative-Bold.ttf" },
  { family: "Crimson Text", cat: "serif", file: "crimsontext/CrimsonText-Regular.ttf", bold: "crimsontext/CrimsonText-Bold.ttf" },
  { family: "Marcellus", cat: "serif", file: "marcellus/Marcellus-Regular.ttf" },
  { family: "MedievalSharp", cat: "serif", file: "medievalsharp/MedievalSharp.ttf" },
  { family: "Playfair Display", cat: "serif", file: "playfairdisplay/PlayfairDisplay-Variable.ttf", variable: true },
  { family: "Rokkitt", cat: "serif", file: "rokkitt/Rokkitt-Variable.ttf", variable: true },
  { family: "Ultra", cat: "serif", file: "ultra/Ultra-Regular.ttf", apache: true },
  { family: "Uncial Antiqua", cat: "serif", file: "uncialantiqua/UncialAntiqua-Regular.ttf" },
  { family: "UnifrakturMaguntia", cat: "serif", file: "unifrakturmaguntia/UnifrakturMaguntia-Book.ttf", noPl: true },
  { family: "Alex Brush", cat: "script", file: "alexbrush/AlexBrush-Regular.ttf" },
  { family: "Allura", cat: "script", file: "allura/Allura-Regular.ttf" },
  { family: "Amatic SC", cat: "script", file: "amaticsc/AmaticSC-Regular.ttf", bold: "amaticsc/AmaticSC-Bold.ttf" },
  { family: "Architects Daughter", cat: "script", file: "architectsdaughter/ArchitectsDaughter-Regular.ttf" },
  { family: "Cookie", cat: "script", file: "cookie/Cookie-Regular.ttf" },
  { family: "Courgette", cat: "script", file: "courgette/Courgette-Regular.ttf" },
  { family: "Grand Hotel", cat: "script", file: "grandhotel/GrandHotel-Regular.ttf" },
  { family: "Indie Flower", cat: "script", file: "indieflower/IndieFlower-Regular.ttf" },
  { family: "Kaushan Script", cat: "script", file: "kaushanscript/KaushanScript-Regular.ttf" },
  { family: "Leckerli One", cat: "script", file: "leckerlione/LeckerliOne-Regular.ttf", noPl: true },
  { family: "Marck Script", cat: "script", file: "marckscript/MarckScript-Regular.ttf" },
  { family: "Merienda", cat: "script", file: "merienda/Merienda-Variable.ttf", variable: true },
  { family: "Niconne", cat: "script", file: "niconne/Niconne-Regular.ttf", noPl: true },
  { family: "Oleo Script", cat: "script", file: "oleoscript/OleoScript-Regular.ttf", bold: "oleoscript/OleoScript-Bold.ttf", noPl: true },
  { family: "Parisienne", cat: "script", file: "parisienne/Parisienne-Regular.ttf" },
  { family: "Patrick Hand", cat: "script", file: "patrickhand/PatrickHand-Regular.ttf" },
  { family: "Playball", cat: "script", file: "playball/Playball-Regular.ttf" },
  { family: "Sacramento", cat: "script", file: "sacramento/Sacramento-Regular.ttf" },
  { family: "Satisfy", cat: "script", file: "satisfy/Satisfy-Regular.ttf", apache: true, noPl: true },
  { family: "Shadows Into Light", cat: "script", file: "shadowsintolight/ShadowsIntoLight.ttf" },
  { family: "Tangerine", cat: "script", file: "tangerine/Tangerine-Regular.ttf", bold: "tangerine/Tangerine-Bold.ttf", noPl: true },
  { family: "Yellowtail", cat: "script", file: "yellowtail/Yellowtail-Regular.ttf", apache: true },
  { family: "Big Shoulders Stencil", cat: "stencil", file: "bigshouldersstencil/BigShouldersStencil-Variable.ttf", variable: true },
  { family: "Emblema One", cat: "stencil", file: "emblemaone/EmblemaOne-Regular.ttf" },
  { family: "Keania One", cat: "stencil", file: "keaniaone/KeaniaOne-Regular.ttf", noPl: true },
  { family: "SirinStencil", cat: "stencil", file: "sirinstencil/SirinStencil-Regular.ttf", noPl: true },
  { family: "Wallpoet", cat: "stencil", file: "wallpoet/Wallpoet-Regular.ttf", noPl: true },
  { family: "Audiowide", cat: "display", file: "audiowide/Audiowide-Regular.ttf" },
  { family: "Bangers", cat: "display", file: "bangers/Bangers-Regular.ttf" },
  { family: "Bowlby One", cat: "display", file: "bowlbyone/BowlbyOne-Regular.ttf", noPl: true },
  { family: "Chewy", cat: "display", file: "chewy/Chewy-Regular.ttf", apache: true, noPl: true },
  { family: "Concert One", cat: "display", file: "concertone/ConcertOne-Regular.ttf", noPl: true },
  { family: "Creepster", cat: "display", file: "creepster/Creepster-Regular.ttf", noPl: true },
  { family: "Ewert", cat: "display", file: "ewert/Ewert-Regular.ttf", noPl: true },
  { family: "Fugaz One", cat: "display", file: "fugazone/FugazOne-Regular.ttf", noPl: true },
  { family: "Germania One", cat: "display", file: "germaniaone/GermaniaOne-Regular.ttf", noPl: true },
  { family: "Lilita One", cat: "display", file: "lilitaone/LilitaOne-Regular.ttf", noPl: true },
  { family: "Limelight", cat: "display", file: "limelight/Limelight-Regular.ttf" },
  { family: "Luckiest Guy", cat: "display", file: "luckiestguy/LuckiestGuy-Regular.ttf", apache: true },
  { family: "Metamorphous", cat: "display", file: "metamorphous/Metamorphous-Regular.ttf" },
  { family: "Monoton", cat: "display", file: "monoton/Monoton-Regular.ttf" },
  { family: "Mountains of Christmas", cat: "display", file: "mountainsofchristmas/MountainsofChristmas-Regular.ttf", bold: "mountainsofchristmas/MountainsofChristmas-Bold.ttf", apache: true, noPl: true },
  { family: "New Rocker", cat: "display", file: "newrocker/NewRocker-Regular.ttf" },
  { family: "Orbitron", cat: "display", file: "orbitron/Orbitron-Variable.ttf", variable: true, noPl: true },
  { family: "Pirata One", cat: "display", file: "pirataone/PirataOne-Regular.ttf" },
  { family: "Poiret One", cat: "display", file: "poiretone/PoiretOne-Regular.ttf" },
  { family: "Press Start 2P", cat: "display", file: "pressstart2p/PressStart2P-Regular.ttf" },
  { family: "Racing Sans One", cat: "display", file: "racingsansone/RacingSansOne-Regular.ttf" },
  { family: "Rye", cat: "display", file: "rye/Rye-Regular.ttf", noPl: true },
  { family: "Shrikhand", cat: "display", file: "shrikhand/Shrikhand-Regular.ttf" },
  { family: "Staatliches", cat: "display", file: "staatliches/Staatliches-Regular.ttf" },
  { family: "Titan One", cat: "display", file: "titanone/TitanOne-Regular.ttf" },
  { family: "Courier Prime", cat: "mono", file: "courierprime/CourierPrime-Regular.ttf", bold: "courierprime/CourierPrime-Bold.ttf" },
  { family: "Share Tech Mono", cat: "mono", file: "sharetechmono/ShareTechMono-Regular.ttf", noPl: true },
  { family: "Space Mono", cat: "mono", file: "spacemono/SpaceMono-Regular.ttf", bold: "spacemono/SpaceMono-Bold.ttf" },
  { family: "VT323", cat: "mono", file: "vt323/VT323-Regular.ttf" },
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

export function customFontNames(): string[] { return [...new Set([...userFonts.map(f => f.name), ...customFonts])]; }

/** Dauerhaft gespeicherte eigene Schriften (user_fonts.rs) */
export interface UserFont { id: string; name: string; alias: string; size: number }
let userFonts: UserFont[] = [];
export const FONTS_CHANGED = "cnc-fonts-changed";
export const userFontList = (): UserFont[] => userFonts.slice();
/** Beim Start: Verzeichnis lesen (die Dateien selbst erst bei Bedarf) */
export const userFontsReady: Promise<void> = (async () => {
  try { const l = await invoke<UserFont[]>("user_fonts"); if (Array.isArray(l)) userFonts = l; } catch { /* im Browser ohne Tauri: nur bis zum Neustart */ }
})();
const findUser = (name: string) => { const l = name.toLowerCase(); return userFonts.find(f => f.name.toLowerCase() === l) ?? userFonts.find(f => f.alias.toLowerCase() === l); };
const loading = new Map<string, Promise<string>>();
/** gespeicherte Schrift laden und anmelden; liefert den internen Namen */
export function loadUserFont(f: UserFont): Promise<string> {
  const key = "u:" + f.name, have = registered.get(key);
  if (have) return Promise.resolve(have);
  let p = loading.get(key);
  if (!p) {
    p = (async () => { const n = nextName(), data = await invoke<ArrayBuffer>("user_font_data", { id: f.id }); await addFace(key, n, data, { weight: readFontInfo(new Uint8Array(data))?.variable ? "100 900" : "400" }); return n; })();
    p.catch(() => loading.delete(key));
    loading.set(key, p);
  }
  return p;
}
export async function removeUserFont(f: UserFont): Promise<void> {
  await invoke("user_font_remove", { id: f.id });
  userFonts = userFonts.filter(x => x.id !== f.id);
  window.dispatchEvent(new Event(FONTS_CHANGED));
}
/** Dateien (Schriften oder ZIP) hinzufügen. Ergebnis: Namen der neuen Schriften und wie viele Dateien keine Schrift waren */
export async function addFontFiles(files: { name: string; data: Uint8Array }[]): Promise<{ names: string[]; bad: number }> {
  const names: string[] = [];
  let bad = 0;
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      try {
        const list: string[] = [];
        await unzipFiles(f.data, n => { list.push(n); return false; });
        const want = new Set(pickFromZip(list)), got = await unzipFiles(f.data, n => want.has(n));
        if (!got.length) bad++;
        for (const g of got) { try { names.push(await addCustomFont(g.name, g.data.slice().buffer as ArrayBuffer)); } catch { bad++; } }
      } catch { bad++; }
    } else { try { names.push(await addCustomFont(f.name, f.data.slice().buffer as ArrayBuffer)); } catch { bad++; } }
  }
  window.dispatchEvent(new Event(FONTS_CHANGED));
  return { names: [...new Set(names)], bad };
}
/** Favoriten (Namen) */
const FAV_KEY = "cnc_craft_font_favs";
export function fontFavs(): Set<string> { try { const l = JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); return new Set(Array.isArray(l) ? l.filter((x: any) => typeof x === "string").slice(0, 500) : []); } catch { return new Set(); } }
export function toggleFontFav(name: string): boolean {
  const s = fontFavs(), on = !s.has(name);
  if (on) s.add(name); else s.delete(name);
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch { /* egal */ }
  return on;
}

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

/** Eigene Schriftdatei anmelden und dauerhaft aufbewahren (Name aus der Schrift, sonst Dateiname). Wirft, wenn es keine Schrift ist */
export async function addCustomFont(fileName: string, data: ArrayBuffer): Promise<string> {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").trim() || "Font";
  const bytes = new Uint8Array(data);
  if (!isFontBytes(bytes)) throw new Error("no-font");
  const i = readFontInfo(bytes);
  let name = i?.family ? i.family + (i.style && !/^regular$/i.test(i.style) ? " " + i.style : "") : base;
  if (BUNDLED.some(b => b.family.toLowerCase() === name.toLowerCase())) name += " 2"; // mitgeliefert hat denselben Namen: auseinanderhalten
  // zuerst laden: was der Browser nicht zeigen kann, wird auch nicht gespeichert
  const css = nextName();
  await addFace("new:" + css, css, data.slice(0), { weight: i?.variable ? "100 900" : "400" });
  try {
    const f = await invoke<UserFont>("user_font_add", bytes, { headers: { "font-name": encodeURIComponent(name), "font-alias": encodeURIComponent(base) } });
    if (!userFonts.some(x => x.id === f.id)) userFonts.push(f);
    registered.set("u:" + f.name, css);
    return f.name;
  } catch { // ohne Speicher (Browser, voll): gilt bis zum Neustart
    registered.set("u:" + name, css);
    registered.set("u:" + base, css);
    customFonts.add(name);
    return name;
  }
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
    await userFontsReady;
    const uf = findUser(f);
    if (uf) return { css: await loadUserFont(uf), missing: false, singleLine: false };
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
