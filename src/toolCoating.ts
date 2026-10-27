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
