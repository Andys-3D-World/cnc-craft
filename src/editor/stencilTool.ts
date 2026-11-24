/**
 * SCHABLONEN-STEGE – Fenster. Die Rechnung liegt in stencilBridge.ts (mit Tests).
 *
 * Für die gewählten Formen (ohne Auswahl: alle auf dem Bett): lose Mittelstücke finden (das Innere von O, A, B …,
 * das mit dem Ausschnitt herausfiele) und mit schmalen Stegen am Blech halten. Die Vorschau zeigt die neuen
 * Schnittkonturen und markiert jedes Mittelstück mit einem Punkt. Übernehmen ersetzt Ausschnitt + Mittelstück
 * durch die neuen Konturen – ein Rückgängig-Schritt.
 */
import { app } from "./editorState";
import { selectedShapes } from "./selection";
import { livePreview } from "./livePreview";
import { createPolyline, MM_TO_PIXEL, shapeToPaths, Pt } from "../shapeTransform";
import { openToolPanel, rowCss, checkCss, ToolPanel } from "../ui/toolPanel";
import { bridgeIslands, findIslands, guessOuterIsPart, type XY } from "../stencilBridge";
import { t } from "../i18n/i18n";

const KEY = "cnc_craft_stencil";
/** Einstellungen der Form, die die neuen Konturen behalten */
const KEEP = ["toolId", "laserLayerId", "plasmaCutId", "millingDepth", "source", "laserOverride"];

export function openStencilDialog(log: (s: string) => void, redraw: () => void, commit: () => void) {
  const st = app();
  const sel = selectedShapes();
  // nur einfache geschlossene Konturen (eine Form = eine Kontur); Bilder und offene Linien bleiben, wie sie sind
  const src: any[] = (sel.length ? sel : st.shapes).filter((s: any) => {
    if (s.type === "image" || s.foldLine) return false;
    const p = shapeToPaths(s);
    return p.length === 1 && p[0].closed && p[0].pts.length >= 3;
  });
  if (src.length < 2) { log(t("stb.needTwo")); return; }
  const loops: XY[][] = src.map(s => shapeToPaths(s)[0].pts.map(q => [q.x / MM_TO_PIXEL, q.y / MM_TO_PIXEL] as XY));
  let o = { width: 2, count: 1, auto: true, angle: 90 };
  try { o = { ...o, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { /* egal */ }
  const outer = guessOuterIsPart(loops);
  const px = (r: XY[]): Pt[] => r.map(([x, y]) => ({ x: x * MM_TO_PIXEL, y: y * MM_TO_PIXEL }));

  const read = (p: ToolPanel) => ({
    width: Math.max(0.1, p.num("#stb-width", 2)), count: Math.max(1, Math.min(4, Math.round(p.num("#stb-count", 1)))),
    auto: p.check("#stb-auto"), angle: p.num("#stb-angle", 90), outerIsPart: p.$<HTMLSelectElement>("#stb-outer").value === "part"
  });
  const calc = (p: ToolPanel) => {
    const v = read(p);
    return { v, res: bridgeIslands(loops, { width: v.width, count: v.count, angle: v.auto ? null : v.angle, outerIsPart: v.outerIsPart }) };
  };

  openToolPanel({
    id: "stencil-panel", ico: "stencilBridge", title: t("stb.title"), ok: "✔ " + t("stb.run"), redraw,
    body: `
      <div style="font-size:0.8rem;color:var(--text-muted);">${t("stb.hint")}</div>
      <label style="${rowCss}">${t("stb.outer")}<select id="stb-outer" class="prop-input" style="width:150px;">
        <option value="part" ${outer ? "selected" : ""}>${t("stb.outer.part")}</option>
        <option value="cutout" ${outer ? "" : "selected"}>${t("stb.outer.cutout")}</option></select></label>
      <label style="${rowCss}">${t("stb.width")}<input id="stb-width" type="number" value="${Number(o.width) || 2}" min="0.1" step="0.5" style="width:90px;"></label>
      <label style="${rowCss}">${t("stb.count")}<input id="stb-count" type="number" value="${Number(o.count) || 1}" min="1" max="4" step="1" style="width:90px;"></label>
      <label style="${checkCss}"><input id="stb-auto" type="checkbox" ${o.auto ? "checked" : ""}> ${t("stb.auto")}</label>
      <label style="${rowCss}">${t("stb.angle")}<input id="stb-angle" type="number" value="${Number(o.angle) || 0}" step="15" style="width:90px;"></label>`,
    onChange: p => {
      p.$("#stb-angle").disabled = p.check("#stb-auto");
      const { v, res } = calc(p);
      const islands = findIslands(loops, v.outerIsPart);
      livePreview.paths = res.cutouts.flatMap(c => c.rings.map(r => ({ pts: px(r), closed: true })));
      livePreview.ghost = res.bridges.map(b => ({ pts: px(b), closed: true }));
      // Punkt auf jedem Mittelstück, das herausfallen würde
      livePreview.dots = islands.map(i => { const l = loops[i.loop]; return { x: l.reduce((s, q) => s + q[0], 0) / l.length * MM_TO_PIXEL, y: l.reduce((s, q) => s + q[1], 0) / l.length * MM_TO_PIXEL }; });
      if (!islands.length) p.info(t("stb.none"));
      else if (res.loose) p.info(t("stb.infoLoose", { n: islands.length, loose: res.loose }), true);
      else p.info(t("stb.info", { n: islands.length, b: res.bridges.length }));
    },
    onOk: p => {
      const { v, res } = calc(p);
      if (!res.cutouts.length) return false;
      try { localStorage.setItem(KEY, JSON.stringify({ width: v.width, count: v.count, auto: v.auto, angle: v.angle })); } catch { /* egal */ }
      const gone = new Set<string>(), made: any[] = [];
      for (const c of res.cutouts) {
        const like = src[c.hole];
        const extra: Record<string, any> = {};
        for (const k of KEEP) if (like[k] !== undefined) extra[k] = like[k];
        if (like.groupId) extra.groupId = like.groupId;
        gone.add(like.id);
        for (const i of c.islands) gone.add(src[i].id);
        // der Ausschnitt behält seine Schnittseite; war der Ausschnitt die äußerste Kontur ("outside" gezeichnet), bleibt auch das
        for (const r of c.rings) made.push(createPolyline(px(r), true, like.millingMode || "inside", extra));
      }
      st.shapes = [...st.shapes.filter((s: any) => !gone.has(s.id)), ...made];
      st.selectedShapeIds = made.map(s => s.id);
      log(t("stb.done", { n: res.bridged, b: res.bridges.length }));
      commit();
    }
  });
}
