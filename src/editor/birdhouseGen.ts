/**
 * VOGELHAUS-GENERATOR – Fenster (wie der Box-Generator): Art wählen (Nistkasten oder Anhänger), Maße eingeben,
 * Vorschau (Platten oder 3D), Platten aufs Bett. Die Geometrie entsteht in birdhouse.ts.
 * Jede Art merkt sich ihre eigenen Werte – beim Umschalten kommen die zuletzt benutzten wieder.
 */
import { app, bedSizeMm } from "./editorState";
import { createPolyline, MM_TO_PIXEL } from "../shapeTransform";
import { t } from "../i18n/i18n";
import { birdhousePanels, birdProblem, birdhouseSize, holeFloor, HOLE_SIZES, HANGERS, ENTRANCES, BASES, ROOF_EDGES, type BirdhouseOptions, type BirdKind } from "../birdhouse";
import { Box3DView } from "./box3d";
import { layout } from "./boxGen";

const KEY = "cnc_craft_birdhouse";
const VIEW_KEY = "cnc_craft_box_view"; // dieselbe Wahl wie beim Box-Generator: "2d" oder "3d"
const KINDS: BirdKind[] = ["nest", "ornament"];
const DEF: Record<BirdKind, BirdhouseOptions> = {
  nest: { w: 120, d: 120, h: 180, t: 6, finger: 15, kerf: 0.1, pitch: 40, overhang: 20, hole: 32,
    perch: false, drain: true, vent: true, hang: true, door: false, kind: "nest", roofTabs: true, roofEdge: "plain", edgeCount: 0 },
  ornament: { w: 40, d: 34, h: 32, t: 3, finger: 8, kerf: 0.1, pitch: 45, overhang: 4, hole: 14, perch: true,
    drain: false, vent: false, hang: false, door: false, kind: "ornament", hanger: "ring", entrance: "circle", frame: true, base: "rect", baseMargin: 5,
    roofTabs: true, roofEdge: "scallops", edgeCount: 0 }
};
const NUMS = ["w", "d", "h", "t", "finger", "kerf", "pitch", "overhang", "hole", "baseMargin", "edgeCount"] as const;
const FLAGS = ["perch", "drain", "vent", "hang", "door", "frame", "roofTabs"] as const;

type Store = { kind: BirdKind } & Record<BirdKind, BirdhouseOptions>;
function clean(s: any, kind: BirdKind): BirdhouseOptions {
  const o: BirdhouseOptions = { ...DEF[kind] };
  if (!s || typeof s !== "object") return o;
  for (const k of NUMS) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
  for (const k of FLAGS) if (typeof s[k] === "boolean") o[k] = s[k];
  if (HANGERS.includes(s.hanger)) o.hanger = s.hanger;
  if (ENTRANCES.includes(s.entrance)) o.entrance = s.entrance;
  if (BASES.includes(s.base)) o.base = s.base;
  if (ROOF_EDGES.includes(s.roofEdge)) o.roofEdge = s.roofEdge;
  if (kind === "nest" && !HOLE_SIZES.includes(o.hole)) o.hole = DEF.nest.hole;
  o.kind = kind;
  return o;
}
function load(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    // ältere Version: ein einzelner Nistkasten ohne „kind“
    if (!s.nest && !s.ornament) return { kind: "nest", nest: clean(s, "nest"), ornament: clean(null, "ornament") };
    return { kind: KINDS.includes(s.kind) ? s.kind : "nest", nest: clean(s.nest, "nest"), ornament: clean(s.ornament, "ornament") };
  } catch { return { kind: "nest", nest: clean(null, "nest"), ornament: clean(null, "ornament") }; }
}

export function openBirdhouseDialog(log: (s: string) => void, done: () => void) {
  const store = load();
  document.getElementById("bird-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "bird-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, step = "1", min = "0") =>
    `<label class="prop-row">${t(key)}<input id="${id}" type="number" step="${step}" min="${min}" class="prop-input"></label>`;
  const chk = (id: string, key: string) =>
    `<label class="prop-row" style="cursor:pointer;"><span>${t(key)}</span><input id="${id}" type="checkbox" style="width:auto;"></label>`;
  const sel = (id: string, key: string, list: (string | number)[], prefix: string) =>
    `<label class="prop-row">${t(key)}<select id="${id}" class="prop-input" style="width:auto;max-width:125px;">${list.map(k => `<option value="${k}">${t(prefix + k)}</option>`).join("")}</select></label>`;
  // data-for: Feld nur bei dieser Art zeigen
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:600px;">
      <h3>🐦 ${t("bh.title")}</h3>
      <div class="dlg-hint">${t("bh.desc")}</div>
      ${sel("bh-kind", "bh.kind", KINDS, "bh.kind.")}
      <div id="bh-kdesc" class="dlg-hint"></div>
      <div class="box-grid">
        <div class="box-fields">
          ${num("bh-w", "bh.w")}
          ${num("bh-d", "bh.d")}
          ${num("bh-h", "bh.h")}
          ${num("bh-pitch", "bh.pitch", "1", "20")}
          ${num("bh-ov", "bh.overhang")}
          ${sel("bh-edge", "bh.edge", ROOF_EDGES, "bh.edge.")}
          ${num("bh-ec", "bh.edgeCount", "1", "0")}
          ${chk("bh-tabs", "bh.roofTabs")}
          <div class="box-x" data-for="nest">${sel("bh-hole", "bh.hole", HOLE_SIZES, "bh.hole.")}</div>
          <div class="box-x" data-for="ornament">
            ${sel("bh-ent", "bh.entrance", ENTRANCES, "bh.entrance.")}
            ${num("bh-holeD", "bh.holeD", "0.5", "3")}
            ${sel("bh-hanger", "bh.hanger", HANGERS, "bh.hanger.")}
            ${sel("bh-base", "bh.base", BASES, "bh.base.")}
            ${num("bh-bm", "bh.baseMargin", "0.5", "0")}
          </div>
          ${num("bh-t", "box.t", "0.1", "0.5")}
          ${num("bh-f", "box.finger", "0.5", "1")}
          ${num("bh-kerf", "box.kerf", "0.01", "0")}
          <div class="box-x" data-for="nest">${chk("bh-door", "bh.door")}</div>
          <div class="box-x" data-for="ornament">${chk("bh-frame", "bh.frame")}</div>
          ${chk("bh-perch", "bh.perch")}
          <div class="box-x" data-for="nest">${chk("bh-drain", "bh.drain")}${chk("bh-vent", "bh.vent")}${chk("bh-hang", "bh.hang")}</div>
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
  const view3d = new Box3DView($<HTMLCanvasElement>("bh-3d"));
  let mode: "2d" | "3d" = "2d";
  try { if (localStorage.getItem(VIEW_KEY) === "3d") mode = "3d"; } catch { /* egal */ }
  let kind: BirdKind = store.kind;

  /** Werte einer Art in die Felder schreiben */
  const fill = (o: BirdhouseOptions) => {
    const set = (id: string, v: number | string) => { $(id).value = String(v); };
    set("bh-w", o.w); set("bh-d", o.d); set("bh-h", o.h); set("bh-pitch", o.pitch); set("bh-ov", o.overhang);
    set("bh-t", o.t); set("bh-f", o.finger); set("bh-kerf", o.kerf);
    if (kind === "nest") set("bh-hole", o.hole); else set("bh-holeD", o.hole);
    set("bh-ent", o.entrance || "circle"); set("bh-hanger", o.hanger || "ring"); set("bh-base", o.base || "rect"); set("bh-bm", o.baseMargin ?? 5);
    set("bh-edge", o.roofEdge || "plain"); set("bh-ec", o.edgeCount ?? 0);
    for (const [id, k] of [["bh-door", "door"], ["bh-frame", "frame"], ["bh-tabs", "roofTabs"], ["bh-perch", "perch"], ["bh-drain", "drain"], ["bh-vent", "vent"], ["bh-hang", "hang"]] as const)
      $(id).checked = !!o[k];
  };
  const read = (): BirdhouseOptions => {
    const d = store[kind];
    const n = (id: string, def: number, min = 0, max = 5000) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? Math.min(max, Math.max(min, v)) : def; };
    const orn = kind === "ornament";
    return { kind, w: n("bh-w", d.w), d: n("bh-d", d.d), h: n("bh-h", d.h), t: n("bh-t", d.t, 0.5, 50), finger: n("bh-f", d.finger, 1),
      kerf: n("bh-kerf", d.kerf, 0, 2), pitch: n("bh-pitch", d.pitch, 20, 60), overhang: n("bh-ov", d.overhang, 0, 200),
      hole: orn ? n("bh-holeD", d.hole, 3, 500) : Number($<HTMLSelectElement>("bh-hole").value) || d.hole,
      perch: $("bh-perch").checked, drain: !orn && $("bh-drain").checked, vent: !orn && $("bh-vent").checked,
      hang: !orn && $("bh-hang").checked, door: !orn && $("bh-door").checked,
      entrance: $<HTMLSelectElement>("bh-ent").value as BirdhouseOptions["entrance"], hanger: $<HTMLSelectElement>("bh-hanger").value as BirdhouseOptions["hanger"],
      base: $<HTMLSelectElement>("bh-base").value as BirdhouseOptions["base"], frame: $("bh-frame").checked, baseMargin: n("bh-bm", d.baseMargin ?? 5, 0, 100),
      roofTabs: $("bh-tabs").checked, roofEdge: $<HTMLSelectElement>("bh-edge").value as BirdhouseOptions["roofEdge"], edgeCount: Math.round(n("bh-ec", 0, 0, 200)) };
  };
  const preview = () => {
    const b = read();
    ov.querySelectorAll<HTMLElement>(".box-x").forEach(el => { el.style.display = (el.dataset.for || "").split(" ").includes(kind) ? "" : "none"; });
    $<HTMLElement>("bh-kdesc").textContent = t("bh.kdesc." + kind);
    const svg = $<HTMLElement>("bh-svg") as unknown as SVGSVGElement;
    const info = $<HTMLElement>("bh-info");
    ov.querySelectorAll<HTMLElement>("[data-view]").forEach(el => el.classList.toggle("active", el.dataset.view === mode));
    svg.style.display = mode === "2d" ? "" : "none";
    ov.querySelectorAll<HTMLElement>(".box-3d, .box-3d-only").forEach(el => { el.style.display = mode === "3d" ? "" : "none"; });
    $<HTMLElement>("bh-hint").textContent = t(kind === "ornament" ? "bh.hintOrn" : b.door ? "bh.hintDoor" : "bh.hint") + (b.roofTabs ? " " + t("bh.hintTabs") : "");
    const problem = birdProblem(b);
    if (problem) {
      svg.innerHTML = ""; view3d.setPanels([], b.t, 0);
      info.textContent = t("bh.problem." + problem);
      $<HTMLButtonElement>("bh-ok").disabled = true; return;
    }
    $<HTMLButtonElement>("bh-ok").disabled = false;
    const ps = birdhousePanels(b);
    if (mode === "3d") view3d.setPanels(birdhousePanels({ ...b, kerf: 0 }), b.t, parseFloat($("bh-explode").value) || 0);
    const pos = layout(ps, kind === "ornament" ? 2 : 4, Math.max(b.w, b.d) * 5);
    let W = 0, H = 0;
    ps.forEach((p, i) => { W = Math.max(W, pos[i].x + p.w); H = Math.max(H, pos[i].y + p.h); });
    svg.setAttribute("viewBox", `-2 -2 ${W + 4} ${H + 4}`);
    svg.innerHTML = ps.map((p, i) => {
      const ring = (pts: { x: number; y: number }[]) => pts.map((q, k) => `${k ? "L" : "M"}${(pos[i].x + q.x).toFixed(2)},${(pos[i].y + p.h - q.y).toFixed(2)}`).join("") + "Z";
      const d = ring(p.pts) + (p.holes || []).map(ring).join("");
      // kleine Teile (Rahmen, Firstplatte) ohne Beschriftung – die würde die Form verdecken
      const lbl = Math.min(p.w, p.h) > 12 ? `<text x="${pos[i].x + p.w / 2}" y="${pos[i].y + p.h / 2}" class="box-lbl" style="font-size:${Math.max(2.5, Math.min(p.w, p.h) / 7)}px">${t("bh.p." + p.name)}</text>` : "";
      return `<path d="${d}" fill-rule="evenodd" class="box-panel"/>${lbl}`;
    }).join("");
    const sz = birdhouseSize(b);
    info.textContent = t("bh.info", { n: ps.length, w: sz.W.toFixed(0), d: sz.D.toFixed(0), h: sz.H.toFixed(0) }) +
      (kind === "ornament" && b.entrance === "none" ? "" : " · " + t("bh.holeInfo", { d: b.hole, h: Math.round(holeFloor(b)) }));
  };
  fill(store[kind]);
  $<HTMLSelectElement>("bh-kind").value = kind;
  $<HTMLSelectElement>("bh-kind").addEventListener("change", () => {
    // Werte der alten Art merken, die der neuen Art einsetzen
    store[kind] = read();
    kind = KINDS.includes($<HTMLSelectElement>("bh-kind").value as BirdKind) ? $<HTMLSelectElement>("bh-kind").value as BirdKind : "nest";
    fill(store[kind]);
    preview();
  });
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
    store[kind] = b; store.kind = kind;
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* egal */ }
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
