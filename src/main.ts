import { initConnection } from "./connection";
import { initMachine } from "./machine";
import { initStreamEvents } from "./machineStream";
import { initSettingsPage } from "./ui/settingsPage";
import { initFlashPage } from "./ui/flashPage";
import { handleGcodeGeneration, exportGcodeToFile, generateGcode, lastGcodeWarnings, noGcodeMessage } from "./cam";
import { initSimulation, setSimProgram } from "./sim/simulation";
import { openCostDialog } from "./ui/costCalc";
import { initOpsPanel, refreshOps } from "./ui/opsPanel";
import { streamState } from "./machineStream";
import { drawEverything } from "./render";
import { initCollapsibleMenus } from "./ui";
import { initLightBurnTooltips } from "./tooltips";
import { renderCamPanel, renderEditorToolbar } from "./ui/camPanel";
import { initFlyouts } from "./ui/flyout";
import { renderRightPanel } from "./ui/rightPanel";
import { initToolLibrary } from "./toolLibrary";
import { initToolPicker, refreshToolPicker } from "./ui/toolPicker";
import { initMachineMode, isLaser } from "./machineMode";
import { rotary } from "./rotary";
import { initRotaryPanel } from "./ui/rotaryPanel";
import { initLaserLayers } from "./laserLayers";
import { initLaserPanel, refreshLaserPanel } from "./ui/laserPanel";
import { initPlasmaCuts } from "./plasmaCuts";
import { initPlasmaPanel, refreshPlasmaPanel } from "./ui/plasmaPanel";
import { initStock } from "./stock";
import { initStockPanel } from "./ui/stockPanel";
import { applySavedMachine, initMachineWizard } from "./ui/machineWizard";
import { initJobTools } from "./ui/jobTools";
import { initSpindlePanel } from "./ui/spindlePanel";
import { initProbePanel } from "./ui/probePanel";
import { initWorkshopPanel } from "./ui/workshopPanel";
import { initVfdPanel } from "./ui/vfdPanel";
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
import { openResumeDialog } from "./ui/resumeDialog";
import { drawOverlay } from "./editor/overlay";
import { initHistory } from "./editor/history";
import { setEngraveLog } from "./raster/engraveDialog";
import { initMaterialView } from "./materialView";
import { solveConstraints } from "./editor/dims";
import { initBeds, refreshBeds, relabelBeds, gcodeFileName, drawOtherBeds } from "./editor/beds";
import { initCommands, zoomFit } from "./editor/commands";
import { setTextRedraw } from "./editor/textTool";
import { initImports, importBytes } from "./importers/importManager";
import { initLanguageMenu } from "./ui/languageMenu";
import { renderToolTable, initToolPage } from "./ui/toolEditor";
import { initLibraryTab } from "./ui/libraryTab";
import { initLibSync } from "./libSync";
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

// Schreibt Meldungen in die Konsole rechts unten (und in die Entwickler-Konsole).
// Damit sie bei langen Jobs nicht immer langsamer wird:
//  - höchstens CONSOLE_MAX Zeilen, die ältesten fliegen raus (jede Zeile kostete sonst bei 40 000 Zeilen ~30 ms)
//  - Meldungen werden gesammelt und einmal pro Bild eingefügt (statt Layout + Scrollen je Zeile)
//  - gleiche Meldung direkt hintereinander wird nur gezählt: „… (×25)“
//  - nach unten scrollen nur, wenn man schon unten war (sonst springt es beim Zurücklesen weg)
const CONSOLE_MAX = 1000;
let consoleQueue: string[] = [];
let consoleFlush = 0;
let lastLine: { el: HTMLElement; text: string; n: number } | null = null;

function flushConsole() {
  cancelAnimationFrame(consoleFlush);
  consoleFlush = 0;
  const consoleEl = document.getElementById("console-log");
  const lines = consoleQueue;
  consoleQueue = [];
  if (!consoleEl || !lines.length) return;
  const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 40;
  const frag = document.createDocumentFragment();
  let added = 0;
  for (const zeile of lines.slice(-CONSOLE_MAX)) {
    if (lastLine && lastLine.text === zeile && (lastLine.el.isConnected || lastLine.el.parentNode === frag)) {
      lastLine.n++;
      lastLine.el.textContent = `${zeile} (×${lastLine.n})`;
      continue;
    }
    const el = document.createElement("p");
    el.className = "system-msg";
    el.textContent = zeile;
    frag.appendChild(el);
    lastLine = { el, text: zeile, n: 1 };
    added++;
  }
  if (added) consoleEl.appendChild(frag);
  let extra = consoleEl.childElementCount - CONSOLE_MAX;
  while (extra-- > 0 && consoleEl.firstElementChild) consoleEl.firstElementChild.remove();
  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function appendToConsole(text: string) {
  consoleQueue.push(...text.split("\n"));
  // einmal pro Bild einfügen; falls das Fenster gerade nicht zeichnet (verdeckt), spätestens nach 200 ms
  if (!consoleFlush) {
    consoleFlush = requestAnimationFrame(flushConsole);
    setTimeout(() => { if (consoleQueue.length) flushConsole(); }, 200);
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
  initFlyouts();
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
        solveConstraints(); // Maße: abhängige Formen folgen ihrer Bezugsform
        drawEverything(ctx, canvas, state.shapes, state.selectedShapeIds, state.offsetX, state.offsetY, state.scale);
        drawOtherBeds(ctx);   // weitere Betten blass daneben (wie im Slicer)
        drawOverlay(ctx, canvas);
        refreshToolPicker(); // Werkzeug-Auswahl an die aktuelle Auswahl anpassen
        refreshOps();        // Bearbeitungen der Auswahl
        refreshLaserPanel(); // Laser-Ebenen ebenso
        refreshPlasmaPanel(); // und Plasma-Schnitte
        refreshBeds();        // Reiter der Betten (Anzahl Teile)
        // Reiter „Objekt“: ohne Auswahl nur Ebenen + Hinweis
        document.getElementById("rp-object")?.classList.toggle("no-sel", !state.selectedShapeIds.length);
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
    initBeds(redraw, appendToConsole, () => zoomFit());
    setEngraveLog(appendToConsole);
    initMaterialView(redraw);         // Materialansicht (Holz, Acryl, Leder …) – Auswahl in der Werkzeugleiste   // Bildgravur: Meldungen aus dem Gravur-Fenster // mehrere Betten: Reiter über der Zeichenfläche

    if (clearBtn) clearBtn.addEventListener("click", () => {
      if (!state.shapes.length) return;
      if (!window.confirm(t("main.confirmClear"))) return;
      state.shapes = []; state.selectedShapeIds = []; redraw();
    });
    if (generateGcodeBtn) generateGcodeBtn.addEventListener("click", () => handleGcodeGeneration(state.shapes, appendToConsole));
    if (saveGcodeBtn) saveGcodeBtn.addEventListener("click", () => exportGcodeToFile(state.shapes, appendToConsole, gcodeFileName()));

    if (loadGcodeBtn) loadGcodeBtn.addEventListener("click", () => loadGcodeFromFile(appendToConsole));
    if (jobStartBtn) jobStartBtn.addEventListener("click", () => startStreaming(() => state.isDeviceConnected, appendToConsole));
    document.getElementById("btn-job-resume")?.addEventListener("click", () => openResumeDialog(appendToConsole));
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
    initProbePanel(appendToConsole);   // Antasten: Tasterplatte, Werkzeuglängensensor
    initWorkshopPanel(appendToConsole); // Werkstatt: Absaugung/Kompressor mit dem Job schalten
    initVfdPanel(appendToConsole); // Frequenzumrichter der Spindel per Modbus
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
      const gcode = generateGcode(state.shapes, { flat: true });
      if (!gcode) { appendToConsole(noGcodeMessage()); return; }
      lastGcodeWarnings.forEach(w => appendToConsole(`${t("log.warning")} ${w}`));
      if (rotary.on && isLaser()) appendToConsole(t("rot.simFlat"));
      setSimProgram(gcode.split("\n"), t("sim.currentDesign"), "design");
      openSimTab();
    });
    document.getElementById("btn-cost")?.addEventListener("click", () => openCostDialog(state.shapes, appendToConsole));
    document.getElementById("btn-sim-job")?.addEventListener("click", () => {
      if (!streamState.loadedLines.length) { appendToConsole(t("stream.noGcode")); return; }
      setSimProgram(streamState.loadedLines, t("sim.loadedJob"), "job");
      openSimTab();
    });
    window.addEventListener("cnc-language-changed", () => { renderToolTable(); relabelBeds(); redraw(); });
    initCollapsibleMenus();
    initLightBurnTooltips();
    initToolLibrary();
    initToolPage();                    // Reiter "Werkzeuge": Fräswerkzeuge
    initLibraryTab(appendToConsole);   // im selben Reiter: Laser-/Plasma-Bibliothek + Export/Import/Sicherung
    initToolPicker(redraw);
    initOpsPanel(redraw, appendToConsole);
    initLaserPanel(redraw);
    initRotaryPanel(redraw);           // Drehachse (Reiter Lasern) + 3D-Vorschau
    initPlasmaPanel(redraw);
    initLibSync(appendToConsole);      // Werkstatt-Sync: Bibliotheken über einen gemeinsamen Ordner abgleichen
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
