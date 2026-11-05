/**
 * KAMERA AM MASCHINENKOPF: Fadenkreuz, Offset messen, Nullpunkt setzen (Oberfläche – die Rechnung steht in cameraOffset.ts)
 *
 * Sicherheit:
 *   - Standard ist der Nullpunkt OHNE Fahrt (G10 L20 P0 mit −Offset). Mit Fahrt nur nach Bestätigung mit genauem Weg:
 *     erst Z hoch, dann X/Y als Jog; danach wird geprüft, ob der Kopf wirklich am Ziel steht. Sonst kein Nullpunkt.
 *   - Gesperrt bei Job, Alarm, Antasten, Werkzeugwechsel, Makro, nicht verbunden und außerhalb der GRBL-Familie.
 *   - Immer aktives System (P0), nie G92, nie Z.
 */
import { t } from "../i18n/i18n";
import { activeMachineId, machine, MACHINE_EVENT, realtime, RT, sendAndWait } from "../machine";
import { macroRunning } from "../macroRun";
import { freshStatus, probeRunning } from "../probe";
import { toolChangeBusy } from "../toolChange";
import { cam, saveCam, setStatus } from "./camera";
import {
  crosshairToPixel, drivePlan, hasArrived, measureIsPlausible, measureOffset, offsetProblem, parseOffsetValue, pixelToCrosshair,
  topZFromSettings, zeroAtCrosshairCommand, zeroBlockReason, type Offset
} from "./cameraOffset";

/** Sichere Höhe über dem Werkstück-Nullpunkt, wie bei „Zum Nullpunkt fahren“ */
const SAFE_Z = 5;
const DRIVE_FEED = 1500;

let log: (s: string) => void = () => {};
let adjusting = false;
let driving = false;
/** Assistent „Offset messen“: 1 = Marke machen, 2 = Fadenkreuz auf die Marke, 3 = Ergebnis */
let wiz: null | { step: 1 | 2 | 3; conn: string; port: string; mark: number[]; result: Offset | null } = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const mm = (v: number) => (v === 0 ? 0 : v).toFixed(3);
const signed = (v: number) => (v > 0 ? "+" : "") + mm(v);

function blockReason(): string {
  return zeroBlockReason({
    connected: machine.connected, protocol: machine.protocol, jobActive: machine.job.active, state: machine.status.state,
    otherBusy: driving || toolChangeBusy() || probeRunning() || macroRunning()
  });
}

function currentOffset(): Offset | null {
  return cam.offX === null || cam.offY === null ? null : { x: cam.offX, y: cam.offY };
}

// ---------------------------------------------------------------------
// Fadenkreuz
// ---------------------------------------------------------------------

export function crosshairHtml(): string {
  return `<div class="cam-xh" id="cam-xh" style="display:none;"><i class="cam-xh-h"></i><i class="cam-xh-v"></i><b></b></div>`;
}

/** Größe des angezeigten Bildes; null = gerade kein Bild */
function mediaSize(): { w: number; h: number } | null {
  const box = $("cam-view");
  const v = box?.querySelector("video");
  if (v && v.videoWidth) return { w: v.videoWidth, h: v.videoHeight };
  const i = box?.querySelector("img");
  if (i && i.naturalWidth) return { w: i.naturalWidth, h: i.naturalHeight };
  return null;
}

export function positionCrosshair() {
  const box = $("cam-view"), xh = $("cam-xh");
  if (!box || !xh) return;
  const size = mediaSize();
  if (!cam.xh || !size) { xh.style.display = "none"; return; }
  const p = crosshairToPixel(cam.xhX, cam.xhY, box.clientWidth, box.clientHeight, size.w, size.h, cam.rot180, cam.mirror);
  xh.style.display = "";
  xh.style.setProperty("--xh-x", p.x + "px");
  xh.style.setProperty("--xh-y", p.y + "px");
}

function setCentreFromPointer(e: PointerEvent) {
  const box = $("cam-view"), size = mediaSize();
  if (!box || !size) return;
  const r = box.getBoundingClientRect();
  const c = pixelToCrosshair(e.clientX - r.left, e.clientY - r.top, box.clientWidth, box.clientHeight, size.w, size.h, cam.rot180, cam.mirror);
  cam.xhX = c.x; cam.xhY = c.y;
  saveCam();
  positionCrosshair();
  // Der gemessene Offset gehört zur alten Mitte
  if (currentOffset()) setStatus(t("camz.remeasure"), true);
}

export function stopCrosshairAdjust() {
  adjusting = false;
  $("cam-view")?.classList.remove("cam-adjust");
  $("cam-xh-adj")?.classList.remove("active");
}

// ---------------------------------------------------------------------
// Bedienfeld im Kamerafenster
// ---------------------------------------------------------------------

export function zeroPanelHtml(): string {
  return `
    <div class="cam-xh-panel" id="cam-xh-panel" style="display:none;">
      <div class="cam-bar">
        <button id="cam-xh-adj" class="btn-secondary cam-tg" data-tip="${esc(t("camz.adjustTip"))}">⌖ ${esc(t("camz.adjust"))}</button>
        <button id="cam-xh-reset" class="btn-secondary" data-tip="${esc(t("camz.resetTip"))}">↺</button>
        <span class="cam-lbl not-ruida not-k40 not-marlin" data-tip="${esc(t("camz.offTip"))}">${esc(t("camz.offset"))} X</span>
        <input id="cam-off-x" class="cam-off not-ruida not-k40 not-marlin" type="text" inputmode="decimal" autocomplete="off" data-tip="${esc(t("camz.offTip"))}">
        <span class="cam-lbl not-ruida not-k40 not-marlin">Y</span>
        <input id="cam-off-y" class="cam-off not-ruida not-k40 not-marlin" type="text" inputmode="decimal" autocomplete="off" data-tip="${esc(t("camz.offTip"))}">
        <span class="cam-lbl not-ruida not-k40 not-marlin">mm</span>
      </div>
      <div class="cam-bar not-ruida not-k40 not-marlin">
        <button id="cam-off-measure" class="btn-secondary" data-tip="${esc(t("camz.measureTip"))}">📐 ${esc(t("camz.measure"))}</button>
        <button id="cam-zero-btn" class="btn-secondary" data-tip="${esc(t("camz.setTip"))}"></button>
      </div>
      <div class="cam-off-wiz not-ruida not-k40 not-marlin" id="cam-off-wiz" style="display:none;"></div>
      <div class="cam-status warn not-ruida not-k40 not-marlin" id="cam-zero-why"></div>
    </div>`;
}

/** Knöpfe verbinden (bei jedem Neuaufbau des Fensters) */
export function wireCameraZero() {
  const box = $("cam-view");
  if (!box) return;
  new ResizeObserver(() => positionCrosshair()).observe(box);

  box.addEventListener("pointerdown", (e) => {
    if (!adjusting) return;
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    setCentreFromPointer(e);
    const move = (ev: PointerEvent) => setCentreFromPointer(ev);
    const up = () => { box.removeEventListener("pointermove", move); box.removeEventListener("pointerup", up); box.removeEventListener("pointercancel", up); };
    box.addEventListener("pointermove", move); box.addEventListener("pointerup", up); box.addEventListener("pointercancel", up);
  });

  $("cam-xh-btn")!.onclick = () => {
    cam.xh = !cam.xh;
    if (!cam.xh) { stopCrosshairAdjust(); wiz = null; }
    saveCam();
    $("cam-xh-btn")?.classList.toggle("active", cam.xh);
    syncCameraZero();
    growWindowForPanel();
    positionCrosshair();
  };
  $("cam-xh-adj")!.onclick = () => {
    adjusting = !adjusting;
    box.classList.toggle("cam-adjust", adjusting);
    $("cam-xh-adj")?.classList.toggle("active", adjusting);
    if (adjusting) setStatus(t("camz.adjustHint"));
  };
  $("cam-xh-reset")!.onclick = () => {
    if (cam.xhX === 0 && cam.xhY === 0) return;
    cam.xhX = 0; cam.xhY = 0;
    saveCam();
    positionCrosshair();
    if (currentOffset()) setStatus(t("camz.remeasure"), true);
  };
  (["x", "y"] as const).forEach(a => {
    const el = $<HTMLInputElement>(`cam-off-${a}`)!;
    el.addEventListener("change", () => {
      const v = parseOffsetValue(el.value);
      if (a === "x") cam.offX = v; else cam.offY = v;
      saveCam();
      el.value = v === null ? "" : String(v);
      syncCameraZero();
    });
  });
  $("cam-off-measure")!.onclick = () => {
    wiz = wiz ? null : { step: 1, conn: activeMachineId(), port: machine.port, mark: [], result: null };
    renderWiz();
    growWindowForPanel();
  };
  $("cam-zero-btn")!.onclick = () => {
    if (driving) { realtime(RT.jogCancel).catch(() => undefined); return; }
    if (!blockReason()) openZeroDialog();
  };
  renderWiz();
  syncCameraZero();
}

/** Das Fenster soll die zusätzlichen Zeilen zeigen, ohne dass das Bild verschwindet */
function growWindowForPanel() {
  const w = $("cam-win"), view = $("cam-view");
  if (!w || !view || !cam.xh) return;
  const missing = 200 - view.clientHeight;
  if (missing > 0) w.style.height = Math.min(window.innerHeight - w.getBoundingClientRect().top - 10, w.offsetHeight + missing) + "px";
}

/** Anzeige an den Maschinen-Zustand anpassen (läuft bei jedem Statusbericht, also nur leichte Änderungen) */
export function syncCameraZero() {
  const panel = $("cam-xh-panel");
  if (!panel) return;
  panel.style.display = cam.xh ? "" : "none";
  if (!cam.xh) return;

  const fill = (id: string, v: number | null) => {
    const el = $<HTMLInputElement>(id);
    if (el && document.activeElement !== el) el.value = v === null ? "" : String(v);
  };
  fill("cam-off-x", cam.offX);
  fill("cam-off-y", cam.offY);

  const why = blockReason();
  const btn = $<HTMLButtonElement>("cam-zero-btn");
  if (btn) {
    btn.disabled = !driving && !!why;
    const label = driving ? `⏹ ${t("camz.stop")}` : `🎯 ${t("camz.set")}`;
    if (btn.textContent !== label) btn.textContent = label;
  }
  const measure = $<HTMLButtonElement>("cam-off-measure");
  if (measure) measure.disabled = driving || (!wiz && !!why);
  $("cam-off-wiz")?.querySelectorAll<HTMLButtonElement>("[data-needs-idle]").forEach(b => { b.disabled = !!why; });

  // Assistent abbrechen, wenn die gemerkte Position nichts mehr wert ist
  if (wiz && wiz.step >= 2 && (!machine.connected || activeMachineId() !== wiz.conn || machine.port !== wiz.port
      || machine.status.state === "Alarm" || machine.status.state === "Home")) {
    wiz = null;
    renderWiz();
    log(t("camz.wAborted"));
  }

  const lines: string[] = [];
  const p = offsetProblem(cam.offX, cam.offY);
  if (p) lines.push(t("camz.warn." + p));
  if (why) lines.push(t("camz.why." + why));
  const text = lines.join(" ");
  const el = $("cam-zero-why");
  if (el && el.textContent !== text) el.textContent = text;
}

// ---------------------------------------------------------------------
// Assistent: Offset messen
// ---------------------------------------------------------------------

function renderWiz() {
  const box = $("cam-off-wiz");
  if (!box) return;
  $("cam-off-measure")?.classList.toggle("active", !!wiz);
  if (!wiz) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "";
  const cancel = `<button id="cam-w-cancel" class="btn-secondary">${esc(t("camz.cancel"))}</button>`;
  if (wiz.step === 1) {
    box.innerHTML = `<div>${esc(t("camz.w1"))}</div><div class="cam-bar"><button id="cam-w-next" class="btn-secondary" data-needs-idle>${esc(t("camz.w1btn"))}</button>${cancel}</div>`;
  } else if (wiz.step === 2) {
    box.innerHTML = `<div>${esc(t("camz.w2"))}</div><div class="cam-bar"><button id="cam-w-next" class="btn-secondary" data-needs-idle>${esc(t("camz.w2btn"))}</button>${cancel}</div>`;
  } else {
    const r = wiz.result!;
    box.innerHTML = `<div>${esc(t("camz.w3", { x: signed(r.x), y: signed(r.y) }))}</div><div class="cam-bar"><button id="cam-w-next" class="btn-secondary">${esc(t("camz.w3ok"))}</button>${cancel}</div>`;
  }
  $("cam-w-cancel")!.onclick = () => { wiz = null; renderWiz(); };
  $("cam-w-next")!.onclick = () => { void wizNext(); };
  syncCameraZero();
}

async function wizNext() {
  if (!wiz) return;
  if (wiz.step === 3) {
    cam.offX = wiz.result!.x; cam.offY = wiz.result!.y;
    saveCam();
    log(t("camz.log.saved", { x: signed(cam.offX), y: signed(cam.offY) }));
    wiz = null;
    renderWiz();
    syncCameraZero();
    return;
  }
  if (blockReason()) return;
  await freshStatus();   // die Position, die jetzt gilt – nicht die vom letzten Bericht
  if (!wiz || blockReason()) return;
  const pos = machine.status.mpos;
  if (wiz.step === 1) {
    wiz.mark = [pos[0], pos[1]];
    wiz.conn = activeMachineId();
    wiz.port = machine.port;
    wiz.step = 2;
  } else {
    const r = measureOffset(wiz.mark, pos);
    if (!measureIsPlausible(r)) { setStatus(t("camz.wTooSmall"), true); return; }
    wiz.result = r;
    wiz.step = 3;
  }
  renderWiz();
}

// ---------------------------------------------------------------------
// Nullpunkt setzen
// ---------------------------------------------------------------------

function wcsName(): string {
  return machine.wcs || t("camz.activeWcs");
}

function openZeroDialog() {
  document.getElementById("cam-zero-overlay")?.remove();
  const off = currentOffset();
  const problem = offsetProblem(cam.offX, cam.offY);
  const st = machine.status;
  const plan = off ? drivePlan(off, st.mpos, st.wpos, SAFE_Z, topZFromSettings(machine.settings), bedSize(), DRIVE_FEED) : null;
  const canDrive = !!plan && plan.dist > 0 && !plan.outside.length;

  const ov = document.createElement("div");
  ov.id = "cam-zero-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box cam-zero-box" role="dialog" aria-modal="true">
      <h3>🎯 ${esc(t("camz.set"))}</h3>
      <div class="dlg-hint">${esc(t("camz.dlg.intro", { wcs: wcsName() }))}</div>
      ${problem ? `<div class="cam-zero-warn">⚠ ${esc(t("camz.warn." + problem))}</div>` : ""}
      ${off && plan ? `
        <label class="cam-zero-opt">
          <input type="radio" name="cam-zero-way" value="stay" checked>
          <span><b>${esc(t("camz.dlg.stay"))}</b><br>
          <span class="dlg-hint">${esc(t("camz.dlg.stayHint"))}<br><code>${esc(zeroAtCrosshairCommand(off))}</code></span></span>
        </label>
        <label class="cam-zero-opt${canDrive ? "" : " off"}">
          <input type="radio" name="cam-zero-way" value="drive" ${canDrive ? "" : "disabled"}>
          <span><b>${esc(t("camz.dlg.drive"))}</b><br>
          <span class="dlg-hint">${esc(plan.lift > 0 ? t("camz.dlg.lift", { lift: mm(plan.lift) }) : t("camz.dlg.noLift"))}<br>
          ${esc(t("camz.dlg.path", { dx: signed(plan.dx), dy: signed(plan.dy), dist: mm(plan.dist) }))}<br>
          <code>${esc(plan.zeroCmd)}</code></span>
          ${plan.outside.length ? `<br><span class="cam-zero-warn">${esc(t("camz.dlg.outside"))}</span>` : ""}</span>
        </label>` : ""}
      <div class="dlg-buttons">
        <button id="cam-zero-cancel" class="btn-secondary">${esc(t("camz.cancel"))}</button>
        ${off ? `<button id="cam-zero-ok" class="btn-primary">${esc(t("camz.dlg.okStay"))}</button>` : ""}
      </div>
    </div>`;
  document.body.appendChild(ov);

  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("pointerdown", e => { if (e.target === ov) close(); });
  $("cam-zero-cancel")!.onclick = close;

  const okBtn = $<HTMLButtonElement>("cam-zero-ok");
  ov.querySelectorAll<HTMLInputElement>('input[name="cam-zero-way"]').forEach(r => r.addEventListener("change", () => {
    if (okBtn) okBtn.textContent = t(r.value === "drive" && r.checked ? "camz.dlg.okDrive" : "camz.dlg.okStay");
  }));

  // Bei Offset 0 soll ein schnelles Enter nicht gleich etwas auslösen
  (problem || !okBtn ? $("cam-zero-cancel") : okBtn)?.focus();

  if (!okBtn || !off || !plan) return;
  const conn = activeMachineId();
  const from = st.mpos.slice(0, 3);
  okBtn.onclick = () => {
    const way = ov.querySelector<HTMLInputElement>('input[name="cam-zero-way"]:checked')?.value;
    close();
    // Zwischendurch könnte etwas gefahren sein (Gamepad, Tasten): dann stimmt der angezeigte Weg nicht mehr
    const moved = Math.abs(machine.status.mpos[0] - from[0]) > 0.01 || Math.abs(machine.status.mpos[1] - from[1]) > 0.01;
    if (activeMachineId() !== conn || moved) { fail(t("camz.log.moved")); return; }
    const why = blockReason();
    if (why) { fail(t("camz.why." + why)); return; }
    void (way === "drive" ? setZeroDriving(off, conn) : setZeroStaying(off));
  };
}

function fail(text: string) {
  log(text);
  setStatus(text, true);
}

function bedSize(): { w: number; h: number } {
  const w = parseFloat($<HTMLInputElement>("bed-w")?.value || "") || 300;
  const h = parseFloat($<HTMLInputElement>("bed-h")?.value || "") || 300;
  return { w, h };
}

/** G21 und dann der Nullpunkt-Befehl (G10 nimmt sonst bei G20 die Zahlen als Zoll) */
async function sendZero(cmd: string): Promise<boolean> {
  const a = await sendAndWait("G21", 3000);
  if (!a.ok) { fail(t("camz.log.failed", { cmd: "G21" })); return false; }
  const b = await sendAndWait(cmd, 3000);
  if (!b.ok) { fail(t("camz.log.failed", { cmd })); return false; }
  const done = t("camz.log.done", { wcs: machine.wcs || "G5x" });
  log(done);
  setStatus(done);
  return true;
}

async function setZeroStaying(off: Offset) {
  await sendZero(zeroAtCrosshairCommand(off));
}

/** Warten, bis die Maschine steht; false bei Alarm, Trennen oder Zeitablauf */
async function waitStopped(timeoutMs: number): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  await sleep(300);
  while (performance.now() < end) {
    if (!machine.connected || machine.status.state === "Alarm") return false;
    if (machine.status.state === "Idle") {
      await freshStatus();
      return machine.status.state === "Idle";
    }
    await sleep(150);
  }
  return false;
}

async function setZeroDriving(off: Offset, conn: string) {
  driving = true;
  syncCameraZero();
  try {
    await freshStatus();
    const st = machine.status;
    const plan = drivePlan(off, st.mpos, st.wpos, SAFE_Z, topZFromSettings(machine.settings), bedSize(), DRIVE_FEED);
    if (plan.outside.length) { fail(t("camz.dlg.outside")); return; }
    if (plan.liftCmd) {
      if (!(await sendAndWait(plan.liftCmd, 10000)).ok) { fail(t("camz.log.failed", { cmd: plan.liftCmd })); return; }
      if (!await waitStopped(60000) || activeMachineId() !== conn) { fail(t("camz.log.notArrived")); return; }
      // Z nicht oben (Abbruch, Fahrt abgelehnt): dann auch nicht seitwärts fahren
      if (machine.status.mpos[2] < plan.liftTo - 0.02) { fail(t("camz.log.notArrived")); return; }
    }
    if (!(await sendAndWait(plan.moveCmd, 10000)).ok) { fail(t("camz.log.failed", { cmd: plan.moveCmd })); return; }
    if (!await waitStopped(120000) || activeMachineId() !== conn) { fail(t("camz.log.notArrived")); return; }
    if (!hasArrived(machine.status.mpos, plan.target)) { fail(t("camz.log.notArrived")); return; }
    await sendZero(plan.zeroCmd);
  } finally {
    driving = false;
    syncCameraZero();
  }
}

export function initCameraZero(logFn: (s: string) => void) {
  log = logFn;
  window.addEventListener(MACHINE_EVENT, () => {
    if ($("cam-win")?.style.display !== "none") syncCameraZero();
  });
}
