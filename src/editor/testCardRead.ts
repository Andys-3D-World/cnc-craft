/**
 * LASER-TESTKARTE ABLESEN – nach dem Lasern: bestes Feld anklicken, Werte als eigene Vorlage speichern,
 * Schnittbreite und Versatz hin/zurück in die Einstellungen übernehmen (mit Rückfrage).
 * Alles kommt aus den Formen der Karte (readCells), nie aus einer Tabelle. Rechnung: testCard.ts.
 */
import { app } from "./editorState";
import { readGen } from "./genRun";
import { addOwnPreset } from "../ownPresets";
import { setLaserSettings } from "../laserLayers";
import { formatScanText } from "../scanOffset";
import { t } from "../i18n/i18n";
import { presetFromCell, presetName, readCells, withKerf, type ReadCell } from "../testCard";

export const CARD_TYPE = "testCard";

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Kurze Hilfe, gleich im Generator und beim Ablesen */
export function helpHtml(): string {
  return `<ul class="tc-help-list">${[1, 2, 3, 4, 5, 6].map(i => `<li>${esc(t("tcard.help." + i))}</li>`).join("")}</ul>`;
}

/** Die zuletzt erstellte Karte auf diesem Bett */
export function latestCardOnBed(): { shapes: any[]; settings: Record<string, any> } | null {
  const all = app().shapes;
  for (let i = all.length - 1; i >= 0; i--) {
    const g = readGen(all[i]);
    if (g?.type === CARD_TYPE) return { shapes: all.filter((s: any) => s.gen?.id === g.id), settings: g.s };
  }
  return null;
}

/** Gemessene Schnittbreite gilt auch für die Generatoren, die eine Schnittbreite fragen */
function kerfIntoGenerators(k: number) {
  const list: [string, string[]][] = [["cnc_craft_box", []], ["cnc_craft_divider", []], ["cnc_craft_birdhouse", ["nest", "ornament"]]];
  for (const [key, nested] of list) {
    try { localStorage.setItem(key, withKerf(localStorage.getItem(key), k, nested)); } catch { /* egal */ }
  }
}

/** Tabelle zum Anklicken. Bei perRow gilt je Zeile eine eigene Auswahl */
function pickTable(cells: ReadCell[], text: (c: ReadCell) => string, rowHead: (c: ReadCell) => string, tint: (c: ReadCell) => number, onPick: () => void, perRow = false) {
  const sel = new Map<number, ReadCell>();
  const wrap = document.createElement("div");
  wrap.className = "tc-table";
  const rows = [...new Set(cells.map(c => c.r))];
  wrap.innerHTML = rows.map(r => {
    const inRow = cells.filter(c => c.r === r);
    const head = rowHead(inRow[0]);
    return `<div class="tc-row">${head ? `<span class="tc-head">${esc(head)}</span>` : ""}${inRow.map(c =>
      `<button type="button" class="tc-cell" data-r="${c.r}" data-c="${c.c}" style="--a:${tint(c).toFixed(2)}">${esc(text(c))}</button>`).join("")}</div>`;
  }).join("");
  wrap.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest(".tc-cell") as HTMLElement | null;
    if (!b) return;
    const r = Number(b.dataset.r), c = Number(b.dataset.c);
    const cell = cells.find(x => x.r === r && x.c === c);
    if (!cell) return;
    const key = perRow ? r : 0;
    const same = sel.get(key) === cell;
    wrap.querySelectorAll<HTMLElement>(".tc-cell").forEach(el => { if (!perRow || Number(el.dataset.r) === r) el.classList.remove("on"); });
    if (same) sel.delete(key); else { sel.set(key, cell); b.classList.add("on"); }
    onPick();
  });
  return { el: wrap, picked: () => [...sel.values()] };
}

export function openTestCardRead(shapes: any[], settings: Record<string, any>, log: (s: string) => void) {
  document.getElementById("tc-read-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "tc-read-overlay";
  ov.className = "dlg-overlay";
  const material = typeof settings.material === "string" ? settings.material.slice(0, 60) : "";
  const thickness = Number.isFinite(settings.thickness) ? Number(settings.thickness) : 0;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:680px;">
      <h3>🔍 ${esc(t("tcard.readTitle"))}</h3>
      <div class="dlg-hint">${esc(t("tcard.readDesc"))}</div>
      <label class="dlg-row"><span>${esc(t("tcard.material"))}</span><input id="tcr-material" type="text" maxlength="60" value="${esc(material)}" style="width:200px;"></label>
      <label class="dlg-row"><span>${esc(t("tcard.thickness"))}</span><span class="dlg-num"><input id="tcr-thickness" type="number" step="0.5" min="0" value="${thickness}"><em>mm</em></span></label>
      <div id="tcr-body"></div>
      <details class="tc-help"><summary>${esc(t("tcard.helpTitle"))}</summary>${helpHtml()}</details>
      <div class="dlg-buttons"><button id="tcr-close" class="btn-primary">${esc(t("tcard.close"))}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const body = ov.querySelector("#tcr-body") as HTMLElement;
  const matInput = ov.querySelector("#tcr-material") as HTMLInputElement, thInput = ov.querySelector("#tcr-thickness") as HTMLInputElement;
  const th = () => { const v = parseFloat(thInput.value); return Number.isFinite(v) && v >= 0 ? v : 0; };

  const section = (titleKey: string) => {
    const s = document.createElement("div");
    s.className = "tc-read-sect";
    s.innerHTML = `<div class="tc-sect">${esc(t(titleKey))}</div>`;
    body.appendChild(s);
    return s;
  };
  const button = (host: HTMLElement, label: string) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn-secondary btn-compact"; b.textContent = label; b.disabled = true;
    host.appendChild(b);
    return b;
  };

  // ---- Raster: Leistung × Geschwindigkeit -> eigene Vorlage ----
  const gridSection = (panel: "engrave" | "cut", extra?: () => ReadCell | undefined, after?: (s: HTMLElement) => void) => {
    const cells = readCells(shapes, panel);
    if (!cells.length) return;
    const s = section("tcard.p." + panel);
    let save: HTMLButtonElement;
    const tb = pickTable(cells, c => `${c.power}`, c => `${c.speed}`, c => 0.1 + 0.8 * c.power / 100, () => { save.disabled = !tb.picked().length; save.textContent = "💾 " + t("tcard.saveBest"); });
    s.appendChild(tb.el);
    after?.(s);
    save = button(s, "💾 " + t("tcard.saveBest"));
    save.onclick = () => {
      const cell = tb.picked()[0];
      if (!cell) return;
      const name = presetName(matInput.value, th(), t("tcard.kind." + panel), cell);
      addOwnPreset("laser", name, presetFromCell(cell, panel, { material: matInput.value.trim(), thickness: th() }, name, t("tcard.presetNote"), extra?.()));
      log(t("tcard.saved", { name }));
      save.disabled = true; save.textContent = "✔ " + t("tcard.savedShort");
    };
  };
  // Linienabstand: nur als Zusatz zur Gravur-Vorlage
  let intervalPick: (() => ReadCell | undefined) | undefined;
  const iv = readCells(shapes, "interval");
  gridSection("engrave", () => intervalPick?.(), iv.length ? s => {
    const hint = document.createElement("div");
    hint.className = "dlg-hint";
    hint.textContent = t("tcard.pickInterval");
    s.appendChild(hint);
    const tb = pickTable(iv, c => `${c.v ?? c.interval}`, () => "", () => 0.45, () => { /* nur merken */ });
    s.appendChild(tb.el);
    intervalPick = () => tb.picked()[0];
  } : undefined);
  gridSection("cut");

  // ---- Schnittbreite ----
  const kerf = readCells(shapes, "kerf").filter(c => Number.isFinite(c.v));
  if (kerf.length) {
    const s = section("tcard.p.kerf");
    let use: HTMLButtonElement;
    const tb = pickTable(kerf, c => `${c.v}`, () => "", () => 0.3, () => { use.disabled = !tb.picked().length; });
    s.appendChild(tb.el);
    use = button(s, "✔ " + t("tcard.useKerf"));
    use.onclick = () => {
      const k = tb.picked()[0]?.v;
      if (k === undefined || !window.confirm(t("tcard.confirmKerf", { k }))) return;
      setLaserSettings({ kerf: k });
      kerfIntoGenerators(k);
      log(t("tcard.kerfSaved", { k }));
      use.disabled = true;
    };
  }

  // ---- Versatz hin/zurück: je Geschwindigkeit ein Wert ----
  const scan = readCells(shapes, "scan").filter(c => Number.isFinite(c.scanMm));
  if (scan.length) {
    const s = section("tcard.p.scan");
    let use: HTMLButtonElement;
    const tb = pickTable(scan, c => `${c.scanMm}`, c => `${c.speed}`, () => 0.3, () => { use.disabled = !tb.picked().length; }, true);
    s.appendChild(tb.el);
    use = button(s, "✔ " + t("tcard.useScan"));
    use.onclick = () => {
      const points = tb.picked().map(c => ({ speed: c.speed, mm: c.scanMm! }));
      if (!points.length || !window.confirm(t("tcard.confirmScan", { list: formatScanText(points) }))) return;
      setLaserSettings({ scanOffsets: points });
      log(t("tcard.scanSaved", { list: formatScanText(points) }));
      use.disabled = true;
    };
  }
  if (!body.children.length) body.innerHTML = `<div class="dlg-hint">${esc(t("tcard.nothing"))}</div>`;

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  (ov.querySelector("#tcr-close") as HTMLElement).onclick = close;
}
