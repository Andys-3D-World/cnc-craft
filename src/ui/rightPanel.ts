/**
 * RECHTE SEITE: Job-Leiste (immer sichtbar), drei Reiter, Konsole (unten, zu Beginn zugeklappt)
 *
 *   Job-Leiste – Zustand, Fortschritt, „Zur Maschine“, Start/Pause/Stopp: egal, welcher Reiter offen ist
 *   Objekt     – Lage/Größe der Auswahl, Werkzeug, Bahn-Korrektur, Frästiefe; Selteneres unter „Erweitert“
 *   Auftrag    – Simulation, G-Code speichern/laden, Werkzeuge im Auftrag, alles was für alle Formen gilt, Nullpunkt, Arbeitsraum
 *   Maschine   – Position, Verbindung (klappt nach dem Verbinden zu), manuelle Fahrt, Maschine (Entsperren, Referenzfahrt …),
 *                Spindel/Laser/Brenner mit Overrides (spindlePanel.ts), Antasten
 *   Objekt ohne Auswahl: nur Ebenen + Hinweis (Abschnitte .needs-sel sind dann versteckt)
 */
import { icon } from "./icons";
import { t, T, tip, ph } from "../i18n/i18n";
import { toolPickerHtml, toolSummaryHtml } from "./toolPicker";
import { millProfilePickerHtml } from "./millProfilePicker";
import { opsPanelHtml } from "./opsPanel";
import { modeSwitchHtml, laserLayersHtml, laserSettingsHtml } from "./laserPanel";
import { rotarySectionHtml } from "./rotaryPanel";
import { plasmaCutsHtml, plasmaSettingsHtml } from "./plasmaPanel";
import { stockSectionHtml } from "./stockPanel";
import { machineLineHtml } from "./machineWizard";
import { spindlePanelHtml } from "./spindlePanel";
import { probePanelHtml } from "./probePanel";
import { pinLedsHtml } from "./pinLeds";
import { workshopPanelHtml } from "./workshopPanel";
import { gamepadPanelHtml } from "./gamepadPanel";
import { wcsRowHtml } from "./wcsPanel";
import { macroPanelHtml } from "./macroPanel";
import { vfdPanelHtml } from "./vfdPanel";
import { setSectionOpen } from "../ui";
import { MACHINE_EVENT } from "../machine";
import { feedAdapt, loadFeedAdapt, saveFeedAdapt, clampPct } from "../feedAdapt";
import { arcFit, loadArcFit, saveArcFit, clampArcTol } from "../arcFit";

const CONSOLE_KEY = "cnc_craft_console_collapsed";
const ADV_KEY = "cnc_craft_mill_advanced";
/** Meldungen, bei denen die zugeklappte Konsole von selbst aufgeht (alle Sprachen) */
const ERROR_RE = /error|fehler|erreur|errore|fout|błąd|alarm|⚠|❌|⛔/i;

export function renderRightPanel(container: HTMLElement) {
  container.innerHTML = `
    ${modeSwitchHtml()}
    <div class="job-bar" id="job-bar">
      <div class="m-state-row">
        <span id="machine-state" class="m-state m-state-off">${T("m.state.Offline")}</span>
        <span id="job-progress-label" class="job-label">${T("rp.noJob")}</span>
        <span id="machine-fs" class="m-fs"></span>
      </div>
      <div id="machine-alarm" class="m-alarm" style="display:none;"></div>
      <div id="job-progress-track" style="height: 5px; border-radius: 3px; overflow: hidden;">
        <div id="job-progress-bar" style="height: 100%; width: 0%; transition: width 0.2s;"></div>
      </div>
      <div class="job-bar-btns">
        <button id="btn-to-machine" class="btn-primary job-main" ${tip("rp.toMachineTip")}>🚀 ${T("rp.toMachine")}</button>
        <button id="btn-job-start" class="btn-secondary">▶ ${T("rp.start")}</button>
        <button id="btn-job-pause" class="btn-secondary job-icon" ${tip("m.pauseTip")}>⏸</button>
        <button id="btn-job-stop" class="btn-secondary job-stop" ${tip("rp.stopTip")}>⏹ ${T("rp.stop")}</button>
        <button id="btn-job-resume" class="btn-secondary job-icon" ${tip("res.btnTip")}>⏭</button>
      </div>
    </div>
    <div class="rp-tabs">
      <button class="rp-tab active" data-rp="rp-object">${T("rp.tabObject")}</button>
      <button class="rp-tab" data-rp="rp-cam">${T("rp.tabJob")}</button>
      <button class="rp-tab" data-rp="rp-machine">${T("rp.tabMachine")}</button>
    </div>

    <div class="rp-scroll">

      <!-- ================= REITER: OBJEKT ================= -->
      <div id="rp-object" class="rp-page active">
        ${laserLayersHtml()}
        ${plasmaCutsHtml()}
        <div class="rp-nosel">${T("rp.noSel")}</div>
        <div class="menu-section-unified needs-sel">
          <h3 class="menu-trigger">${T("rp.properties")}</h3>
          <div class="menu-body rp-box">
            <div class="prop-row">${T("rp.centerX")}<input type="number" id="dim-x" class="prop-input"></div>
            <div class="prop-row">${T("rp.centerY")}<input type="number" id="dim-y" class="prop-input"></div>
            <div class="prop-row">${T("rp.width")}<input type="number" id="dim-w" class="prop-input"></div>
            <div class="prop-row">${T("rp.height")}<input type="number" id="dim-h" class="prop-input"></div>
            <label class="prop-row" style="cursor: pointer;"><span>🔒 ${T("rp.lockRatio")}</span><input type="checkbox" id="dim-lock-ratio" checked style="width: auto;"></label>
            <div class="prop-row" ${tip("rp.rotateTip")}>${T("rp.rotate")}<input type="number" id="dim-angle" value="0" step="15" class="prop-input"></div>
          </div>
        </div>

        ${toolPickerHtml()}

        <div class="menu-section-unified mill-plasma needs-sel">
          <h3 class="menu-trigger">${T("rp.pathMode")}</h3>
          <div class="menu-body rp-grid2">
            <button id="cam-mode-part" class="btn-secondary" ${tip("rp.modeOutsideTip")}>🔷 ${T("rp.modeOutside")}</button>
            <button id="cam-mode-hole" class="btn-secondary" ${tip("rp.modeInsideTip")}>🕳️ ${T("rp.modeInside")}</button>
            <button id="cam-mode-engrave" class="btn-secondary" ${tip("rp.modeOnLineTip")}>✒️ ${T("rp.modeOnLine")}</button>
            <button id="cam-mode-pocket" class="btn-secondary" ${tip("rp.modePocketTip")}>🔲 ${T("rp.modePocket")}</button>
            <button id="cam-mode-vcarve" class="btn-secondary only-mill" ${tip("rp.modeVcarveTip")}>🔻 ${T("rp.modeVcarve")}</button>
            <button id="cam-mode-drill" class="btn-secondary only-mill" ${tip("rp.modeDrillTip")}>🔩 ${T("rp.modeDrill")}</button>
            <button id="cam-mode-face" class="btn-secondary only-mill" ${tip("rp.modeFaceTip")}>🪵 ${T("rp.modeFace")}</button>
            <button id="cam-inlay" class="btn-secondary only-mill" ${tip("rp.inlayTip")}>🧩 ${T("rp.inlay")}</button>
          </div>
        </div>

        ${opsPanelHtml()}

        <div class="menu-section-unified only-mill">
          <h3 class="menu-trigger">${T("rp.millParams")}</h3>
          <div class="menu-body rp-box">
            ${millProfilePickerHtml()}
            <div class="prop-row" style="color: var(--color-warning); font-weight: 700;">${T("rp.depth")}<input type="number" id="dim-depth" value="-2.0" step="0.5" class="prop-input" style="border-color: var(--color-warning);"></div>
            <details class="rp-adv needs-sel" id="rp-adv-mill">
              <summary>${T("rp.advanced")}</summary>
              <div class="rp-adv-body">
            <div class="prop-row" ${tip("rp.finishTip")}>${T("rp.finish")}<input type="number" id="dim-finish" value="0" min="0" max="5" step="0.05" class="prop-input"></div>
            <div class="prop-row" ${tip("rp.millDirTip")}>${T("rp.millDir")}
              <select id="dim-mill-dir" class="prop-input" style="width: 110px;">
                <option value="" data-i18n="rp.millDir.default">${t("rp.millDir.default")}</option>
                <option value="climb" data-i18n="rp.millDir.climb">${t("rp.millDir.climb")}</option>
                <option value="conventional" data-i18n="rp.millDir.conventional">${t("rp.millDir.conventional")}</option>
              </select>
            </div>
            <label class="prop-row" style="cursor:pointer;" ${tip("rp.leadTip")}>${T("rp.leadIn")}<input type="checkbox" id="dim-lead-in" style="width:auto;"></label>
            <label class="prop-row" style="cursor:pointer;" ${tip("rp.leadTip")}>${T("rp.leadOut")}<input type="checkbox" id="dim-lead-out" style="width:auto;"></label>
            <div class="prop-row" id="dim-lead-opts" ${tip("rp.leadTip")}>${T("rp.leadSize")}
              <span style="display:flex;gap:4px;align-items:center;">
                <select id="dim-lead-type" class="prop-input" style="width: 74px;">
                  <option value="arc" data-i18n="rp.leadArc">${t("rp.leadArc")}</option>
                  <option value="line" data-i18n="rp.leadLine">${t("rp.leadLine")}</option>
                </select>
                <input type="number" id="dim-lead-len" value="3" min="0.1" max="50" step="0.5" class="prop-input" style="width: 54px;">
              </span>
            </div>
              </div>
            </details>
          </div>
        </div>

        <!-- Haltestege: Fräse (mit Höhe), Laser und Plasma (Werkzeug über dem Steg aus) -->
        <div class="menu-section-unified needs-sel">
          <h3 class="menu-trigger">${T("rp.tabsTitle")}</h3>
          <div class="menu-body rp-box">
            <div class="prop-row" ${tip("rp.tabsModeTip")}>${T("rp.tabsMode")}
              <select id="dim-tab-mode" class="prop-input" style="width: 110px;">
                <option value="auto">${T("rp.tabsAuto")}</option>
                <option value="manual">${T("rp.tabsManual")}</option>
              </select>
            </div>
            <div class="prop-row" ${tip("rp.tabsTip")}>${T("rp.tabsN")}<input type="number" id="dim-tab-n" value="0" min="0" max="50" step="1" class="prop-input"></div>
            <button id="btn-tab-tool" class="btn-secondary" style="width:100%;margin:4px 0;" ${tip("rp.tabsToolTip")}>✋ ${T("rp.tabsTool")}</button>
            <div class="prop-row" ${tip("rp.tabsTip")}>${T("rp.tabsLen")}<input type="number" id="dim-tab-w" value="5" min="0.5" step="0.5" class="prop-input"></div>
            <div class="prop-row only-mill" ${tip("rp.tabsTip")}>${T("rp.tabsH")}<input type="number" id="dim-tab-h" value="1.5" min="0.1" step="0.5" class="prop-input"></div>
          </div>
        </div>
      </div>

      <!-- ================= REITER: FRÄSEN ================= -->
      <div id="rp-cam" class="rp-page">
        <div class="menu-section-unified">
          <h3 class="menu-trigger">${T("rp.gcode")}</h3>
          <div class="menu-body" style="display: flex; flex-direction: column; gap: 6px;">
            <button id="btn-simulate" class="btn-secondary" ${tip("rp.simulateTip")}>🎬 ${T("rp.simulate")}</button>
            <button id="btn-cost" class="btn-secondary" ${tip("cost.tip")}>💶 ${T("cost.button")}</button>
            <button id="btn-save-gcode" class="btn-secondary" ${tip("rp.saveGcodeTip")}>💾 ${T("rp.saveGcode")}</button>
            <button id="btn-save-rd" class="btn-secondary only-ruida" ${tip("rd.saveTip")}>💾 ${T("rd.save")}</button>
            <div style="display: flex; gap: 5px;">
              <button id="btn-load-gcode" class="btn-secondary" style="flex: 1;" ${tip("rp.loadGcodeTip")}>📂 ${T("rp.loadGcode")}</button>
              <button id="btn-sim-job" class="btn-secondary" ${tip("rp.simJobTip")}>🎬</button>
            </div>
          </div>
        </div>

        ${toolSummaryHtml()}
        ${stockSectionHtml()}
        ${laserSettingsHtml()}
        ${rotarySectionHtml()}
        ${plasmaSettingsHtml()}

        <div class="menu-section-unified only-mill">
          <h3 class="menu-trigger">${T("rp.gcodeAdv")}</h3>
          <div class="menu-body rp-box">
            <div class="prop-row" ${tip("rp.pocketStrategyTip")}>${T("rp.pocketStrategy")}
              <select id="dim-pocket-strategy" class="prop-input" style="width: 90px;">
                <option value="linear" data-i18n="rp.pocketParallel">Parallel</option>
                <option value="spiral" data-i18n="rp.pocketContour">Kontur</option>
                <option value="adaptive" data-i18n="rp.pocketAdaptive">Adaptiv</option>
              </select>
            </div>
            <label class="prop-row" style="cursor:pointer;" ${tip("rp.feedAdaptTip")}><span>${T("rp.feedAdapt")}</span><input type="checkbox" id="feed-adapt-on" style="width:auto;"></label>
            <div class="prop-row" ${tip("rp.feedAdaptTip")}>${T("rp.feedAdaptMin")}<input type="number" id="feed-adapt-min" min="10" max="100" step="5" class="prop-input"></div>
            <label class="prop-row" style="cursor:pointer;" ${tip("rp.arcFitTip")}><span>${T("rp.arcFit")}</span><input type="checkbox" id="arc-fit-on" style="width:auto;"></label>
            <div class="prop-row" ${tip("rp.arcFitTip")}>${T("rp.arcFitTol")}<input type="number" id="arc-fit-tol" min="0.001" max="0.1" step="0.005" class="prop-input"></div>
          </div>
        </div>

        <div class="menu-section-unified">
          <h3 class="menu-trigger">${T("rp.origin")}</h3>
          <div class="menu-body">
            <div class="rp-grid2 rp-box" style="font-size: 0.78rem;">
              <label><input type="radio" name="origin-select" value="top-left"> ${T("rp.originTL")}</label>
              <label><input type="radio" name="origin-select" value="top-right"> ${T("rp.originTR")}</label>
              <label><input type="radio" name="origin-select" value="bottom-left" checked> ${T("rp.originBL")}</label>
              <label><input type="radio" name="origin-select" value="bottom-right"> ${T("rp.originBR")}</label>
            </div>
          </div>
        </div>

        <div class="menu-section-unified">
          <h3 class="menu-trigger">${T("rp.workArea")}</h3>
          <div class="menu-body rp-box">
            ${machineLineHtml()}
            <div class="prop-row">${T("rp.bedW")}<input type="number" id="bed-w" value="300" class="prop-input"></div>
            <div class="prop-row">${T("rp.bedH")}<input type="number" id="bed-h" value="300" class="prop-input"></div>
            <button id="btn-sync-bed" class="btn-secondary btn-compact" style="font-size: 0.75rem;">🤖 ${T("rp.syncBed")}</button>
          </div>
        </div>
      </div>

      <!-- ================= REITER: MASCHINE ================= -->
      <div id="rp-machine" class="rp-page">
        <div class="m-dock">
            <div class="dro">
              <div style="color: #ff5757;">X <span id="pos-x">0.00</span></div>
              <div style="color: #34d17b;">Y <span id="pos-y">0.00</span></div>
              <div style="color: var(--lt-amber, #ffc043);">Z <span id="pos-z">0.00</span></div>
            </div>
        </div>

        <div class="menu-section-unified">
          <h3 class="menu-trigger">${T("rp.connection")}</h3>
          <div class="menu-body rp-box">
            <div id="m-slots" class="m-slots" style="display: none;"></div>
            <div style="display: flex; gap: 4px;">
              <select id="port-select" style="flex: 1; min-width: 0; font-size: 0.78rem; padding: 4px;" ${tip("m.portTip")}>
                <option value="" data-i18n="rp.scanPorts">Ports scannen...</option>
              </select>
              <button id="scan-btn" class="btn-secondary btn-icon" ${tip("m.scanTip")}>🔍</button>
              <button id="usb-find-btn" class="btn-secondary btn-icon not-ruida not-k40" ${tip("usb.findTip")}>🧭</button>
            </div>
            <div style="display: flex; gap: 4px;">
              <input type="text" id="ruida-ip" style="flex: 1; min-width: 0; font-size: 0.78rem; padding: 4px; display: none;" placeholder="192.168.1.100" ${tip("m.ruidaIpTip")}>
              <button id="net-find-btn" class="btn-secondary btn-icon" style="display: none;" ${tip("net.findTip")}>📡</button>
              <select id="baud-select" class="not-ruida not-k40" style="flex: 1; min-width: 0; font-size: 0.78rem; padding: 4px;" ${tip("m.baudTip")}>
                <option value="115200">115200 Baud</option>
                <option value="250000">250000 Baud</option>
                <option value="230400">230400 Baud</option>
                <option value="57600">57600 Baud</option>
                <option value="9600">9600 Baud</option>
              </select>
              <button id="connect-btn" class="btn-primary" style="flex: 1; padding: 4px; font-size: 0.8rem;">🔌 ${T("rp.connect")}</button>
            </div>
            <label class="prop-row not-k40" style="cursor:pointer;" ${tip("conn.autoBedTip")}><span>📐 ${T("conn.autoBed")}</span><input type="checkbox" id="conn-auto-bed" checked style="width:auto;"></label>
            <label class="prop-row not-ruida not-k40" style="cursor:pointer;" ${tip("conn.autoHomeTip")}><span>⌂ ${T("conn.autoHome")}</span><input type="checkbox" id="conn-auto-home" style="width:auto;"></label>
            <div id="net-find-list" class="net-find" style="display: none;"></div>
            <button id="wifi-setup-btn" class="btn-secondary btn-compact" style="display: none;" ${tip("wifi.btnTip")}>📶 ${T("wifi.title")}</button>
            <div id="machine-info" class="tool-scope"></div>
            ${machineLineHtml()}
          </div>
        </div>

        <div class="menu-section-unified">
          <h3 class="menu-trigger">${T("rp.jog")}</h3>
          <div class="menu-body">
            <div style="display: flex; gap: 4px; margin-bottom: 8px;">
              <button class="btn-step" data-step="0.1">0.1</button>
              <button class="btn-step active" data-step="1">1mm</button>
              <button class="btn-step" data-step="10">10mm</button>
              <button class="btn-step" data-step="100">100</button>
              <input type="number" id="jog-step-custom" placeholder="mm" style="width: 48px; padding: 2px; font-size: 0.75rem; text-align: center;">
            </div>
            <div style="display: flex; gap: 14px; align-items: center; justify-content: center; margin-bottom: 5px;">
              <div style="width: 140px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px;">
                <button class="btn-jog btn-diag" data-cmd="X-1 Y1">↖</button>
                <button id="jog-y-plus" class="btn-jog" data-cmd="Y1">Y+</button>
                <button class="btn-jog btn-diag" data-cmd="X1 Y1">↗</button>
                <button id="jog-x-minus" class="btn-jog" data-cmd="X-1">X−</button>
                <button id="jog-home" class="btn-jog btn-home" ${tip("m.jogStopTip")}>■</button>
                <button id="jog-x-plus" class="btn-jog" data-cmd="X1">X+</button>
                <button class="btn-jog btn-diag" data-cmd="X-1 Y-1">↙</button>
                <button id="jog-y-minus" class="btn-jog" data-cmd="Y-1">Y−</button>
                <button class="btn-jog btn-diag" data-cmd="X1 Y-1">↘</button>
              </div>
              <div class="not-ruida not-k40" style="width: 1px; height: 110px; background: var(--border-color);"></div>
              <div class="not-ruida not-k40" style="display: flex; flex-direction: column; gap: 8px; width: 50px;">
                <button class="btn-jog btn-z" data-cmd="Z1">Z+</button>
                <button class="btn-jog btn-z" data-cmd="Z-1">Z−</button>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; padding: 2px 4px;">
              <input type="range" id="jog-feed-slider" min="100" max="5000" step="100" value="1000" style="flex: 1; min-width: 0; accent-color: var(--accent-color);">
              <span id="jog-feed-display" style="font-size: 0.72rem; font-family: var(--font-mono); color: var(--text-muted); width: 80px; text-align: right;">1000 mm/min</span>
            </div>
          </div>
        </div>

        <div class="menu-section-unified">
          <h3 class="menu-trigger">${T("m.statusSection")}</h3>
          <div class="menu-body rp-box">
            <div id="machine-mpos" class="tool-scope m-mpos"></div>
            ${pinLedsHtml()}
            <div class="m-btn-grid">
              <button id="m-unlock" class="btn-secondary not-ruida" ${tip("m.unlockTip")}>🔓 ${T("m.unlock")}</button>
              <button id="m-home" class="btn-secondary" ${tip("m.homeTip")}>⌂ ${T("m.home")}</button>
              <button id="m-reset" class="btn-secondary" ${tip("m.resetTip")}>⟲ ${T("m.reset")}</button>
              <button id="m-zero-xy" class="btn-secondary not-ruida not-k40" ${tip("m.zeroXYTip")}>◎ XY=0</button>
              <button id="m-zero-z" class="btn-secondary not-ruida not-k40" ${tip("m.zeroZTip")}>⊥ Z=0</button>
              <button id="m-goto-zero" class="btn-secondary" ${tip("m.gotoZeroTip")}>➜ 0,0</button>
            </div>
            ${wcsRowHtml()}
          </div>
        </div>

        <div class="menu-section-unified">
          <h3 class="menu-trigger">${T("rp.positionJob")}</h3>
          <div class="menu-body rp-box">
            <button id="btn-job-frame" class="btn-secondary only-laser" ${tip("frame.tip")}>▢ ${T("frame.btn")}</button>
            <button id="btn-job-here" class="btn-secondary not-ruida not-k40" ${tip("jobhere.tip")}>${icon("jobHere", 14)} ${T("jobhere.title")}</button>
            <button id="btn-setup-sheet" class="btn-secondary" ${tip("sheet.tip")}>📋 ${T("sheet.btn")}</button>
          </div>
        </div>

        ${macroPanelHtml()}

        ${spindlePanelHtml()}

        ${vfdPanelHtml()}

        ${probePanelHtml()}

        ${workshopPanelHtml()}

        ${gamepadPanelHtml()}

      </div>
    </div>

    <!-- ================= KONSOLE (immer sichtbar) ================= -->
    <div class="rp-console" id="rp-console">
      <div class="rp-console-head" id="rp-console-toggle" ${tip("rp.consoleTip")}>
        ${icon("console", 15)} ${T("rp.console")}<span class="rp-console-last" id="rp-console-last"></span><span class="rp-console-new" id="rp-console-new"></span><span class="rp-console-arrow">▾</span>
      </div>
      <div class="rp-console-body">
        <div id="console-log">
          <p class="system-msg">${t("rp.ready")}</p>
        </div>
        <div class="rp-console-input">
          <input type="text" id="cmd-input" ${ph("rp.cmdPh")}>
          <button id="send-cmd-btn" class="btn-primary">${T("rp.send")}</button>
        </div>
      </div>
    </div>
  `;

  // Vorschub in Kurven anpassen (gemerkt, gilt für alle Formen)
  loadFeedAdapt();
  loadArcFit();
  const afOn = container.querySelector<HTMLInputElement>("#arc-fit-on")!, afTol = container.querySelector<HTMLInputElement>("#arc-fit-tol")!;
  const afShow = () => { afOn.checked = arcFit.on; afTol.value = String(arcFit.tol); afTol.disabled = !arcFit.on; };
  afShow();
  afOn.addEventListener("change", () => { arcFit.on = afOn.checked; saveArcFit(); afShow(); });
  afTol.addEventListener("change", () => { const v = parseFloat(afTol.value); if (Number.isFinite(v) && v > 0) arcFit.tol = clampArcTol(v); saveArcFit(); afShow(); });
  const faOn = container.querySelector<HTMLInputElement>("#feed-adapt-on")!, faMin = container.querySelector<HTMLInputElement>("#feed-adapt-min")!;
  const faShow = () => { faOn.checked = feedAdapt.on; faMin.value = String(feedAdapt.minPct); faMin.disabled = !feedAdapt.on; };
  faShow();
  faOn.addEventListener("change", () => { feedAdapt.on = faOn.checked; saveFeedAdapt(); faShow(); });
  faMin.addEventListener("change", () => { const v = parseFloat(faMin.value); if (Number.isFinite(v)) feedAdapt.minPct = clampPct(v); saveFeedAdapt(); faShow(); });

  // „Erweitert“ offen oder zu: gemerkt
  const adv = container.querySelector<HTMLDetailsElement>("#rp-adv-mill")!;
  try { adv.open = localStorage.getItem(ADV_KEY) === "1"; } catch { /* egal */ }
  adv.addEventListener("toggle", () => { try { localStorage.setItem(ADV_KEY, adv.open ? "1" : "0"); } catch { /* egal */ } });

  // Reiter umschalten
  const tabs = container.querySelectorAll<HTMLButtonElement>(".rp-tab");
  tabs.forEach(t => t.addEventListener("click", () => {
    tabs.forEach(x => x.classList.toggle("active", x === t));
    container.querySelectorAll(".rp-page").forEach(p => p.classList.toggle("active", p.id === t.dataset.rp));
  }));

  // Konsole ein-/ausklappen (gemerkt). Zugeklappt: Zähler für neue Meldungen, bei Fehlern/Alarm geht sie von selbst auf
  const con = container.querySelector<HTMLElement>("#rp-console")!;
  const badge = container.querySelector<HTMLElement>("#rp-console-new")!;
  let unseen = 0;
  const setCollapsed = (c: boolean) => {
    con.classList.toggle("collapsed", c);
    if (!c) { unseen = 0; badge.textContent = ""; }
    try { localStorage.setItem(CONSOLE_KEY, c ? "1" : "0"); } catch { /* egal */ }
  };
  // Zu Beginn zugeklappt: die letzte Meldung steht in der Kopfzeile, bei Fehlern geht sie von selbst auf
  let startCollapsed = true;
  try { startCollapsed = localStorage.getItem(CONSOLE_KEY) !== "0"; } catch { /* egal */ }
  con.classList.toggle("collapsed", startCollapsed);
  container.querySelector("#rp-console-toggle")!.addEventListener("click", () => setCollapsed(!con.classList.contains("collapsed")));
  const log = container.querySelector("#console-log");
  const lastLine = container.querySelector<HTMLElement>("#rp-console-last")!;
  lastLine.textContent = t("rp.ready");
  if (log) new MutationObserver(recs => {
    const added = recs.flatMap(r => [...r.addedNodes]).map(n => n.textContent || "");
    if (!added.length) return;
    const text = added.join("\n").split("\n").map(l => l.trim()).filter(Boolean).pop();
    if (text) lastLine.textContent = text; // nur als Text: Meldungen können Antworten vom Board enthalten
    if (!con.classList.contains("collapsed")) return;
    if (added.some(x => ERROR_RE.test(x))) { setCollapsed(false); log.scrollTop = log.scrollHeight; return; }
    unseen += added.length;
    badge.textContent = String(Math.min(unseen, 99)) + (unseen > 99 ? "+" : "");
  }).observe(log, { childList: true });

  // Verbindung: nach dem Verbinden zuklappen, nach dem Trennen wieder aufklappen (nicht gemerkt)
  window.addEventListener(MACHINE_EVENT, e => {
    const ty = (e as CustomEvent).detail?.type;
    if (ty === "connected") setSectionOpen("rp.connection", false);
    else if (ty === "disconnected") setSectionOpen("rp.connection", true);
  });

  // Aktiv-Markierung für die Bahn-Korrektur-Knöpfe
  ["part", "hole", "engrave", "pocket", "vcarve", "drill", "face"].forEach(mode => {
    const btn = container.querySelector(`#cam-mode-${mode}`);
    btn?.addEventListener("click", () => {
      container.querySelectorAll("#cam-mode-part, #cam-mode-hole, #cam-mode-engrave, #cam-mode-pocket, #cam-mode-vcarve, #cam-mode-drill, #cam-mode-face")
        .forEach(b => b.classList.remove("cam-mode-active"));
      btn.classList.add("cam-mode-active");
    });
  });
}
