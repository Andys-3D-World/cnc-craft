/**
 * SERIENNUMMERN UND VARIABLER TEXT (Extras → Seriennummern / CSV)
 *
 * Die Auswahl ist die Vorlage. Texte (textData) und QR-Codes (qrData) dürfen Platzhalter enthalten:
 *   {n}            fortlaufende Nummer (Start, Schritt, Stellen mit führenden Nullen)
 *   {Spaltenname}  Wert aus einer CSV-Datei (erste Zeile = Spaltennamen), {1}, {2} … = Spalte 1, 2 …
 * Daraus entstehen Kopien im Raster (nach rechts, dann nach oben); jede Kopie bekommt ihre eigenen Werte. Die Vorlage wird zur 1. Kopie.
 * Andere Formen der Auswahl (Rahmen, Löcher …) werden einfach mitkopiert.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { app } from "./editorState";
import { cloneShape, groupBounds, newId, translateShape, MM_TO_PIXEL } from "../shapeTransform";
import { selectedShapes } from "./selection";
import { traceTextWithFont, textShapes, TextParams } from "./textTool";
import { qrShapes, QrData } from "./qrTool";
import { t } from "../i18n/i18n";

const KEY = "cnc_craft_serial";
const MAX_COPIES = 500;
const KEEP = ["laserLayerId", "toolId", "plasmaCutId", "millingDepth"];

interface SerialOptions { start: number; step: number; digits: number; count: number; cols: number; gap: number; }
const DEF: SerialOptions = { start: 1, step: 1, digits: 3, count: 10, cols: 5, gap: 5 };

export interface Csv { header: string[]; rows: string[][] }

/** CSV lesen: Trennzeichen ; , oder Tab (automatisch), Anführungszeichen wie in Excel/LibreOffice */
export function parseCsv(text: string): Csv {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/)[0] || "";
  const count = (c: string) => first.split(c).length;
  const sep = [";", ",", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(x => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim())) rows.push(row);
  const header = (rows.shift() || []).map(h => h.trim());
  return { header, rows };
}

/** Platzhalter ersetzen; unbekannte bleiben stehen */
export function fillIn(text: string, vars: Record<string, string>): string {
  return text.replace(/\{([^{}\n]{1,40})\}/g, (m, k) => {
    const key = String(k).trim();
    if (key in vars) return vars[key];
    const low = key.toLowerCase();
    const hit = Object.keys(vars).find(v => v.toLowerCase() === low);
    return hit !== undefined ? vars[hit] : m;
  });
}

function varsFor(i: number, o: SerialOptions, csv: Csv | null): Record<string, string> {
  const num = o.start + i * o.step;
  const v: Record<string, string> = { n: (num < 0 ? "-" : "") + String(Math.abs(num)).padStart(o.digits, "0") };
  if (csv) {
    const r = csv.rows[i] || [];
    csv.header.forEach((h, j) => { if (h) v[h] = (r[j] ?? "").trim(); });
    r.forEach((x, j) => { v[String(j + 1)] = x.trim(); });
  }
  return v;
}

/** Vorlage zerlegen: Texte und QR-Codes (je Gruppe + Inhalt) und übrige Formen */
function units(sel: any[]) {
  const texts = new Map<string, any[]>(), qrs = new Map<string, any[]>(), others: any[] = [];
  for (const s of sel) {
    if (s.textData) { const k = (s.groupId || s.id) + JSON.stringify(s.textData); if (!texts.has(k)) texts.set(k, []); texts.get(k)!.push(s); }
    else if (s.qrData) { const k = (s.groupId || s.id) + JSON.stringify(s.qrData); if (!qrs.has(k)) qrs.set(k, []); qrs.get(k)!.push(s); }
    else others.push(s);
  }
  return { texts: [...texts.values()], qrs: [...qrs.values()], others };
}

function keepProps(s: any): Record<string, any> {
  const r: Record<string, any> = {};
  for (const k of KEEP) if (s[k] !== undefined) r[k] = s[k];
  return r;
}

async function makeCopies(sel: any[], o: SerialOptions, csv: Csv | null, n: number): Promise<any[]> {
  const u = units(sel);
  // erst alle Kopien an der Stelle der Vorlage bauen, dann nach der größten Kopie im Raster verteilen
  // (Werte aus der CSV können länger sein als die Platzhalter)
  const copies: any[][] = [];
  for (let i = 0; i < n; i++) {
    const vars = varsFor(i, o, csv);
    const gids = new Map<string, string>();
    const gid = (old: string | undefined) => {
      if (!old) return undefined;
      if (!gids.has(old)) gids.set(old, old.split("-")[0] + "-" + newId());
      return gids.get(old);
    };
    const made: any[] = [];
    for (const m of u.texts) {
      const tb = groupBounds(m)!;
      const p: TextParams = { ...m[0].textData, text: fillIn(m[0].textData.text, vars) };
      const res = await traceTextWithFont(p);
      if (!res.traced.loops.length) continue;
      made.push(...textShapes(p, res.traced, tb.minX, tb.minY, m[0].millingMode, { ...keepProps(m[0]), groupId: gid(m[0].groupId) }));
    }
    for (const m of u.qrs) {
      const qb = groupBounds(m)!;
      const d: QrData = { ...m[0].qrData, text: fillIn(m[0].qrData.text, vars) };
      const shapes = qrShapes(d, qb.minX, qb.minY, { ...keepProps(m[0]), groupId: gid(m[0].groupId) });
      if (!shapes) throw new Error(t("qr.tooLong"));
      made.push(...shapes);
    }
    for (const s of u.others) {
      const c = cloneShape(s);
      c.id = newId();
      if (c.groupId) c.groupId = gid(c.groupId);
      made.push(c);
    }
    copies.push(made);
  }
  let w = 0, h = 0;
  for (const c of copies) {
    const b = groupBounds(c);
    if (b) { w = Math.max(w, b.maxX - b.minX); h = Math.max(h, b.maxY - b.minY); }
  }
  const cw = w + o.gap * MM_TO_PIXEL, ch = h + o.gap * MM_TO_PIXEL;
  copies.forEach((c, i) => {
    const dx = (i % o.cols) * cw, dy = Math.floor(i / o.cols) * ch; // nach rechts, dann nach oben (Nullpunkt liegt unten links)
    if (dx || dy) c.forEach(s => translateShape(s, dx, dy));
  });
  return copies.flat();
}

function placeholdersOf(sel: any[]): string[] {
  const set = new Set<string>();
  for (const s of sel) {
    const txt = s.textData?.text ?? s.qrData?.text;
    if (typeof txt === "string") for (const m of txt.matchAll(/\{([^{}\n]{1,40})\}/g)) set.add(m[1].trim());
  }
  return [...set];
}

export function openSerialDialog(log: (s: string) => void, done: () => void) {
  const sel = selectedShapes();
  const ph = placeholdersOf(sel);
  if (!sel.length || !ph.length) { log(t("ser.needTemplate")); return; }
  let o: SerialOptions = { ...DEF };
  try { o = { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { /* Standard */ }
  let csv: Csv | null = null;

  document.getElementById("ser-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "ser-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step: string, unit = "", extra = "") => `
      <label class="dlg-row" ${extra}><span>${t(key)}</span>
        <span class="dlg-num"><input id="${id}" type="number" value="${v}" step="${step}"><em>${unit}</em></span></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:520px;">
      <h3>#️⃣ ${t("ser.title")}</h3>
      <div class="dlg-hint">${t("ser.desc")}</div>
      <div class="dlg-hint" id="ser-found"></div>
      ${num("ser-start", "ser.start", o.start, "1")}
      ${num("ser-step", "ser.step", o.step, "1")}
      ${num("ser-digits", "ser.digits", o.digits, "1")}
      ${num("ser-count", "ser.count", o.count, "1", "", 'id="ser-count-row"')}
      <div class="dlg-row"><span>${t("ser.csv")}</span>
        <span style="display:flex;gap:6px;align-items:center;"><span id="ser-csv-name" class="dlg-hint"></span>
        <button id="ser-csv" class="btn-secondary" type="button">📄 ${t("ser.csvLoad")}</button>
        <button id="ser-csv-clear" class="btn-secondary" type="button" hidden>✕</button></span></div>
      ${num("ser-cols", "ser.cols", o.cols, "1")}
      ${num("ser-gap", "ser.gap", o.gap, "0.5", "mm")}
      <div id="ser-preview" class="dlg-hint" style="font-family:monospace;white-space:pre-wrap;max-height:120px;overflow:auto;"></div>
      <div class="dlg-hint">${t("ser.hint")}</div>
      <div class="dlg-buttons">
        <button id="ser-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="ser-ok" class="btn-primary">✔ ${t("ser.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  // Platzhalter stammen aus Texten des Nutzers -> nur als textContent
  $<HTMLElement>("ser-found").textContent = t("ser.found", { list: ph.map(p => "{" + p + "}").join(" ") });

  const read = (): SerialOptions => {
    const n = (id: string, d: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
    return {
      start: Math.round(n("ser-start", 1)), step: Math.round(n("ser-step", 1)),
      digits: Math.max(0, Math.min(12, Math.round(n("ser-digits", 0)))),
      count: Math.max(1, Math.min(MAX_COPIES, Math.round(n("ser-count", 1)))),
      cols: Math.max(1, Math.min(100, Math.round(n("ser-cols", 1)))), gap: Math.max(0, n("ser-gap", 0))
    };
  };
  const total = () => (csv ? Math.min(MAX_COPIES, csv.rows.length) : read().count);
  const example = (txt: string, v: Record<string, string>) => fillIn(txt, v).replace(/\n/g, " ⏎ ");
  const preview = () => {
    const m = read();
    $<HTMLElement>("ser-count-row").style.display = csv ? "none" : "";
    const n = total();
    const txts = [...new Set(sel.map(s => s.textData?.text ?? s.qrData?.text).filter((x): x is string => typeof x === "string"))];
    const lines = [0, 1, n - 1].filter((i, k, a) => i >= 0 && i < n && a.indexOf(i) === k)
      .map(i => `${i + 1}: ${txts.map(x => example(x, varsFor(i, m, csv))).join("  |  ")}`);
    if (n > 3) lines.splice(2, 0, "…");
    const missing = csv ? ph.filter(p => p !== "n" && !csv!.header.some(h => h.toLowerCase() === p.toLowerCase()) && !/^\d+$/.test(p)) : [];
    $<HTMLElement>("ser-preview").textContent = t("ser.total", { n }) + "\n" + lines.join("\n")
      + (missing.length ? "\n⚠ " + t("ser.missing", { list: missing.join(", ") }) : "");
    $<HTMLButtonElement>("ser-ok").disabled = n < 1;
  };
  ov.querySelectorAll("input").forEach(i => i.addEventListener("input", preview));

  $<HTMLElement>("ser-csv").onclick = async () => {
    const pick = await open({ multiple: false, directory: false, title: t("ser.csvLoad"), filters: [{ name: "CSV", extensions: ["csv", "txt", "tsv"] }] });
    if (!pick) return;
    const path = typeof pick === "object" && pick !== null ? (pick as any).path : pick; // Pfad unverändert lesen
    try {
      const bytes = await readFile(path);
      csv = parseCsv(new TextDecoder("utf-8").decode(bytes));
      $<HTMLElement>("ser-csv-name").textContent = t("ser.csvInfo", { file: String(path).split(/[\\/]/).pop() || "", n: csv.rows.length, cols: csv.header.join(", ") });
      $<HTMLElement>("ser-csv-clear").hidden = false;
    } catch (e) {
      csv = null;
      $<HTMLElement>("ser-csv-name").textContent = t("ser.csvError", { e: String(e) });
    }
    preview();
  };
  $<HTMLElement>("ser-csv-clear").onclick = () => {
    csv = null;
    $<HTMLElement>("ser-csv-name").textContent = "";
    $<HTMLElement>("ser-csv-clear").hidden = true;
    preview();
  };
  // nur für Tests ohne Dateidialog (Vorschau im Browser)
  (ov as any).setCsv = (text: string) => { csv = parseCsv(text); preview(); };
  preview();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("ser-cancel").onclick = close;
  $<HTMLElement>("ser-ok").onclick = async () => {
    const m = read();
    try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* egal */ }
    const n = total();
    close();
    try {
      const made = await makeCopies(sel, m, csv, n);
      const st = app();
      const ids = new Set(sel.map(s => s.id));
      st.shapes = [...st.shapes.filter((s: any) => !ids.has(s.id)), ...made];
      st.selectedShapeIds = made.map(s => s.id);
      log(t("ser.done", { n }));
    } catch (e) {
      log(t("ser.error", { e: String((e as Error)?.message || e) }));
    }
    done();
  };
}
