/**
 * STL FÜR DEN 3D-DRUCK (Extras → STL exportieren)
 *
 * Die Auswahl (ohne Auswahl: alles) wird zu einem Körper (Rechnung in view3d/solid.ts). Die Formen sind in Gruppen
 * eingeteilt – Laser: je Ebene, Fräse: je Bearbeitungsart, Plasma: eine Gruppe. Jede Gruppe ist Grundkörper
 * (Höhe), Vertiefung (Tiefe), Erhebung (Höhe) oder bleibt weg. Vorschlag: Laser-Schnitt = Grundkörper,
 * Füllen/Gravieren = Vertiefung; Fräse: außen/innen = Grundkörper, Tasche/V-Carve = Vertiefung mit der Frästiefe.
 * Live-Vorschau im 3D-Betrachter, Speichern als binäres STL über den Dialog (Pfad danach nie verändern).
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n/i18n";
import { app } from "../editor/editorState";
import { selectedShapes } from "../editor/selection";
import { isClosedShape } from "../shapeTransform";
import { layerForShape } from "../laserLayers";
import { isLaser, isPlasma } from "../machineMode";
import { Viewer3D } from "../view3d/viewer3d";
import { buildSolid, shellMeshes, stlBinary, shellBounds, Shell, SolidKind } from "../view3d/solid";

type Kind = SolidKind | "skip";
interface Group { key: string; name: string; color: string; kind: Kind; value: number; shapes: any[] }

const KEY = "cnc_craft_stl";
const KINDS: Kind[] = ["body", "recess", "raise", "skip"];
const DEF_VALUE: Record<Kind, number> = { body: 3, recess: 0.6, raise: 1, skip: 0 };

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const MILL_NAME: Record<string, string> = { "on-line": "mode.engrave", pocket: "mode.pocket", vcarve: "mode.vcarve", drill: "mode.drill" };

/** Formen in Gruppen einteilen, mit Vorschlag für die Art */
function makeGroups(shapes: any[]): Group[] {
  const map = new Map<string, Group>();
  for (const s of shapes) {
    if (!isClosedShape(s)) continue;
    let key: string, name: string, color = "#999", kind: Kind = "body", value = DEF_VALUE.body;
    if (isPlasma()) { key = "P"; name = t("stl.all"); }
    else if (isLaser()) {
      const l = layerForShape(s);
      key = "L:" + (l?.id || "-"); name = l?.name || "–"; color = l?.color || color;
      const cut = !!l && l.mode !== "fill" && l.power >= 70;
      kind = cut ? "body" : l && l.mode !== "line" ? "recess" : "skip";
      value = DEF_VALUE[kind];
    } else {
      const m = String(s.millingMode || "outside");
      // außen + innen gehören zusammen, sonst würde ein Loch zu einem eigenen Körper statt frei zu bleiben
      const cut = m === "outside" || m === "inside";
      key = "M:" + (cut ? "cut" : m); name = cut ? `${t("mode.part")} / ${t("mode.hole")}` : MILL_NAME[m] ? t(MILL_NAME[m]) : m;
      kind = cut ? "body" : m === "pocket" || m === "vcarve" || m === "drill" ? "recess" : "skip";
      value = kind === "recess" ? Math.abs(Number(s.millingDepth)) || DEF_VALUE.recess : DEF_VALUE[kind];
    }
    let g = map.get(key);
    if (!g) { g = { key, name, color, kind, value, shapes: [] }; map.set(key, g); }
    g.shapes.push(s);
  }
  // zuletzt benutzte Einstellungen je Gruppe
  let mem: Record<string, { kind: Kind; value: number }> = {};
  try { mem = JSON.parse(localStorage.getItem(KEY) || "{}").groups || {}; } catch { /* egal */ }
  for (const g of map.values()) {
    const m = mem[g.key];
    if (m && KINDS.includes(m.kind) && Number.isFinite(Number(m.value)) && Number(m.value) >= 0) { g.kind = m.kind; g.value = Number(m.value); }
  }
  return [...map.values()];
}

export function openStlExport(log: (s: string) => void) {
  const sel = selectedShapes();
  const groups = makeGroups(sel.length ? sel : app().shapes);
  if (!groups.length) { log(t("stl.none")); return; }

  document.getElementById("stlx-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "stlx-dialog-overlay";
  ov.className = "dlg-overlay";
  const row = (g: Group, i: number) => `
    <div class="dlg-row" style="gap:6px;">
      <span style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
        <i style="flex:none;width:10px;height:10px;border-radius:2px;background:${esc(g.color)};"></i>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(g.name)}">${esc(g.name)} <em style="font-style:normal;color:var(--text-muted);">(${g.shapes.length})</em></span></span>
      <select data-g="${i}" class="stl-kind" style="width:auto;">${KINDS.map(k => `<option value="${k}">${t("stl.kind." + k)}</option>`).join("")}</select>
      <span class="dlg-num"><input data-g="${i}" class="stl-val" type="number" min="0" step="0.1" style="width:64px;"><em style="width:auto;">mm</em></span>
    </div>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(900px, calc(100vw - 32px));">
      <h3>🖨 ${t("stlx.title")}</h3>
      <div class="dlg-hint">${t(sel.length ? "stl.descSel" : "stl.descAll", { n: groups.reduce((a, g) => a + g.shapes.length, 0) })}</div>
      <div style="display:grid;grid-template-columns:minmax(280px, 360px) 1fr;gap:12px;align-items:start;">
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${groups.map(row).join("")}
          <div class="dlg-hint">${t("stl.kindHint")}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <canvas id="stl-cv" style="width:100%;height:min(420px, calc(100vh - 300px));border-radius:10px;cursor:grab;display:block;"></canvas>
          <div id="stl-info" class="dlg-hint"></div>
        </div>
      </div>
      <div class="dlg-buttons">
        <button id="stl-cancel" class="btn-secondary">${t("dlg.close")}</button>
        <button id="stl-ok" class="btn-primary">💾 ${t("stl.save")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement>(id: string) => ov.querySelector("#" + id) as E;
  const viewer = new Viewer3D($<HTMLCanvasElement>("stl-cv"));
  const kinds = [...ov.querySelectorAll<HTMLSelectElement>(".stl-kind")];
  const vals = [...ov.querySelectorAll<HTMLInputElement>(".stl-val")];
  groups.forEach((g, i) => { kinds[i].value = g.kind; vals[i].value = String(g.value); });

  let shells: Shell[] = [];
  let first = true;
  const build = () => {
    groups.forEach((g, i) => {
      g.kind = kinds[i].value as Kind;
      const v = parseFloat(vals[i].value);
      g.value = Number.isFinite(v) && v >= 0 ? v : DEF_VALUE[g.kind];
      vals[i].disabled = g.kind === "skip";
    });
    shells = buildSolid(groups.filter(g => g.kind !== "skip").map(g => ({ kind: g.kind as SolidKind, value: g.value, shapes: g.shapes })));
    if (viewer.ok) viewer.setMeshes(shellMeshes(shells), !first);
    first = false;
    const b = shellBounds(shells);
    const n = shells.reduce((a, s) => a + s.tris.length / 9, 0);
    $<HTMLElement>("stl-info").textContent = !viewer.ok ? t("v3d.noGl")
      : b ? t("stl.info", { w: (b.x1 - b.x0).toFixed(1), d: (b.y1 - b.y0).toFixed(1), h: (b.z1 - b.z0).toFixed(1), n }) : t("stl.empty");
    $<HTMLButtonElement>("stl-ok").disabled = !n;
  };
  const remember = () => {
    let o: any = {};
    try { o = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { /* egal */ }
    o.groups = { ...(o.groups || {}) };
    for (const g of groups) o.groups[g.key] = { kind: g.kind, value: g.value };
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ }
  };
  kinds.forEach((k, i) => k.addEventListener("change", () => {
    // neue Art: passenden Standardwert vorschlagen
    vals[i].value = String(DEF_VALUE[k.value as Kind] || vals[i].value);
    build();
  }));
  vals.forEach(v => v.addEventListener("input", build));
  build();

  const close = () => { viewer.destroy(); ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("stl-cancel").onclick = close;
  $<HTMLElement>("stl-ok").onclick = async () => {
    if (!shells.length) return;
    remember();
    try {
      const p = await save({ title: t("stl.saveTitle"), defaultPath: "cnc-craft.stl", filters: [{ name: "STL", extensions: ["stl"] }] });
      if (!p) return;
      const data = stlBinary(shells);
      await writeFile(String(p), data);
      log(t("stl.saved", { n: (data.length - 84) / 50, p: String(p) }));
      close();
    } catch (e) {
      log(`${t("log.error")} ${e}`);
    }
  };
}
