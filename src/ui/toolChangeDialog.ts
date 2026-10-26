/**
 * WERKZEUGWECHSEL – Einstellungen (im Abschnitt „Antasten“) und das Ablauf-Fenster
 *
 * Das Fenster schwebt unten rechts und sperrt die Oberfläche NICHT: man kann währenddessen joggen
 * (z. B. Z bis knapp über die Tastplatte). Es zeigt den Zustand aus toolChange.ts (tc.state) und schickt
 * nur Antworten zurück (tcAnswer, tcAbort …) – den Ablauf selbst steuert toolChange.ts.
 */
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT } from "../machine";
import { probeSettings as s, saveProbe, ProbeSettings } from "../probe";
import { tc, TcState, onToolChange, tcAnswer, tcAbort, tcClose, tcManualPlate, tcManualResume, tcWaiting,
  measureReference, toolLabel, toolChangeBusy, initToolChange } from "../toolChange";

export { toolChangeBusy };

function esc(v: string): string {
  return v.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

export function toolChangeSettingsHtml(): string {
  const num = (id: string, key: string, step = "0.1", min = "") =>
    `<div class="prop-row" ${tip(key + "Tip")}>${T(key)}<input type="number" id="${id}" step="${step}" ${min ? `min="${min}"` : ""} class="prop-input"></div>`;
  return `
        <div class="pr-sub">${T("tc.title")}</div>
        <div class="prop-row" ${tip("tc.modeTip")}>${T("tc.mode")}<select id="tc-mode" class="prop-input" style="width:auto;">
          <option value="0">${T("tc.mode0")}</option><option value="1">${T("tc.mode1")}</option><option value="2">${T("tc.mode2")}</option></select></div>
        <div class="prop-row" ${tip("tc.liftTip")}>${T("tc.lift")}<select id="tc-lift" class="prop-input" style="width:auto;">
          <option value="3">${T("tc.lift3")}</option><option value="1">${T("tc.lift1")}</option><option value="0">${T("tc.lift0")}</option><option value="2">${T("tc.lift2")}</option></select></div>
        <div id="tc-workz-row">${num("tc-workz", "tc.workZ", "1", "0")}</div>
        <div id="tc-safe-row">${num("tc-safe", "tc.safe", "0.5")}</div>
        ${num("tc-feed", "tc.feed", "100", "100")}
        <div id="tc-auto">
          ${num("tc-travel", "tc.travel", "1", "1")}
          <div id="tc-sensor-only">${num("tc-sz", "tc.sz", "0.5")}</div>
          <div class="prop-row" ${tip("tc.posTip")}>${T("tc.pos")}<select id="tc-pos" class="prop-input" style="width:auto;">
            <option value="0">${T("tc.pos0")}</option><option value="1">${T("tc.pos1")}</option></select></div>
          <div id="tc-pos-box">
            <div class="rp-grid2">${num("tc-x", "tc.x")}${num("tc-y", "tc.y")}</div>
            <button id="tc-here" class="btn-secondary btn-compact" ${tip("tc.hereTip")}>📍 ${T("tc.here")}</button>
          </div>
          <div class="tool-scope" id="tc-reuse"></div>
          <div id="tc-ref-box">
            <div class="tool-scope" id="tc-ref"></div>
            <button id="tc-ref-go" class="btn-secondary btn-compact" ${tip("tc.refGoTip")}>📏 ${T("tc.refGo")}</button>
          </div>
        </div>
        <label class="prop-row" style="cursor:pointer;" ${tip("tc.m6Tip")}>${T("tc.m6")}<input type="checkbox" id="tc-m6" style="width:auto;"></label>`;
}

export function initToolChangeSettings(log: (s: string) => void) {
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as E | null;
  initToolChange(log);
  const fields: [string, keyof ProbeSettings][] = [
    ["tc-safe", "tcSafe"], ["tc-workz", "tcWorkZ"], ["tc-travel", "tcTravel"], ["tc-sz", "tcSz"], ["tc-x", "tcX"], ["tc-y", "tcY"], ["tc-feed", "tcFeed"]
  ];
  const show = () => {
    fields.forEach(([id, k]) => { const el = $(id); if (el) el.value = String(s[k]); });
    const mode = $<HTMLSelectElement>("tc-mode"), pos = $<HTMLSelectElement>("tc-pos"), m6 = $("tc-m6");
    if (mode) mode.value = String(s.tcMode);
    if (pos) pos.value = String(s.tcPos);
    const lift = $<HTMLSelectElement>("tc-lift");
    if (lift) lift.value = String(s.tcLift);
    if (m6) m6.checked = !!s.tcM6;
    const vis = (id: string, on: boolean) => { const el = $(id); if (el) el.style.display = on ? "" : "none"; };
    vis("tc-auto", s.tcMode !== 0);
    // „ganz nach oben“ braucht die Höhe nur als Ersatz (ohne Referenzfahrt); „nicht anheben“ gilt nur von Hand
    vis("tc-safe-row", s.tcLift === 0 || (s.tcLift === 2 && s.tcMode !== 0));
    vis("tc-workz-row", s.tcLift === 1 || s.tcLift === 3);
    vis("tc-sensor-only", s.tcMode === 1);
    vis("tc-ref-box", s.tcMode === 1);
    vis("tc-pos-box", s.tcPos === 1);
    const reuse = $("tc-reuse");
    if (reuse) reuse.textContent = s.tcMode === 1
      ? t("tc.reuseSensor", { x: s.sx, y: s.sy, f: s.fast, sl: s.slow })
      : t("tc.reusePlate", { d: s.plate, f: s.fast, sl: s.slow });
    const ref = $("tc-ref");
    if (ref) ref.textContent = tc.ref === null ? t("tc.refNone") : t("tc.refSet", { z: tc.ref.toFixed(3) });
    const go = $<HTMLButtonElement>("tc-ref-go");
    if (go) go.disabled = !machine.connected || machine.protocol !== "grbl" || machine.job.active || toolChangeBusy();
  };
  fields.forEach(([id, k]) => $(id)?.addEventListener("change", () => {
    const v = parseFloat(($(id) as HTMLInputElement).value);
    if (Number.isFinite(v)) {
      s[k] = k === "tcWorkZ" ? Math.min(500, Math.max(0, v)) : k === "tcTravel" ? Math.min(300, Math.max(1, v)) : k === "tcFeed" ? Math.min(10000, Math.max(100, v)) : v;
      saveProbe();
    }
    show();
  }));
  $<HTMLSelectElement>("tc-mode")?.addEventListener("change", e => { s.tcMode = +(e.target as HTMLSelectElement).value; saveProbe(); show(); });
  $<HTMLSelectElement>("tc-lift")?.addEventListener("change", e => { s.tcLift = +(e.target as HTMLSelectElement).value; saveProbe(); show(); });
  $<HTMLSelectElement>("tc-pos")?.addEventListener("change", e => { s.tcPos = +(e.target as HTMLSelectElement).value; saveProbe(); show(); });
  $("tc-m6")?.addEventListener("change", e => { s.tcM6 = (e.target as HTMLInputElement).checked ? 1 : 0; saveProbe(); });
  $("tc-here")?.addEventListener("click", () => {
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    s.tcX = +machine.status.mpos[0].toFixed(3); s.tcY = +machine.status.mpos[1].toFixed(3);
    saveProbe(); show();
    log(t("tc.hereDone", { x: s.tcX, y: s.tcY }));
  });
  $("tc-ref-go")?.addEventListener("click", () => { measureReference(); });
  // Sensor-Platz/Platte stehen weiter oben im Abschnitt – Hinweis aktuell halten
  ["pr-sx", "pr-sy", "pr-plate", "pr-fast", "pr-slow"].forEach(id => $(id)?.addEventListener("change", show));
  onToolChange(() => { show(); render(); });
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type } = (e as CustomEvent).detail || {};
    if (type === "status") live();
    if (type === "connected" || type === "disconnected" || type === "job-progress" || type === "job-done" || type === "switched") show();
  });
  window.addEventListener("cnc-language-changed", () => { show(); render(); });
  show();
}

// ---------------------------------------------------------------------
// Ablauf-Fenster
// ---------------------------------------------------------------------

const BUSY = [TcState.Parking, TcState.MeasureRef, TcState.Travel, TcState.Probing, TcState.Returning];

function render() {
  let box = document.getElementById("tc-float");
  if (tc.state === TcState.Idle) { box?.remove(); return; }
  if (!box) {
    box = document.createElement("div");
    box.id = "tc-float";
    box.className = "dlg-box tc-float";
    box.setAttribute("role", "dialog");
    document.body.appendChild(box);
  }
  const st = tc.state;
  const params = {
    travel: s.tcTravel, plate: s.plate, x: s.tcPos ? s.tcX : "-", y: s.tcPos ? s.tcY : "-",
    d: tc.delta !== null ? tc.delta.toFixed(3) : "-", z: tc.zSet !== null ? tc.zSet.toFixed(2) : "-", s: tc.spindle
  };
  const btn = (id: string, label: string, cls = "btn-secondary") => `<button id="${id}" class="${cls}">${label}</button>`;
  const stop = btn("tc-b-stop", "⏹ " + t("tc.b.stop"), "btn-secondary dlg-danger");
  let buttons = "";
  switch (st) {
    case TcState.Manual:
      buttons = (machine.protocol === "grbl" ? btn("tc-b-plate", "⊥ " + t("tc.b.plateNow")) : "") + btn("tc-b-mresume", "▶ " + t("tc.b.resume"), "btn-primary") + stop; break;
    case TcState.WaitSwap: buttons = btn("tc-b-go", "📏 " + t("tc.b.measure"), "btn-primary") + btn("tc-b-skip", t("tc.b.skip")) + stop; break;
    case TcState.WaitPlate: buttons = btn("tc-b-go", "⊥ " + t("tc.b.probe"), "btn-primary") + btn("tc-b-skip", t("tc.b.skip")) + stop; break;
    case TcState.Failed: buttons = btn("tc-b-go", "↻ " + t("tc.b.retry"), "btn-primary") + btn("tc-b-skip", t("tc.b.skip")) + stop; break;
    case TcState.WaitRemovePlate: buttons = btn("tc-b-go", "✓ " + t("tc.b.removed"), "btn-primary") + stop; break;
    case TcState.WaitResume: buttons = btn("tc-b-go", "▶ " + t("tc.b.resume"), "btn-primary") + stop; break;
    case TcState.Aborted: buttons = btn("tc-b-close", t("tc.b.close")); break;
    default: buttons = stop;
  }
  const extra = st === TcState.WaitResume
    ? (tc.delta !== null ? `<div class="tc-result">${esc(t("tc.resDelta", params))}</div>` : tc.zSet !== null ? `<div class="tc-result">${esc(t("tc.resPlate", params))}</div>` : "")
      + (tc.spindle ? `<div class="dlg-hint">${esc(t("tc.resSpindle", params))}</div>` : "")
    : "";
  box.innerHTML = `
    <h3>🔧 ${esc(t("tc.dlgTitle"))}</h3>
    <div class="tc-tool">${esc(toolLabel())}</div>
    <div class="tc-step${BUSY.includes(st) ? " tc-busy" : ""}">${esc(t("tc.st." + st, params))}</div>
    ${tc.msg ? `<div class="tc-msg">⚠ ${esc(tc.msg)}</div>` : ""}
    ${extra}
    ${st === TcState.WaitPlate || st === TcState.WaitSwap || st === TcState.Failed ? `<div class="pr-live" id="tc-live"></div>` : ""}
    <div class="dlg-buttons tc-buttons">${buttons}</div>`;
  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener("click", fn);
  on("tc-b-go", () => { if (tcWaiting()) tcAnswer("go"); });
  on("tc-b-skip", () => { if (tcWaiting() && window.confirm(t("tc.skipConfirm"))) tcAnswer("skip"); });
  on("tc-b-stop", () => { if (window.confirm(t("tc.stopConfirm"))) tcAbort(t("tc.why.user"), true); });
  on("tc-b-close", () => tcClose());
  on("tc-b-plate", () => tcManualPlate());
  on("tc-b-mresume", () => { if (window.confirm(t("tc.manualConfirm"))) tcManualResume(); });
  liveShown = "";
  live();
}

/** Taster live im Fenster (ob die Klemme Kontakt hat) */
let liveShown = "";
function live() {
  const el = document.getElementById("tc-live");
  if (!el) return;
  const st = (machine.status.pins || "").includes("P") ? "on" : "open";
  if (st === liveShown) return;
  liveShown = st;
  el.className = "pr-live pr-live-" + st;
  el.textContent = st === "on" ? "● " + t("pr.liveOn") : "○ " + t("pr.liveOpen");
}
