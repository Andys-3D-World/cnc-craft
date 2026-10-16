/**
 * EINGANGS-ANZEIGE (Reiter "Maschine" → Status)
 *
 * Für jeden Eingang ein Lämpchen: grün = frei, rot = ausgelöst, grau = unbekannt/offline.
 *   Zeile 1: Endschalter X, Y, Z (A/B/C, sobald das Board sie meldet) und Taster/WLS
 *   Zeile 2: Tür, Halt, Start, Reset, Not-Aus (Not-Aus und Motor-Meldungen nur bei grblHAL/FluidNC
 *            oder sobald sie einmal gemeldet wurden)
 *
 * Quelle: Feld "Pn:" im GRBL-Statusbericht. GRBL lässt es weg, wenn nichts ausgelöst ist –
 * dann ist alles grün. Buchstaben (GRBL 1.1 / grblHAL):
 *   X Y Z A B C U V W  Endschalter   P Taster   O Taster abgesteckt (grblHAL)
 *   D Tür   H Halt   S Start   R Reset   E Not-Aus   M Motor-Warnung   F Motor-Fehler
 * Ein Werkzeuglängensensor (WLS) hängt bei GRBL am Taster-Eingang – er erscheint als "P".
 *
 * Marlin meldet Endschalter nur auf Anfrage: Knopf "M119", die Antwortzeilen
 * ("x_min: TRIGGERED", "z_probe: open" …) werden ausgewertet.
 * Wechsel (frei ↔ ausgelöst) wird in der Konsole gemeldet – praktisch zum Testen der Schalter.
 */
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT, send } from "../machine";

const AXES = ["X", "Y", "Z", "A", "B", "C", "U", "V", "W"];
const CTRL = ["D", "H", "S", "R", "E"];
const EXTRA = ["O", "M", "F"];

export function pinLedsHtml(): string {
  return `
    <div class="pin-leds not-ruida not-k40" id="pin-leds">
      <div class="pin-row" id="pin-row-main"></div>
      <div class="pin-row pin-row-ctrl" id="pin-row-ctrl"></div>
      <div class="pin-warn" id="pin-warn" style="display:none;"></div>
      <button id="pin-m119" class="btn-secondary btn-compact only-marlin" ${tip("pin.m119Tip")}>🔍 ${T("pin.m119")}</button>
    </div>`;
}

function label(p: string): string {
  if (AXES.includes(p)) return p;
  return t("pin.name." + p);
}

/** Langer Name für Konsole/Tooltip */
function longName(p: string): string {
  if (AXES.includes(p)) return t("pin.axisName", { a: p });
  return t("pin.long." + p);
}

export function initPinLeds(log: (s: string) => void) {
  const $ = (id: string) => document.getElementById(id);
  const seen = new Set<string>();       // Buchstaben, die das Board schon einmal gemeldet hat
  let last: Set<string> | null = null;  // zuletzt angezeigter Zustand (für Konsolen-Meldungen)
  let marlinPins: Set<string> | null = null;
  let marlinCollect: Set<string> | null = null;
  let marlinTimer = 0;

  const isGrbl = () => machine.protocol === "grbl";
  const hal = () => /grblHAL|FluidNC/i.test(machine.firmware);

  /** aktueller Zustand: null = unbekannt */
  const current = (): Set<string> | null => {
    if (!machine.connected) return null;
    if (machine.protocol === "marlin") return marlinPins;
    if (!isGrbl() || !machine.status.state) return null;
    return new Set((machine.status.pins || "").toUpperCase().replace(/[^A-Z]/g, "").split("").filter(Boolean));
  };

  const led = (p: string, st: Set<string> | null, warnOnly = false) => {
    const on = st ? st.has(p) : false;
    const cls = !st ? "pin-unknown" : on ? (warnOnly ? "pin-warnstate" : "pin-hit") : "pin-ok";
    const state = !st ? t("pin.unknown") : on ? t("pin.triggered") : t("pin.free");
    return `<span class="pin-led ${cls}" data-pin="${p}" data-tip="${longName(p)}: ${state}"><i></i>${label(p)}</span>`;
  };

  const render = () => {
    const st = current();
    if (st) st.forEach(p => seen.add(p));
    const axes = ["X", "Y", "Z", ...AXES.slice(3).filter(a => seen.has(a))];
    const main = $("pin-row-main"), ctrl = $("pin-row-ctrl");
    if (main) main.innerHTML = axes.map(a => led(a, st)).join("") + `<span class="pin-sep"></span>` + led("P", st)
      + (seen.has("O") ? led("O", st, true) : "");
    if (ctrl) {
      const marlin = machine.protocol === "marlin";
      const list = marlin ? [] : CTRL.filter(c => c !== "E" || hal() || seen.has("E"));
      const extra = EXTRA.filter(x => x !== "O" && seen.has(x));
      ctrl.innerHTML = list.map(c => led(c, st)).join("") + extra.map(x => led(x, st, x === "M")).join("");
      ctrl.style.display = list.length + extra.length ? "" : "none";
    }
    // Hinweis: alle Endschalter gleichzeitig rot -> meist Öffner-Schalter mit falscher Invertierung
    const w = $("pin-warn");
    if (w) {
      const allHit = !!st && isGrbl() && ["X", "Y", "Z"].every(a => st.has(a)) && machine.status.state !== "Home";
      w.style.display = allHit ? "" : "none";
      if (allHit) w.textContent = t("pin.allHit");
    }
    // Wechsel in der Konsole melden
    if (st && last) {
      const nm = (p: string) => AXES.includes(p) ? longName(p) : label(p);
      for (const p of st) if (!last.has(p)) log(t("pin.logHit", { name: nm(p) }));
      for (const p of last) if (!st.has(p)) log(t("pin.logFree", { name: nm(p) }));
    }
    last = st ? new Set(st) : null;
  };

  // ---------------- Marlin: M119 ----------------
  $("pin-m119")?.addEventListener("click", async () => {
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    marlinCollect = new Set();
    clearTimeout(marlinTimer);
    // Antwortzeilen kommen kurz nacheinander; nach einer Pause gilt die Abfrage als fertig
    marlinTimer = window.setTimeout(() => { if (marlinCollect) { marlinPins = marlinCollect; marlinCollect = null; render(); } }, 1500);
    try { await send("M119"); } catch (e) { log(`${t("log.error")} ${e}`); }
  });
  const onMarlinLine = (text: string) => {
    const s = text.trim();
    if (/Reporting endstop status/i.test(s)) { marlinCollect = new Set(); return; }
    const m = s.match(/^([xyzijkuvw])\d?_(min|max)\s*:\s*(TRIGGERED|open)/i);
    const pr = s.match(/^(z_probe|probe|z_min_probe|bltouch)\s*:\s*(TRIGGERED|open)/i);
    if (!m && !pr) return;
    if (!marlinCollect) marlinCollect = new Set(marlinPins || []);
    if (m) {
      const a = m[1].toUpperCase().replace("I", "A").replace("J", "B").replace("K", "C");
      if (/TRIGGERED/i.test(m[3])) marlinCollect.add(a);
    }
    if (pr && /TRIGGERED/i.test(pr[2])) marlinCollect.add("P");
    // sofort anzeigen (Zwischenstand), endgültig nach der Pause
    marlinPins = new Set(marlinCollect);
    clearTimeout(marlinTimer);
    marlinTimer = window.setTimeout(() => { marlinCollect = null; }, 800);
    render();
  };

  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type, data } = (e as CustomEvent).detail || {};
    if (type === "status") render();
    else if (type === "text" && machine.protocol === "marlin") onMarlinLine(String(data?.text || ""));
    else if (type === "connected" || type === "disconnected" || type === "welcome") {
      if (type !== "welcome") { seen.clear(); marlinPins = null; last = null; }
      render();
    }
  });
  window.addEventListener("cnc-language-changed", render);
  window.addEventListener("cnc-protocol-changed", render);
  render();
}
