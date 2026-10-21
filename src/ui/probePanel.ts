/**
 * ANTASTEN / WERKZEUGLÄNGE (Reiter "Maschine", nur Fräse mit GRBL/grblHAL)
 *
 *  - Tasterplatte: Platte aufs Werkstück, Klemme an den Fräser → Z fährt langsam runter, bis Kontakt,
 *    dann Z = Plattendicke. Danach etwas hoch.
 *  - Werkzeuglängensensor (fester Platz am Bett): fährt erst hoch, dann zum Sensor (Maschinenkoordinaten),
 *    tastet an und setzt Z so, dass Z = 0 wieder auf der Werkstück-Oberseite liegt:
 *        Z beim Kontakt = Höhe des Messpunkts über dem Bett − Materialstärke
 *    (Z = 0 auf dem Bett statt auf dem Material: Materialstärke 0.)
 *
 * Antasten in zwei Schritten (schnell suchen, 2 mm zurück, langsam genau messen) mit G38.2.
 * Fahrten über G53 bzw. absolute Werte – nur G90 wird gesetzt (Standard), nie G91.
 * Kein Kontakt → GRBL meldet Alarm 5 (Taster nicht ausgelöst), der Ablauf bricht ab.
 */
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT, sendAndWait, canCommand, errorText } from "../machine";

const KEY = "cnc_craft_probe";

interface ProbeSettings {
  plate: number;      // Dicke der Tasterplatte (mm)
  sx: number; sy: number; // Sensor-Position (Maschinenkoordinaten, mm)
  sensorH: number;    // Höhe des Messpunkts über dem Bett (mm)
  material: number;   // Materialstärke (mm) – Z = 0 auf der Oberseite
  travel: number;     // höchstens so weit runter suchen (mm)
  fast: number;       // Suchvorschub (mm/min)
  slow: number;       // Mess-Vorschub (mm/min)
  lift: number;       // so weit vor/nach dem Messen hochfahren (mm)
}
const DEF: ProbeSettings = { plate: 20, sx: 0, sy: 0, sensorH: 30, material: 10, travel: 50, fast: 200, slow: 25, lift: 10 };

function load(): ProbeSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: any = { ...DEF };
    for (const k of Object.keys(DEF)) if (s[k] !== undefined && Number.isFinite(Number(s[k]))) o[k] = Number(s[k]);
    return o;
  } catch { return { ...DEF }; }
}
function save(s: ProbeSettings) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* egal */ } }

export function probePanelHtml(): string {
  const num = (id: string, key: string, step = "0.1", min = "") =>
    `<div class="prop-row" ${tip(key + "Tip")}>${T(key)}<input type="number" id="${id}" step="${step}" ${min ? `min="${min}"` : ""} class="prop-input"></div>`;
  return `
    <div class="menu-section-unified only-mill not-ruida not-k40 not-marlin" id="probe-section">
      <h3 class="menu-trigger">${T("pr.title")}</h3>
      <div class="menu-body rp-box">
        <div class="pr-sub">${T("pr.plateTitle")}</div>
        ${num("pr-plate", "pr.plate", "0.01", "0")}
        <button id="pr-plate-go" class="btn-secondary" ${tip("pr.plateGoTip")}>⊥ ${T("pr.plateGo")}</button>

        <div class="pr-sub">${T("pr.sensorTitle")}</div>
        <div class="rp-grid2">
          ${num("pr-sx", "pr.sx", "0.1")}
          ${num("pr-sy", "pr.sy", "0.1")}
        </div>
        <button id="pr-here" class="btn-secondary btn-compact" ${tip("pr.hereTip")}>📍 ${T("pr.here")}</button>
        ${num("pr-sensorh", "pr.sensorH", "0.01")}
        ${num("pr-material", "pr.material", "0.1", "0")}
        <div id="pr-result" class="tool-scope"></div>
        <button id="pr-sensor-go" class="btn-secondary" ${tip("pr.sensorGoTip")}>📏 ${T("pr.sensorGo")}</button>

        <details class="pr-more"><summary>${T("pr.more")}</summary>
          ${num("pr-travel", "pr.travel", "1", "1")}
          ${num("pr-fast", "pr.fast", "10", "10")}
          ${num("pr-slow", "pr.slow", "1", "1")}
          ${num("pr-lift", "pr.lift", "1", "0")}
        </details>
        <div class="tool-scope">${T("pr.hint")}</div>
      </div>
    </div>`;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Warten, bis die Maschine steht (Idle) und ein frischer Statusbericht da ist */
async function settled(timeoutMs = 60000): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  await sleep(300);
  while (performance.now() < end) {
    const st = machine.status.state;
    if (st === "Alarm" || !machine.connected) return false;
    if (st === "Idle") { await sleep(250); return machine.status.state === "Idle"; }
    await sleep(150);
  }
  return false;
}

export function initProbePanel(log: (s: string) => void) {
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as E | null;
  const s = load();
  const fields: [string, keyof ProbeSettings][] = [
    ["pr-plate", "plate"], ["pr-sx", "sx"], ["pr-sy", "sy"], ["pr-sensorh", "sensorH"], ["pr-material", "material"],
    ["pr-travel", "travel"], ["pr-fast", "fast"], ["pr-slow", "slow"], ["pr-lift", "lift"]
  ];
  const fill = () => fields.forEach(([id, k]) => { const el = $(id); if (el) (el as HTMLInputElement).value = String(s[k]); });
  const result = () => {
    const el = $("pr-result");
    if (el) el.textContent = t("pr.result", { z: (s.sensorH - s.material).toFixed(2) });
  };
  fill(); result();
  fields.forEach(([id, k]) => $(id)?.addEventListener("change", () => {
    const v = parseFloat(($(id) as HTMLInputElement).value);
    if (Number.isFinite(v)) { s[k] = v; save(s); }
    fill(); result();
  }));

  let busy = false;
  const ready = (): boolean => {
    if (!machine.connected) { log(t("conn.connectFirst")); return false; }
    if (machine.protocol !== "grbl") { log(t("pr.grblOnly")); return false; }
    if (busy || machine.job.active || !canCommand()) { log(t("sp.jobRunning")); return false; }
    if (machine.status.state === "Alarm") { log(t("m.unlockFirst")); return false; }
    if (machine.status.state !== "Idle") { log(t("m.jogNotIdle", { s: machine.status.state })); return false; }
    // Taster schon ausgelöst (Klemme liegt auf der Platte, Kabel kurzgeschlossen …) → würde sofort „Kontakt“ melden
    if ((machine.status.pins || "").includes("P")) { log(t("pr.alreadyTriggered")); return false; }
    return true;
  };

  /** Eine Zeile schicken; false (mit Meldung) bei Fehler/Alarm */
  const step = async (line: string, timeoutMs = 10000): Promise<boolean> => {
    const a = await sendAndWait(line, timeoutMs);
    if (!a.ok) { log(t("pr.failed", { cmd: line, e: a.code && a.code > 0 ? errorText(a.code) : String(a.code ?? "") })); return false; }
    return true;
  };

  /** Z nach unten bis Kontakt: schnell suchen, 2 mm zurück, langsam messen. true = Kontakt */
  const touch = async (): Promise<boolean> => {
    const travel = Math.max(1, s.travel);
    const z0 = machine.status.wpos[2];
    const tFast = (travel / Math.max(1, s.fast)) * 60000 + 8000; // Weg / Vorschub + Reserve
    if (!await step("G90")) return false;
    if (!await step(`G38.2 Z${(z0 - travel).toFixed(3)} F${Math.max(10, s.fast)}`, tFast)) return false;
    if (!await settled()) { log(t("pr.noContact")); return false; }
    const zc = machine.status.wpos[2];
    if (!await step(`G0 Z${(zc + 2).toFixed(3)}`)) return false;
    const tSlow = (3 / Math.max(1, s.slow)) * 60000 + 8000;
    if (!await step(`G38.2 Z${(zc - 1).toFixed(3)} F${Math.max(1, s.slow)}`, tSlow)) return false;
    if (!await settled()) { log(t("pr.noContact")); return false; }
    return true;
  };
  /** Hochfahren um lift (Maschinenkoordinaten) */
  const liftUp = async (): Promise<boolean> => {
    if (!(s.lift > 0)) return true;
    return step(`G53 G0 Z${(machine.status.mpos[2] + s.lift).toFixed(3)}`);
  };

  const run = async (what: () => Promise<boolean>) => {
    busy = true; refresh();
    try { await what(); }
    catch (e) { log(`${t("log.error")} ${e}`); }
    finally { busy = false; refresh(); }
  };

  // ---- Tasterplatte ----
  $("pr-plate-go")?.addEventListener("click", () => {
    if (!ready()) return;
    if (!window.confirm(t("pr.plateConfirm", { d: s.plate }))) return;
    run(async () => {
      log(t("pr.plateStart"));
      if (!await touch()) return false;
      if (!await step(`G10 L20 P1 Z${s.plate.toFixed(3)}`)) return false;
      await liftUp();
      log(t("pr.plateDone", { d: s.plate }));
      return true;
    });
  });

  // ---- Werkzeuglängensensor ----
  $("pr-here")?.addEventListener("click", () => {
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    s.sx = +machine.status.mpos[0].toFixed(3); s.sy = +machine.status.mpos[1].toFixed(3);
    save(s); fill();
    log(t("pr.hereDone", { x: s.sx, y: s.sy }));
  });
  $("pr-sensor-go")?.addEventListener("click", () => {
    if (!ready()) return;
    const z = s.sensorH - s.material;
    if (!window.confirm(t("pr.sensorConfirm", { x: s.sx, y: s.sy, z: z.toFixed(2) }))) return;
    run(async () => {
      log(t("pr.sensorStart"));
      if (!await liftUp()) return false;
      if (!await step(`G53 G0 X${s.sx.toFixed(3)} Y${s.sy.toFixed(3)}`, 60000)) return false;
      if (!await settled()) return false;
      if (!await touch()) return false;
      if (!await step(`G10 L20 P1 Z${z.toFixed(3)}`)) return false;
      await liftUp();
      log(t("pr.sensorDone", { z: z.toFixed(2) }));
      return true;
    });
  });

  // Knöpfe nur, wenn es geht
  function refresh() {
    const ok = machine.connected && machine.protocol === "grbl" && !busy && !machine.job.active;
    ["pr-plate-go", "pr-sensor-go"].forEach(id => { const b = $<HTMLButtonElement>(id); if (b) b.disabled = !ok; });
  }
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type } = (e as CustomEvent).detail || {};
    if (type === "status" || type === "connected" || type === "disconnected" || type === "welcome" || type === "switched") refresh();
  });
  refresh();
}
