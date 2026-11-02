/**
 * THEMEN für die Deko-Generatoren: welche Formen, Verzierungen, Aufsätze, Landschaften und welcher Himmel zu welcher
 * Jahreszeit bzw. welchem Fest passen. „Alle“ zeigt alles. Nur Daten (Tests: tests/themes.test.ts).
 */
import type { OrnamentShape, OrnamentDeco, OrnamentTopper } from "./ornament.ts";
import type { SceneKind } from "./landscape.ts";

export type Theme = "christmas" | "easter" | "halloween" | "spring" | "summer" | "autumn" | "love" | "all";
export const THEMES: Theme[] = ["christmas", "easter", "halloween", "spring", "summer", "autumn", "love", "all"];

export interface ThemeSet {
  shapes: OrnamentShape[];
  decos: OrnamentDeco[];
  toppers: OrnamentTopper[];
  scenes: SceneKind[];
  sky: { motifs: OrnamentDeco[]; body: "crescent" | "full" | "sun" };  // Schattenbox: Motive am Himmel und Mond/Sonne
}

export const THEME_SETS: Record<Exclude<Theme, "all">, ThemeSet> = {
  christmas: { shapes: ["ball", "star", "tree", "bell", "snowflake", "arch", "heart"], decos: ["stars", "flakes", "trees", "hearts", "dots", "mixed"],
    toppers: ["antlers", "bow", "cap"], scenes: ["trees", "village", "gifts", "hills"], sky: { motifs: ["stars", "flakes"], body: "crescent" } },
  easter: { shapes: ["egg", "bunny", "flower", "arch", "heart"], decos: ["eggs", "flowers", "butterflies", "dots"],
    toppers: ["bunny", "bow", "flower"], scenes: ["easter", "spring", "hills"], sky: { motifs: ["butterflies", "flowers"], body: "sun" } },
  halloween: { shapes: ["pumpkin", "ghost", "bat", "arch", "ball"], decos: ["bats", "pumpkins", "stars", "dots"],
    toppers: ["witch", "cat"], scenes: ["halloween", "hills"], sky: { motifs: ["bats", "stars"], body: "full" } },
  spring: { shapes: ["flower", "butterfly", "egg", "arch", "heart"], decos: ["flowers", "butterflies", "hearts", "dots"],
    toppers: ["flower", "bow"], scenes: ["spring", "easter", "hills"], sky: { motifs: ["butterflies", "flowers"], body: "sun" } },
  summer: { shapes: ["sun", "shell", "flower", "arch", "ball"], decos: ["suns", "flowers", "stars", "dots"],
    toppers: ["flower", "bow"], scenes: ["summer", "hills"], sky: { motifs: ["suns", "butterflies"], body: "sun" } },
  autumn: { shapes: ["leaf", "acorn", "mushroom", "pumpkin", "arch", "ball"], decos: ["leaves", "pumpkins", "dots"],
    toppers: ["leaves", "bow"], scenes: ["autumn", "hills"], sky: { motifs: ["leaves"], body: "crescent" } },
  love: { shapes: ["heart", "ball", "arch", "flower"], decos: ["hearts", "flowers", "dots", "stars"],
    toppers: ["bow", "flower"], scenes: ["spring", "hills"], sky: { motifs: ["hearts", "stars"], body: "crescent" } },
};

/** Liste für ein Thema („alle“ = alles aus allen Themen, ohne Doppelte, in der Reihenfolge der Themen) */
export function themeList<K extends keyof Omit<ThemeSet, "sky">>(theme: Theme, key: K): ThemeSet[K] {
  if (theme !== "all") return THEME_SETS[theme][key];
  return [...new Set(Object.values(THEME_SETS).flatMap(s => s[key] as string[]))] as ThemeSet[K];
}

/** Himmel einer Schattenbox nach Thema */
export const themeSky = (theme: Theme) => THEME_SETS[theme === "all" ? "christmas" : theme].sky;
