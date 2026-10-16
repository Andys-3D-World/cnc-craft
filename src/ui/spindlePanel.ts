/**
 * SPINDEL / LASER / BRENNER (Reiter "Maschine")
 *
 * Wie die Handsteuerung in Estlcam – je nach Betriebsart:
 *   Fräse  – Spindel an/aus, Drehrichtung (M3 rechts / M4 links), Drehzahl (S)
 *   Laser  – Testschuss zum Ausrichten/Fokussieren: nur solange gedrückt, mit Zeitgrenze
 *   Plasma – Höhenregelung (THC) von Hand frei-/sperren,
 *            Pilotzündung testen (ein Klick: Brenner kurz in der Luft zünden, 0,2–2 s),
 *            Brenner-Test (gedrückt halten, höchstens 3 s)
 * Darunter für alle: Overrides als Schieberegler 10–200 % (Vorschub, Spindel bzw.
 * Laserleistung) und Eilgang 25/50/100 %. Overrides wirken sofort, auch mitten im Job.
 *
 * GRBL kennt für Overrides nur die Echtzeit-Bytes 100 %, ±10 %, ±1 % – setOverride()
 * rechnet die kürzeste Folge aus (machine.ts). Unter 10 % geht nicht: "aus" ist M5.
 * Während ein Job pausiert ist, schaltet "aus/an" die Spindel mit dem Spindel-Stopp-
 * Override (0x9E) – GRBL fährt sie beim Fortsetzen von selbst wieder hoch.
 */
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT, RT, OV_MIN, OV_MAX, send, realtime, setOverride, canCommand } from "../machine";
import { currentMachine } from "./machineWizard";
import { plasmaSettings } from "../plasmaCuts";

const KEY_RPM = "cnc_craft_spindle_rpm";
const KEY_DIR = "cnc_craft_spindle_dir";
const KEY_LF_POWER = "cnc_craft_laser_test_power";
const KEY_LF_MAX = "cnc_craft_laser_test_max";
const KEY_PILOT = "cnc_craft_plasma_pilot_time";
const TORCH_MAX_MS = 3000;

export function spindlePanelHtml(): string {
  const slider = (id: string) =>
    `<input type="range" id="${id}" class="ov-slider" min="${OV_MIN}" max="${OV_MAX}" step="1" value="100" list="ov-ticks">`;
  return `
    <div class="menu-section-unified not-ruida not-k40" id="spindle-section">
      <h3 class="menu-trigger"><span class="only-mill">${T("sp.titleMill")}</span><span class="only-laser">${T("sp.titleLaser")}</span><span class="only-plasma">${T("sp.titlePlasma")}</span></h3>
      <div class="menu-body rp-box">
        <datalist id="ov-ticks"><option value="50"></option><option value="100"></option><option value="150"></option></datalist>

        <!-- ===== Fräse: Spindel ===== -->
        <div class="only-mill sp-block">
          <div class="sp-state-row"><span id="sp-state" class="sp-state sp-off">${T("sp.off")}</span><span id="sp-max" class="sp-max"></span></div>
          <div class="prop-row" ${tip("sp.rpmTip")}>${T("sp.rpm")}<input type="number" id="sp-rpm" min="0" step="100" class="prop-input"></div>
          <div class="rp-grid2 sp-dir">
            <label ${tip("sp.cwTip")}><input type="radio" name="sp-dir" value="M3" checked> ↻ ${T("sp.cw")}</label>
            <label ${tip("sp.ccwTip")}><input type="radio" name="sp-dir" value="M4"> ↺ ${T("sp.ccw")}</label>
          </div>
          <div class="sp-btns">
            <button id="sp-on" class="btn-primary" ${tip("sp.onTip")}>▶ ${T("sp.on")}</button>
            <button id="sp-off" class="btn-secondary sp-stop" ${tip("sp.offTip")}>■ ${T("sp.offBtn")}</button>
          </div>
        </div>

        <!-- ===== Laser: Testschuss ===== -->
        <div class="only-laser sp-block">
          <div class="prop-row" ${tip("lf.powerTip")}>${T("lf.power")}<input type="number" id="lf-power" min="0.1" max="100" step="0.5" class="prop-input"></div>
          <div class="prop-row" ${tip("lf.maxTip")}>${T("lf.max")}<input type="number" id="lf-max" min="1" max="30" step="1" class="prop-input"></div>
          <button id="lf-fire" class="btn-secondary sp-fire" ${tip("lf.fireTip")}>🔴 ${T("lf.fire")}</button>
          <div class="tool-scope">${T("lf.safety")}</div>
        </div>

        <!-- ===== Plasma: THC + Brenner-Test ===== -->
        <div class="only-plasma sp-block">
          <div class="sp-state-row"><span id="thc-state" class="sp-state sp-off"></span></div>
          <div class="sp-btns">
            <button id="thc-on" class="btn-secondary" ${tip("thc.onTip")}>${T("thc.on")}</button>
            <button id="thc-off" class="btn-secondary" ${tip("thc.offTip")}>${T("thc.off")}</button>
          </div>
          <div class="sp-pilot">
            <div class="prop-row" ${tip("pl.pilotTimeTip")}>${T("pl.pilotTime")}<input type="number" id="pl-pilot-time" min="0.2" max="2" step="0.1" class="prop-input"></div>
            <button id="pl-pilot" class="btn-secondary sp-fire" ${tip("pl.pilotTip")}>✨ ${T("pl.pilot")}</button>
          </div>
          <button id="pl-fire" class="btn-secondary sp-fire" ${tip("pl.fireTip")}>⚡ ${T("pl.fire")}</button>
          <div id="thc-manual-hint" class="tool-scope"></div>
        </div>

        <!-- ===== Overrides ===== -->
        <div class="sp-ov-title">${T("m.overrides")}</div>
        <div class="m-ov-row"><span>${T("m.ovFeed")}</span>
          <button class="btn-secondary btn-icon" data-rt="feedMinus10">−</button>
          <button class="btn-secondary m-ov-val" data-rt="feed100" id="ov-feed-val" ${tip("m.ovResetTip")}>100%</button>
          <button class="btn-secondary btn-icon" data-rt="feedPlus10">+</button></div>
        ${slider("ov-feed-slider")}
        <div class="not-plasma not-marlin">
          <div class="m-ov-row"><span><span class="only-mill">${T("sp.ovSpindle")}</span><span class="only-laser">${T("sp.ovPower")}</span></span>
            <button class="btn-secondary btn-icon" data-rt="spindleMinus10">−</button>
            <button class="btn-secondary m-ov-val" data-rt="spindle100" id="ov-spindle-val" ${tip("m.ovResetTip")}>100%</button>
            <button class="btn-secondary btn-icon" data-rt="spindlePlus10">+</button></div>
          ${slider("ov-spindle-slider")}
        </div>
        <div class="m-ov-row not-marlin"><span>${T("m.ovRapid")}</span>
          <button class="btn-secondary m-ov-small" data-rt="rapid25">25%</button>
          <button class="btn-secondary m-ov-small" data-rt="rapid50">50%</button>
          <button class="btn-secondary m-ov-small" data-rt="rapid100" id="ov-rapid-val">100%</button></div>
        <div class="tool-scope">${T("sp.ovHint")}</div>
      </div>
    </div>`;
}

function get(k: string): string { try { return localStorage.getItem(k) || ""; } catch { return ""; } }
function put(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* egal */ } }

/** Höchster S-Wert: $30 vom Board, sonst aus der gewählten Maschine, sonst 1000 */
export function maxSpindle(): number {
  const s30 = parseFloat(machine.settings.get("$30") || "");
  if (s30 > 0) return s30;
  const m = currentMachine();
  if (m && m.sMax > 0) return m.sMax;
  return 1000;
}

/** Laser-Testleistung in % → S-Wert */
export function laserTestS(percent: number, sMax = maxSpindle()): number {
  const p = Math.max(0, Math.min(100, percent));
  return Math.round(p / 100 * sMax * 10) / 10;
}

/** Befehle zum Feuern im Stillstand (GRBL-Lasermodus feuert mit M3 nur im G1-Modus) */
export function fireLines(s: number): string[] {
  return machine.protocol === "grbl" ? ["G1 F100", `M3 S${s}`] : [`M3 S${s}`];
}

/** Befehle, um die THC von Hand frei-/zu sperren (null = keine THC eingestellt) */
export function thcLines(on: boolean): string | null {
  if (plasmaSettings.thc === "external") return on ? plasmaSettings.thcOut : "M9";
  if (plasmaSettings.thc === "grblhal") return on ? "M65 P2" : "M64 P2";
  return null;
}

export function initSpindlePanel(log: (s: string) => void) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const rpmIn = $<HTMLInputElement>("sp-rpm");
  const lfPower = $<HTMLInputElement>("lf-power");
  const lfMax = $<HTMLInputElement>("lf-max");

  // ---------------- Werte merken ----------------
  if (rpmIn) {
    rpmIn.value = get(KEY_RPM) || String(Math.min(12000, maxSpindle()));
    rpmIn.addEventListener("change", () => put(KEY_RPM, rpmIn.value));
  }
  const dirSaved = get(KEY_DIR);
  document.querySelectorAll<HTMLInputElement>("input[name=sp-dir]").forEach(r => {
    if (dirSaved) r.checked = r.value === dirSaved;
    r.addEventListener("change", () => { if (r.checked) put(KEY_DIR, r.value); });
  });
  const dir = () => document.querySelector<HTMLInputElement>("input[name=sp-dir]:checked")?.value === "M4" ? "M4" : "M3";
  if (lfPower) {
    lfPower.value = get(KEY_LF_POWER) || "1";
    lfPower.addEventListener("change", () => {
      const v = Math.max(0.1, Math.min(100, parseFloat(lfPower.value) || 1));
      lfPower.value = String(v); put(KEY_LF_POWER, lfPower.value);
    });
  }
  if (lfMax) {
    lfMax.value = get(KEY_LF_MAX) || "5";
    lfMax.addEventListener("change", () => {
      const v = Math.max(1, Math.min(30, Math.round(parseFloat(lfMax.value) || 5)));
      lfMax.value = String(v); put(KEY_LF_MAX, lfMax.value);
    });
  }

  // Befehle nacheinander (Klick-Reihenfolge bleibt erhalten, auch beim schnellen Loslassen)
  let chain: Promise<void> = Promise.resolve();
  const queue = (lines: string[]) => {
    chain = chain.catch(() => {}).then(async () => {
      for (const l of lines) await send(l);
    }).catch(e => log(`${t("log.error")} ${e}`));
    return chain;
  };

  // ---------------- Spindel ----------------
  let spOn: "" | "M3" | "M4" = ""; // zuletzt selbst geschaltet (falls das Board kein "A:" meldet)
  const spindleRunning = (): boolean => {
    const a = machine.status.acc;
    if (a !== null && machine.protocol === "grbl") return /[SC]/.test(a);
    return !!spOn;
  };
  const pausedGrbl = () => machine.job.active && machine.job.paused && machine.protocol === "grbl";

  $("sp-on")?.addEventListener("click", async () => {
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    if (machine.job.active) {
      if (pausedGrbl()) { if (!spindleRunning()) { log(t("sp.resumeInHold")); await realtime(RT.spindleStop); } }
      else log(t("sp.jobRunning"));
      return;
    }
    if (machine.status.state === "Alarm") { log(t("m.unlockFirst")); return; }
    let rpm = Math.round(parseFloat(rpmIn?.value || "") || 0);
    const max = maxSpindle();
    if (rpm <= 0) { log(t("sp.noRpm")); rpmIn?.focus(); return; }
    if (rpm > max) { log(t("sp.clamped", { rpm, max })); rpm = max; if (rpmIn) rpmIn.value = String(max); }
    spOn = dir();
    await queue([`${spOn} S${rpm}`]);
    updateState();
  });
  $("sp-off")?.addEventListener("click", async () => {
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    if (machine.job.active) {
      if (pausedGrbl()) { if (spindleRunning()) { log(t("sp.stopInHold")); await realtime(RT.spindleStop); } }
      else log(t("sp.jobRunning"));
      return;
    }
    spOn = "";
    await queue(["M5"]);
    updateState();
  });

  // ---------------- Halten zum Feuern (Laser und Plasma) ----------------
  let firing: { btn: HTMLElement; timer: number; tick: number; until: number } | null = null;
  const stopFire = (why?: string) => {
    if (!firing) return;
    const f = firing;
    firing = null;
    clearTimeout(f.timer); clearInterval(f.tick);
    f.btn.classList.remove("firing");
    f.btn.querySelector(".sp-count")?.remove();
    if (why) log(why);
    if (machine.connected) queue(["M5"]);
  };
  const startFire = (btn: HTMLElement, lines: string[], maxMs: number, doneMsg?: string) => {
    if (firing) return;
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    if (!canCommand() || machine.job.active) { log(t("sp.jobRunning")); return; }
    if (machine.status.state && machine.status.state !== "Idle") { log(t("m.jogNotIdle", { s: machine.status.state })); return; }
    const until = performance.now() + maxMs;
    firing = {
      btn, until,
      timer: window.setTimeout(() => stopFire(doneMsg ?? t("lf.timeout", { s: Math.round(maxMs / 1000) })), maxMs),
      tick: window.setInterval(() => {
        const c = btn.querySelector(".sp-count");
        if (c) c.textContent = ` ${Math.max(0, (until - performance.now()) / 1000).toFixed(1)} s`;
      }, 100)
    };
    btn.classList.add("firing");
    const c = document.createElement("span"); c.className = "sp-count"; btn.appendChild(c);
    queue(lines);
  };
  const holdButton = (id: string, begin: (btn: HTMLElement) => void) => {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener("pointerdown", (e) => {
      if ((e as PointerEvent).button !== 0) return;
      e.preventDefault();
      try { btn.setPointerCapture((e as PointerEvent).pointerId); } catch { /* egal */ }
      begin(btn);
    });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach(ev => btn.addEventListener(ev, () => stopFire()));
    btn.addEventListener("pointerleave", () => stopFire());
    // Tastatur (Leertaste/Enter) feuert absichtlich nicht – nur echtes Gedrückthalten
    btn.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") e.preventDefault(); });
  };
  holdButton("lf-fire", (btn) => {
    const p = parseFloat(lfPower?.value || "1") || 1;
    const maxMs = Math.max(1, Math.min(30, parseFloat(lfMax?.value || "5") || 5)) * 1000;
    const s = laserTestS(p);
    log(t("lf.firing", { p, s }));
    startFire(btn, fireLines(s), maxMs);
  });
  let torchConfirmed = false;
  holdButton("pl-fire", (btn) => {
    if (!torchConfirmed) {
      // erst bestätigen – danach erneut drücken und halten
      if (!window.confirm(t("pl.fireConfirm"))) return;
      torchConfirmed = true;
      log(t("pl.fireArmed"));
      return;
    }
    startFire(btn, ["M3 S1000"], TORCH_MAX_MS);
  });

  // Pilotzündung: ein Klick, Brenner zündet für die eingestellte Zeit (ohne Werkstück
  // brennt nur der Pilotlichtbogen) – prüft Druckluft, Zündung, Düse/Elektrode und Verkabelung
  const pilotIn = $<HTMLInputElement>("pl-pilot-time");
  const pilotSec = () => Math.max(0.2, Math.min(2, parseFloat(pilotIn?.value || "") || 0.5));
  if (pilotIn) {
    pilotIn.value = get(KEY_PILOT) || "0.5";
    pilotIn.addEventListener("change", () => { pilotIn.value = String(pilotSec()); put(KEY_PILOT, pilotIn.value); });
  }
  $("pl-pilot")?.addEventListener("click", () => {
    const btn = $("pl-pilot")!;
    if (firing) return;
    if (!torchConfirmed) {
      if (!window.confirm(t("pl.pilotConfirm"))) return;
      torchConfirmed = true;
    }
    const sec = pilotSec();
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    log(t("pl.pilotRun", { s: sec }));
    startFire(btn, ["M3 S1000"], sec * 1000, t("pl.pilotDone"));
  });
  // Fenster verliert den Fokus, Seite versteckt, Verbindung weg -> sofort aus
  window.addEventListener("blur", () => stopFire());
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopFire(); });

  // ---------------- THC von Hand ----------------
  let thcManual: boolean | null = null;
  const thcActive = (): boolean | null => {
    if (plasmaSettings.thc === "external" && machine.status.acc !== null && machine.protocol === "grbl") {
      return machine.status.acc.includes(plasmaSettings.thcOut === "M7" ? "M" : "F");
    }
    return thcManual;
  };
  const thcSwitch = async (on: boolean) => {
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    const l = thcLines(on);
    if (!l) { log(t("thc.manualNone")); return; }
    if (!canCommand()) { log(t("sp.jobRunning")); return; }
    thcManual = on;
    await queue([l]);
    updateState();
  };
  $("thc-on")?.addEventListener("click", () => thcSwitch(true));
  $("thc-off")?.addEventListener("click", () => thcSwitch(false));

  // ---------------- Override-Schieberegler ----------------
  const sliders: { el: HTMLInputElement; idx: number; kind: "feed" | "spindle"; label: string; timer: number; busy: boolean; pending: boolean }[] = [];
  const bindSlider = (id: string, kind: "feed" | "spindle", label: string, idx: number) => {
    const el = $<HTMLInputElement>(id);
    if (!el) return;
    const s = { el, idx, kind, label, timer: 0, busy: false, pending: false };
    sliders.push(s);
    const show = () => { const l = $(label); if (l) l.textContent = `${el.value}%`; };
    const apply = () => {
      clearTimeout(s.timer);
      s.pending = false;
      if (!machine.connected) { log(t("conn.connectFirst")); el.value = String(machine.status.ov[idx]); show(); return; }
      setOverride(kind, parseInt(el.value, 10)).catch(e => log(`${t("log.error")} ${e}`));
    };
    el.addEventListener("pointerdown", () => { s.busy = true; });
    el.addEventListener("pointerup", () => { s.busy = false; });
    el.addEventListener("input", () => { show(); clearTimeout(s.timer); s.pending = true; s.timer = window.setTimeout(apply, 150); });
    el.addEventListener("change", () => { s.busy = false; apply(); });
    // Doppelklick: zurück auf 100 %
    el.addEventListener("dblclick", () => { el.value = "100"; show(); apply(); });
  };
  bindSlider("ov-feed-slider", "feed", "ov-feed-val", 0);
  bindSlider("ov-spindle-slider", "spindle", "ov-spindle-val", 2);

  // ---------------- Anzeige ----------------
  const setChip = (el: HTMLElement | null, text: string, on: boolean | null) => {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("sp-on", on === true);
    el.classList.toggle("sp-off", on !== true);
  };
  function updateState() {
    const conn = machine.connected;
    // Spindel
    const max = maxSpindle();
    const mx = $("sp-max");
    if (mx) mx.textContent = t("sp.max", { max });
    if (rpmIn) rpmIn.max = String(max);
    const run = conn && spindleRunning();
    const a = machine.status.acc || "";
    const ccw = machine.protocol === "grbl" && machine.status.acc !== null ? a.includes("C") : spOn === "M4";
    const sNow = Math.round(machine.status.spindle || 0);
    setChip($("sp-state"),
      !conn ? t("sp.off") : run ? t(ccw ? "sp.runCcw" : "sp.runCw", { s: sNow || (rpmIn?.value ?? "") }) : t("sp.off"), run);
    const canNow = conn && (canCommand() || pausedGrbl());
    ["sp-on", "sp-off"].forEach(id => { const b = $<HTMLButtonElement>(id); if (b) b.disabled = !canNow; });
    // Laser / Brenner
    ["lf-fire", "pl-fire", "pl-pilot"].forEach(id => { const b = $<HTMLButtonElement>(id); if (b) b.disabled = !conn || !canCommand() || machine.job.active; });
    // THC
    const thc = plasmaSettings.thc;
    const act = conn ? thcActive() : null;
    setChip($("thc-state"),
      thc === "none" ? t("thc.stateNone") : act === true ? t("thc.stateOn") : act === false ? t("thc.stateOff") : t("thc.stateUnknown"), act);
    ["thc-on", "thc-off"].forEach(id => { const b = $<HTMLButtonElement>(id); if (b) b.disabled = !conn || thc === "none" || !canCommand(); });
    const h = $("thc-manual-hint");
    if (h) h.textContent = t("thc.manual." + thc, { out: plasmaSettings.thcOut });
    // Schieberegler dem Board folgen lassen (außer während man zieht)
    for (const s of sliders) {
      s.el.disabled = !conn;
      if (s.busy || s.pending) continue;
      const v = machine.status.ov[s.idx];
      if (typeof v === "number" && String(v) !== s.el.value) s.el.value = String(v);
      const l = $(s.label);
      if (l) l.textContent = `${s.el.value}%`;
    }
  }

  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type } = (e as CustomEvent).detail || {};
    if (type === "disconnected") { stopFire(); spOn = ""; thcManual = null; }
    if (type === "connected") { spOn = ""; thcManual = null; }
    if (type === "status" || type === "connected" || type === "disconnected" || type === "welcome"
      || type === "job-progress" || type === "job-done" || type === "setting") updateState();
    // Job startet -> Laser-/Brenner-Test sofort beenden
    if (type === "job-progress" && machine.job.active) stopFire();
  });
  window.addEventListener("cnc-thc-changed", updateState);
  window.addEventListener("cnc-language-changed", updateState);
  window.addEventListener("cnc-machine-profile-changed", updateState);
  window.addEventListener("cnc-protocol-changed", updateState);
  updateState();
}
