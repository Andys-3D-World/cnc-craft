/**
 * MATERIAL ERKENNEN (Beta) – Fenster mit Anleitung
 *
 * Ablauf: 1. Kamera ausrichten (🎯)  2. leeres Bett aufnehmen  3. Material auflegen, erkennen
 *         4. Ergebnis prüfen (Ecken mit der Maus ziehen)  5. übernehmen → Material-Platte
 * Übernehmen setzt die Platte auf Bettgröße und markiert alles ohne Material als „verbraucht“
 * (außerhalb der Platte + Löcher). Verschachteln und „Auf freie Stelle“ nutzen dann nur echtes Material.
 *
 * Das Bild vom leeren Bett wird gemerkt (klein, als JPEG) – gilt nur für dieselbe Ausrichtung und Bettgröße.
 */
import { t } from "../i18n/i18n";
import { cam, grabStill } from "./camera";
import { Warper } from "./cameraWarp";
import { detectMaterial, inQuad, DetectResult, Img } from "./materialDetect";
import { applyPlateFromCamera, hasUsedArea } from "../stock";

const REF_KEY = "cnc_craft_camera_ref";
const LONG = 600; // Pixel der langen Bettseite für die Erkennung

interface RefStore { img: Img; bedW: number; bedH: number; calibDate: string; date: string }
let ref: RefStore | null = null;
let warper: Warper | null = null;

function bed(): { w: number; h: number } {
  const w = parseFloat((document.getElementById("bed-w") as HTMLInputElement | null)?.value || "") || 300;
  const h = parseFloat((document.getElementById("bed-h") as HTMLInputElement | null)?.value || "") || 300;
  return { w, h };
}
function size(b: { w: number; h: number }) {
  return b.w >= b.h ? { w: LONG, h: Math.max(32, Math.round(LONG * b.h / b.w)) } : { w: Math.max(32, Math.round(LONG * b.w / b.h)), h: LONG };
}

/** Aktuelles Kamerabild entzerrt als Bett von oben (Pixel), null = keine Kamera / nicht ausgerichtet */
async function snapshot(): Promise<{ img: Img; canvas: HTMLCanvasElement } | null> {
  const c = cam.calib;
  if (!c) return null;
  const f = await grabStill();
  if (!f) return null;
  const b = bed(), sz = size(b);
  if (!warper) warper = new Warper();
  if (!warper.render(f.src, f.w, f.h, { mode: "bed", k1: c.k1, rot180: cam.rot180, mirror: cam.mirror, H: c.H, bedW: b.w, bedH: b.h, outW: sz.w, outH: sz.h })) return null;
  const cv = document.createElement("canvas");
  cv.width = sz.w; cv.height = sz.h;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(warper.canvas, 0, 0);
  const d = ctx.getImageData(0, 0, sz.w, sz.h);
  return { img: { w: sz.w, h: sz.h, data: d.data }, canvas: cv };
}

function loadRef() {
  if (ref) return;
  try {
    const raw = JSON.parse(localStorage.getItem(REF_KEY) || "null");
    if (!raw?.jpg) return;
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = raw.w; cv.height = raw.h;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(im, 0, 0);
      ref = { img: { w: raw.w, h: raw.h, data: ctx.getImageData(0, 0, raw.w, raw.h).data }, bedW: raw.bedW, bedH: raw.bedH, calibDate: raw.calibDate, date: raw.date };
      window.dispatchEvent(new Event("cnc-matref"));
    };
    im.src = raw.jpg;
  } catch { /* kein gespeichertes Bild */ }
}

function refValid(): boolean {
  const b = bed();
  return !!ref && !!cam.calib && ref.bedW === b.w && ref.bedH === b.h && ref.calibDate === cam.calib.date;
}

export function openMaterialDialog(log: (s: string) => void) {
  loadRef();
  document.getElementById("mat-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "mat-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:600px;max-width:calc(100vw - 32px);max-height:calc(100vh - 40px);overflow:auto;">
      <h3>🧱 ${t("mat.title")}</h3>
      <div class="mat-beta">⚠️ ${t("mat.beta")}</div>
      <ol class="mat-steps">
        <li>${t("mat.s1")} <span id="mat-s1-ok"></span></li>
        <li>${t("mat.s2")} <button id="mat-ref" class="btn-secondary btn-compact">📷 ${t("mat.refBtn")}</button> <span id="mat-ref-ok" class="mat-ok"></span></li>
        <li>${t("mat.s3")} <button id="mat-detect" class="btn-primary btn-compact">🔍 ${t("mat.detectBtn")}</button></li>
        <li>${t("mat.s4")}</li>
        <li>${t("mat.s5")}</li>
      </ol>
      <div class="mat-view"><canvas id="mat-canvas" width="560" height="373"></canvas><div id="mat-empty" class="mat-empty">${t("mat.empty")}</div></div>
      <div class="mat-row">
        <label>${t("mat.sens")} <input id="mat-sens" type="range" min="-50" max="50" step="5" value="0"></label>
        <label>${t("mat.minHole")} <input id="mat-minhole" type="number" min="0" step="10" value="30" style="width:70px;"></label>
        <label><input id="mat-useholes" type="checkbox" checked> ${t("mat.useHoles")}</label>
      </div>
      <div id="mat-info" class="dlg-hint"></div>
      <details class="mat-tips"><summary>${t("mat.tipsTitle")}</summary><ul>
        <li>${t("mat.tip1")}</li><li>${t("mat.tip2")}</li><li>${t("mat.tip3")}</li><li>${t("mat.tip4")}</li><li>${t("mat.tip5")}</li>
      </ul></details>
      <div class="dlg-buttons">
        <button id="mat-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="mat-apply" class="btn-primary" disabled>✔ ${t("mat.apply")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <T extends HTMLElement>(id: string) => ov.querySelector("#" + id) as T;
  const canvas = $<HTMLCanvasElement>("mat-canvas");
  const ctx = canvas.getContext("2d")!;
  let shot: { img: Img; canvas: HTMLCanvasElement } | null = null;
  let res: DetectResult | null = null;
  let corners: { x: number; y: number }[] = [];
  let drag = -1;
  const b = bed();
  // Vorschau im Seitenverhältnis des Betts
  canvas.height = Math.round(canvas.width * b.h / b.w);

  const status = () => {
    $("mat-s1-ok").textContent = cam.calib ? "✔" : "✖ " + t("mat.noCalib");
    $("mat-s1-ok").className = cam.calib ? "mat-ok" : "mat-bad";
    $("mat-ref-ok").textContent = refValid() ? "✔ " + new Date(ref!.date).toLocaleString() : (ref ? t("mat.refOld") : "");
  };
  window.addEventListener("cnc-matref", status);
  status();

  const toCv = (p: { x: number; y: number }) => ({ x: (p.x / b.w) * canvas.width, y: (1 - p.y / b.h) * canvas.height });
  const toMm = (x: number, y: number) => ({ x: (x / canvas.width) * b.w, y: (1 - y / canvas.height) * b.h });

  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $("mat-empty").style.display = shot ? "none" : "";
    if (!shot) return;
    ctx.drawImage(shot.canvas, 0, 0, canvas.width, canvas.height);
    if (res) {
      // grün = Material, rot = Löcher (halb durchsichtig)
      const ov2 = document.createElement("canvas");
      ov2.width = res.w; ov2.height = res.h;
      const o = ov2.getContext("2d")!, id = o.createImageData(res.w, res.h);
      const useHoles = $<HTMLInputElement>("mat-useholes").checked;
      for (let i = 0; i < res.w * res.h; i++) {
        if (res.holes[i] && useHoles) id.data.set([255, 70, 60, 110], i * 4);
        else if (res.plate[i]) id.data.set([60, 220, 120, 70], i * 4);
      }
      o.putImageData(id, 0, 0);
      ctx.drawImage(ov2, 0, 0, canvas.width, canvas.height);
    }
    if (corners.length === 4) {
      ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 2;
      ctx.beginPath();
      corners.forEach((p, i) => { const q = toCv(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      ctx.closePath(); ctx.stroke();
      ctx.fillStyle = "#ffd23f";
      corners.forEach(p => { const q = toCv(p); ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.fill(); });
    }
  };

  const info = () => {
    if (!res) { $("mat-info").textContent = ""; $<HTMLButtonElement>("mat-apply").disabled = true; return; }
    const side = (a: { x: number; y: number }, c: { x: number; y: number }) => Math.hypot(a.x - c.x, a.y - c.y);
    const ok = corners.length === 4;
    const w = ok ? side(corners[0], corners[1]) : 0, h = ok ? side(corners[1], corners[2]) : 0;
    // Schräglage als kleiner Winkel (−45…45°) – welche Kante „unten“ ist, spielt keine Rolle
    const raw = ok ? Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * 180 / Math.PI : 0;
    const ang = ((raw % 90) + 135) % 90 - 45;
    $("mat-info").textContent = res.coverage < 0.02
      ? t("mat.nothing")
      : t("mat.result", { w: w.toFixed(0), h: h.toFixed(0), a: ang.toFixed(1), n: $<HTMLInputElement>("mat-useholes").checked ? res.holeCount : 0 })
        + (res.usedRef ? "" : " " + t("mat.noRefWarn"));
    $<HTMLButtonElement>("mat-apply").disabled = res.coverage < 0.02 || !ok;
  };

  const detect = async () => {
    if (!cam.calib) { log(t("mat.noCalib")); status(); return; }
    shot = await snapshot();
    if (!shot) { log(t("mat.noCam")); $("mat-info").textContent = t("mat.noCam"); return; }
    const mmPerPx = b.w / size(b).w;
    const minHole = Math.max(0, parseFloat($<HTMLInputElement>("mat-minhole").value) || 0);
    res = detectMaterial(shot.img, refValid() ? ref!.img : null, mmPerPx, +$<HTMLInputElement>("mat-sens").value, minHole);
    corners = res && res.corners.length === 4 ? res.corners.map(p => ({ ...p })) : [];
    draw(); info();
  };

  $("mat-ref").onclick = async () => {
    if (!cam.calib) { log(t("mat.noCalib")); status(); return; }
    const s = await snapshot();
    if (!s) { log(t("mat.noCam")); $("mat-info").textContent = t("mat.noCam"); return; }
    ref = { img: s.img, bedW: b.w, bedH: b.h, calibDate: cam.calib.date, date: new Date().toISOString() };
    try {
      localStorage.setItem(REF_KEY, JSON.stringify({ jpg: s.canvas.toDataURL("image/jpeg", 0.85), w: s.img.w, h: s.img.h, bedW: b.w, bedH: b.h, calibDate: cam.calib.date, date: ref.date }));
    } catch { /* zu groß – gilt bis zum Neustart */ }
    shot = s; res = null; corners = [];
    draw(); info(); status();
    log(t("mat.refSaved"));
  };
  $("mat-detect").onclick = detect;
  $("mat-sens").addEventListener("change", () => { if (shot) detect(); });
  $("mat-minhole").addEventListener("change", () => { if (shot) detect(); });
  $("mat-useholes").addEventListener("change", () => { draw(); info(); });

  // Ecken mit der Maus ziehen (Hand-Korrektur)
  const pos = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height }; };
  const near = (p: { x: number; y: number }) => corners.findIndex(c => { const q = toCv(c); return Math.hypot(q.x - p.x, q.y - p.y) < 12; });
  canvas.addEventListener("pointerdown", e => {
    drag = near(pos(e));
    if (drag >= 0) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", e => {
    const p = pos(e);
    if (drag >= 0) { corners[drag] = toMm(Math.max(0, Math.min(canvas.width, p.x)), Math.max(0, Math.min(canvas.height, p.y))); draw(); info(); }
    else canvas.style.cursor = near(p) >= 0 ? "grab" : "default";
  });
  canvas.addEventListener("pointerup", () => { drag = -1; });

  const close = () => { window.removeEventListener("cnc-matref", status); ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  $("mat-cancel").onclick = close;
  $("mat-apply").onclick = () => {
    if (!res || corners.length !== 4) return;
    if (hasUsedArea() && !window.confirm(t("mat.confirmReplace"))) return;
    const r = res, q = corners.slice(), useHoles = $<HTMLInputElement>("mat-useholes").checked;
    const k = r.w / b.w; // Pixel pro mm
    const p = applyPlateFromCamera(b.w, b.h, (x, y) => {
      if (!inQuad(x, y, q)) return true;
      if (!useHoles) return false;
      const c = Math.floor(x * k), row = r.h - 1 - Math.floor(y * k);
      return c >= 0 && row >= 0 && c < r.w && row < r.h && !!r.holes[row * r.w + c];
    }, t("mat.label"));
    log(t("mat.applied", { p: p.toFixed(1) }));
    close();
  };
}
