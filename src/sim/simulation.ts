/**
 * SIMULATIONS-REITER
 *
 * Zeigt G-Code als 3D-Bahnen und spielt ihn ab – vor dem Fräsen (aus der Zeichnung oder
 * einer geladenen Datei) und live während des echten Jobs.
 *
 * Tasten (wenn der Reiter offen ist): Leertaste = Abspielen/Pause, Pos1/Ende = Anfang/Ende,
 * Pfeil links/rechts = eine Bewegung zurück/vor.
 *
 * Bahn anklicken = passende G-Code-Zeile springt ins Bild und leuchtet; Zeile anklicken = ihre Bahn leuchtet.
 *
 * G-CODE BEARBEITEN (✏️): Zeilen ändern (Doppelklick/Enter), löschen (Entf), einfügen (M0, F …),
 * Rückgängig (Strg+Z). „Übernehmen“ macht den Text zum Job. Läuft der Job schon, darf nur geändert werden,
 * was die Maschine noch nicht bekommen hat (Sicherheitsabstand, siehe liveEditFloor) – mit Rückfrage.
 */
import { t, T, tip } from "../i18n/i18n";
import { SimProgram, parseGcodeProgram, positionAt, firstMoveOfLine, timeBeforeLine } from "./gcodeParser";
import { SimView, ViewPreset } from "./simView";
import { loadGcodeFromText, streamState, liveEditFloor, patchRunningJob } from "../machineStream";
import { machine, setOverride } from "../machine";
import { bedSizeMm } from "../editor/editorState";
import { openResumeDialog } from "../ui/resumeDialog";

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
let hiLine = -1;            // hervorgehobene Zeile (Bahn gelb)
let keepViewOnce = false;   // nächstes geladenes Programm: Kamera nicht neu einpassen (nach „Übernehmen“)

// Bearbeiten
let editing = false;
let editLive = false;       // Bearbeitung eines laufenden Jobs (nur ungesendete Zeilen)
let editBase: string[] = [];
let draft: string[] = [];
let undoStack: string[][] = [];
let redoStack: string[][] = [];
let selLine = -1;
let edRow = -1;             // Zeile mit offenem Eingabefeld
let edInput: HTMLInputElement | null = null;
let rerendering = false;

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
          <button id="sim-job-resume" class="btn-secondary" ${tip("res.simTip")}>⏭ ${T("res.simBtn")}</button>
          <div class="sim-job-state" id="sim-job-state"></div>
        </div>
        <div class="sim-box sim-code-box">
          <h4>${T("sim.code")} <span id="sim-line-info"></span>
            <button class="sim-btn sim-ed-toggle" id="sim-ed-toggle" ${tip("sim.ed.editTip")}>✏️ ${T("sim.ed.edit")}</button></h4>
          <div class="sim-ed-bar" id="sim-ed-bar" style="display:none">
            <button class="sim-btn" id="sim-ed-undo" ${tip("sim.ed.undoTip")}>↶</button>
            <button class="sim-btn" id="sim-ed-redo" ${tip("sim.ed.redoTip")}>↷</button>
            <button class="sim-btn" id="sim-ed-change" ${tip("sim.ed.changeTip")}>✎</button>
            <button class="sim-btn" id="sim-ed-del" ${tip("sim.ed.delTip")}>🗑</button>
            <select id="sim-ed-ins" ${tip("sim.ed.insTip")}>
              <option value="">＋ ${t("sim.ed.insert")}</option>
              <option value="blank">${t("sim.ed.insBlank")}</option>
              <option value="M0">M0 – ${t("sim.ed.insPause")}</option>
              <option value="F">F… – ${t("sim.ed.insFeed")}</option>
              <option value="G4">G4 P1 – ${t("sim.ed.insDwell")}</option>
            </select>
            <span style="flex:1"></span>
            <button class="btn-primary" id="sim-ed-apply">✓ ${T("sim.ed.apply")}</button>
            <button class="btn-secondary" id="sim-ed-cancel" ${tip("sim.ed.cancelTip")}>✕</button>
          </div>
          <div class="sim-ed-note" id="sim-ed-note" style="display:none">
            <div id="sim-ed-hint"></div>
            <div id="sim-ed-msg" class="sim-warn"></div>
            <div id="sim-ed-ov" class="sim-ed-ov">
              <div>${T("sim.ed.ovHint")}</div>
              <div class="sim-ed-ov-row"><b>${T("sim.ed.ovFeed")}</b>
                <button class="sim-btn" data-ov="feed:-10">−10%</button><button class="sim-btn" data-ov="feed:100">100%</button><button class="sim-btn" data-ov="feed:10">+10%</button>
                <i id="sim-ed-ovf"></i></div>
              <div class="sim-ed-ov-row"><b>${T("sim.ed.ovSpindle")}</b>
                <button class="sim-btn" data-ov="spindle:-10">−10%</button><button class="sim-btn" data-ov="spindle:100">100%</button><button class="sim-btn" data-ov="spindle:10">+10%</button>
                <i id="sim-ed-ovs"></i></div>
            </div>
          </div>
          <div class="sim-code" id="sim-code"><div id="sim-code-inner"></div></div>
        </div>
      </aside>
    </div>`;

  $ = <T extends HTMLElement>(id: string) => container.querySelector("#" + id) as T;
  const canvas = $<HTMLCanvasElement>("sim-canvas");
  view = new SimView(canvas);
  // Bahn angeklickt -> Zeile zeigen (und die Simulation dorthin, wenn kein echter Job läuft)
  view.onPick = (line, move) => {
    if (!prog) return;
    selectLine(line);
    if (line < 0) return;
    if (!live && move >= 0) { playing = false; seek(moveEnd(move)); }
    scrollCodeTo(line, true);
  };

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
  // Fortsetzen ab der Zeile, an der die Simulation gerade steht
  $("sim-job-resume").addEventListener("click", () => {
    if (!prog || source !== "job" || streamState.isRunning) { log(t(streamState.isRunning ? "stream.alreadyRunning" : "res.needJob")); return; }
    const p = positionAt(prog, simTime);
    openResumeDialog(log, p.i >= 0 ? prog.line[p.i] : undefined);
  });
  // Dialog „Job fortsetzen“: Simulation an die gewählte Stelle
  window.addEventListener("cnc-sim-seek-line", (e: any) => {
    if (!prog || source !== "job" || live) return;
    playing = false;
    seek(timeBeforeLine(prog, e.detail.line));
    scrollCodeTo(e.detail.line);
  });

  // G-Code-Liste (nur sichtbare Zeilen werden gebaut -> auch riesige Dateien bleiben flüssig)
  const code = $("sim-code");
  code.addEventListener("scroll", renderCodeList);
  code.addEventListener("click", e => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const row = (e.target as HTMLElement).closest("[data-line]") as HTMLElement | null;
    if (!row || !prog) return;
    const line = parseInt(row.dataset.line!, 10);
    selectLine(line);
    if (live) { renderCodeList(); return; }
    const i = firstMoveOfLine(prog, line);
    playing = false;
    seek(i < prog.n ? moveEnd(i) : prog.totalTime);
  });
  code.addEventListener("dblclick", e => {
    const row = (e.target as HTMLElement).closest("[data-line]") as HTMLElement | null;
    if (!row || !prog) return;
    if (!editing) enterEdit();
    if (editing) openInput(parseInt(row.dataset.line!, 10));
  });

  // ---- Bearbeiten ----
  $("sim-ed-toggle").addEventListener("click", () => { if (editing) leaveEdit(true); else enterEdit(); });
  $("sim-ed-undo").addEventListener("click", undo);
  $("sim-ed-redo").addEventListener("click", redo);
  $("sim-ed-change").addEventListener("click", () => { if (selLine >= 0) openInput(selLine); });
  $("sim-ed-del").addEventListener("click", deleteSelected);
  $<HTMLSelectElement>("sim-ed-ins").addEventListener("change", e => {
    const sel = e.target as HTMLSelectElement;
    const v = sel.value;
    sel.value = "";
    if (v) insertLine(v);
  });
  $("sim-ed-apply").addEventListener("click", () => { void applyEdit(); });
  $("sim-ed-cancel").addEventListener("click", () => leaveEdit(true));
  container.querySelectorAll<HTMLButtonElement>("[data-ov]").forEach(b => b.addEventListener("click", () => {
    const [kind, v] = b.dataset.ov!.split(":") as ["feed" | "spindle", string];
    const step = parseInt(v, 10);
    const cur = machine.status.ov[kind === "feed" ? 0 : 2];
    void setOverride(kind, step === 100 ? 100 : cur + step).then(updateEditUI);
  }));

  // ---- Job-Ereignisse ----
  window.addEventListener("cnc-job-loaded", (e: any) => {
    // neuer Job: offene Bearbeitung gehört zum alten Text
    if (editing) closeEdit();
    setSimProgram(e.detail.lines, e.detail.label, "job");
  });
  // laufender Job wurde geändert (Live-Bearbeitung): neue Zeilen anzeigen, Kamera und Fortschritt bleiben
  window.addEventListener("cnc-job-patched", (e: any) => {
    if (source !== "job") return;
    prog = parseGcodeProgram(e.detail.lines);
    view.replaceProgram(prog);
    if (live || started) { simTime = timeBeforeLine(prog, streamState.currentLine); }
    updateInfo();
    applyTime(false);
  });
  window.addEventListener("cnc-job-progress", (e: any) => {
    const d = e.detail;
    if (editing) {
      // Job startet während der Bearbeitung: bisher Geändertes passt nicht mehr zu dem, was die Maschine fährt
      if (d.running && !editLive && source === "job") { leaveEdit(true); showEditMsg(t("sim.ed.discardedStart")); log(t("sim.ed.discardedStart")); }
      else if (!d.running && editLive) editLive = false; // Job fertig: weiter bearbeiten, „Übernehmen“ lädt dann neu
    }
    if (source !== "job" || !prog) { updateJobState(); updateEditUI(); return; }
    live = d.running;
    view.live = live;
    if (d.running || d.line > 0) {
      playing = false;
      started = true;
      simTime = timeBeforeLine(prog, d.line);
      applyTime(!editing);
    }
    updateJobState();
    updateEditUI();
  });

  window.addEventListener("keydown", e => {
    const tab = document.getElementById("tab-sim");
    if (!tab || !tab.classList.contains("active")) return;
    const target = e.target as HTMLElement;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
    if (!prog) return;
    if (editing && editKey(e)) { e.preventDefault(); return; }
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

  window.addEventListener("cnc-language-changed", () => { updateInfo(); updateUI(); updateJobState(); updateEditUI(); });
  window.addEventListener("cnc-redraw", () => { const b = bedSizeMm(); view.setBed(b.w, b.h); });

  const b = bedSizeMm();
  view.setBed(b.w, b.h);
  updateInfo();
  updateUI();
  updateJobState();
  updateEditUI();
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
  hiLine = -1;
  view.setHighlight(-1);
  if (keepViewOnce) view.replaceProgram(prog); else view.setProgram(prog);
  keepViewOnce = false;
  view.setProgress(-1, 0, 0, 0, 0);
  updateInfo();
  updateUI();
  updateJobState();
  updateEditUI();
  renderCodeList();
}

/** Zeitpunkt kurz vor dem Ende einer Bewegung (so bleibt ihre Zeile die aktuelle) */
function moveEnd(i: number): number {
  if (!prog) return 0;
  return Math.max(prog.t0[i], prog.t0[i] + prog.dur[i] - 1e-6);
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

/** Zeile auswählen und ihre Bahn hervorheben (-1 = nichts) */
function selectLine(line: number) {
  hiLine = line;
  view.setHighlight(line);
  if (editing) { selLine = line; updateEditUI(); }
}

function scrollCodeTo(line: number, pickOnly = false) {
  if (!pickOnly) listLine = line;
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
  const lines = editing ? draft : prog.lines;
  const n = lines.length;
  inner.style.height = `${n * ROW_H}px`;
  const first = Math.max(0, Math.floor(code.scrollTop / ROW_H) - 5);
  const last = Math.min(n, first + Math.ceil(code.clientHeight / ROW_H) + 10);
  const cur = started ? listLine : -1;
  const floor = editing ? editFloor() : 0;
  let html = "";
  for (let i = first; i < last; i++) {
    const cls = (i === cur ? " cur" : "") + (started && i < cur ? " done" : "") + (i === hiLine ? " hi" : "") + (i < floor ? " locked" : "");
    if (i === edRow && edInput) {
      html += `<div class="sim-row edit${cls}" data-line="${i}" style="top:${i * ROW_H}px"><span>${i + 1}</span><i id="sim-ed-slot"></i></div>`;
      continue;
    }
    // G-Code aus Dateien ist fremder Text -> immer maskieren
    const txt = lines[i].replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
    html += `<div class="sim-row${cls}" data-line="${i}" style="top:${i * ROW_H}px"><span>${i < floor ? "🔒" : i + 1}</span>${txt || "&nbsp;"}</div>`;
  }
  // offenes Eingabefeld beim Neuaufbau behalten (Fokus und Cursor bleiben)
  const focused = !!edInput && document.activeElement === edInput;
  const caret = edInput ? edInput.selectionStart : null;
  rerendering = true;
  inner.innerHTML = html;
  const slot = inner.querySelector("#sim-ed-slot");
  if (slot && edInput) {
    slot.replaceWith(edInput);
    if (focused) { edInput.focus(); if (caret !== null) edInput.setSelectionRange(caret, caret); }
  }
  rerendering = false;
}

// ---------------- G-Code bearbeiten ----------------

function isLiveJob(): boolean {
  return source === "job" && streamState.isRunning;
}

/** erste änderbare Zeile (laufender Job: alles davor ist gesendet oder zu nah dran) */
function editFloor(): number {
  if (!editLive) return 0;
  const f = liveEditFloor();
  return f === null ? Infinity : f;
}

function enterEdit() {
  if (!prog || editing) return;
  if (isLiveJob() && liveEditFloor() === null) { showEditMsg(t("sim.ed.err.unsupported")); log(t("sim.ed.err.unsupported")); return; }
  playing = false;
  editing = true;
  editLive = isLiveJob();
  editBase = prog.lines;
  draft = prog.lines.slice();
  undoStack = [];
  redoStack = [];
  selLine = hiLine >= 0 ? hiLine : (started ? listLine : -1);
  showEditMsg("");
  updateEditUI();
  renderCodeList();
}

/** Bearbeitung beenden; discard = Änderungen verwerfen (Anzeige zurück auf den Ausgangstext) */
function leaveEdit(discard: boolean) {
  if (!editing) return;
  const changed = draft !== editBase && (draft.length !== editBase.length || draft.some((l, i) => l !== editBase[i]));
  closeEdit();
  if (discard && changed && prog) {
    prog = parseGcodeProgram(editBase);
    view.replaceProgram(prog);
    if (source === "job" && streamState.isRunning) simTime = timeBeforeLine(prog, streamState.currentLine);
    updateInfo();
    applyTime(false);
  }
  updateEditUI();
  renderCodeList();
}

function closeEdit() {
  editing = false;
  editLive = false;
  edRow = -1;
  edInput = null;
  undoStack = [];
  redoStack = [];
}

/** neuen Entwurf übernehmen (mit Rückgängig), neu einlesen und zeichnen */
function change(next: string[], sel = selLine) {
  undoStack.push(draft);
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
  setDraft(next, sel);
}

function setDraft(next: string[], sel: number) {
  draft = next;
  selLine = Math.min(sel, next.length - 1);
  hiLine = selLine;
  prog = parseGcodeProgram(draft);
  view.replaceProgram(prog);
  view.setHighlight(hiLine);
  simTime = Math.min(simTime, prog.totalTime);
  updateInfo();
  applyTime(false);
  showEditMsg("");
  updateEditUI();
}

function undo() {
  if (!editing || !undoStack.length) return;
  closeInput(false);
  const prev = undoStack.pop()!;
  // gesperrte Zeilen dürfen auch durch Rückgängig nicht zurückkommen
  if (firstDiff(prev, draft) < editFloor()) { undoStack.push(prev); showEditMsg(t("sim.ed.err.locked")); return; }
  redoStack.push(draft);
  setDraft(prev, Math.min(selLine, prev.length - 1));
}

function redo() {
  if (!editing || !redoStack.length) return;
  closeInput(false);
  const next = redoStack.pop()!;
  if (firstDiff(next, draft) < editFloor()) { redoStack.push(next); showEditMsg(t("sim.ed.err.locked")); return; }
  undoStack.push(draft);
  setDraft(next, Math.min(selLine, next.length - 1));
}

function firstDiff(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i === a.length && i === b.length ? Infinity : i;
}

function lockedMsg(line: number): boolean {
  if (line >= editFloor()) return false;
  showEditMsg(t("sim.ed.err.locked"));
  return true;
}

function deleteSelected() {
  if (!editing || selLine < 0 || selLine >= draft.length || lockedMsg(selLine)) return;
  closeInput(false);
  const next = draft.slice();
  next.splice(selLine, 1);
  change(next, Math.min(selLine, next.length - 1));
  renderCodeList();
}

/** Zeile nach der ausgewählten einfügen (ohne Auswahl: am Ende) */
function insertLine(kind: string) {
  if (!editing) return;
  closeInput(true);
  const at = selLine >= 0 ? selLine + 1 : draft.length;
  if (lockedMsg(at)) return;
  const text = kind === "M0" ? `M0 (${ascii(t("sim.ed.insPause"))})` : kind === "G4" ? "G4 P1" : kind === "F" ? "F" + guessFeed(at) : "";
  const next = draft.slice();
  next.splice(at, 0, text);
  change(next, at);
  if (kind === "blank" || kind === "F") openInput(at);
  else scrollCodeTo(at, true);
}

/** Vorschub an dieser Stelle (letztes F davor) – als Vorschlag zum Ändern */
function guessFeed(at: number): number {
  for (let i = at - 1; i >= 0; i--) {
    const m = /F\s*([\d.]+)/i.exec(draft[i].replace(/\([^)]*\)/g, "").replace(/;.*$/, ""));
    if (m) return Math.round(parseFloat(m[1]));
  }
  return 1000;
}

/** Klammern/Zeilenumbrüche aus übersetzten Texten raus (G-Code-Kommentar) */
function ascii(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "").replace(/[()]/g, "").trim();
}

function openInput(line: number) {
  if (!editing || line < 0 || line >= draft.length) return;
  if (lockedMsg(line)) return;
  closeInput(true);
  selLine = line;
  hiLine = line;
  view.setHighlight(line);
  const inp = document.createElement("input");
  inp.className = "sim-ed-input";
  inp.value = draft[line];
  inp.spellcheck = false;
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { closeInput(true); e.preventDefault(); }
    else if (e.key === "Escape") { closeInput(false); e.preventDefault(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const to = line + (e.key === "ArrowDown" ? 1 : -1);
      closeInput(true);
      if (to >= 0 && to < draft.length) openInput(to);
      e.preventDefault();
    }
    e.stopPropagation();
  });
  inp.addEventListener("blur", () => { if (!rerendering && edInput === inp) closeInput(true); });
  edInput = inp;
  edRow = line;
  scrollCodeTo(line, true);
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
  updateEditUI();
}

/** Eingabefeld schließen; commit = Text übernehmen (leer = Zeile löschen) */
function closeInput(commit: boolean) {
  const inp = edInput, row = edRow;
  if (!inp) return;
  edInput = null;
  edRow = -1;
  if (commit && row >= 0 && row < draft.length && row >= editFloor()) {
    const v = inp.value.replace(/[\r\n]+/g, " ").trim();
    if (v !== draft[row]) {
      const next = draft.slice();
      if (v) next[row] = v; else next.splice(row, 1);
      change(next, Math.min(row, next.length - 1));
      if (editLive && /^F\s*[\d.]+$/i.test(v)) showEditMsg(t("sim.ed.feedHint"));
    } else if (!v) {
      // neu eingefügte, leer gelassene Zeile wieder weg
      const next = draft.slice();
      next.splice(row, 1);
      change(next, Math.min(row, next.length - 1));
    }
  }
  renderCodeList();
}

/** Tasten im Bearbeiten-Modus (Liste hat den Fokus, kein Eingabefeld). true = verarbeitet */
function editKey(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") { if (e.shiftKey) redo(); else undo(); return true; }
  if (mod && e.key.toLowerCase() === "y") { redo(); return true; }
  if (e.key === "Delete" || e.key === "Backspace") { deleteSelected(); return true; }
  if (e.key === "Enter") { if (selLine >= 0) openInput(selLine); return true; }
  if (e.key === "Escape") { leaveEdit(true); return true; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const to = Math.max(0, Math.min(draft.length - 1, selLine + (e.key === "ArrowDown" ? 1 : -1)));
    selectLine(to);
    scrollCodeTo(to, true);
    return true;
  }
  return false;
}

async function applyEdit() {
  if (!editing || !prog) return;
  closeInput(true);
  const lines = draft;
  if (editLive && isLiveJob()) {
    const d = firstDiff(lines, editBase);
    if (d === Infinity) { leaveEdit(false); return; }
    if (!window.confirm(t("sim.ed.confirmLive", { n: d + 1 }))) return;
    const err = await patchRunningJob(lines);
    if (err) {
      const key = "sim.ed.err." + err.replace(/\s+/g, "");
      const msg = t(key) !== key ? t(key) : t("sim.ed.err.other", { e: err });
      showEditMsg(msg);
      log(msg);
      return;
    }
    log(t("sim.ed.patched", { n: d + 1 }));
    closeEdit();
    updateEditUI();
    renderCodeList();
    return;
  }
  if (streamState.isRunning) { showEditMsg(t("stream.alreadyRunning")); return; }
  keepViewOnce = true;
  if (!loadGcodeFromText(lines.join("\n"), label || t("sim.loadedJob"), log)) { keepViewOnce = false; return; }
  // cnc-job-loaded hat die Bearbeitung beendet und den neuen Job angezeigt
  log(t("sim.ed.applied"));
}

function showEditMsg(msg: string) {
  if (!$) return;
  const el = $("sim-ed-msg");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
  if (msg) $("sim-ed-note").style.display = "flex";
}

function updateEditUI() {
  if (!$) return;
  const has = !!prog;
  const tog = $<HTMLButtonElement>("sim-ed-toggle");
  tog.disabled = !has;
  tog.classList.toggle("active", editing);
  $("sim-ed-bar").style.display = editing ? "flex" : "none";
  const note = $("sim-ed-note");
  const msgShown = !!$("sim-ed-msg").textContent;
  note.style.display = editing || msgShown ? "flex" : "none";
  if (!editing) { $("sim-ed-hint").textContent = ""; $("sim-ed-ov").style.display = "none"; return; }
  $<HTMLButtonElement>("sim-ed-undo").disabled = !undoStack.length;
  $<HTMLButtonElement>("sim-ed-redo").disabled = !redoStack.length;
  const floor = editFloor();
  $<HTMLButtonElement>("sim-ed-del").disabled = selLine < 0 || selLine < floor;
  $<HTMLButtonElement>("sim-ed-change").disabled = selLine < 0 || selLine < floor;
  $<HTMLButtonElement>("sim-ed-apply").disabled = !undoStack.length && firstDiff(draft, editBase) === Infinity;
  const hint = $("sim-ed-hint");
  if (editLive) {
    hint.textContent = floor === Infinity ? t("sim.ed.err.unsupported")
      : floor >= draft.length ? t("sim.ed.liveAllSent") : t("sim.ed.liveLocked", { n: floor });
  } else {
    hint.textContent = t("sim.ed.hint");
  }
  const ov = editLive && streamState.onMachine && machine.connected;
  $("sim-ed-ov").style.display = ov ? "flex" : "none";
  if (ov) {
    $("sim-ed-ovf").textContent = `${machine.status.ov[0]} %`;
    $("sim-ed-ovs").textContent = `${machine.status.ov[2]} %`;
  }
}
