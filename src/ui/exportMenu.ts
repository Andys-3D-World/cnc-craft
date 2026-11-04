/**
 * ZEICHNUNG EXPORTIEREN (Datei-Leiste ⤴, Strg+E, Rechtsklick → Exportieren)
 *
 * Auswahl (ohne Auswahl: alles) als SVG, DXF, PDF oder PLT speichern. Die Formen werden hier in neutrale
 * Elemente in mm umgewandelt (Y nach oben), das Schreiben macht vectorExport.ts.
 * Ebenen: Laser = Laser-Ebene (Name + Farbe), Fräse = Bearbeitungsart, Plasma = eine Ebene.
 * Gespeichert wird über den Dialog – den Pfad danach nie verändern (der Dialog gibt genau diesen frei).
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n/i18n";
import { app } from "../editor/editorState";
import { selectedShapes } from "../editor/selection";
import { MM_TO_PIXEL, arcGeometry, shapeToPaths } from "../shapeTransform";
import { layerForShape } from "../laserLayers";
import { isLaser, isPlasma } from "../machineMode";
import { modeColor } from "../render";
import { ExpItem, ExpResult, toSvg, toDxf, toPdf, toHpgl, curveItems } from "../vectorExport";

export type ExportFormat = "svg" | "dxf" | "pdf" | "plt";
export const EXPORT_FORMATS: ExportFormat[] = ["svg", "dxf", "pdf", "plt"];

const WRITERS: Record<ExportFormat, (items: ExpItem[]) => ExpResult> = { svg: toSvg, dxf: toDxf, pdf: toPdf, plt: toHpgl };
const NAMES: Record<ExportFormat, string> = { svg: "SVG", dxf: "DXF", pdf: "PDF", plt: "PLT / HPGL" };

/** Formen -> Export-Elemente (mm, Y oben) */
export function shapesToItems(shapes: any[]): ExpItem[] {
  const k = 1 / MM_TO_PIXEL;
  const laser = isLaser(), plasma = isPlasma();
  const out: ExpItem[] = [];
  for (const s of shapes) {
    let layer: string, color: string;
    if (plasma) { layer = "plasma"; color = "#ff4040"; }
    else if (laser) { const l = layerForShape(s); layer = l?.name || "0"; color = l?.color || "#ff4040"; }
    else { layer = s.millingMode || "outside"; color = modeColor(s.millingMode); }
    const base = { layer, color, ...(s.groupId ? { group: String(s.groupId) } : {}) };

    if (s.type === "circle") {
      out.push({ ...base, kind: "circle", cx: s.x * k, cy: s.y * k, r: Math.abs(s.w) * k });
    } else if (s.type === "arc" && arcGeometry(s)) {
      const g = arcGeometry(s)!;
      out.push({ ...base, kind: "arc", cx: g.cx * k, cy: g.cy * k, r: g.r * k, start: g.start, sweep: g.sweep });
    } else if (s.type === "image") {
      const p = s.points || [];
      if (p.length === 4 && typeof s.img?.src === "string") {
        out.push({ ...base, kind: "image", src: s.img.src, corners: p.map((q: any) => ({ x: q.x * k, y: q.y * k })) as any });
      }
    } else {
      for (const p of shapeToPaths(s)) {
        if (p.pts.length >= 2) out.push({ ...base, kind: "path", closed: p.closed, pts: p.pts.map(q => ({ x: q.x * k, y: q.y * k })) });
      }
    }
  }
  return out;
}

export function formatLabel(f: ExportFormat): string {
  return t(`exp.${f}`);
}

/** Auswahl bzw. alles im gewählten Format speichern. all = true: immer alles */
export async function exportDrawing(format: ExportFormat, all: boolean, log: (s: string) => void) {
  const sel = selectedShapes();
  const shapes = !all && sel.length ? sel : app().shapes;
  const items = curveItems(shapesToItems(shapes));
  if (!items.length) { log(t("exp.empty")); return; }
  try {
    const p = await save({ title: t("exp.saveTitle", { fmt: NAMES[format] }), defaultPath: `cnc-craft.${format}`, filters: [{ name: NAMES[format], extensions: [format] }] });
    if (!p) return;
    const r = WRITERS[format](items);
    await writeFile(String(p), new TextEncoder().encode(r.data));
    log(t("exp.saved", { n: shapes.length, p: String(p) }));
    if (r.skippedImages) log(t("exp.skippedImages", { n: r.skippedImages, fmt: NAMES[format] }));
  } catch (e) {
    log(`${t("log.error")} ${e}`);
  }
}
