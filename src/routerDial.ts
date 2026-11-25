/**
 * WÄHLRAD DER OBERFRÄSE (Tests: tests/smallPack.test.ts)
 *
 * Oberfräsen haben kein S-Signal, sondern ein Rad mit Stufen. Aus der Drehzahl des Werkzeugs wird die Stufe.
 * Makita RT0700: Tabelle der Bedienungsanleitung. DeWalt DWP611: 16 000–27 000 gleichmäßig auf 1–6 (Richtwerte).
 * Die echten Drehzahlen weichen je nach Gerät etwas ab.
 */
export type RouterModel = "none" | "makita" | "dewalt" | "own";
export const ROUTER_MODELS: RouterModel[] = ["none", "makita", "dewalt", "own"];
/** Drehzahl je Stufe 1, 2, 3 … */
export const DIALS: Record<"makita" | "dewalt", number[]> = {
  makita: [10000, 12000, 17000, 22000, 27000, 30000],
  dewalt: [16000, 18200, 20400, 22600, 24800, 27000],
};

/** Eigene Tabelle aus Text („10000, 12000, 17000“): 2 bis 12 Werte, aufsteigend; sonst null */
export function parseDial(text: string): number[] | null {
  const v = String(text ?? "").split(/[^\d.]+/).filter(Boolean).map(Number);
  if (v.length < 2 || v.length > 12 || v.some(x => !(x >= 500 && x <= 60000))) return null;
  for (let i = 1; i < v.length; i++) if (v[i] <= v[i - 1]) return null;
  return v;
}

export function dialTable(model: unknown, own: unknown): number[] | null {
  if (model === "makita" || model === "dewalt") return DIALS[model];
  if (model === "own") return parseDial(String(own ?? ""));
  return null;
}

export interface DialPos { pos: number; rpm: number; out: "" | "low" | "high" }
/** Stufe für eine Drehzahl, auf halbe Stufen gerundet; out = liegt außerhalb dessen, was das Rad kann */
export function dialFor(rpm: number, table: number[]): DialPos {
  const n = table.length, last = table[n - 1];
  if (rpm <= table[0]) return { pos: 1, rpm: table[0], out: rpm < table[0] * 0.97 ? "low" : "" };
  if (rpm >= last) return { pos: n, rpm: last, out: rpm > last * 1.03 ? "high" : "" };
  let i = 0;
  while (table[i + 1] < rpm) i++;
  const pos = Math.round((i + 1 + (rpm - table[i]) / (table[i + 1] - table[i])) * 2) / 2;
  const k = Math.min(n - 1, Math.floor(pos)), f = pos - Math.floor(pos);
  return { pos, rpm: f && k < n ? Math.round(table[k - 1] + (table[k] - table[k - 1]) * f) : table[Math.round(pos) - 1], out: "" };
}

// ---------------- Steifigkeit der Maschine (Schnittdaten-Rechner) ----------------
export type Rigidity = "weak" | "light" | "normal" | "stiff";
export const RIGIDITIES: Rigidity[] = ["weak", "light", "normal", "stiff"];
/** Faktor auf Zustellung und Zahnvorschub; „normal“ = wie bisher */
export const RIGID_K: Record<Rigidity, { ap: number; fz: number }> = {
  weak: { ap: 0.5, fz: 0.8 }, light: { ap: 0.7, fz: 0.9 }, normal: { ap: 1, fz: 1 }, stiff: { ap: 1.25, fz: 1 },
};
export const rigidK = (r: unknown) => RIGID_K[(RIGIDITIES as unknown[]).includes(r) ? r as Rigidity : "normal"];
