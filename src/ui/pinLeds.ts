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
 *
 * Endschalter testen (GRBL): Mit harten Endschaltern ($21=1) löst JEDER Druck auf einen Endschalter sofort
 * Alarm 1 aus – auch im Stillstand (Schutzfunktion von GRBL). Der Testmodus schaltet $21 kurz aus, die
 * Lämpchen zeigen jeden Schalter, „Test beenden“ schaltet $21 wieder ein. Bricht die Verbindung im Test ab,
 * wird $21=1 beim nächsten Verbinden mit demselben Anschluss automatisch zurückgesetzt (KEY_TEST).
 *
 * Freigeben (🔓 / F11, wie in Estlcam): Reset (Strg-X), dann $X. Nach einem Endschalter-Alarm nimmt GRBL $X erst
 * nach einem Reset an – deshalb ging „Entsperren“ allein oft nicht. Ist danach noch ein Endschalter gedrückt,
 * werden die harten Endschalter ($21) kurz ausgeschaltet, damit man vom Schalter wegfahren kann. Sobald alle
 * Endschalter frei sind und die Maschine steht, schaltet $21 von selbst wieder ein (bei Verbindungsabbruch über KEY_TEST).
 */
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT, send, sendAndWait, errorText, realtime, RT } from "../machine";

const KEY_TEST = "cnc_craft_limit_test"; // Anschluss, an dem $21 für den Test ausgeschaltet ist

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
      <div class="pin-test-warn" id="pin-test-warn" style="display:none;"></div>
      <button id="pin-test" class="btn-secondary btn-compact not-marlin" ${tip("pin.testTip")}>🧪 ${T("pin.test")}</button>
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

let releaseFn: () => Promise<void> = async () => { /* noch nicht bereit */ };
/** Maschine freigeben (Knopf 🔓 und Taste F11) */
export function releaseMachine(): Promise<void> { return releaseFn(); }

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
    checkBypassEnd(st);
  };

  // ---------------- Endschalter testen (GRBL, $21 kurz aus) ----------------
  let testing = false;
  const testUi = () => {
    const b = $("pin-test"), w = $("pin-test-warn");
    if (b) b.textContent = testing ? `✔ ${t("pin.testEnd")}` : `🧪 ${t("pin.test")}`;
    if (b) b.classList.toggle("pin-test-on", testing);
    if (w) { w.style.display = testing ? "" : "none"; w.textContent = testing ? t("pin.testActive") : ""; }
  };
  const setHard = async (on: boolean): Promise<boolean> => {
    const a = await sendAndWait(`$21=${on ? 1 : 0}`, 5000);
    if (!a.ok) { log(t("pin.testFail", { e: a.code && a.code > 0 ? errorText(a.code) : String(a.code ?? "") })); return false; }
    return true;
  };
  const endTest = async () => {
    if (!machine.connected) return;
    if (await setHard(true)) {
      testing = false;
      try { localStorage.removeItem(KEY_TEST); } catch { /* egal */ }
      log(t("pin.testOff"));
      testUi();
    }
  };
  $("pin-test")?.addEventListener("click", async () => {
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    if (!isGrbl()) return;
    if (testing) { await endTest(); return; }
    if (machine.job.active) { log(t("sp.jobRunning")); return; }
    if (!machine.settings.has("$21")) await sendAndWait("$$", 5000, true);
    const v = machine.settings.get("$21");
    if (v === undefined) { log(t("pin.testNoSetting")); return; }
    if (Number(v) === 0) { log(t("pin.testAlreadyOff")); return; }
    if (!window.confirm(t("pin.testConfirm"))) return;
    if (!await setHard(false)) return;
    testing = true;
    try { localStorage.setItem(KEY_TEST, machine.port || "?"); } catch { /* egal */ }
    // Alarm 1 vom letzten Druck noch aktiv? Jetzt (ohne harte Endschalter) entsperren
    if (machine.status.state === "Alarm") await sendAndWait("$X", 5000);
    log(t("pin.testOn"));
    testUi();
  });
  /** Nach einem Abbruch im Test: $21 beim nächsten Verbinden wieder einschalten */
  const restoreAfterReconnect = async () => {
    let port: string | null = null;
    try { port = localStorage.getItem(KEY_TEST); } catch { /* egal */ }
    if (!port || !machine.connected || !isGrbl() || testing) return;
    if (port !== "?" && machine.port && port !== machine.port) return;
    if (await setHard(true)) {
      try { localStorage.removeItem(KEY_TEST); } catch { /* egal */ }
      log(t("pin.testRestored"));
    }
  };

  // ---------------- Freigeben (wie F11 in Estlcam) ----------------
  let releasing = false;
  let bypass = false;   // $21 ist aus, bis alle Endschalter frei sind
  let restoring = false;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const waitFor = (type: string, ms: number) => new Promise<boolean>(res => {
    const h = (e: Event) => { if ((e as CustomEvent).detail?.type === type) { done(true); } };
    const timer = window.setTimeout(() => done(false), ms);
    const done = (v: boolean) => { clearTimeout(timer); window.removeEventListener(MACHINE_EVENT, h); res(v); };
    window.addEventListener(MACHINE_EVENT, h);
  });
  const axesHit = (st: Set<string> | null) => st ? AXES.filter(a => st.has(a)) : [];
  function checkBypassEnd(st: Set<string> | null) {
    if (!bypass || restoring || !st || !machine.connected) return;
    if (axesHit(st).length || machine.status.state !== "Idle") return;
    restoring = true;
    setHard(true).then(ok => {
      if (ok) {
        bypass = false;
        try { localStorage.removeItem(KEY_TEST); } catch { /* egal */ }
        log(t("rel.restored"));
      }
    }).finally(() => { restoring = false; });
  }
  releaseFn = async () => {
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    if (!isGrbl()) { await send("$X"); machine.lastAlarm = 0; return; }
    if (machine.job.active) { log(t("sp.jobRunning")); return; }
    if (releasing) return;
    releasing = true;
    try {
      log(t("rel.start"));
      const welcome = waitFor("welcome", 3000);
      await realtime(RT.reset);
      await welcome;
      await sleep(700); // Board-Infos und frischer Status nach dem Reset
      let ack = await sendAndWait("$X", 5000);
      await sleep(400);
      const hit = axesHit(current());
      if (hit.length && !testing && !bypass) {
        if (!machine.settings.has("$21")) await sendAndWait("$$", 5000, true);
        if (Number(machine.settings.get("$21") ?? 0) !== 0) {
          if (!await setHard(false)) return;
          bypass = true;
          try { localStorage.setItem(KEY_TEST, machine.port || "?"); } catch { /* egal */ }
          ack = await sendAndWait("$X", 5000);
          log(t("rel.bypass", { axes: hit.join(", ") }));
          machine.lastAlarm = 0;
          return;
        }
      }
      await sleep(200);
      if (machine.status.state === "Alarm" || !ack.ok) log(t("rel.still"));
      else { machine.lastAlarm = 0; log(t("rel.ok")); }
    } catch (e) {
      log(`${t("log.error")} ${e}`);
    } finally {
      releasing = false;
    }
  };
  window.addEventListener("keydown", (e) => {
    if (e.key !== "F11" || e.repeat) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    e.preventDefault();
    releaseFn().catch(() => {});
  });

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
      // Verbindung weg im Test: $21 bleibt am Board aus → beim nächsten Verbinden zurücksetzen
      if (type === "disconnected" && testing) { testing = false; testUi(); }
      if (type === "disconnected") bypass = false; // KEY_TEST bleibt → $21 beim nächsten Verbinden zurück
      if (type === "welcome") setTimeout(() => { restoreAfterReconnect().catch(() => {}); }, 1500);
      render();
    }
  });
  window.addEventListener("cnc-language-changed", render);
  window.addEventListener("cnc-protocol-changed", render);
  render();
}
