/**
 * FENSTER „3D-KÖRPER“ (Rechnung in editor/body3d.ts)
 *
 * Geschlossene Formen auswählen → „Auswahl hochziehen“: ein neuer Schritt in der Zeitleiste. Jeder Schritt nimmt die
 * Fläche dazu (Aufbauen) oder weg (Ausschneiden), ab einer Höhe um eine Höhe (negativ = nach unten). Vorschlag:
 * der erste Schritt baut die Platte in Materialdicke auf, jeder weitere schneidet 5 mm von der Oberkante aus.
 * Die Schritte hängen an der ersten Profil-Form (s.feat3d) – sie werden mit dem Projekt gespeichert, sind Teil von
 * Rückgängig und folgen jeder Änderung der Skizze. Live-Vorschau rechts, Speichern als binäres STL (Pfad aus dem Dialog,
 * danach nie verändern).
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n/i18n";
import { app } from "../editor/editorState";
import { selectedShapes } from "../editor/selection";
import { MM_TO_PIXEL, createPolyline, isClosedShape, newId } from "../shapeTransform";
import { Viewer3D } from "../view3d/viewer3d";
import { regionOf, shellBounds, shellMeshes, stlBinary, type Shell } from "../view3d/solid";
import { bodyShells, millPlan, topOf, volume, zRange, type EvalFeat, type Feature, type FeatOp } from "../editor/body3d";
import { isMill } from "../machineMode";
import { getStock } from "../stock";
import { checkpoint } from "../editor/history";

type Entry = { f: Feature; owner: any };

/** Alle Schritte der Zeichnung in ihrer Reihenfolge */
export function allFeatures(): Entry[] {
  const out: Entry[] = [];
  for (const s of app().shapes) for (const f of (s.feat3d as Feature[] | undefined) || []) out.push({ f, owner: s });
  return out.sort((a, b) => a.f.seq - b.f.seq);
}

/** Schritt → Fläche und Höhen (fehlende Profil-Formen fallen weg) */
function evalFeat(f: Feature, byId: Map<string, any>): EvalFeat & { missing: number } {
  const shapes = f.profile.map(id => byId.get(id)).filter(s => s && isClosedShape(s));
  const [z0, z1] = zRange(f);
  return { op: f.op, z0, z1, region: shapes.length ? regionOf(shapes) : [], missing: f.profile.length - shapes.length };
}

export function bodyNow(): Shell[] {
  const byId = new Map<string, any>(app().shapes.map((s: any) => [s.id, s]));
  return bodyShells(allFeatures().filter(e => !e.f.off).map(e => evalFeat(e.f, byId)));
}

const num = (v: number) => String(+v.toFixed(3));

/** Fenster öffnen; addSelection: die ausgewählten geschlossenen Formen gleich als neuen Schritt anlegen */
export function openBodyDialog(log: (s: string) => void, addSelection: boolean, redraw: () => void) {
  if (addSelection && !addFromSelection(log)) { if (!allFeatures().length) return; }
  else if (!addSelection && !allFeatures().length && !selectedShapes().some(isClosedShape)) { log(t("body.none")); return; }

  document.getElementById("body-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "body-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(960px, calc(100vw - 32px));">
      <h3>🧊 ${t("body.title")}</h3>
      <div class="dlg-hint">${t("body.desc")}</div>
      <div style="display:grid;grid-template-columns:minmax(300px, 400px) 1fr;gap:12px;align-items:start;">
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div id="body-list" style="display:flex;flex-direction:column;gap:6px;max-height:min(380px, calc(100vh - 320px));overflow:auto;"></div>
          <button id="body-add" class="btn-secondary">＋ ${t("body.add")}</button>
          <div class="dlg-hint">${t("body.hint")}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <canvas id="body-cv" style="width:100%;height:min(420px, calc(100vh - 300px));border-radius:10px;cursor:grab;display:block;"></canvas>
          <div id="body-info" class="dlg-hint"></div>
        </div>
      </div>
      <div class="dlg-buttons">
        <button id="body-close" class="btn-secondary">${t("dlg.close")}</button>
        <button id="body-mill" class="btn-secondary" title="${t("body.millTip")}">⚙ ${t("body.mill")}</button>
        <button id="body-stl" class="btn-primary">💾 ${t("body.save")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement>(id: string) => ov.querySelector("#" + id) as E;
  const viewer = new Viewer3D($<HTMLCanvasElement>("body-cv"));
  let shells: Shell[] = [];
  let first = true;

  const rebuild = () => {
    shells = bodyNow();
    if (viewer.ok) viewer.setMeshes(shellMeshes(shells), !first);
    first = false;
    const b = shellBounds(shells);
    const byId = new Map<string, any>(app().shapes.map((s: any) => [s.id, s]));
    const v = volume(allFeatures().filter(e => !e.f.off).map(e => evalFeat(e.f, byId)));
    $<HTMLElement>("body-info").textContent = !viewer.ok ? t("v3d.noGl")
      : b ? t("body.info", { w: (b.x1 - b.x0).toFixed(1), d: (b.y1 - b.y0).toFixed(1), h: (b.z1 - b.z0).toFixed(1), v: (v / 1000).toFixed(1) }) : t("body.empty");
    $<HTMLButtonElement>("body-stl").disabled = !shells.length;
    $<HTMLButtonElement>("body-mill").disabled = !shells.length || !isMill();
    redraw();
  };

  const list = () => {
    const box = $<HTMLElement>("body-list");
    box.textContent = "";
    const byId = new Map<string, any>(app().shapes.map((s: any) => [s.id, s]));
    allFeatures().forEach((e, i) => {
      const f = e.f, ev = evalFeat(f, byId);
      const row = document.createElement("div");
      row.className = "dlg-row";
      row.style.cssText = "flex-wrap:wrap;gap:6px;padding:6px;border:1px solid var(--border-color);border-radius:8px;";
      row.innerHTML = `
        <label style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
          <input type="checkbox" class="b-on" title="${t("body.onTip")}"> <b>${i + 1}.</b>
          <select class="b-op" style="width:auto;min-width:130px;"><option value="join">${t("body.op.join")}</option><option value="cut">${t("body.op.cut")}</option></select>
        </label>
        <button class="b-del btn-secondary" title="${t("body.delete")}" style="padding:2px 8px;margin-left:auto;">✕</button>
        <span style="display:flex;gap:10px;flex-basis:100%;">
          <span class="dlg-num">${t("body.from")} <input class="b-z0" type="number" step="0.5" style="width:70px;"><em style="width:auto;">mm</em></span>
          <span class="dlg-num">${t("body.h")} <input class="b-h" type="number" step="0.5" style="width:70px;"><em style="width:auto;">mm</em></span>
        </span>
        <span class="dlg-hint" style="flex-basis:100%;margin:0;">${t("body.profile", { n: f.profile.length - ev.missing })}${ev.missing ? " · ⚠ " + t("body.missing", { n: ev.missing }) : ""}${!ev.region.length ? " · ⚠ " + t("body.noArea") : ""}</span>`;
      const q = <E extends HTMLElement>(c: string) => row.querySelector("." + c) as E;
      q<HTMLInputElement>("b-on").checked = !f.off;
      q<HTMLSelectElement>("b-op").value = f.op;
      q<HTMLInputElement>("b-z0").value = num(f.z0);
      q<HTMLInputElement>("b-h").value = num(f.h);
      q<HTMLInputElement>("b-on").onchange = () => { f.off = !q<HTMLInputElement>("b-on").checked || undefined; if (!f.off) delete f.off; rebuild(); };
      q<HTMLSelectElement>("b-op").onchange = () => { f.op = q<HTMLSelectElement>("b-op").value as FeatOp; rebuild(); };
      const numIn = (c: string, key: "z0" | "h") => q<HTMLInputElement>(c).addEventListener("input", () => {
        const v = parseFloat(q<HTMLInputElement>(c).value.replace(",", "."));
        if (Number.isFinite(v) && (key !== "h" || v !== 0)) { f[key] = v; rebuild(); }
      });
      numIn("b-z0", "z0"); numIn("b-h", "h");
      q<HTMLButtonElement>("b-del").onclick = () => {
        e.owner.feat3d = (e.owner.feat3d as Feature[]).filter(x => x !== f);
        if (!e.owner.feat3d.length) delete e.owner.feat3d;
        releaseSketch();
        checkpoint();
        list(); rebuild();
      };
      box.appendChild(row);
    });
  };

  $<HTMLButtonElement>("body-add").disabled = !selectedShapes().some(isClosedShape);
  $<HTMLButtonElement>("body-add").onclick = () => { if (addFromSelection(log)) { checkpoint(); list(); rebuild(); } };
  list();
  rebuild();

  const close = () => { viewer.destroy(); ov.remove(); checkpoint(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("body-close").onclick = close;
  $<HTMLElement>("body-mill").onclick = () => { if (makeMillShapes(log)) { checkpoint(); redraw(); } };
  $<HTMLElement>("body-stl").onclick = async () => {
    if (!shells.length) return;
    try {
      const p = await save({ title: t("body.saveTitle"), defaultPath: "cnc-craft-body.stl", filters: [{ name: "STL", extensions: ["stl"] }] });
      if (!p) return;
      const data = stlBinary(shells);
      await writeFile(String(p), data);
      log(t("stl.saved", { n: (data.length - 84) / 50, p: String(p) }));
    } catch (e) {
      log(`${t("log.error")} ${e}`);
    }
  };
}

/** Neuer Schritt aus der Auswahl: erster = Aufbauen in Materialdicke, sonst Ausschneiden 5 mm ab Oberkante */
function addFromSelection(log: (s: string) => void): boolean {
  const sel = selectedShapes().filter(isClosedShape);
  if (!sel.length) { log(t("body.selectClosed")); return false; }
  const all = allFeatures();
  const byId = new Map<string, any>(app().shapes.map((s: any) => [s.id, s]));
  const top = topOf(all.filter(e => !e.f.off).map(e => evalFeat(e.f, byId)));
  const thick = Number(getStock().thick) > 0 ? Number(getStock().thick) : 10;
  const op: FeatOp = all.length && top > 0 ? "cut" : "join";
  const f: Feature = {
    id: "f-" + newId(), seq: (all.length ? Math.max(...all.map(e => e.f.seq)) : 0) + 1, op,
    z0: op === "join" ? 0 : top, h: op === "join" ? thick : -Math.min(5, top), profile: sel.map(s => s.id)
  };
  const owner = sel[0];
  owner.feat3d = [...(owner.feat3d || []), f];
  log(t(op === "join" ? "body.addedJoin" : "body.addedCut", { n: sel.length }));
  return true;
}

/** Formen, die zu keinem Schritt mehr gehören, werden wieder normal gefräst */
function releaseSketch() {
  const used = new Set(allFeatures().flatMap(e => e.f.profile));
  for (const s of app().shapes) if (s.noMill && !used.has(s.id)) delete s.noMill;
}

/**
 * Fräsformen aus dem Körper erzeugen (Rechnung: millPlan in body3d.ts). Die Oberkante des Körpers liegt auf Z 0
 * (Material-Oberseite), Tiefen negativ wie bei jeder Form. Vorher erzeugte Fräsformen (from3d) werden ersetzt,
 * die Skizzen-Formen werden „nicht fräsen“ (noMill, grau gestrichelt). Erhebungen über der Grundplatte gehen noch
 * nicht – dann wird lieber nichts erzeugt als falsche Tiefen.
 */
function makeMillShapes(log: (s: string) => void): boolean {
  const st = app();
  const entries = allFeatures().filter(e => !e.f.off);
  const byId = new Map<string, any>(st.shapes.map((s: any) => [s.id, s]));
  const plan = millPlan(entries.map(e => evalFeat(e.f, byId)));
  if (!plan.ops.length) { log(t("body.millNone")); return false; }
  if (plan.raised) { log(t("body.millRaised", { n: plan.raised })); return false; }
  const gid = "grp-3d-" + newId();
  const made = plan.ops.map(o => createPolyline(o.ring.map(([x, y]) => ({ x: x * MM_TO_PIXEL, y: y * MM_TO_PIXEL })), true, o.mode,
    { groupId: gid, millingDepth: -+o.depth.toFixed(4), from3d: true }));
  const sketch = new Set(entries.flatMap(e => e.f.profile));
  st.shapes = [...st.shapes.filter((s: any) => !s.from3d), ...made];
  for (const s of st.shapes) if (sketch.has(s.id)) s.noMill = true;
  st.selectedShapeIds = made.map(s => s.id);
  const thick = Number(getStock().thick) || 0;
  log(t("body.millDone", { n: made.length, h: +plan.height.toFixed(2) }));
  if (thick > 0 && Math.abs(thick - plan.height) > 0.01) log(t("body.millThick", { h: +plan.height.toFixed(2), t: thick }));
  if (plan.inner) log(t("body.millInner", { n: plan.inner }));
  return true;
}
