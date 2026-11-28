/**
 * PDF- UND AI-IMPORT: Meldungen zum Ergebnis von pdfParse.ts. Rust liest dieselbe Datei im Hintergrund noch einmal und
 * vergleicht (importRust.ts).
 */
import { ImportResult, emptyResult } from "./common";
import { pdfParse } from "./pdfParse";
import { checkImport } from "./importRust";
import { t } from "../i18n/i18n";

export async function parsePdf(bytes: Uint8Array): Promise<ImportResult> {
  const p = await pdfParse(bytes);
  if (p.kind === "postscript") throw new Error(t("pdf.errPostscript"));
  if (p.kind === "notpdf") throw new Error(t("pdf.errNotPdf"));
  checkImport("import_pdf", bytes, p);
  if (!p.contents) throw new Error(t("pdf.errNoVectors"));
  const res: ImportResult = { ...emptyResult(), paths: p.paths };
  if (p.textBlocks) res.warnings.push(t("pdf.textSkipped"));
  if (p.skippedFilters) res.warnings.push(t("pdf.filterSkipped", { n: p.skippedFilters }));
  if (p.contents > 1) res.warnings.push(t("pdf.multiple", { n: p.contents }));
  res.info = t("pdf.info", { n: res.paths.length });
  return res;
}
