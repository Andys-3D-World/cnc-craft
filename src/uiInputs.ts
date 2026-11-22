/**
 * EIGENSCHAFTEN-FELDER (rechte Seite): Position, Größe, Drehung, Frästiefe der Auswahl.
 *
 * - X-Mitte / Y-Mitte: Mittelpunkt der Auswahl in mm
 * - Breite / Höhe:     Größe der Auswahl in mm (mit Schloss = Seitenverhältnis bleibt)
 * - Drehen um (°):     dreht die Auswahl um ihren Mittelpunkt (positiv = gegen den Uhrzeigersinn)
 *
 * Werte werden übernommen, sobald du Enter drückst oder das Feld verlässt.
 */
import { MM_TO_PIXEL, groupBounds, translateShape, scaleShape, rotateShape } from "./shapeTransform";
import { cleanMillDir } from "./millDir";
import { leadOptions, LEAD_MIN, LEAD_MAX, LEAD_DEFAULT_LEN } from "./millLead";
import { autoFractions } from "./tabs";
import { skinFits, skinSettings, SKIN_DEFAULT, SKIN_MIN, SKIN_MAX, SKIN_FEED_MIN } from "./onionSkin";

function getState(): any {
  return (window as any).cncState;
}

function selected(state: any): any[] {
  const ids = new Set(state.selectedShapeIds);
  return state.shapes.filter((s: any) => ids.has(s.id));
}

export function setupUiInputs(redraw: () => void) {
  const dimX = document.getElementById("dim-x") as HTMLInputElement;
  const dimY = document.getElementById("dim-y") as HTMLInputElement;
  const dimW = document.getElementById("dim-w") as HTMLInputElement;
  const dimH = document.getElementById("dim-h") as HTMLInputElement;
  const dimAngle = document.getElementById("dim-angle") as HTMLInputElement;
  const dimDepth = document.getElementById("dim-depth") as HTMLInputElement;
  const dimFinish = document.getElementById("dim-finish") as HTMLInputElement | null;
  const lockRatio = document.getElementById("dim-lock-ratio") as HTMLInputElement | null;
  const tabN = document.getElementById("dim-tab-n") as HTMLInputElement | null;
  const tabW = document.getElementById("dim-tab-w") as HTMLInputElement | null;
  const tabH = document.getElementById("dim-tab-h") as HTMLInputElement | null;
  const tabMode = document.getElementById("dim-tab-mode") as HTMLSelectElement | null;
  const tabInputs = [tabN, tabW, tabH].filter(Boolean) as HTMLInputElement[];
  // Automatisch / selbst gesetzt: beim Wechsel auf „selbst“ werden die automatischen Stellen übernommen
  tabMode?.addEventListener("change", () => {
    const state = getState();
    if (!state) return;
    for (const s of selected(state)) {
      if (tabMode.value === "manual" && s.tabMode !== "manual") s.tabPts = autoFractions(Math.round(Number(s.tabN) || 0));
      s.tabMode = tabMode.value;
      if (!(Number(s.tabLen) > 0)) s.tabLen = parseFloat(tabW?.value || "") || 5;
      if (!(Number(s.tabH) > 0)) s.tabH = parseFloat(tabH?.value || "") || 1.5;
    }
    redraw();
  });

  const apply = (input: HTMLInputElement) => {
    const state = getState();
    if (!state || state.selectedShapeIds.length === 0) return;
    const value = parseFloat(input.value);
    if (!Number.isFinite(value)) { updateDimensionInputs(null); return; }

    const shapes = selected(state);
    const b = groupBounds(shapes);
    if (!b) return;
    const curW = b.maxX - b.minX, curH = b.maxY - b.minY;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;

    if (input === dimX) {
      const dx = value * MM_TO_PIXEL - cx;
      shapes.forEach(s => translateShape(s, dx, 0));
    } else if (input === dimY) {
      const dy = value * MM_TO_PIXEL - cy;
      shapes.forEach(s => translateShape(s, 0, dy));
    } else if (input === dimW || input === dimH) {
      if (value <= 0) { updateDimensionInputs(null); return; }
      const locked = lockRatio ? lockRatio.checked : true;
      let sx = 1, sy = 1;
      if (input === dimW) {
        if (curW <= 1e-9) return;
        sx = (value * MM_TO_PIXEL) / curW;
        sy = locked ? sx : 1;
      } else {
        if (curH <= 1e-9) return;
        sy = (value * MM_TO_PIXEL) / curH;
        sx = locked ? sy : 1;
      }
      // Skalieren von der linken unteren Ecke aus -> das Teil bleibt auf dem Bett
      shapes.forEach(s => scaleShape(s, b.minX, b.minY, sx, sy));
    } else if (input === dimAngle) {
      if (value !== 0) shapes.forEach(s => rotateShape(s, cx, cy, (value * Math.PI) / 180));
      input.value = "0";
    } else if (input === dimDepth) {
      shapes.forEach(s => { s.millingDepth = value; });
    } else if (input === dimFinish) {
      // Schlichtgang: Aufmaß in mm, 0 = aus
      const a = Math.max(0, Math.min(5, value));
      shapes.forEach(s => { if (a > 0) s.finishAllow = a; else delete s.finishAllow; });
    } else if (tabInputs.includes(input)) {
      // Haltestege: alle drei Werte zusammen an die Auswahl (Anzahl 0 = keine Stege)
      const num = (el: HTMLInputElement | null, d: number) => { const v = parseFloat(el?.value || ""); return Number.isFinite(v) && v >= 0 ? v : d; };
      const n = Math.round(num(tabN, 0)), len = num(tabW, 5), h = num(tabH, 1.5);
      shapes.forEach(s => {
        s.tabLen = len; s.tabH = h;
        // eine neue Anzahl heißt: wieder automatisch verteilen
        if (input === tabN) { s.tabN = n; s.tabMode = "auto"; } else if (s.tabMode !== "manual") s.tabN = n;
      });
    }

    updateDimensionInputs(null);
    redraw();
  };

  // Fräsrichtung je Form (leer = Standard, wie bisher)
  document.getElementById("dim-mill-dir")?.addEventListener("change", e => {
    const state = getState();
    if (!state) return;
    const v = cleanMillDir((e.target as HTMLSelectElement).value);
    selected(state).forEach(s => { if (v) s.millDir = v; else delete s.millDir; });
    redraw();
  });

  // An-/Wegfahren je Form (beides aus = keine Angaben an der Form, alles wie bisher)
  ["dim-lead-in", "dim-lead-out", "dim-lead-type", "dim-lead-len"].forEach(id => document.getElementById(id)?.addEventListener("change", () => {
    const state = getState();
    if (!state) return;
    const on = (i: string) => (document.getElementById(i) as HTMLInputElement | null)?.checked === true;
    const type = (document.getElementById("dim-lead-type") as HTMLSelectElement | null)?.value === "line" ? "line" : "arc";
    const n = parseFloat((document.getElementById("dim-lead-len") as HTMLInputElement | null)?.value || "");
    const len = Number.isFinite(n) && n > 0 ? Math.max(LEAD_MIN, Math.min(LEAD_MAX, n)) : LEAD_DEFAULT_LEN;
    selected(state).forEach(s => {
      if (on("dim-lead-in")) s.leadIn = true; else delete s.leadIn;
      if (on("dim-lead-out")) s.leadOut = true; else delete s.leadOut;
      if (s.leadIn || s.leadOut) { s.leadType = type; s.leadLen = len; } else { delete s.leadType; delete s.leadLen; }
    });
    updateDimensionInputs(null);
    redraw();
  }));

  // Zwiebelhaut je Form (onionSkin.ts): ohne Häkchen keine Angaben an der Form, alles wie bisher.
  // Gesetzt wird sie nur an Formen, bei denen sie wirken kann (geschlossen, außen/innen) – die anderen bleiben, wie sie sind.
  const skinOn = document.getElementById("dim-skin-on") as HTMLInputElement | null;
  const skinH = document.getElementById("dim-skin-h") as HTMLInputElement | null;
  const skinCut = document.getElementById("dim-skin-cut") as HTMLInputElement | null;
  const skinFeedEl = document.getElementById("dim-skin-feed") as HTMLInputElement | null;
  const applySkin = (from: HTMLInputElement) => {
    const state = getState();
    if (!state || !skinOn || !skinH) return;
    const h = parseFloat(skinH.value);
    // Dicke 0 (oder leer) heißt: keine Haut
    const on = skinOn.checked && (from !== skinH || h > 0);
    const thick = h > 0 ? Math.max(SKIN_MIN, Math.min(SKIN_MAX, h)) : SKIN_DEFAULT;
    const feed = parseFloat(skinFeedEl?.value || "");
    for (const s of selected(state)) {
      if (!on || !skinFits(s)) { delete s.skinH; delete s.skinCut; delete s.skinFeed; continue; }
      s.skinH = thick;
      if (skinCut?.checked) s.skinCut = true; else delete s.skinCut;
      if (s.skinCut && feed > 0) s.skinFeed = Math.max(SKIN_FEED_MIN, feed); else delete s.skinFeed;
    }
    updateDimensionInputs(null);
    redraw();
  };
  [skinOn, skinH, skinCut, skinFeedEl].forEach(el => el?.addEventListener("change", () => applySkin(el)));

  [dimX, dimY, dimW, dimH, dimAngle, dimDepth, dimFinish, ...tabInputs].forEach(input => {
    if (!input) return;
    input.addEventListener("change", () => apply(input));
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") { apply(input); input.blur(); }
    });
  });
}

/**
 * Trägt die echten Millimeter-Maße der aktuellen Auswahl in die Felder ein.
 * (Der Parameter ist nur noch aus Kompatibilitätsgründen da.)
 */
export function updateDimensionInputs(_shape: any) {
  const dimX = document.getElementById("dim-x") as HTMLInputElement;
  const dimY = document.getElementById("dim-y") as HTMLInputElement;
  const dimW = document.getElementById("dim-w") as HTMLInputElement;
  const dimH = document.getElementById("dim-h") as HTMLInputElement;
  const dimDepth = document.getElementById("dim-depth") as HTMLInputElement;
  const state = getState();
  if (!state || !dimX || !dimY || !dimW || !dimH) return;

  const shapes = selected(state);
  const b = groupBounds(shapes);
  if (!b) {
    [dimX, dimY, dimW, dimH].forEach(i => { i.value = ""; });
    return;
  }

  dimX.value = (((b.minX + b.maxX) / 2) / MM_TO_PIXEL).toFixed(2);
  dimY.value = (((b.minY + b.maxY) / 2) / MM_TO_PIXEL).toFixed(2);
  dimW.value = ((b.maxX - b.minX) / MM_TO_PIXEL).toFixed(2);
  dimH.value = ((b.maxY - b.minY) / MM_TO_PIXEL).toFixed(2);
  if (dimDepth && shapes[0] && typeof shapes[0].millingDepth === "number") {
    dimDepth.value = String(shapes[0].millingDepth);
  }
  const fin = document.getElementById("dim-finish") as HTMLInputElement | null;
  if (fin && shapes[0]) fin.value = String(Number(shapes[0].finishAllow) > 0 ? shapes[0].finishAllow : 0);
  const md = document.getElementById("dim-mill-dir") as HTMLSelectElement | null;
  if (md && shapes[0]) md.value = cleanMillDir(shapes[0].millDir);
  if (shapes[0]) {
    const lo = leadOptions(shapes[0]);
    const box = (id: string, v: boolean) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.checked = v; };
    box("dim-lead-in", !!lo?.in); box("dim-lead-out", !!lo?.out);
    if (lo) {
      (document.getElementById("dim-lead-type") as HTMLSelectElement).value = lo.type;
      (document.getElementById("dim-lead-len") as HTMLInputElement).value = String(lo.len);
    }
  }
  // Haltestege der ersten Form zeigen (ohne eigene Werte: keine Stege, Länge/Höhe bleiben stehen)
  const s0 = shapes[0];
  const set = (id: string, v: any) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el && typeof v === "number") el.value = String(v); };
  if (s0) {
    set("dim-tab-n", s0.tabMode === "manual" ? (s0.tabPts || []).length : s0.tabN ?? 0);
    set("dim-tab-w", s0.tabLen); set("dim-tab-h", s0.tabH);
    const m = document.getElementById("dim-tab-mode") as HTMLSelectElement | null;
    if (m) m.value = s0.tabMode === "manual" ? "manual" : "auto";
  }
  // Zwiebelhaut: die erste Form der Auswahl, die eine hat (sonst aus; die zuletzt getippte Dicke bleibt stehen)
  const skinOn = document.getElementById("dim-skin-on") as HTMLInputElement | null;
  if (skinOn) {
    const withSkin = shapes.find(s => skinFits(s) && skinSettings(s));
    const sk = withSkin ? skinSettings(withSkin) : null;
    const hEl = document.getElementById("dim-skin-h") as HTMLInputElement | null;
    const cutEl = document.getElementById("dim-skin-cut") as HTMLInputElement | null;
    const feedEl = document.getElementById("dim-skin-feed") as HTMLInputElement | null;
    skinOn.checked = !!sk;
    // an offenen Linien, Taschen, Bohrungen … gibt es nichts auszuschneiden: Häkchen gesperrt
    skinOn.disabled = !shapes.some(skinFits);
    if (hEl) { if (sk) hEl.value = String(sk.h); else if (!(parseFloat(hEl.value) > 0)) hEl.value = String(SKIN_DEFAULT); hEl.disabled = skinOn.disabled; }
    if (cutEl) cutEl.checked = !!sk?.cut;
    if (feedEl) feedEl.value = sk && sk.cut && sk.feed > 0 ? String(sk.feed) : "";
    const show = (id: string, on: boolean) => { const el = document.getElementById(id); if (el) el.style.display = on ? "" : "none"; };
    show("dim-skin-cut-row", !!sk);
    show("dim-skin-feed-row", !!sk?.cut);
  }
}
