/**
 * STL-IMPORT-DIALOG: Datei laden -> Ansicht und Schnitthöhe wählen -> als 2D-Konturen einfügen.
 *
 * Farben in der Vorschau:  Blau = Außenkontur, Gelb = Loch, Rot = offene Linie (Modell undicht)
 */
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  parseStl, weldMesh, viewCoords, sliceMesh, findBestHeight,
  StlView, WeldedMesh, ViewCoords, SliceResult
} from "./stlLoader";
import { Mesh3DPreview, render2D } from "./stlPreview";
import { createPolyline, MM_TO_PIXEL } from "./shapeTransform";
import { updateDimensionInputs } from "./uiInputs";
import { assignPartGroups } from "./editor/parts";
import { t } from "./i18n/i18n";

export function setupStlLoader(
  btn: HTMLElement | null,
  state: any,
  redraw: () => void,
  appendToConsole: (t: string) => void
) {
  if (!btn) return;

  btn.addEventListener("click", async () => {
    try {
      const selectedFile = await open({
        multiple: false,
        directory: false,
        title: t("stl.dlgTitle"),
        filters: [{ name: t("stl.dlgFilter"), extensions: ["stl", "STL"] }]
      });
      if (!selectedFile) return;

      const filePath = typeof selectedFile === "object" && selectedFile !== null
        ? (selectedFile as any).path
        : selectedFile;
      const fileName = String(filePath).split(/[\\/]/).pop() || "Modell";
      const binary = await readFile(filePath);
      openStlFromBytes(fileName, binary, state, redraw, appendToConsole);
    } catch (err) {
      appendToConsole(t("stl.loadError", { e: String(err) }));
    }
  });
}

/** STL aus bereits gelesenen Bytes öffnen (wird auch vom allgemeinen Import benutzt) */
export function openStlFromBytes(
  fileName: string,
  binary: Uint8Array,
  state: any,
  redraw: () => void,
  appendToConsole: (t: string) => void
) {
  appendToConsole(t("stl.reading", { name: fileName }));
  const buffer = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer;
  const mesh = parseStl(buffer);
  const welded = weldMesh(mesh);
  const size = mesh.max.map((m, i) => (m - mesh.min[i]).toFixed(1));
  appendToConsole(
    t("stl.loaded", { n: mesh.triangleCount, fmt: mesh.format === "ascii" ? t("stl.ascii") : t("stl.binary"), x: size[0], y: size[1], z: size[2] })
  );
  showStlDialog(fileName, welded, size, state, redraw, appendToConsole);
}

const VIEW_LABELS = (v: StlView) => t(`stl.view.${v}`);
const VIEWS: StlView[] = ["top", "front", "left", "bottom", "back", "right"];

function showStlDialog(
  fileName: string,
  mesh: WeldedMesh,
  size: string[],
  state: any,
  redraw: () => void,
  appendToConsole: (t: string) => void
) {
  document.getElementById("stl-dialog-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "stl-dialog-overlay";
  overlay.innerHTML = `
    <div class="stl-dlg">
      <div class="stl-dlg-head">
        <h3>📐 ${t("stl.title")}</h3>
        <span class="stl-dlg-file">${escapeHtml(fileName)} · ${size[0]} × ${size[1]} × ${size[2]} mm</span>
      </div>

      <div class="stl-dlg-cols">
        <div class="stl-dlg-col">
          <div class="stl-dlg-label">${t("stl.step1")}</div>
          <canvas id="stl-3d" width="330" height="250"></canvas>
          <div class="stl-dlg-views">
            ${VIEWS.map(v =>
              `<button class="stl-view-btn${v === "top" ? " active" : ""}" data-view="${v}">${VIEW_LABELS(v)}</button>`
            ).join("")}
          </div>
        </div>

        <div class="stl-dlg-col">
          <div class="stl-dlg-label">${t("stl.step2")}</div>
          <canvas id="stl-2d" width="330" height="250"></canvas>
          <div id="stl-info" class="stl-dlg-info"></div>
        </div>
      </div>

      <div class="stl-dlg-label" style="margin-top:12px;">${t("stl.step3")}</div>
      <div class="stl-dlg-row">
        <input type="range" id="stl-height" min="0" max="1000" step="1" value="500" style="flex:1;">
        <span id="stl-height-val" class="stl-dlg-mono">–</span>
      </div>
      <div class="stl-dlg-row">
        <button class="stl-small-btn" data-h="auto" data-tip="${t("stl.autoTip")}">✨ ${t("stl.auto")}</button>
        <button class="stl-small-btn" data-h="0.02">${t("stl.hBottom")}</button>
        <button class="stl-small-btn" data-h="0.5">${t("stl.hMiddle")}</button>
        <button class="stl-small-btn" data-h="0.98">${t("stl.hTop")}</button>
        <span style="flex:1"></span>
        <label class="stl-dlg-mono">${t("stl.scale")} <input type="number" id="stl-scale" value="100" min="1" step="1" style="width:64px;"> %</label>
      </div>
      <label class="stl-dlg-check"><input type="checkbox" id="stl-holes" checked> ${t("stl.holes")}</label>

      <div id="stl-warning" class="stl-dlg-warn" style="display:none;"></div>

      <div class="stl-dlg-row" style="margin-top:14px;">
        <button id="stl-cancel" class="stl-btn-cancel">${t("dlg.cancel")}</button>
        <button id="stl-insert" class="stl-btn-ok">✔ ${t("stl.insert")}</button>
      </div>
    </div>

    <style>
      #stl-dialog-overlay { position: fixed; inset: 0; z-index: 5000; background: rgba(0,0,0,0.75);
        display: flex; align-items: center; justify-content: center; font-family: var(--font-ui, sans-serif); }
      .stl-dlg { background: var(--bg-panel, #1f1f26); border: 1px solid var(--border-color, #35353f);
        border-radius: 12px; padding: 18px; width: 720px; max-width: 96vw; max-height: 96vh; overflow: auto;
        color: var(--text-main, #e6e6ee); box-shadow: 0 20px 60px rgba(0,0,0,0.7); }
      .stl-dlg-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
      .stl-dlg-head h3 { margin: 0; font-size: 1.1rem; }
      .stl-dlg-file { font-family: monospace; font-size: 0.78rem; color: var(--text-muted, #9a9aae); }
      .stl-dlg-cols { display: flex; gap: 14px; flex-wrap: wrap; }
      .stl-dlg-col { flex: 1; min-width: 300px; display: flex; flex-direction: column; gap: 6px; }
      .stl-dlg-col canvas { width: 100%; height: auto; border: 1px solid var(--border-color, #35353f); border-radius: 8px; background: #121216; }
      .stl-dlg-label { font-size: 0.8rem; font-weight: 700; color: var(--text-muted, #9a9aae); }
      .stl-dlg-views { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
      .stl-view-btn, .stl-small-btn { padding: 7px 4px; border-radius: 6px; background: var(--bg-panel-2, #26262f);
        border: 1px solid var(--border-color, #35353f); color: var(--text-main, #e6e6ee); font-size: 0.8rem; font-weight: 600; cursor: pointer; }
      .stl-small-btn { padding: 5px 10px; }
      .stl-view-btn:hover, .stl-small-btn:hover { border-color: var(--accent-color, #6d4aff); }
      .stl-view-btn.active { background: var(--accent-color, #6d4aff); border-color: var(--accent-color, #6d4aff); color: #fff; }
      .stl-dlg-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
      .stl-dlg-mono { font-family: monospace; font-size: 0.8rem; color: var(--text-main, #e6e6ee); }
      .stl-dlg-info { font-size: 0.8rem; line-height: 1.5; }
      .stl-dlg-check { display: flex; gap: 6px; align-items: center; font-size: 0.8rem; margin-top: 8px; }
      .stl-dlg-warn { margin-top: 10px; padding: 8px 10px; border-radius: 6px; font-size: 0.8rem;
        background: rgba(255, 77, 77, 0.12); border: 1px solid rgba(255, 77, 77, 0.5); color: #ffb3b3; }
      .stl-btn-cancel { flex: 1; padding: 9px; border-radius: 6px; border: 1px solid var(--border-color, #35353f);
        background: transparent; color: var(--text-muted, #9a9aae); cursor: pointer; }
      .stl-btn-ok { flex: 2; padding: 9px; border-radius: 6px; border: none; font-weight: 700; cursor: pointer;
        background: var(--accent-color, #6d4aff); color: #fff; }
      .stl-btn-ok:disabled { opacity: 0.4; cursor: not-allowed; }
    </style>
  `;
  document.body.appendChild(overlay);

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector(sel) as T;
  const canvas3d = $<HTMLCanvasElement>("#stl-3d");
  const canvas2d = $<HTMLCanvasElement>("#stl-2d");
  const slider = $<HTMLInputElement>("#stl-height");
  const heightVal = $<HTMLSpanElement>("#stl-height-val");
  const scaleInput = $<HTMLInputElement>("#stl-scale");
  const holesCheck = $<HTMLInputElement>("#stl-holes");
  const info = $<HTMLDivElement>("#stl-info");
  const warning = $<HTMLDivElement>("#stl-warning");
  const insertBtn = $<HTMLButtonElement>("#stl-insert");

  const preview3d = new Mesh3DPreview(canvas3d, mesh);
  let view: StlView = "top";
  let vc: ViewCoords = viewCoords(mesh, view);
  let slice: SliceResult | null = null;
  let pending = false;

  const heightFromSlider = () => vc.minW + (vc.maxW - vc.minW) * (parseInt(slider.value) / 1000);
  const setSliderToHeight = (h: number) => {
    const span = vc.maxW - vc.minW;
    slider.value = String(span > 0 ? Math.round(((h - vc.minW) / span) * 1000) : 500);
  };

  const update = () => {
    pending = false;
    const h = heightFromSlider();
    slice = sliceMesh(mesh, vc, h);
    heightVal.textContent = t("stl.aboveBed", { v: (h - vc.minW).toFixed(2) });

    const shown = holesCheck.checked ? slice : { ...slice, loops: slice.loops.filter(l => !l.isHole) };
    const pct = parseFloat(scaleInput.value) || 100;
    preview3d.draw(slice);
    render2D(canvas2d, shown, pct);

    const f = pct / 100;
    info.innerHTML = slice.loops.length === 0
      ? t("stl.noContour")
      : `<b style="color:#3aa0ff">${slice.outerCount}</b> ${t("stl.outer")}, ` +
        `<b style="color:#ffc107">${slice.holeCount}</b> ${t("stl.holesCount")}` +
        (slice.openCount ? `, <b style="color:#ff4d4d">${slice.openCount}</b> ${t("stl.open")}` : "") +
        `<br>${t("stl.size")}: ${((slice.maxU - slice.minU) * f).toFixed(2)} × ${((slice.maxV - slice.minV) * f).toFixed(2)} mm`;

    if (slice.openCount > 0) {
      warning.style.display = "block";
      warning.textContent =
        t("stl.openWarning", { n: slice.openCount });
    } else {
      warning.style.display = "none";
    }
    insertBtn.disabled = slice.loops.length === 0;
  };
  const scheduleUpdate = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  };

  const applyView = (v: StlView) => {
    view = v;
    vc = viewCoords(mesh, view);
    preview3d.setView(vc);
    setSliderToHeight(findBestHeight(mesh, vc));
    update();
  };

  overlay.querySelectorAll<HTMLButtonElement>(".stl-view-btn").forEach(b => {
    b.addEventListener("click", () => {
      overlay.querySelectorAll(".stl-view-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      applyView(b.dataset.view as StlView);
    });
  });

  overlay.querySelectorAll<HTMLButtonElement>(".stl-small-btn").forEach(b => {
    b.addEventListener("click", () => {
      const h = b.dataset.h!;
      if (h === "auto") setSliderToHeight(findBestHeight(mesh, vc));
      else slider.value = String(Math.round(parseFloat(h) * 1000));
      update();
    });
  });

  slider.addEventListener("input", scheduleUpdate);
  scaleInput.addEventListener("input", scheduleUpdate);
  holesCheck.addEventListener("change", scheduleUpdate);

  const close = () => overlay.remove();
  $("#stl-cancel").addEventListener("click", close);
  overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(); });

  insertBtn.addEventListener("click", () => {
    if (!slice || slice.loops.length === 0) return;
    const pct = parseFloat(scaleInput.value) || 100;
    const shapes = sliceToShapes(slice, pct / 100, holesCheck.checked, fileName);
    state.shapes = [...state.shapes, ...shapes];
    state.selectedShapeIds = shapes.map((s: any) => s.id);
    appendToConsole(
      t("stl.inserted", { view: VIEW_LABELS(view), h: (slice.height - vc.minW).toFixed(2), pct, outer: slice.outerCount, holes: holesCheck.checked ? slice.holeCount : 0 }) +
      (slice.openCount ? " " + t("stl.insertedOpen", { n: slice.openCount }) : "")
    );
    close();
    updateDimensionInputs(null);
    redraw();
  });

  // Start: Ansicht "Oben" mit automatisch gesuchter Höhe
  applyView("top");
}

/**
 * Wandelt das Schnitt-Ergebnis in Formen für den Arbeitsbereich um.
 * Das Teil wird 10 mm vom Nullpunkt (unten links) entfernt abgelegt.
 */
function sliceToShapes(slice: SliceResult, factor: number, withHoles: boolean, fileName: string): any[] {
  const MARGIN_MM = 10;
  const shapes: any[] = [];

  for (const loop of slice.loops) {
    if (loop.isHole && !withHoles) continue;
    const points = loop.points.map(p => ({
      x: ((p.u - slice.minU) * factor + MARGIN_MM) * MM_TO_PIXEL,
      y: ((p.v - slice.minV) * factor + MARGIN_MM) * MM_TO_PIXEL
    }));
    const mode = !loop.closed ? "on-line" : loop.isHole ? "inside" : "outside";
    shapes.push(createPolyline(points, loop.closed, mode, { source: fileName }));
  }
  // Jedes Teil (Außenkontur + Löcher) als eigene Gruppe
  assignPartGroups(shapes);
  return shapes;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
