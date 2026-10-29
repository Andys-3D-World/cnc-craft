/**
 * MANDALA-GENERATOR – Fenster (wie der Box-Generator): Werte wählen, Vorschau, „Erstellen“ setzt die Formen ein.
 * Die Geometrie entsteht in mandala.ts. Ergebnis: Außenkontur („außen“) + Muster als Löcher („innen“) oder als
 * Gravur („Mitte“), alles in einer Gruppe – zum Lasern oder Fräsen.
 */
import { app, bedSizeMm } from "./editorState";
import { createPolyline, MM_TO_PIXEL } from "../shapeTransform";
import { t } from "../i18n/i18n";
import { mandala, MandalaOptions, MandalaEdge, MandalaCenter, Motif, Pt, MOTIFS, MANDALA_EDGES, MANDALA_CENTERS } from "../mandala";

const KEY = "cnc_craft_mandala";
const EDGES = MANDALA_EDGES, CENTERS = MANDALA_CENTERS;
const STYLES: (Motif | "mixed")[] = ["mixed", ...MOTIFS];

interface Opts extends MandalaOptions { engrave: boolean }
const DEF: Opts = { d: 150, n: 12, rings: 4, web: 2, edge: "petals", center: "flower", seed: 1, engrave: false, motif: "mixed" };

function load(): Opts {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: Opts = { ...DEF };
    for (const k of ["d", "n", "rings", "web", "seed"] as const) if (Number.isFinite(Number(s[k])) && Number(s[k]) > 0) o[k] = Number(s[k]);
    if (EDGES.includes(s.edge)) o.edge = s.edge;
    if (CENTERS.includes(s.center)) o.center = s.center;
    if (STYLES.includes(s.motif)) o.motif = s.motif;
    if (typeof s.engrave === "boolean") o.engrave = s.engrave;
    return o;
  } catch { return { ...DEF }; }
}

export function openMandalaDialog(log: (s: string) => void, done: () => void) {
  const o = load();
  document.getElementById("mandala-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "mandala-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step = "1", min = "0") =>
    `<label class="prop-row">${t(key)}<input id="${id}" type="number" step="${step}" min="${min}" value="${v}" class="prop-input"></label>`;
  const sel = (id: string, key: string, list: string[], prefix: string) =>
    `<label class="prop-row">${t(key)}<select id="${id}" class="prop-input" style="width:auto;">${list.map(k => `<option value="${k}">${t(prefix + k)}</option>`).join("")}</select></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:560px;">
      <h3>🌸 ${t("mand.title")}</h3>
      <div class="dlg-hint">${t("mand.desc")}</div>
      <div class="box-grid">
        <div class="box-fields">
          ${num("mand-d", "mand.d", o.d, "5", "20")}
          ${num("mand-n", "mand.n", o.n, "1", "3")}
          ${num("mand-rings", "mand.rings", o.rings, "1", "1")}
          ${num("mand-web", "mand.web", o.web, "0.1", "0.3")}
          ${sel("mand-motif", "mand.motif", STYLES, "mand.motif.")}
          ${sel("mand-edge", "mand.edge", EDGES, "mand.edge.")}
          ${sel("mand-center", "mand.center", CENTERS, "mand.center.")}
          <label class="prop-row" style="cursor:pointer;"><span>${t("mand.engrave")}</span><input id="mand-engrave" type="checkbox" ${o.engrave ? "checked" : ""} style="width:auto;"></label>
          <button id="mand-dice" class="btn-secondary" type="button" style="width:100%;margin-top:6px;">🎲 ${t("mand.dice")}</button>
        </div>
        <div class="box-prev"><svg id="mand-svg" viewBox="0 0 100 100"></svg><div id="mand-info" class="dlg-hint"></div></div>
      </div>
      <div class="dlg-hint">${t("mand.hint")}</div>
      <div class="dlg-buttons">
        <button id="mand-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="mand-ok" class="btn-primary">✔ ${t("mand.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  $<HTMLSelectElement>("mand-edge").value = o.edge;
  $<HTMLSelectElement>("mand-center").value = o.center;
  $<HTMLSelectElement>("mand-motif").value = o.motif || "mixed";

  const read = (): Opts => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    return {
      d: n("mand-d", o.d, 20, 2000), n: Math.round(n("mand-n", o.n, 3, 36)), rings: Math.round(n("mand-rings", o.rings, 1, 8)),
      web: n("mand-web", o.web, 0.3, 20), edge: $<HTMLSelectElement>("mand-edge").value as MandalaEdge,
      center: $<HTMLSelectElement>("mand-center").value as MandalaCenter, seed: o.seed, engrave: $("mand-engrave").checked,
      motif: $<HTMLSelectElement>("mand-motif").value as Motif | "mixed",
    };
  };
  const preview = () => {
    const m = read(), res = mandala(m), R = m.d / 2;
    const ring = (pts: Pt[]) => pts.map((q, k) => `${k ? "L" : "M"}${q.x.toFixed(2)},${(-q.y).toFixed(2)}`).join("") + "Z";
    const svg = $<HTMLElement>("mand-svg") as unknown as SVGSVGElement;
    svg.setAttribute("viewBox", `${-R - 2} ${-R - 2} ${m.d + 4} ${m.d + 4}`);
    svg.innerHTML = m.engrave
      ? `<path d="${ring(res.outer)}" class="box-panel"/><path d="${res.holes.map(ring).join("")}" class="box-cut"/>`
      : `<path d="${ring(res.outer)}${res.holes.map(ring).join("")}" fill-rule="evenodd" class="box-panel"/>`;
    $<HTMLElement>("mand-info").textContent = t("mand.info", { n: res.holes.length, d: m.d, s: m.seed });
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener("input", preview));
  $<HTMLElement>("mand-dice").onclick = () => { o.seed = 1 + Math.floor(Math.random() * 99999); preview(); };
  preview();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $<HTMLElement>("mand-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("mand-cancel").onclick = close;
  $<HTMLElement>("mand-ok").onclick = () => {
    const m = read();
    try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* egal */ }
    close();
    const res = mandala(m);
    // links unten aufs Bett (10 mm Rand) wie beim Box-Generator; größer als das Bett: Hinweis
    const bed = bedSizeMm(), R = m.d / 2;
    const cx = 10 + R, cy = 10 + R;
    if (m.d + 20 > Math.min(bed.w, bed.h)) log(t("mand.bigger", { d: m.d }));
    const toW = (pts: Pt[]) => pts.map(q => ({ x: (cx + q.x) * MM_TO_PIXEL, y: (cy + q.y) * MM_TO_PIXEL }));
    const extra = { source: t("mand.title"), groupId: "mandala-" + Math.random().toString(36).slice(2, 10) };
    const made: any[] = [createPolyline(toW(res.outer), true, "outside", extra)];
    for (const h of res.holes) made.push(createPolyline(toW(h), true, m.engrave ? "on-line" : "inside", extra));
    const st = app();
    st.shapes = [...st.shapes, ...made];
    st.selectedShapeIds = made.map(s => s.id);
    log(t("mand.done", { n: res.holes.length }));
    done();
  };
}
