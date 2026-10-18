import { initConnection } from "./connection";
import { initMachine } from "./machine";
import { initStreamEvents } from "./machineStream";
import { initSettingsPage } from "./ui/settingsPage";
import { initFlashPage } from "./ui/flashPage";
import { handleGcodeGeneration, exportGcodeToFile, generateGcode, lastGcodeWarnings, noGcodeMessage } from "./cam";
import { initSimulation, setSimProgram } from "./sim/simulation";
import { streamState } from "./machineStream";
import { drawEverything } from "./render";
import { initCollapsibleMenus } from "./ui";
import { initLightBurnTooltips } from "./tooltips";
import { renderCamPanel, renderEditorToolbar } from "./ui/camPanel";
import { renderRightPanel } from "./ui/rightPanel";
import { initToolLibrary } from "./toolLibrary";
import { initToolPicker, refreshToolPicker } from "./ui/toolPicker";
import { initMachineMode } from "./machineMode";
import { initLaserLayers } from "./laserLayers";
import { initLaserPanel, refreshLaserPanel } from "./ui/laserPanel";
import { initPlasmaCuts } from "./plasmaCuts";
import { initPlasmaPanel, refreshPlasmaPanel } from "./ui/plasmaPanel";
import { initStock } from "./stock";
import { initStockPanel } from "./ui/stockPanel";
import { applySavedMachine, initMachineWizard } from "./ui/machineWizard";
import { initJobTools } from "./ui/jobTools";
import { initSpindlePanel } from "./ui/spindlePanel";
import { initPinLeds } from "./ui/pinLeds";
import { initWiringPage } from "./ui/wiringPage";
import { initAboutDialog } from "./ui/aboutDialog";
import { initSupport } from "./ui/supportTip";
import { attachPanelResizer, attachConsoleResizer } from "./ui/panelResize";
import { initUpdater } from "./update/updater";
import { setupUiInputs } from "./uiInputs";
import { initTabsEngine } from "./tabsEngine";
import { setupToolsHandler } from "./toolsHandler";
import { initMouseEngine } from "./mouseEngine";
import { bindOffsetModes } from "./offsetModes";
import { loadGcodeFromFile, startStreaming, pauseStreaming, stopStreaming } from "./machineStream";
import { drawOverlay } from "./editor/overlay";
import { initHistory } from "./editor/history";
import { initCommands, zoomFit } from "./editor/commands";
import { setTextRedraw } from "./editor/textTool";
import { initImports, importBytes } from "./importers/importManager";
import { initLanguageMenu } from "./ui/languageMenu";
import { renderToolTable, initToolPage } from "./ui/toolEditor";
import { initLibraryTab } from "./ui/libraryTab";
import { initCamera } from "./camera/camera";
import { restoreSettings, startSettingsMirror } from "./settingsStore";
import type { ToolName } from "./editor/editorState";
import { t, initI18n, applyTranslations } from "./i18n/i18n";

export const state = {
  shapes: [] as any[],
  selectedShapeIds: [] as string[],
  currentTool: "select" as ToolName,
  scale: 1.0,
  offsetX: 40,
  offsetY: 40,
  isDeviceConnected: false
};

(window as any).cncState = state;

// Schreibt Meldungen in die Konsole rechts unten (und in die Entwickler-Konsole)
function appendToConsole(text: string) {
  const consoleEl = document.getElementById("console-log");
  if (consoleEl) {
    text.split("\n").forEach(zeile => {
      const el = document.createElement("p");
      el.className = "system-msg";
      el.textContent = zeile;
      consoleEl.appendChild(el);
    });
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  console.log(text);
}

window.addEventListener("DOMContentLoaded", async () => {
  // Zuerst: Einstellungen aus der Datei im App-Datenordner zurückholen, falls sie im Speicher
  // der Oberfläche fehlen (z. B. nach einem Update) – danach jede Änderung in die Datei spiegeln
  const restored = await restoreSettings();
  startSettingsMirror();
  initI18n();
  initMachineMode();   // Fräse oder Laser (setzt die CSS-Klasse am <body>)
  initLaserLayers();
  initPlasmaCuts();
  initStock();
  const camContainer = document.getElementById("dynamic-cam-panel");
  const rightContainer = document.getElementById("dynamic-right-panel");
  const toolbarContainer = document.getElementById("editor-toolbar");
  if (camContainer) renderCamPanel(camContainer);
  if (toolbarContainer) renderEditorToolbar(toolbarContainer);
  if (rightContainer) renderRightPanel(rightContainer);
  applySavedMachine(); // gewählte Maschine: Bettgröße, Baudrate, Nullpunkt
  applyTranslations(document); // feste Texte aus index.html übersetzen

  setTimeout(() => {
    const canvas = document.getElementById("cnc-canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    const clearBtn = document.getElementById("btn-clear-canvas");
    const generateGcodeBtn = document.getElementById("btn-generate-gcode");
    const saveGcodeBtn = document.getElementById("btn-save-gcode");
    const loadGcodeBtn = document.getElementById("btn-load-gcode");
    const jobStartBtn = document.getElementById("btn-job-start");
    const jobPauseBtn = document.getElementById("btn-job-pause");
    const jobStopBtn = document.getElementById("btn-job-stop");
    const bedWInput = document.getElementById("bed-w") as HTMLInputElement;
    const bedHInput = document.getElementById("bed-h") as HTMLInputElement;
    const bedInfo = document.getElementById("canvas-bed-info");

    // Neu zeichnen nur, wenn sich etwas geändert hat (spart Rechenleistung)
    let dirty = true;
    const redraw = () => { dirty = true; };
    const paint = () => {
      if (dirty && ctx && canvas) {
        dirty = false;
        drawEverything(ctx, canvas, state.shapes, state.selectedShapeIds, state.offsetX, state.offsetY, state.scale);
        drawOverlay(ctx, canvas);
        refreshToolPicker(); // Werkzeug-Auswahl an die aktuelle Auswahl anpassen
        refreshLaserPanel(); // Laser-Ebenen ebenso
        refreshPlasmaPanel(); // und Plasma-Schnitte
      }
      requestAnimationFrame(paint);
    };
    requestAnimationFrame(paint);
    window.addEventListener("cnc-redraw", redraw);

    setupToolsHandler(state);
    initTabsEngine(redraw);
    setupUiInputs(redraw);
    initImports(state, redraw, appendToConsole, () => zoomFit());
    bindOffsetModes(state, redraw, appendToConsole);
    setTextRedraw(redraw);

    if (canvas && ctx) {
      initMouseEngine(canvas, state, redraw);
      initCommands(canvas, redraw, appendToConsole);
    }
    initHistory();

    if (clearBtn) clearBtn.addEventListener("click", () => {
      if (!state.shapes.length) return;
      if (!window.confirm(t("main.confirmClear"))) return;
      state.shapes = []; state.selectedShapeIds = []; redraw();
    });
    if (generateGcodeBtn) generateGcodeBtn.addEventListener("click", () => handleGcodeGeneration(state.shapes, appendToConsole));
    if (saveGcodeBtn) saveGcodeBtn.addEventListener("click", () => exportGcodeToFile(state.shapes, appendToConsole));

    if (loadGcodeBtn) loadGcodeBtn.addEventListener("click", () => loadGcodeFromFile(appendToConsole));
    if (jobStartBtn) jobStartBtn.addEventListener("click", () => startStreaming(() => state.isDeviceConnected, appendToConsole));
    if (jobPauseBtn) jobPauseBtn.addEventListener("click", () => pauseStreaming(appendToConsole));
    if (jobStopBtn) jobStopBtn.addEventListener("click", () => stopStreaming());

    // Dateien einfach aufs Fenster ziehen
    window.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("drop-active"); });
    window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("drop-active"); });
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      document.body.classList.remove("drop-active");
      const files = Array.from(e.dataTransfer?.files || []);
      for (const f of files) await importBytes(f.name, new Uint8Array(await f.arrayBuffer()));
    });

    initMachine(appendToConsole);      // Ereignisse vom Rust-Teil (Status, ok/error, Job …)
    initStreamEvents(appendToConsole);
    initConnection(appendToConsole);
    initSpindlePanel(appendToConsole); // Spindel an/aus, Laser-Testschuss, THC, Override-Regler
    initPinLeds(appendToConsole);      // Lämpchen für Endschalter, Taster/WLS, Tür, Not-Aus …
    initWiringPage();                  // Reiter "Anschlüsse": Anschlusspläne für die Boards
    initAboutDialog(appendToConsole);  // ⓘ oben rechts: Version + Updates
    initSupport();                     // ❤️ oben rechts: freiwillig unterstützen
    initCamera(appendToConsole);       // 📷 oben rechts: Kamera-Fenster, Bild auf der Arbeitsfläche, Ausrichten
    if (restored > 0) appendToConsole(t("store.restored", { n: restored }));
    initUpdater(appendToConsole);      // Update-Prüfung über GitHub (aus, solange kein Repository eingetragen ist)
    initSettingsPage(appendToConsole); // $$-Einstellungen (Reiter "Kalibrieren")
    initFlashPage(appendToConsole);    // Firmware flashen (Reiter "Board flashen")
    initLanguageMenu(document.getElementById("language-menu"), appendToConsole);

    // ---- Simulation ----
    initSimulation(document.getElementById("tab-sim"), appendToConsole);
    // rechtes Panel breiter/schmaler ziehen (CAM und Simulation, Breite wird gemerkt)
    attachPanelResizer(document.querySelector<HTMLElement>(".main-content"), rightContainer, "cam");
    attachConsoleResizer(document.getElementById("rp-console"));
    attachPanelResizer(document.querySelector<HTMLElement>("#tab-sim .sim-layout"), document.querySelector<HTMLElement>("#tab-sim .sim-side"), "sim");
    const openSimTab = () => (document.querySelector('.tab-navigation [data-tab="tab-sim"]') as HTMLElement | null)?.click();
    document.getElementById("btn-simulate")?.addEventListener("click", () => {
      const gcode = generateGcode(state.shapes);
      if (!gcode) { appendToConsole(noGcodeMessage()); return; }
      lastGcodeWarnings.forEach(w => appendToConsole(`${t("log.warning")} ${w}`));
      setSimProgram(gcode.split("\n"), t("sim.currentDesign"), "design");
      openSimTab();
    });
    document.getElementById("btn-sim-job")?.addEventListener("click", () => {
      if (!streamState.loadedLines.length) { appendToConsole(t("stream.noGcode")); return; }
      setSimProgram(streamState.loadedLines, t("sim.loadedJob"), "job");
      openSimTab();
    });
    window.addEventListener("cnc-language-changed", () => { renderToolTable(); redraw(); });
    initCollapsibleMenus();
    initLightBurnTooltips();
    initToolLibrary();
    initToolPage();                    // Reiter "Werkzeuge": Fräswerkzeuge
    initLibraryTab(appendToConsole);   // im selben Reiter: Laser-/Plasma-Bibliothek + Export/Import/Sicherung
    initToolPicker(redraw);
    initLaserPanel(redraw);
    initPlasmaPanel(redraw);
    initStockPanel(redraw, appendToConsole);
    initMachineWizard(redraw, appendToConsole);
    initJobTools(appendToConsole);      // Rahmen abfahren, .rd speichern

    const updateBedInfo = () => {
      if (bedInfo) bedInfo.textContent = `${bedWInput?.value || 300} × ${bedHInput?.value || 300} mm`;
      redraw();
    };

    // Canvas immer genau so groß wie der freie Platz (auch wenn sich Leisten/Fenster ändern)
    let firstResize = true;
    const resizeCanvas = () => {
      if (!canvas) return;
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect || rect.width < 10 || rect.height < 10) return;
      const w = Math.floor(rect.width), h = Math.floor(rect.height);
      if (canvas.width === w && canvas.height === h && !firstResize) return;
      canvas.width = w;
      canvas.height = h;
      if (firstResize) { firstResize = false; zoomFit(); }
      redraw();
    };
    window.addEventListener("resize", resizeCanvas);
    if (canvas?.parentElement && "ResizeObserver" in window) new ResizeObserver(resizeCanvas).observe(canvas.parentElement);
    if (bedWInput) bedWInput.addEventListener("input", updateBedInfo);
    if (bedHInput) bedHInput.addEventListener("input", updateBedInfo);
    updateBedInfo();
    setTimeout(resizeCanvas, 50);
  }, 30);
});
