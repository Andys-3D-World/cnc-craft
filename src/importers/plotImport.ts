/**
 * HPGL/PLT-IMPORT (Schneideplotter, CorelDRAW-, Inkscape-, SignCut-Export)
 * und G-CODE-IMPORT (vorhandene .nc/.gcode-Dateien als Konturen anzeigen/weiterbearbeiten).
 */
import { ImportResult, emptyResult } from "./common";
import { hpglParse, gcodeParse } from "./plotParse";
import { checkImport } from "./importRust";
import { t } from "../i18n/i18n";

export function parseHpgl(text: string): ImportResult {
  const p = hpglParse(text);
  checkImport("import_plt", { kind: "hpgl", text }, p);
  const res = { ...emptyResult(), paths: p.paths, circles: p.circles };
  res.info = t("hpgl.info", { paths: res.paths.length, circles: res.circles.length, n: p.n });
  return res;
}

export function parseGcode(text: string): ImportResult {
  const p = gcodeParse(text);
  checkImport("import_plt", { kind: "gcode", text }, p);
  const res = { ...emptyResult(), paths: p.paths, circles: p.circles };
  res.info = t("gcodeImp.info", { n: res.paths.length, lines: p.n });
  if (res.paths.length) res.warnings.push(t("gcodeImp.warn"));
  return res;
}
