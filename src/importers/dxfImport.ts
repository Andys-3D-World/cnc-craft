/**
 * DXF-IMPORT: Texte (Einheit, Hinweise, Info) zum Ergebnis von dxfParse.ts. Rust liest dieselbe Datei im Hintergrund
 * noch einmal und vergleicht (importRust.ts).
 */
import { ImportResult, emptyResult } from "./common";
import { dxfParse, UNITS_TO_MM } from "./dxfParse";
import { checkImport } from "./importRust";
import { t } from "../i18n/i18n";

export function parseDxf(text: string): ImportResult {
  const p = dxfParse(text);
  if (p.binary) throw new Error(t("dxf.errBinary"));
  checkImport("import_dxf", { text }, p);
  const res: ImportResult = { ...emptyResult(), paths: p.paths, circles: p.circles, texts: p.texts };
  const unitKey = (UNITS_TO_MM[p.units] || [1, "dxf.unit.none"])[1];
  const unitName = unitKey.startsWith("dxf.") ? t(unitKey) : unitKey;
  const skipped = new Set(p.skipped.map(([k]) => k));
  const skippedList = p.skipped.map(([k, v]) => `${v}× ${k}`).join(", ");
  if (skippedList) res.warnings.push(t("dxf.skipped", { list: skippedList }));
  if (p.units === 0) res.warnings.push(t("dxf.noUnits"));
  res.info = `DXF (${unitName}): ` + p.counts.filter(([k]) => !skipped.has(k)).map(([k, v]) => `${v}× ${k}`).join(", ");
  return res;
}
