/** DREHBANK rechts: Knopf zum Dreh-Fenster mit kurzer Übersicht (Reiter „Objekt“) und Nullpunkt setzen (Reiter „Maschine“) */
import { t } from "../i18n/i18n";
import { state } from "../main";
import { isLathe, MODE_CHANGED } from "../machineMode";
import { latheSettings, planFromDesign, issueTexts, saveLathe } from "../lathe/latheJob";
import { openLatheDialog } from "./latheDialog";
import { machine, canCommand, sendAndWait } from "../machine";
import { probeRunning } from "../probe";
import { streamState } from "../machineStream";

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const T = (k: string) => `<span data-i18n="${k}">${esc(t(k))}</span>`;
const tip = (k: string) => `data-i18n-tip="${k}" data-tip="${esc(t(k))}"`;

export function lathePanelHtml(): string {
  return `
    <div class="menu-section-unified only-lathe">
      <h3 class="menu-trigger">${T("lathe.title")}</h3>
      <div class="menu-body rp-box">
        <div class="tool-scope">${T("lathe.drawHint")}</div>
        <button id="lathe-open" class="btn-primary" ${tip("lathe.openTip")}>🔩 ${T("lathe.open")}</button>
        <button id="lathe-take" class="btn-secondary btn-compact" ${tip("lathe.takeTip")}>${T("lathe.take")}</button>
        <div id="lathe-info" class="tool-scope" style="white-space:pre-line;"></div>
      </div>
    </div>`;
}
export function latheZeroHtml(): string {
  return `
    <div class="menu-section-unified only-lathe">
      <h3 class="menu-trigger">${T("lathe.zero")}</h3>
      <div class="menu-body rp-box" data-unit-scope="none">
        <div class="tool-scope">${T("lathe.zeroHint")}</div>
        <div class="prop-row" ${tip("lathe.zeroXTip")}>${T("lathe.zeroX")}<span style="display:flex;gap:4px;"><input type="number" id="lathe-zx" step="0.01" min="0" class="prop-input"><button id="lathe-zx-set" class="btn-secondary btn-compact">X</button></span></div>
        <div class="prop-row" ${tip("lathe.zeroZTip")}>${T("lathe.zeroZ")}<span style="display:flex;gap:4px;"><input type="number" id="lathe-zz" step="0.01" value="0" class="prop-input"><button id="lathe-zz-set" class="btn-secondary btn-compact">Z</button></span></div>
      </div>
    </div>`;
}

export function initLathePanel(log: (s: string) => void, redraw: () => void) {
  const $ = (id: string) => document.getElementById(id) as any;
  const refresh = () => {
    const info = $("lathe-info");
    if (!info || !isLathe()) return;
    const s = latheSettings, own = state.shapes.filter((x: any) => s.profile.includes(x.id)).length;
    info.textContent = t("lathe.info", { d: s.job.stockD, n: s.job.ops.filter(o => o.on).length }) + "\n" + (own ? t("lathe.infoOwn", { n: own }) : t("lathe.infoAll"));
  };
  $("lathe-open")?.addEventListener("click", () => openLatheDialog(log, () => { refresh(); redraw(); }));
  $("lathe-take")?.addEventListener("click", () => {
    const ids = (state.selectedShapeIds as string[]).slice();
    latheSettings.profile = ids;
    saveLathe();
    const p = planFromDesign(state.shapes), m = issueTexts(p);
    log(ids.length ? t("lathe.taken", { n: ids.length, l: p.partLen.toFixed(1) }) : t("lathe.infoAll"));
    m.hard.slice(0, 2).forEach(x => log(`${t("log.warning")} ${x}`));
    refresh(); redraw();
  });
  // Nullpunkt: setzt nur den Wert der jetzigen Stelle, es fährt nichts
  const zero = async (axis: "X" | "Z") => {
    const v = parseFloat($(axis === "X" ? "lathe-zx" : "lathe-zz").value);
    if (!Number.isFinite(v) || (axis === "X" && !(v > 0))) { log(t("lathe.zeroBad")); return; }
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    if (probeRunning()) { log(t("pr.running")); return; }
    if (!canCommand() || (machine.job.active && !machine.job.paused) || (streamState.isRunning && !machine.job.paused) || /^(Run|Jog|Home|Alarm)/.test(machine.status.state || "")) { log(t("m.jogNotIdle", { s: esc(machine.status.state || "") })); return; }
    const o = latheSettings.out, val = axis === "X" ? (o.xMode === "dia" || o.xMode === "g7" ? v : v / 2) * o.xSign : v;
    const a = await sendAndWait(`G21 G10 L20 P0 ${axis}${val.toFixed(3)}`, 4000, true);
    log(a.ok ? t("lathe.zeroDone", { a: axis, v: val.toFixed(3) }) : t("lathe.zeroFailed"));
  };
  $("lathe-zx-set")?.addEventListener("click", () => zero("X"));
  $("lathe-zz-set")?.addEventListener("click", () => zero("Z"));
  window.addEventListener(MODE_CHANGED, refresh);
  window.addEventListener("cnc-lathe-changed", refresh);
  setInterval(() => { if (isLathe() && !document.hidden) refresh(); }, 1500);
  refresh();
}
