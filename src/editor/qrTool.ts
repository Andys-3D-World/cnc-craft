/**
 * QR-CODE EINFÜGEN (Extras → QR-Code)
 *
 * Der Code wird als geschlossene Umrisse eingefügt (Gruppe, shape.qrData merkt sich Text, Größe und
 * Fehlerkorrektur). Doppelklick auf den Code öffnet ihn wieder. Platzhalter wie {n} im Text werden
 * erst bei „Seriennummern“ (serial.ts) ersetzt.
 */
import { polishGenDialog } from "../ui/genDialog";
import { icon } from "../ui/icons";
import { matchDefaults } from "./genRun";
import { app } from "./editorState";
import { createPolyline, groupBounds, newId, MM_TO_PIXEL } from "../shapeTransform";
import { encodeQr, qrOutlines, QrEcc } from "./qrcode";
import { code128, ean13, type Bars } from "./barcode";
import { t } from "../i18n/i18n";
import { checkImport, importInApp } from "../importers/importRust";

export type CodeKind = "qr" | "code128" | "ean13";
const KINDS: CodeKind[] = ["qr", "code128", "ean13"];
/** size = Kantenlänge (QR) oder Breite (Strichcode) in mm, height nur Strichcode */
export interface QrData { text: string; size: number; ecc: QrEcc; kind: CodeKind; height: number }

const barsOf = (d: QrData): Bars | null => (d.kind === "ean13" ? ean13(d.text) : code128(d.text));

const KEY = "cnc_craft_qr";
const DEF: QrData = { text: "https://github.com/Andys-3D-World/cnc-craft", size: 30, ecc: "M", kind: "qr", height: 15 };

/** Werte können aus einer fremden Projektdatei stammen */
function clean(raw: any): QrData {
  const o: QrData = { ...DEF, ...matchDefaults(DEF, raw) };
  if (!(["L", "M", "Q", "H"] as QrEcc[]).includes(o.ecc)) o.ecc = DEF.ecc;
  if (!KINDS.includes(o.kind)) o.kind = "qr";
  return o;
}

function load(): QrData {
  try { return clean(JSON.parse(localStorage.getItem(KEY) || "{}")); } catch { return { ...DEF }; }
}

/** Formen des QR-Codes, linke untere Ecke bei (x0, y0) in Welt-Pixeln. null = Text zu lang. */
export function qrShapes(d: QrData, x0: number, y0: number, extra: Record<string, any> = {}): any[] | null {
  const groupId = extra.groupId || "qr-" + newId();
  if (d.kind === "code128" || d.kind === "ean13") {
    const b = barsOf(d);
    if (!b) return null;
    const m = (d.size / b.width) * MM_TO_PIXEL, h = Math.max(1, d.height || DEF.height) * MM_TO_PIXEL;
    return b.bars.map(k => createPolyline(
      [[k.x, 0], [k.x + k.w, 0], [k.x + k.w, 1], [k.x, 1]].map(([x, y]) => ({ x: x0 + x * m, y: y0 + y * h })), true, "on-line",
      { ...extra, groupId, qrData: { ...d }, source: "Barcode" }
    ));
  }
  const qr = encodeQr(d.text, d.ecc);
  const loops = qr ? qrOutlines(qr.modules) : null;
  // the same in Rust (qrencode.rs), in the background; what is inserted stays the TypeScript result
  if (importInApp()) checkImport("qr_encode", { text: d.text, ecc: d.ecc }, qr ? { ...qr, outlines: loops } : null);
  if (!qr || !loops) return null;
  const mod = (d.size / qr.size) * MM_TO_PIXEL;
  return loops.map(loop => createPolyline(
    loop.map(q => ({ x: x0 + q.x * mod, y: y0 + (qr.size - q.y) * mod })), true, "on-line",
    { ...extra, groupId, qrData: { ...d }, source: "QR" }
  ));
}

export function openQrDialog(log: (s: string) => void, done: () => void, edit?: any) {
  const st = app();
  const members = edit ? st.shapes.filter((s: any) => s.groupId && s.groupId === edit.groupId && s.qrData) : [];
  const init: QrData = edit?.qrData ? clean(edit.qrData) : load();
  document.getElementById("qr-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "qr-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:520px;">
      <h3>${icon("qrCode", 20)}${t("qr.title")}</h3>
      <div class="dlg-hint">${t("qr.desc")}</div>
      <textarea id="qr-text" rows="3" style="width:100%;box-sizing:border-box;"></textarea>
      <div class="box-grid">
        <div class="box-fields">
          <label class="dlg-row"><span>${t("qr.kind")}</span>
            <select id="qr-kind" style="width:auto;max-width:150px;">${KINDS.map(k => `<option value="${k}">${t("qr.kind." + k)}</option>`).join("")}</select></label>
          <label class="dlg-row" id="qr-height-row"><span>${t("qr.height")}</span>
            <span class="dlg-num"><input id="qr-height" type="number" min="3" step="1" value="${init.height}"><em>mm</em></span></label>
          <label class="dlg-row"><span id="qr-size-label">${t("qr.size")}</span>
            <span class="dlg-num"><input id="qr-size" type="number" min="5" step="1" value="${init.size}"><em>mm</em></span></label>
          <label class="dlg-row" id="qr-ecc-row"><span>${t("qr.ecc")}</span>
            <select id="qr-ecc" style="width:auto;max-width:150px;">
              ${(["L", "M", "Q", "H"] as QrEcc[]).map(e => `<option value="${e}">${t("qr.ecc." + e)}</option>`).join("")}
            </select></label>
          <div id="qr-info" class="dlg-hint"></div>
          <div id="qr-warn" class="dlg-hint" style="color:var(--lt-amber, #ffb454);"></div>
        </div>
        <div class="box-prev"><svg id="qr-svg" viewBox="0 0 10 10" style="background:#fff;"></svg></div>
      </div>
      <div class="dlg-hint" id="qr-hint">${t("qr.hint")}</div>
      <div class="dlg-buttons">
        <button id="qr-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="qr-ok" class="btn-primary">✔ ${t(edit ? "tool.save" : "dlg.insert")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  $<HTMLTextAreaElement>("qr-text").value = init.text; // per value, nicht innerHTML (fremder Text)
  $<HTMLSelectElement>("qr-ecc").value = init.ecc;
  $<HTMLSelectElement>("qr-kind").value = init.kind;

  const read = (): QrData => ({
    text: $<HTMLTextAreaElement>("qr-text").value,
    size: Math.max(5, parseFloat($("qr-size").value) || DEF.size),
    ecc: $<HTMLSelectElement>("qr-ecc").value as QrEcc,
    kind: $<HTMLSelectElement>("qr-kind").value as CodeKind,
    height: Math.max(3, parseFloat($("qr-height").value) || DEF.height)
  });
  const preview = () => {
    const d = read(), bar = d.kind !== "qr";
    const svg = $<HTMLElement>("qr-svg") as unknown as SVGSVGElement;
    $<HTMLElement>("qr-height-row").style.display = bar ? "" : "none";
    $<HTMLElement>("qr-ecc-row").style.display = bar ? "none" : "";
    $<HTMLElement>("qr-size-label").textContent = t(bar ? "qr.width" : "qr.size");
    $<HTMLElement>("qr-hint").textContent = t(bar ? "qr.barHint" : "qr.hint");
    if (bar) {
      const b = barsOf(d);
      $<HTMLButtonElement>("qr-ok").disabled = !b;
      const h = b ? (d.height / d.size) * b.width : 0;
      svg.setAttribute("viewBox", b ? `-10 -10 ${b.width + 20} ${h + 20}` : "0 0 10 10");
      svg.innerHTML = b ? `<path d="${b.bars.map(k => `M${k.x},0h${k.w}v${h.toFixed(2)}h${-k.w}z`).join("")}" fill="#000"/>` : "";
      const mm = b ? d.size / b.width : 0;
      $<HTMLElement>("qr-info").textContent = b ? t("qr.barInfo", { text: b.text, mm: mm.toFixed(2) }) : d.text ? t(d.kind === "ean13" ? "qr.eanBad" : "qr.c128Bad") : "";
      $<HTMLElement>("qr-warn").textContent = b && mm < 0.25 ? t("qr.barSmall") : "";
      return;
    }
    const qr = d.text ? encodeQr(d.text, d.ecc) : null;
    $<HTMLButtonElement>("qr-ok").disabled = !qr;
    if (!qr) {
      svg.innerHTML = "";
      $<HTMLElement>("qr-info").textContent = d.text ? t("qr.tooLong") : "";
      $<HTMLElement>("qr-warn").textContent = "";
      return;
    }
    svg.setAttribute("viewBox", `-4 -4 ${qr.size + 8} ${qr.size + 8}`);
    const path = qrOutlines(qr.modules).map(l => l.map((q, i) => `${i ? "L" : "M"}${q.x},${q.y}`).join("") + "Z").join("");
    svg.innerHTML = `<path d="${path}" fill="#000" fill-rule="evenodd"/>`;
    const mm = d.size / qr.size;
    $<HTMLElement>("qr-info").textContent = t("qr.info", { v: qr.version, n: qr.size, mm: mm.toFixed(2) });
    $<HTMLElement>("qr-warn").textContent = mm < 0.5 ? t("qr.small") : "";
  };
  ov.querySelectorAll("input, select, textarea").forEach(i => i.addEventListener("input", preview));
  preview();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("qr-cancel").onclick = close;
  $<HTMLElement>("qr-ok").onclick = () => {
    const d = read();
    const b = members.length ? groupBounds(members) : null;
    // Ebene/Werkzeug des alten Codes behalten
    const keep: Record<string, any> = {};
    if (members[0]) for (const k of ["laserLayerId", "toolId", "plasmaCutId", "millingDepth"]) if (members[0][k] !== undefined) keep[k] = members[0][k];
    const made = qrShapes(d, b ? b.minX : 10 * MM_TO_PIXEL, b ? b.minY : 10 * MM_TO_PIXEL, { ...keep, ...(members[0] ? { groupId: members[0].groupId } : {}) });
    if (!made) return;
    try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* egal */ }
    close();
    if (members.length) { const ids = new Set(members.map((m: any) => m.id)); st.shapes = st.shapes.filter((s: any) => !ids.has(s.id)); }
    st.shapes = [...st.shapes, ...made];
    st.selectedShapeIds = made.map(s => s.id);
    log(t(d.kind === "qr" ? "qr.done" : "qr.barDone", { n: made.length }));
    done();
  };
  setTimeout(() => { const ta = $<HTMLTextAreaElement>("qr-text"); ta.focus(); ta.select(); }, 0);
  polishGenDialog(edit ? "edit" : "new");
}
