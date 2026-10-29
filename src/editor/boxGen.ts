/**
 * BOX-GENERATOR – Fenster: Maße eingeben, Vorschau, Platten aufs Bett legen. Die Geometrie entsteht in box.ts.
 */
import { app, bedSizeMm } from "./editorState";
import { createPolyline, MM_TO_PIXEL } from "../shapeTransform";
import { t } from "../i18n/i18n";
import { boxPanels, outerSize, BOX_TYPES, LIDDED, isFlex, type BoxOptions, type BoxType, type Panel } from "../box";
import { Box3DView } from "./box3d";

/** Vieleck-Kiste: Wände brauchen Platz für mindestens einen Zapfen (3 t breit) */
const hexWallTooSmall = (b: BoxOptions) => !boxPanels(b).some(p => p.name === "hexWall" && p.w >= 3 * b.t && p.h > 3 * b.t);

const KEY = "cnc_craft_box";
const VIEW_KEY = "cnc_craft_box_view"; // Vorschau: "2d" (Platten) oder "3d" (fertige Kiste)
const DEF: BoxOptions = { w: 100, d: 80, h: 50, inner: false, t: 3, finger: 9, lid: true, kerf: 0.1, type: "closed", nx: 1, ny: 2, overhang: 5, shelves: 2, radius: 15, sides: 6 };

function loadBox(): BoxOptions {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: any = { ...DEF };
    for (const k of ["w", "d", "h", "t", "finger", "kerf", "nx", "ny", "overhang", "shelves", "radius", "sides"] as const) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    for (const k of ["inner", "lid"] as const) if (typeof s[k] === "boolean") o[k] = s[k];
    o.type = BOX_TYPES.includes(s.type) ? s.type : (o.lid ? "closed" : "open");
    return o;
  } catch { return { ...DEF }; }
}

/** Platten nebeneinander (Reihen) – Rückgabe: Rechtecke der Lage in mm */
function layout(panels: Panel[], gap: number, maxW: number): { x: number; y: number }[] {
  const pos: { x: number; y: number }[] = [];
  let x = 0, y = 0, rowH = 0;
  for (const p of panels) {
    if (x > 0 && x + p.w > maxW) { x = 0; y += rowH + gap; rowH = 0; }
    pos.push({ x, y });
    x += p.w + gap; rowH = Math.max(rowH, p.h);
  }
  return pos;
}

export function openBoxDialog(log: (s: string) => void, done: () => void) {
  const o = loadBox();
  document.getElementById("box-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "box-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step = "1", min = "0") =>
    `<label class="prop-row">${t(key)}<input id="${id}" type="number" step="${step}" min="${min}" value="${v}" class="prop-input"></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:560px;">
      <h3>📦 ${t("box.title")}</h3>
      <div class="dlg-hint">${t("box.desc")}</div>
      <label class="prop-row">${t("box.type")}
        <select id="box-type" class="prop-input" style="width:auto;">${BOX_TYPES.map(k => `<option value="${k}">${t("box.type." + k)}</option>`).join("")}</select></label>
      <div id="box-tdesc" class="dlg-hint"></div>
      <div class="box-grid">
        <div class="box-fields">
          ${num("box-w", "box.w", o.w)}
          <div class="box-x" data-not="hex">${num("box-d", "box.d", o.d)}</div>
          ${num("box-h", "box.h", o.h)}
          <label class="prop-row" style="cursor:pointer;"><span>${t("box.inner")}</span><input id="box-inner" type="checkbox" ${o.inner ? "checked" : ""} style="width:auto;"></label>
          ${num("box-t", "box.t", o.t, "0.1", "0.5")}
          ${num("box-f", "box.finger", o.finger, "0.5", "1")}
          <div class="box-x" data-for="tray traylid">${num("box-nx", "box.nx", o.nx ?? 1, "1", "0")}${num("box-ny", "box.ny", o.ny ?? 2, "1", "0")}</div>
          <div class="box-x" data-for="drawer">${num("box-ov", "box.overhang", o.overhang ?? 5, "1", "0")}</div>
          <div class="box-x" data-for="shelf cabinet">${num("box-sh", "box.shelves", o.shelves ?? 2, "1", "0")}</div>
          <div class="box-x" data-for="flex flexcup">${num("box-rad", "box.radius", o.radius ?? 15, "1", "2")}</div>
          <div class="box-x" data-for="hex">${num("box-sides", "box.sides", o.sides ?? 6, "1", "5")}</div>
          ${num("box-kerf", "box.kerf", o.kerf, "0.01", "0")}
        </div>
        <div class="box-prev">
          <div class="box-view">
            <button type="button" class="btn-secondary" data-view="2d">${t("box.view.flat")}</button>
            <button type="button" class="btn-secondary" data-view="3d">🧊 ${t("box.view.3d")}</button>
          </div>
          <svg id="box-svg" viewBox="0 0 100 100"></svg>
          <canvas id="box-3d" class="box-3d" title="${t("box.view.hint")}"></canvas>
          <label class="prop-row box-3d-only">${t("box.view.explode")}<input id="box-explode" type="range" min="0" max="1" step="0.05" value="0" style="width:110px;"></label>
          <div class="dlg-hint box-3d-only">${t("box.view.hint")}</div>
          <div id="box-info" class="dlg-hint"></div>
        </div>
      </div>
      <div class="dlg-hint">${t("box.hint")}</div>
      <div class="dlg-buttons">
        <button id="box-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="box-ok" class="btn-primary">✔ ${t("box.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const view3d = new Box3DView($<HTMLCanvasElement>("box-3d"));
  let mode: "2d" | "3d" = "2d";
  try { if (localStorage.getItem(VIEW_KEY) === "3d") mode = "3d"; } catch { /* egal */ }
  const read = (): BoxOptions => {
    const n = (id: string, d: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : d; };
    const type = $<HTMLSelectElement>("box-type").value as BoxType;
    return { w: n("box-w", o.w), d: n("box-d", o.d), h: n("box-h", o.h), inner: $("box-inner").checked, t: n("box-t", o.t),
      finger: n("box-f", o.finger), lid: LIDDED.includes(type), kerf: n("box-kerf", o.kerf), type,
      nx: Math.round(n("box-nx", o.nx ?? 1)), ny: Math.round(n("box-ny", o.ny ?? 2)), overhang: n("box-ov", o.overhang ?? 5),
      shelves: Math.min(20, Math.round(n("box-sh", o.shelves ?? 2))), radius: n("box-rad", o.radius ?? 15),
      sides: Math.max(5, Math.min(12, Math.round(n("box-sides", o.sides ?? 6)))) };
  };
  const valid = (b: BoxOptions) => {
    if (!(b.t > 0) || Math.min(b.w, b.d, b.h) <= (b.inner ? 0 : 3 * b.t)) return false;
    const { H } = outerSize(b);
    if (b.type === "slide" && H < 6 * b.t + 2) return false;         // Platz für Futter + Deckel + Leiste
    if (b.type === "hex" && hexWallTooSmall(b)) return false;
    if (b.type === "dice" && boxPanels(b).filter(p => p.name === "ramp").length < 2) return false; // mindestens zwei Rampen
    if (b.type === "cabinet" && !boxPanels(b).some(p => p.name === "drPlate")) return false;      // Fächer zu niedrig
    if (isFlex(b.type) && H < 6 * Math.max(2, b.t) + 8) return false;   // Aussparungen oben/unten + Biegescharnier + Verschluss
    return true;
  };
  const preview = () => {
    const b = read();
    // Zusatzfelder nur bei der passenden Art
    ov.querySelectorAll<HTMLElement>(".box-x").forEach(el => {
      const on = el.dataset.for ? el.dataset.for.split(" ").includes(b.type!) : !(el.dataset.not || "").split(" ").includes(b.type!);
      el.style.display = on ? "" : "none";
    });
    $<HTMLElement>("box-tdesc").textContent = t("box.tdesc." + b.type);
    const svg = $<HTMLElement>("box-svg") as unknown as SVGSVGElement;
    const info = $<HTMLElement>("box-info");
    ov.querySelectorAll<HTMLElement>("[data-view]").forEach(el => el.classList.toggle("active", el.dataset.view === mode));
    svg.style.display = mode === "2d" ? "" : "none";
    ov.querySelectorAll<HTMLElement>(".box-3d, .box-3d-only").forEach(el => { el.style.display = mode === "3d" ? "" : "none"; });
    if (!valid(b)) { svg.innerHTML = ""; view3d.setPanels([], b.t, 0); info.textContent = t("box.tooSmall"); $<HTMLButtonElement>("box-ok").disabled = true; return; }
    $<HTMLButtonElement>("box-ok").disabled = false;
    const ps = boxPanels(b);
    // 2D: Platten nebeneinander; 3D: fertige Kiste (ohne Schnittspalt, der ist zu klein zum Sehen)
    if (mode === "3d") view3d.setPanels(boxPanels({ ...b, kerf: 0 }), b.t, parseFloat($("box-explode").value) || 0);
    const pos = layout(ps, 4, Math.max(b.w, b.d) * 2.4);
    let W = 0, H = 0;
    ps.forEach((p, i) => { W = Math.max(W, pos[i].x + p.w); H = Math.max(H, pos[i].y + p.h); });
    svg.setAttribute("viewBox", `-2 -2 ${W + 4} ${H + 4}`);
    svg.innerHTML = ps.map((p, i) => {
      const ring = (pts: { x: number; y: number }[]) => pts.map((q, k) => `${k ? "L" : "M"}${(pos[i].x + q.x).toFixed(2)},${(pos[i].y + p.h - q.y).toFixed(2)}`).join("") + "Z";
      const d = ring(p.pts) + (p.holes || []).map(ring).join("");
      const ln = (p.lines || []).map(l => ring(l).slice(0, -1)).join("");
      return `<path d="${d}" fill-rule="evenodd" class="box-panel"/>${ln ? `<path d="${ln}" class="box-cut"/>` : ""}<text x="${pos[i].x + p.w / 2}" y="${pos[i].y + p.h / 2}" class="box-lbl" style="font-size:${Math.max(4, Math.min(p.w, p.h) / 6)}px">${t("box.p." + p.name)}</text>`;
    }).join("");
    const os = outerSize(b);
    info.textContent = t("box.info", { n: ps.length, w: os.W.toFixed(1), d: os.D.toFixed(1), h: os.H.toFixed(1) });
  };
  $<HTMLSelectElement>("box-type").value = o.type || "closed";
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener("input", preview));
  ov.querySelectorAll<HTMLElement>("[data-view]").forEach(el => el.addEventListener("click", () => {
    mode = el.dataset.view === "3d" ? "3d" : "2d";
    try { localStorage.setItem(VIEW_KEY, mode); } catch { /* egal */ }
    preview();
  }));
  preview();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $<HTMLElement>("box-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("box-cancel").onclick = close;
  $<HTMLElement>("box-ok").onclick = () => {
    const b = read();
    if (!valid(b)) return;
    try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* egal */ }
    close();
    const ps = boxPanels(b);
    const bed = bedSizeMm();
    const pos = layout(ps, 5, Math.max(bed.w - 20, Math.max(...ps.map(p => p.w))));
    const st = app();
    const toW = (i: number, pts: { x: number; y: number }[]) => pts.map(q => ({ x: (10 + pos[i].x + q.x) * MM_TO_PIXEL, y: (10 + pos[i].y + q.y) * MM_TO_PIXEL }));
    const made: any[] = [];
    ps.forEach((p, i) => {
      // Platte + ihre Ausschnitte (Schlitze, Griffe) als Gruppe – sie bewegen sich zusammen
      const gid = p.holes?.length || p.lines?.length ? "box-" + Math.random().toString(36).slice(2, 10) : undefined;
      const extra = gid ? { source: t("box.title"), groupId: gid } : { source: t("box.title") };
      made.push(createPolyline(toW(i, p.pts), true, "outside", extra));
      for (const hl of p.holes || []) made.push(createPolyline(toW(i, hl), true, "inside", extra));
      for (const ln of p.lines || []) made.push(createPolyline(toW(i, ln), false, "on-line", extra));
    });
    st.shapes = [...st.shapes, ...made];
    st.selectedShapeIds = made.map(s => s.id);
    log(t("box.done", { n: ps.length }));
    done();
  };
}
