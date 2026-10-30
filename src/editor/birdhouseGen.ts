/**
 * VOGELHAUS-GENERATOR – Fenster (wie der Box-Generator): Maße eingeben, Vorschau (Platten oder 3D), Platten aufs Bett.
 * Die Geometrie entsteht in birdhouse.ts.
 */
import { app, bedSizeMm } from "./editorState";
import { createPolyline, MM_TO_PIXEL } from "../shapeTransform";
import { t } from "../i18n/i18n";
import { birdhousePanels, birdProblem, birdhouseSize, holeSpot, HOLE_SIZES, type BirdhouseOptions } from "../birdhouse";
import { Box3DView } from "./box3d";
import { layout } from "./boxGen";

const KEY = "cnc_craft_birdhouse";
const VIEW_KEY = "cnc_craft_box_view"; // dieselbe Wahl wie beim Box-Generator: "2d" oder "3d"
const DEF: BirdhouseOptions = { w: 120, d: 120, h: 180, t: 6, finger: 15, kerf: 0.1, pitch: 40, overhang: 20, hole: 32,
  perch: false, drain: true, vent: true, hang: true, door: false };
const NUMS = ["w", "d", "h", "t", "finger", "kerf", "pitch", "overhang", "hole"] as const;
const FLAGS = ["perch", "drain", "vent", "hang", "door"] as const;

function load(): BirdhouseOptions {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: BirdhouseOptions = { ...DEF };
    for (const k of NUMS) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    for (const k of FLAGS) if (typeof s[k] === "boolean") o[k] = s[k];
    if (!HOLE_SIZES.includes(o.hole)) o.hole = DEF.hole;
    return o;
  } catch { return { ...DEF }; }
}

export function openBirdhouseDialog(log: (s: string) => void, done: () => void) {
  const o = load();
  document.getElementById("bird-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "bird-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step = "1", min = "0") =>
    `<label class="prop-row">${t(key)}<input id="${id}" type="number" step="${step}" min="${min}" value="${v}" class="prop-input"></label>`;
  const chk = (id: string, key: string, on: boolean) =>
    `<label class="prop-row" style="cursor:pointer;"><span>${t(key)}</span><input id="${id}" type="checkbox" ${on ? "checked" : ""} style="width:auto;"></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:580px;">
      <h3>🐦 ${t("bh.title")}</h3>
      <div class="dlg-hint">${t("bh.desc")}</div>
      <div class="box-grid">
        <div class="box-fields">
          ${num("bh-w", "bh.w", o.w)}
          ${num("bh-d", "bh.d", o.d)}
          ${num("bh-h", "bh.h", o.h)}
          ${num("bh-pitch", "bh.pitch", o.pitch, "1", "20")}
          ${num("bh-ov", "bh.overhang", o.overhang)}
          <label class="prop-row">${t("bh.hole")}
            <select id="bh-hole" class="prop-input" style="width:auto;max-width:125px;">${HOLE_SIZES.map(d => `<option value="${d}">${t("bh.hole." + d)}</option>`).join("")}</select></label>
          ${num("bh-t", "box.t", o.t, "0.1", "0.5")}
          ${num("bh-f", "box.finger", o.finger, "0.5", "1")}
          ${num("bh-kerf", "box.kerf", o.kerf, "0.01", "0")}
          ${chk("bh-door", "bh.door", o.door)}
          ${chk("bh-perch", "bh.perch", o.perch)}
          ${chk("bh-drain", "bh.drain", o.drain)}
          ${chk("bh-vent", "bh.vent", o.vent)}
          ${chk("bh-hang", "bh.hang", o.hang)}
        </div>
        <div class="box-prev">
          <div class="box-view">
            <button type="button" class="btn-secondary" data-view="2d">${t("box.view.flat")}</button>
            <button type="button" class="btn-secondary" data-view="3d">🧊 ${t("box.view.3d")}</button>
          </div>
          <svg id="bh-svg" viewBox="0 0 100 100"></svg>
          <canvas id="bh-3d" class="box-3d" title="${t("bh.view.hint")}"></canvas>
          <label class="prop-row box-3d-only">${t("box.view.explode")}<input id="bh-explode" type="range" min="0" max="1" step="0.05" value="0" style="width:110px;"></label>
          <div class="dlg-hint box-3d-only">${t("bh.view.hint")}</div>
          <div id="bh-info" class="dlg-hint"></div>
        </div>
      </div>
      <div id="bh-hint" class="dlg-hint"></div>
      <div class="dlg-buttons">
        <button id="bh-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="bh-ok" class="btn-primary">✔ ${t("bh.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  $<HTMLSelectElement>("bh-hole").value = String(o.hole);
  const view3d = new Box3DView($<HTMLCanvasElement>("bh-3d"));
  let mode: "2d" | "3d" = "2d";
  try { if (localStorage.getItem(VIEW_KEY) === "3d") mode = "3d"; } catch { /* egal */ }

  const read = (): BirdhouseOptions => {
    const n = (id: string, d: number, min = 0, max = 5000) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? Math.min(max, Math.max(min, v)) : d; };
    return { w: n("bh-w", o.w), d: n("bh-d", o.d), h: n("bh-h", o.h), t: n("bh-t", o.t, 0.5, 50), finger: n("bh-f", o.finger, 1),
      kerf: n("bh-kerf", o.kerf, 0, 2), pitch: n("bh-pitch", o.pitch, 20, 60), overhang: n("bh-ov", o.overhang, 0, 200),
      hole: Number($<HTMLSelectElement>("bh-hole").value) || o.hole,
      perch: $("bh-perch").checked, drain: $("bh-drain").checked, vent: $("bh-vent").checked, hang: $("bh-hang").checked, door: $("bh-door").checked };
  };
  const preview = () => {
    const b = read();
    const svg = $<HTMLElement>("bh-svg") as unknown as SVGSVGElement;
    const info = $<HTMLElement>("bh-info");
    ov.querySelectorAll<HTMLElement>("[data-view]").forEach(el => el.classList.toggle("active", el.dataset.view === mode));
    svg.style.display = mode === "2d" ? "" : "none";
    ov.querySelectorAll<HTMLElement>(".box-3d, .box-3d-only").forEach(el => { el.style.display = mode === "3d" ? "" : "none"; });
    $<HTMLElement>("bh-hint").textContent = t(b.door ? "bh.hintDoor" : "bh.hint");
    const problem = birdProblem(b);
    if (problem) {
      svg.innerHTML = ""; view3d.setPanels([], b.t, 0);
      info.textContent = t("bh.problem." + problem);
      $<HTMLButtonElement>("bh-ok").disabled = true; return;
    }
    $<HTMLButtonElement>("bh-ok").disabled = false;
    const ps = birdhousePanels(b);
    if (mode === "3d") view3d.setPanels(birdhousePanels({ ...b, kerf: 0 }), b.t, parseFloat($("bh-explode").value) || 0);
    const pos = layout(ps, 4, Math.max(b.w, b.d) * 5);
    let W = 0, H = 0;
    ps.forEach((p, i) => { W = Math.max(W, pos[i].x + p.w); H = Math.max(H, pos[i].y + p.h); });
    svg.setAttribute("viewBox", `-2 -2 ${W + 4} ${H + 4}`);
    svg.innerHTML = ps.map((p, i) => {
      const ring = (pts: { x: number; y: number }[]) => pts.map((q, k) => `${k ? "L" : "M"}${(pos[i].x + q.x).toFixed(2)},${(pos[i].y + p.h - q.y).toFixed(2)}`).join("") + "Z";
      const d = ring(p.pts) + (p.holes || []).map(ring).join("");
      return `<path d="${d}" fill-rule="evenodd" class="box-panel"/><text x="${pos[i].x + p.w / 2}" y="${pos[i].y + p.h / 2}" class="box-lbl" style="font-size:${Math.max(4, Math.min(p.w, p.h) / 7)}px">${t("bh.p." + p.name)}</text>`;
    }).join("");
    const sz = birdhouseSize(b);
    info.textContent = t("bh.info", { n: ps.length, w: sz.W.toFixed(0), d: sz.D.toFixed(0), h: sz.H.toFixed(0) }) + " · " +
      t("bh.holeInfo", { d: b.hole, h: Math.round(holeSpot(b).floor) });
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener("input", preview));
  ov.querySelectorAll<HTMLElement>("[data-view]").forEach(el => el.addEventListener("click", () => {
    mode = el.dataset.view === "3d" ? "3d" : "2d";
    try { localStorage.setItem(VIEW_KEY, mode); } catch { /* egal */ }
    preview();
  }));
  preview();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $<HTMLElement>("bh-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("bh-cancel").onclick = close;
  $<HTMLElement>("bh-ok").onclick = () => {
    const b = read();
    if (birdProblem(b)) return;
    try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* egal */ }
    close();
    const ps = birdhousePanels(b);
    const bed = bedSizeMm();
    const pos = layout(ps, 5, Math.max(bed.w - 20, Math.max(...ps.map(p => p.w))));
    const toW = (i: number, pts: { x: number; y: number }[]) => pts.map(q => ({ x: (10 + pos[i].x + q.x) * MM_TO_PIXEL, y: (10 + pos[i].y + q.y) * MM_TO_PIXEL }));
    const made: any[] = [];
    ps.forEach((p, i) => {
      // Platte + ihre Löcher als Gruppe – sie bewegen sich zusammen
      const extra = p.holes?.length ? { source: t("bh.title"), groupId: "bird-" + Math.random().toString(36).slice(2, 10) } : { source: t("bh.title") };
      made.push(createPolyline(toW(i, p.pts), true, "outside", extra));
      for (const hl of p.holes || []) made.push(createPolyline(toW(i, hl), true, "inside", extra));
    });
    const st = app();
    st.shapes = [...st.shapes, ...made];
    st.selectedShapeIds = made.map(s => s.id);
    log(t("bh.done", { n: ps.length }));
    done();
  };
}
