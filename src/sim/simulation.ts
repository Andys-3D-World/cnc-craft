/**
 * SIMULATIONS-REITER
 *
 * Zeigt G-Code als 3D-Bahnen und spielt ihn ab – vor dem Fräsen (aus der Zeichnung oder
 * einer geladenen Datei) und live während des echten Jobs.
 *
 * Tasten (wenn der Reiter offen ist): Leertaste = Abspielen/Pause, Pos1/Ende = Anfang/Ende,
 * Pfeil links/rechts = eine Bewegung zurück/vor.
 */
import { t, T, tip } from "../i18n/i18n";
import { SimProgram, parseGcodeProgram, positionAt, firstMoveOfLine, timeBeforeLine } from "./gcodeParser";
import { SimView, ViewPreset } from "./simView";
import { loadGcodeFromText, streamState } from "../machineStream";
import { bedSizeMm } from "../editor/editorState";

type Source = "design" | "job" | "none";

const ROW_H = 18;
const SPEEDS = [1, 2, 5, 10, 25, 50, 100, 250, 1000];

let view: SimView;
let prog: SimProgram | null = null;
let source: Source = "none";
let label = "";
let simTime = 0;
let playing = false;
let started = false;        // wurde abgespielt/gescrubbt? (sonst alles "fertig" zeigen)
let speed = 10;
let live = false;
let lastFrame = 0;
let log: (s: string) => void = () => {};
let $: <T extends HTMLElement>(id: string) => T;

export function initSimulation(container: HTMLElement | null, appendToConsole: (s: string) => void) {
  if (!container) return;
  log = appendToConsole;
  container.innerHTML = `
    <div class="sim-layout">
      <div class="sim-main">
        <div class="sim-toolbar">
          <span class="sim-source" id="sim-source">${t("sim.noProgram")}</span>
          <span style="flex:1"></span>
          <div class="sim-seg">
            <button class="sim-btn" data-view="top" ${tip("sim.viewTopTip")}>${T("sim.viewTop")}</button>
            <button class="sim-btn" data-view="iso" ${tip("sim.view3dTip")}>${T("sim.view3d")}</button>
            <button class="sim-btn" data-view="front" ${tip("sim.viewFrontTip")}>${T("sim.viewFront")}</button>
            <button class="sim-btn" id="sim-fit" ${tip("sim.fitTip")}>⛶</button>
          </div>
          <label class="sim-check"><input type="checkbox" id="sim-rapids" checked> ${T("sim.showRapids")}</label>
        </div>
        <div class="sim-canvas-holder">
          <canvas id="sim-canvas"></canvas>
          <div class="sim-live" id="sim-live" style="display:none">● LIVE</div>
          <div class="sim-legend">
            <span><i style="background:#7ff3ff"></i><i style="background:#3b8cff"></i><i style="background:#c03ce0"></i> ${T("sim.legendCut")}</span>
            <span><i class="dash" style="border-color:#ff9a3c"></i> ${T("sim.legendRapid")}</span>
            <span><i class="dash" style="border-color:#9aa0b4"></i> ${T("sim.legendTravel")}</span>
          </div>
          <div class="sim-empty" id="sim-empty">${T("sim.emptyHint")}</div>
        </div>
        <div class="sim-controls">
          <button class="sim-btn" id="sim-start" ${tip("sim.toStartTip")}>⏮</button>
          <button class="sim-btn sim-play" id="sim-play" ${tip("sim.playTip")}>▶</button>
          <button class="sim-btn" id="sim-end" ${tip("sim.toEndTip")}>⏭</button>
          <select id="sim-speed" ${tip("sim.speedTip")}>
            ${SPEEDS.map(s => `<option value="${s}" ${s === speed ? "selected" : ""}>${s}×</option>`).join("")}
          </select>
          <input type="range" id="sim-slider" min="0" max="1000" step="1" value="0">
          <span class="sim-time" id="sim-time">0:00 / 0:00</span>
        </div>
      </div>

      <aside class="sim-side">
        <div class="sim-box">
          <h4>${T("sim.info")}</h4>
          <div class="sim-info" id="sim-info"></div>
        </div>
        <div class="sim-box">
          <h4>${T("sim.job")}</h4>
          <button id="sim-to-job" class="btn-secondary" ${tip("sim.toJobTip")}>📥 ${T("sim.toJob")}</button>
          <div class="sim-job-row">
            <button id="sim-job-start" class="btn-primary">▶ ${T("rp.start")}</button>
            <button id="sim-job-pause" class="btn-secondary">⏸ ${T("rp.pause")}</button>
            <button id="sim-job-stop" class="btn-secondary sim-stop" ${tip("rp.stopTip")}>⏹ ${T("rp.stop")}</button>
          </div>
          <div class="sim-job-state" id="sim-job-state"></div>
        </div>
        <div class="sim-box sim-code-box">
          <h4>${T("sim.code")} <span id="sim-line-info"></span></h4>
          <div class="sim-code" id="sim-code"><div id="sim-code-inner"></div></div>
        </div>
      </aside>
    </div>`;

  $ = <T extends HTMLElement>(id: string) => container.querySelector("#" + id) as T;
  const canvas = $<HTMLCanvasElement>("sim-canvas");
  view = new SimView(canvas);

  // Canvas-Größe an den Platz anpassen
  const holder = canvas.parentElement!;
  const resize = () => {
    const r = holder.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const w = Math.floor(r.width), h = Math.floor(r.height);
    if (canvas.width !== w || canvas.height !== h) {
      const first = canvas.width === 300 && canvas.height === 150; // Standardgröße
      canvas.width = w; canvas.height = h;
      if (first) view.fit(); else view.invalidate();
    }
  };
  new ResizeObserver(resize).observe(holder);

  // ---- Bedienelemente ----
  container.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(b =>
    b.addEventListener("click", () => view.setView(b.dataset.view as ViewPreset)));
  $("sim-fit").addEventListener("click", () => view.fit());
  $<HTMLInputElement>("sim-rapids").addEventListener("change", e => { view.showRapids = (e.target as HTMLInputElement).checked; view.invalidate(); });
  $("sim-play").addEventListener("click", togglePlay);
  $("sim-start").addEventListener("click", () => { seek(0); });
  $("sim-end").addEventListener("click", () => { if (prog) seek(prog.totalTime); });
  $<HTMLSelectElement>("sim-speed").addEventListener("change", e => { speed = parseFloat((e.target as HTMLSelectElement).value); });
  $<HTMLInputElement>("sim-slider").addEventListener("input", e => {
    if (!prog) return;
    playing = false;
    seek((parseFloat((e.target as HTMLInputElement).value) / 1000) * prog.totalTime);
  });

  $("sim-to-job").addEventListener("click", () => {
    if (!prog) return;
    if (loadGcodeFromText(prog.lines.join("\n"), label, log)) {
      // Job ersetzt die Vorschau (gleiche Zeilen wie die Maschine bekommt)
    }
  });
  $("sim-job-start").addEventListener("click", () => document.getElementById("btn-job-start")?.click());
  $("sim-job-pause").addEventListener("click", () => document.getElementById("btn-job-pause")?.click());
  $("sim-job-stop").addEventListener("click", () => document.getElementById("btn-job-stop")?.click());

  // G-Code-Liste (nur sichtbare Zeilen werden gebaut -> auch riesige Dateien bleiben flüssig)
  const code = $("sim-code");
  code.addEventListener("scroll", renderCodeList);
  code.addEventListener("click", e => {
    const row = (e.target as HTMLElement).closest("[data-line]") as HTMLElement | null;
    if (!row || !prog) return;
    const i = firstMoveOfLine(prog, parseInt(row.dataset.line!, 10));
    playing = false;
    seek(i < prog.n ? prog.t0[i] + prog.dur[i] : prog.totalTime);
  });

  // ---- Job-Ereignisse ----
  window.addEventListener("cnc-job-loaded", (e: any) => {
    setSimProgram(e.detail.lines, e.detail.label, "job");
  });
  window.addEventListener("cnc-job-progress", (e: any) => {
    const d = e.detail;
    if (source !== "job" || !prog) { updateJobState(); return; }
    live = d.running;
    view.live = live;
    if (d.running || d.line > 0) {
      playing = false;
      started = true;
      simTime = timeBeforeLine(prog, d.line);
      applyTime(true);
    }
    updateJobState();
  });

  window.addEventListener("keydown", e => {
    const tab = document.getElementById("tab-sim");
    if (!tab || !tab.classList.contains("active")) return;
    const target = e.target as HTMLElement;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
    if (!prog) return;
    if (e.key === " ") { togglePlay(); e.preventDefault(); }
    else if (e.key === "Home") { seek(0); e.preventDefault(); }
    else if (e.key === "End") { seek(prog.totalTime); e.preventDefault(); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const cur = positionAt(prog, simTime).i;
      const ni = Math.max(0, Math.min(prog.n - 1, cur + (e.key === "ArrowRight" ? 1 : -1)));
      playing = false;
      seek(prog.t0[ni] + prog.dur[ni]);
      e.preventDefault();
    }
  });

  window.addEventListener("cnc-language-changed", () => { updateInfo(); updateUI(); updateJobState(); });
  window.addEventListener("cnc-redraw", () => { const b = bedSizeMm(); view.setBed(b.w, b.h); });

  const b = bedSizeMm();
  view.setBed(b.w, b.h);
  updateInfo();
  updateUI();
  updateJobState();
  requestAnimationFrame(tick);
}

/** Neues Programm anzeigen */
export function setSimProgram(lines: string[], name: string, src: Source) {
  const b = bedSizeMm();
  view.setBed(b.w, b.h);
  prog = parseGcodeProgram(lines);
  source = src;
  label = name;
  simTime = 0;
  playing = false;
  started = false;
  live = false;
  view.live = false;
  view.setProgram(prog);
  view.setProgress(-1, 0, 0, 0, 0);
  updateInfo();
  updateUI();
  updateJobState();
  renderCodeList();
}

function togglePlay() {
  if (!prog || live) return;
  if (!playing && simTime >= prog.totalTime - 1e-6) simTime = 0;
  playing = !playing;
  started = true;
  lastFrame = performance.now();
  applyTime(false);
}

function seek(time: number) {
  if (!prog) return;
  started = true;
  simTime = Math.max(0, Math.min(prog.totalTime, time));
  applyTime(true);
}

function tick(now: number) {
  if (playing && prog) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    simTime += dt * speed;
    if (simTime >= prog.totalTime) { simTime = prog.totalTime; playing = false; }
    applyTime(true);
  }
  lastFrame = now;
  requestAnimationFrame(tick);
}

function applyTime(scrollList: boolean) {
  if (!prog) return;
  if (!started) { view.setProgress(-1, 0, 0, 0, 0); updateUI(); return; }
  const p = positionAt(prog, simTime);
  view.setProgress(p.i, p.frac, p.x, p.y, p.z);
  updateUI();
  if (scrollList) scrollCodeTo(p.i >= 0 ? prog.line[p.i] : 0);
  else renderCodeList();
}

function fmtTime(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function updateUI() {
  if (!$) return;
  const has = !!prog && prog.n > 0;
  $("sim-empty").style.display = has ? "none" : "flex";
  $("sim-live").style.display = live ? "block" : "none";
  $("sim-play").textContent = playing ? "⏸" : "▶";
  const total = prog ? prog.totalTime : 0;
  $("sim-time").textContent = `${fmtTime(simTime)} / ${fmtTime(total)}`;
  const slider = $<HTMLInputElement>("sim-slider");
  slider.value = String(total > 0 ? Math.round((simTime / total) * 1000) : 0);
  slider.disabled = !has || live;
  $<HTMLButtonElement>("sim-play").disabled = !has || live;
  $("sim-source").textContent = prog
    ? `${source === "job" ? t("sim.sourceJob") : t("sim.sourceDesign")}: ${label}`
    : t("sim.noProgram");
  if (prog && started) {
    const p = positionAt(prog, simTime);
    $("sim-line-info").textContent = p.i >= 0 ? t("sim.lineOf", { n: prog.line[p.i] + 1, total: prog.lines.length }) : "";
  } else {
    $("sim-line-info").textContent = prog ? t("sim.lines", { n: prog.lines.length }) : "";
  }
}

function updateInfo() {
  if (!$) return;
  const el = $("sim-info");
  if (!prog) { el.innerHTML = `<div class="sim-muted">${t("sim.noProgram")}</div>`; return; }
  const b = prog.bounds;
  const row = (k: string, v: string) => `<div><span>${k}</span><b>${v}</b></div>`;
  el.innerHTML =
    row(t("sim.estTime"), fmtTime(prog.totalTime)) +
    row(t("sim.cutLength"), `${(prog.cutLength / 1000).toFixed(2)} m`) +
    row(t("sim.rapidLength"), `${(prog.rapidLength / 1000).toFixed(2)} m`) +
    row("X", `${b.minX.toFixed(1)} … ${b.maxX.toFixed(1)} mm`) +
    row("Y", `${b.minY.toFixed(1)} … ${b.maxY.toFixed(1)} mm`) +
    row("Z", `${b.minZ.toFixed(2)} … ${b.maxZ.toFixed(2)} mm`) +
    row(t("sim.moves"), String(prog.n)) +
    `<div class="sim-muted">${t("sim.estNote")}</div>`;
  const bed = bedSizeMm();
  if (prog.n && (b.minX < -0.01 || b.minY < -0.01 || b.maxX > bed.w + 0.01 || b.maxY > bed.h + 0.01)) {
    el.innerHTML += `<div class="sim-warn">⚠ ${t("sim.outOfBed")}</div>`;
  }
}

function updateJobState() {
  if (!$) return;
  const el = $("sim-job-state");
  const toJob = $<HTMLButtonElement>("sim-to-job");
  toJob.style.display = source === "design" ? "block" : "none";
  const st = streamState;
  if (st.isRunning) el.textContent = (st.isPaused ? t("sim.jobPaused") : t("sim.jobRunning")) + ` – ${st.currentLine}/${st.totalLines}`;
  else if (st.totalLines) el.textContent = t("sim.jobReady", { n: st.totalLines });
  else el.textContent = t("sim.jobNone");
}

// ---------------- G-Code-Liste ----------------

let listLine = -1;

function scrollCodeTo(line: number) {
  listLine = line;
  const code = $("sim-code");
  const top = line * ROW_H;
  if (top < code.scrollTop + ROW_H * 2 || top > code.scrollTop + code.clientHeight - ROW_H * 3) {
    code.scrollTop = Math.max(0, top - code.clientHeight / 2);
  }
  renderCodeList();
}

function renderCodeList() {
  if (!$) return;
  const code = $("sim-code");
  const inner = $("sim-code-inner");
  if (!prog) { inner.style.height = "0px"; inner.innerHTML = ""; return; }
  const n = prog.lines.length;
  inner.style.height = `${n * ROW_H}px`;
  const first = Math.max(0, Math.floor(code.scrollTop / ROW_H) - 5);
  const last = Math.min(n, first + Math.ceil(code.clientHeight / ROW_H) + 10);
  const cur = started ? listLine : -1;
  let html = "";
  for (let i = first; i < last; i++) {
    const txt = prog.lines[i].replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
    html += `<div class="sim-row${i === cur ? " cur" : ""}${started && i < cur ? " done" : ""}" data-line="${i}" style="top:${i * ROW_H}px"><span>${i + 1}</span>${txt || "&nbsp;"}</div>`;
  }
  inner.innerHTML = html;
}
