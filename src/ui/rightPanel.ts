/**
 * RECHTE SEITE: drei Reiter + Konsole (immer sichtbar unten)
 *
 *   Objekt   – Position/Größe/Drehung der Auswahl, Werkzeug, Bahn-Korrektur, Frästiefe
 *   Fräsen   – G-Code erzeugen/speichern, Werkzeuge im Auftrag, Nullpunkt, Arbeitsraum
 *   Maschine – Verbindung, Position, Job starten/pausieren/stoppen,
 *              Spindel/Laser/Brenner mit Overrides (spindlePanel.ts), manuelle Fahrt
 */
import { icon } from "./icons";
import { t, T, tip, ph } from "../i18n/i18n";
import { toolPickerHtml, toolSummaryHtml } from "./toolPicker";
import { modeSwitchHtml, laserLayersHtml, laserSettingsHtml } from "./laserPanel";
import { plasmaCutsHtml, plasmaSettingsHtml } from "./plasmaPanel";
import { stockSectionHtml } from "./stockPanel";
import { machineLineHtml } from "./machineWizard";
import { spindlePanelHtml } from "./spindlePanel";
import { pinLedsHtml } from "./pinLeds";

export function renderRightPanel(container: HTMLElement) {
  container.innerHTML = `
    ${modeSwitchHtml()}
    <div class="rp-tabs">
      <button class="rp-tab active" data-rp="rp-object">${T("rp.tabObject")}</button>
      <button class="rp-tab" data-rp="rp-cam"><span class="only-mill">${T("rp.tabCam")}</span><span class="only-laser">${T("rp.tabLaser")}</span><span class="only-plasma">${T("rp.tabPlasma")}</span></button>
      <button class="rp-tab" data-rp="rp-machine">${T("rp.tabMachine")}</button>
    </div>

    <div class="rp-scroll">

      <!-- ================= REITER: OBJEKT ================= -->
      <div id="rp-object" class="rp-page active">
        ${laserLayersHtml()}
        ${plasmaCutsHtml()}
        <div class="menu-section-unified">
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

        <div class="menu-section-unified mill-plasma">
          <h3 class="menu-trigger">${T("rp.pathMode")}</h3>
          <div class="menu-body rp-grid2">
            <button id="cam-mode-part" class="btn-secondary" ${tip("rp.modeOutsideTip")}>🔷 ${T("rp.modeOutside")}</button>
            <button id="cam-mode-hole" class="btn-secondary" ${tip("rp.modeInsideTip")}>🕳️ ${T("rp.modeInside")}</button>
            <button id="cam-mode-engrave" class="btn-secondary" ${tip("rp.modeOnLineTip")}>✒️ ${T("rp.modeOnLine")}</button>
            <button id="cam-mode-pocket" class="btn-secondary" ${tip("rp.modePocketTip")}>🔲 ${T("rp.modePocket")}</button>
          </div>
        </div>

        <div class="menu-section-unified only-mill">
          <h3 class="menu-trigger">${T("rp.millParams")}</h3>
          <div class="menu-body rp-box">
            <div class="prop-row" style="color: var(--color-warning); font-weight: 700;">${T("rp.depth")}<input type="number" id="dim-depth" value="-2.0" step="0.5" class="prop-input" style="border-color: var(--color-warning);"></div>
            <div class="prop-row">${T("rp.tabs")}<input type="number" id="dim-tab-w" value="1.5" step="0.5" class="prop-input"></div>
            <div class="prop-row">${T("rp.pocketStrategy")}
              <select id="dim-pocket-strategy" class="prop-input" style="width: 90px;">
                <option value="linear" data-i18n="rp.pocketParallel">Parallel</option>
                <option value="spiral" data-i18n="rp.pocketContour">Kontur</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <!-- ================= REITER: FRÄSEN ================= -->
      <div id="rp-cam" class="rp-page">
        <div class="menu-section-unified">
          <h3 class="menu-trigger">${T("rp.gcode")}</h3>
          <div class="menu-body" style="display: flex; flex-direction: column; gap: 6px;">
            <button id="btn-generate-gcode" class="btn-primary" ${tip("rp.genGcodeTip")}>🚀 ${T("rp.genGcode")}</button>
            <button id="btn-simulate" class="btn-secondary" ${tip("rp.simulateTip")}>🎬 ${T("rp.simulate")}</button>
            <button id="btn-save-gcode" class="btn-secondary" ${tip("rp.saveGcodeTip")}>💾 ${T("rp.saveGcode")}</button>
            <button id="btn-save-rd" class="btn-secondary only-ruida" ${tip("rd.saveTip")}>💾 ${T("rd.save")}</button>
          </div>
        </div>

        ${toolSummaryHtml()}
        ${stockSectionHtml()}
        ${laserSettingsHtml()}
        ${plasmaSettingsHtml()}

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
        <div class="menu-section-unified">
          <h3 class="menu-trigger">${T("rp.connection")}</h3>
          <div class="menu-body rp-box">
            <div id="m-slots" class="m-slots" style="display: none;"></div>
            <div style="display: flex; gap: 4px;">
              <select id="port-select" style="flex: 1; min-width: 0; font-size: 0.78rem; padding: 4px;" ${tip("m.portTip")}>
                <option value="" data-i18n="rp.scanPorts">Ports scannen...</option>
              </select>
              <button id="scan-btn" class="btn-secondary btn-icon" ${tip("m.scanTip")}>🔍</button>
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
            <div id="net-find-list" class="net-find" style="display: none;"></div>
            <button id="wifi-setup-btn" class="btn-secondary btn-compact" style="display: none;" ${tip("wifi.btnTip")}>📶 ${T("wifi.title")}</button>
            <div id="machine-info" class="tool-scope"></div>
            ${machineLineHtml()}
          </div>
        </div>

        <div class="menu-section-unified">
          <h3 class="menu-trigger">${T("m.statusSection")}</h3>
          <div class="menu-body rp-box">
            <div class="m-state-row">
              <span id="machine-state" class="m-state m-state-off">${T("m.state.Offline")}</span>
              <span id="machine-fs" class="m-fs"></span>
            </div>
            <div id="machine-alarm" class="m-alarm" style="display:none;"></div>
            <div class="dro">
              <div style="color: #ff5757;">X <span id="pos-x">0.00</span></div>
              <div style="color: #34d17b;">Y <span id="pos-y">0.00</span></div>
              <div style="color: #ffc043;">Z <span id="pos-z">0.00</span></div>
            </div>
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
          </div>
        </div>

        <div class="menu-section-unified">
          <h3 class="menu-trigger">${T("rp.positionJob")}</h3>
          <div class="menu-body rp-box">
            <div style="display: flex; gap: 5px;">
              <button id="btn-load-gcode" class="btn-secondary" style="flex: 1;" ${tip("rp.loadGcodeTip")}>📂 ${T("rp.loadGcode")}</button>
              <button id="btn-sim-job" class="btn-secondary" ${tip("rp.simJobTip")}>🎬</button>
            </div>
            <div id="job-progress-track" style="height: 8px; border-radius: 4px; overflow: hidden;">
              <div id="job-progress-bar" style="height: 100%; width: 0%; transition: width 0.2s;"></div>
            </div>
            <div id="job-progress-label" style="font-size: 0.7rem; text-align: center; color: var(--text-muted); font-family: var(--font-mono);">${T("rp.noJob")}</div>
            <button id="btn-job-frame" class="btn-secondary only-laser" ${tip("frame.tip")}>▢ ${T("frame.btn")}</button>
            <div style="display: flex; gap: 5px;">
              <button id="btn-job-start" class="btn-primary" style="flex: 1; padding: 6px;">▶ ${T("rp.start")}</button>
              <button id="btn-job-pause" class="btn-secondary" style="flex: 1; padding: 6px;" ${tip("m.pauseTip")}>⏸ ${T("rp.pause")}</button>
              <button id="btn-job-stop" class="btn-secondary" style="flex: 1; padding: 6px; color: var(--color-danger); border-color: var(--color-danger);" ${tip("rp.stopTip")}>⏹ ${T("rp.stop")}</button>
            </div>
          </div>
        </div>

        ${spindlePanelHtml()}

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
      </div>
    </div>

    <!-- ================= KONSOLE (immer sichtbar) ================= -->
    <div class="rp-console" id="rp-console">
      <div class="rp-console-head" id="rp-console-toggle" ${tip("rp.consoleTip")}>
        ${icon("console", 15)} ${T("rp.console")}<span class="rp-console-arrow">▾</span>
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

  // Reiter umschalten
  const tabs = container.querySelectorAll<HTMLButtonElement>(".rp-tab");
  tabs.forEach(t => t.addEventListener("click", () => {
    tabs.forEach(x => x.classList.toggle("active", x === t));
    container.querySelectorAll(".rp-page").forEach(p => p.classList.toggle("active", p.id === t.dataset.rp));
  }));

  // Konsole ein-/ausklappen
  const con = container.querySelector("#rp-console")!;
  container.querySelector("#rp-console-toggle")!.addEventListener("click", () => con.classList.toggle("collapsed"));

  // Aktiv-Markierung für die Bahn-Korrektur-Knöpfe
  ["part", "hole", "engrave", "pocket"].forEach(mode => {
    const btn = container.querySelector(`#cam-mode-${mode}`);
    btn?.addEventListener("click", () => {
      container.querySelectorAll("#cam-mode-part, #cam-mode-hole, #cam-mode-engrave, #cam-mode-pocket")
        .forEach(b => b.classList.remove("cam-mode-active"));
      btn.classList.add("cam-mode-active");
    });
  });
}
