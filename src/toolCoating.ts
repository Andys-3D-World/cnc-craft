/**
 * BESCHICHTUNG der Fräser (nur zur Info in der Werkzeug-Bibliothek, ändert keine Schnittdaten).
 * Liste wie bei typischen Händlern: blank, TiN, TiAlN, AlTiN, AlCrN, CrN, ZrN, DLC.
 * Eigene Datei ohne Abhängigkeiten, damit auch der Fusion-Import (und seine Tests) sie nutzen kann.
 */
export type Coating = "none" | "tin" | "tialn" | "altin" | "alcrn" | "crn" | "zrn" | "dlc";

export const COATINGS: Coating[] = ["none", "tin", "tialn", "altin", "alcrn", "crn", "zrn", "dlc"];

/** Kurzname, wie er auf dem Fräser/Katalog steht ("none" hat einen übersetzten Text) */
export const COATING_LABEL: Record<Exclude<Coating, "none">, string> = {
  tin: "TiN", tialn: "TiAlN", altin: "AlTiN", alcrn: "AlCrN", crn: "CrN", zrn: "ZrN", dlc: "DLC"
};

/** Beschichtung aus einem Text erkennen (z. B. Name aus einer Fusion-Bibliothek), sonst undefined */
export function coatingFromText(s: string): Coating | undefined {
  const m = /\b(TiAlN|AlTiN|AlCrN|TiN|CrN|ZrN|DLC)\b/i.exec(s || "");
  return m ? (m[1].toLowerCase() as Coating) : undefined;
}

/** Farbe des Fräsers je Beschichtung (0…1), für die Bilder in Simulation und Bibliothek – "none" = blankes Hartmetall */
export const COATING_RGB: Record<Coating, [number, number, number]> = {
  none: [0.66, 0.68, 0.72], tin: [0.86, 0.68, 0.27], tialn: [0.33, 0.27, 0.37], altin: [0.24, 0.24, 0.27],
  alcrn: [0.47, 0.5, 0.56], crn: [0.74, 0.75, 0.77], zrn: [0.87, 0.81, 0.55], dlc: [0.15, 0.15, 0.17]
};
