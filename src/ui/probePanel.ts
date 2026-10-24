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
 * Antasten in zwei Schritten (schnell suchen, 2 mm zurück, langsam genau messen) – in der Software mit Jog-Fahrten
 * und Entprellung statt G38.2 (siehe probeDown: das Arduino-CNC-Shield fängt beim Fahren ständig Störimpulse ein,
 * G38.2 hält bei jedem an). Alle Fahrten RELATIV: das Ziel hängt so nicht an der gemeldeten Werkstück-Position
 * (GRBL schickt den Versatz WCO nur ab und zu, ein veralteter Wert ließ Z nach oben fahren).
 *
 * Wächter (während des ganzen Ablaufs, alle 40 ms):
 *   - Taster meldet Kontakt (Pn:P), die Maschine fährt aber weiter → sofort Halt (!) + Reset
 *     (bei Eilfahrten hoch/zum Sensor reagiert GRBL selbst nicht auf den Taster; oder das Board wertet ihn nicht aus)
 *   - beim Antasten fährt Z nach OBEN statt nach unten → sofort Halt + Reset (Z-Richtung $3 falsch?)
 * Live-Anzeige „Taster: offen / Kontakt“ im Abschnitt – so sieht man vorher, ob das Board den Taster überhaupt sieht.
 *
 * Oberfläche abtasten (Höhenkarte, heightMap.ts): Raster ab der aktuellen Position (vorne links), Punkt für Punkt
 * mit derselben Zwei-Stufen-Messung. Nach jedem Punkt um „Abstand“ hoch, dann relativ zum nächsten Punkt (Schlangenlinie).
 * Vor der Rückfahrt zum ersten Punkt über den höchsten gemessenen Punkt. Beim Senden gleicht machineStream.ts Z aus.
 */
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT, sendAndWait, canCommand, errorText, realtime, RT } from "../machine";
import { getHeightMap, setHeightMap, setHeightMapEnabled, heightMapEnabled, heightRange, HEIGHTMAP_CHANGED, HeightMap } from "../heightMap";

const KEY = "cnc_craft_probe";
const LIFT_MAX = 30;

interface ProbeSettings {
  plate: number;      // Dicke der Tasterplatte (mm)
  sx: number; sy: number; // Sensor-Position (Maschinenkoordinaten, mm)
  sensorH: number;    // Höhe des Messpunkts über dem Bett (mm)
  material: number;   // Materialstärke (mm) – Z = 0 auf der Oberseite
  travel: number;     // höchstens so weit runter suchen (mm)
  fast: number;       // Suchvorschub (mm/min)
  slow: number;       // Mess-Vorschub (mm/min)
  lift: number;       // so weit vor/nach dem Messen hochfahren (mm)
  sensorSet: number;  // 1 = Sensor-Platz wurde festgelegt (sonst fährt „Werkzeug messen“ nicht los)
  mx: number; my: number;   // Höhenkarte: Größe des Bereichs (mm)
  mnx: number; mny: number; // Höhenkarte: Punkte in X / Y
  hop: number;        // Höhenkarte: so weit nach jedem Punkt hoch (mm)
  mzero: number;      // Höhenkarte: 1 = am ersten Punkt Z = 0 setzen
}
const DEF: ProbeSettings = { plate: 20, sx: 0, sy: 0, sensorH: 30, material: 10, travel: 50, fast: 200, slow: 25, lift: 10, sensorSet: 0,
  mx: 100, my: 100, mnx: 5, mny: 5, hop: 3, mzero: 1 };
const MAP_FEED = 1000;     // Fahrt zwischen den Punkten (mm/min)
const MAP_MAX = 20;        // höchstens 20 × 20 Punkte

function load(): ProbeSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: any = { ...DEF };
    for (const k of Object.keys(DEF)) if (s[k] !== undefined && Number.isFinite(Number(s[k]))) o[k] = Number(s[k]);
    o.lift = Math.min(LIFT_MAX, Math.max(0, o.lift)); // früher ging auch mehr (100 mm fuhr gegen den Endschalter)
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
        <div class="pr-live" id="pr-live" ${tip("pr.liveTip")}></div>
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

        <div class="pr-sub">${T("hm.title")}</div>
        <div class="rp-grid2">
          ${num("pr-mx", "hm.mx", "1", "1")}
          ${num("pr-my", "hm.my", "1", "1")}
          ${num("pr-mnx", "hm.mnx", "1", "2")}
          ${num("pr-mny", "hm.mny", "1", "2")}
        </div>
        ${num("pr-hop", "hm.hop", "0.5", "1")}
        <label class="prop-row" style="cursor:pointer;" ${tip("hm.mzeroTip")}>${T("hm.mzero")}<input type="checkbox" id="pr-mzero" style="width:auto;"></label>
        <button id="pr-map-go" class="btn-secondary" ${tip("hm.goTip")}>🗺 ${T("hm.go")}</button>
        <canvas id="pr-map-view" width="220" height="70" style="width:100%;height:70px;display:none;border-radius:4px;margin-top:4px;"></canvas>
        <div id="pr-map-info" class="tool-scope"></div>
        <label class="prop-row" style="cursor:pointer;" ${tip("hm.useTip")}>${T("hm.use")}<input type="checkbox" id="pr-map-use" style="width:auto;"></label>
        <button id="pr-map-clear" class="btn-secondary btn-compact">🗑 ${T("hm.clear")}</button>

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
    ["pr-travel", "travel"], ["pr-fast", "fast"], ["pr-slow", "slow"], ["pr-lift", "lift"],
    ["pr-mx", "mx"], ["pr-my", "my"], ["pr-mnx", "mnx"], ["pr-mny", "mny"], ["pr-hop", "hop"]
  ];
  const fill = () => fields.forEach(([id, k]) => { const el = $(id); if (el) (el as HTMLInputElement).value = String(s[k]); });
  const result = () => {
    const el = $("pr-result");
    if (el) el.textContent = t("pr.result", { z: (s.sensorH - s.material).toFixed(2) });
  };
  fill(); result();
  fields.forEach(([id, k]) => $(id)?.addEventListener("change", () => {
    const v = parseFloat(($(id) as HTMLInputElement).value);
    if (Number.isFinite(v)) {
      s[k] = k === "lift" ? Math.min(LIFT_MAX, Math.max(0, v)) : v;
      if (k === "lift" && v > LIFT_MAX) log(t("pr.liftMax", { mm: LIFT_MAX }));
      if (k === "sx" || k === "sy") s.sensorSet = 1;
      save(s);
    }
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

  /** Hochfahren höchstens LIFT_MAX mm – mehr fährt meist gegen den Z-Endschalter */
  const liftMm = () => Math.min(LIFT_MAX, Math.max(0, s.lift));

  // ---- Wächter ----
  /** probing = gerade läuft G38.2 nach unten (dann darf Z nicht steigen, Kontakt beendet die Fahrt selbst) */
  /** away = gerade weg vom Kontakt hochfahren (Taster darf da noch geschlossen sein) */
  const guard = { on: false, probing: false, away: false, z0: 0, hits: 0, tripped: "" as "" | "noStop" | "wrongDir", timer: 0 };
  const moving = () => ["Run", "Jog", "Home"].includes(machine.status.state);
  const trip = async (why: "noStop" | "wrongDir") => {
    if (guard.tripped) return;
    guard.tripped = why;
    try { await realtime(RT.hold); await realtime(RT.reset); } catch { /* Verbindung weg */ }
    log(t(why === "noStop" ? "pr.guardNoStop" : "pr.guardWrongDir"));
  };
  /** bei jedem neuen Statusbericht prüfen (Zählung je Bericht, nicht je Zeit – Berichte kommen etwa alle 100–200 ms) */
  const onReport = () => {
    if (!guard.on || guard.tripped) return;
    const contact = (machine.status.pins || "").includes("P");
    // weg vom Kontakt: sobald der Taster frei ist, wieder scharf (ein neuer Kontakt beim Hochfahren hält dann an)
    if (guard.away && !contact) guard.away = false;
    // Kontakt, aber die Maschine fährt weiter – erst nach 2 Berichten eingreifen (beim Antasten hält GRBL selbst an,
    // ein einzelnes Störsignal soll keine Fahrt abbrechen)
    if (contact && moving() && !guard.away && !guard.probing) { if (++guard.hits >= 2) trip("noStop"); }
    else guard.hits = 0;
    if (guard.probing && moving() && machine.status.mpos[2] > guard.z0 + 0.5) trip("wrongDir");
  };
  const startGuard = () => {
    guard.on = true; guard.tripped = ""; guard.hits = 0;
    clearInterval(guard.timer);
    // öfter nach dem Status fragen, solange der Ablauf läuft (schnellere Reaktion des Wächters)
    guard.timer = window.setInterval(() => { if (guard.on && machine.connected) realtime(RT.status).catch(() => undefined); }, 100);
  };
  const stopGuard = () => { guard.on = false; guard.probing = false; clearInterval(guard.timer); };

  /** frischen Statusbericht abwarten (nach „?“), höchstens 400 ms */
  const freshStatus = () => new Promise<void>(res => {
    const done = () => { clearTimeout(to); window.removeEventListener(MACHINE_EVENT, on); res(); };
    const on = (e: Event) => { if ((e as CustomEvent).detail?.type === "status") done(); };
    const to = window.setTimeout(done, 400);
    window.addEventListener(MACHINE_EVENT, on);
    realtime(RT.status).catch(done);
  });
  /** Ist der Taster wirklich geschlossen? Zwei frische Berichte nacheinander müssen „P“ zeigen */
  const stillClosed = async (): Promise<boolean> => {
    await sleep(120);
    await freshStatus();
    const a = (machine.status.pins || "").includes("P");
    await freshStatus();
    return a && (machine.status.pins || "").includes("P");
  };

  /**
   * Antasten in der Software (wie Estlcam), NICHT mit G38.2: GRBL hält bei G38.2 beim ersten Impuls am Taster-Eingang
   * an – beim Arduino-CNC-Shield kommt beim Fahren etwa alle 0,3 mm ein Störimpuls vom Schrittmotor-Takt, und ein
   * Impuls genau beim Start gibt Alarm 4. Deshalb: Z fährt als Jog nach unten ($J=G91 Z-…), das Programm fragt den
   * Status schnell ab und zählt nur einen Kontakt, der in 2 Berichten hintereinander geschlossen ist (kurze Impulse
   * fallen so heraus). Dann Jog-Abbruch (0x85) – sauber, ohne Reset und ohne Alarm – und die Lage nach dem Stillstand
   * ist die Kontakt-Höhe. Ist der Taster nach dem Anhalten wieder offen, geht die Suche mit dem Rest weiter.
   * Rückgabe: Maschinen-Z beim Kontakt oder null.
   */
  const probeDown = async (dist: number, feed: number): Promise<number | null> => {
    let left = dist, glitches = 0;
    while (left > 0.02) {
      // probing bleibt bis zum Stillstand an: nach dem Jog-Abbruch bremst Z noch kurz mit geschlossenem Taster –
      // der Wächter darf das nicht als „fährt trotz Kontakt weiter“ werten (sonst Reset → Alarm 3)
      guard.probing = true; guard.z0 = machine.status.mpos[2];
      const from = guard.z0;
      let z: number;
      try {
        if (!await step(`$J=G91 G21 Z-${left.toFixed(3)} F${feed}`)) return null;
        let hits = 0, started = false;
        const end = performance.now() + (left / feed) * 60000 + 8000;
        for (;;) {
          await freshStatus();
          if (guard.tripped || !machine.connected || machine.status.state === "Alarm") return null;
          const st = machine.status.state;
          if (st === "Jog") started = true;
          hits = (machine.status.pins || "").includes("P") ? hits + 1 : 0;
          if (hits >= 2) { await realtime(RT.jogCancel); break; }
          // Jog fertig ohne Kontakt (nach dem Start wieder Idle)
          if (st === "Idle" && (started || performance.now() > end - 7000)) { log(t("pr.noContact")); return null; }
          if (performance.now() > end) { await realtime(RT.jogCancel); log(t("pr.noContact")); return null; }
        }
        if (!await settled()) return null;
        await freshStatus();
        z = machine.status.mpos[2];
      } finally { guard.probing = false; }
      if (await stillClosed()) return z;
      // war doch nur ein längerer Störimpuls: mit dem Rest weitersuchen
      if (++glitches > 25) { log(t("pr.tooManyGlitches")); return null; }
      if (glitches <= 3) log(t("pr.glitch", { z: z.toFixed(2) }));
      left -= Math.max(0, from - z);
    }
    log(t("pr.noContact"));
    return null;
  };

  /**
   * Z relativ nach unten bis Kontakt: schnell suchen, 2 mm zurück, langsam messen. true = Kontakt.
   * Beide Messungen müssen auf 0,5 mm übereinstimmen, sonst Abbruch OHNE Z zu setzen.
   */
  /** Rückgabe: Maschinen-Z der genauen Messung oder null. quiet = keine Zwischenmeldungen (Höhenkarte) */
  const touchAt = async (travel: number, quiet = false): Promise<number | null> => {
    if (!quiet) log(t("pr.phaseSearch", { mm: travel }));
    // schnell suchen höchstens 150 mm/min: bis zum Abbruch fährt Z noch etwa 2 Statusberichte weiter
    const z1 = await probeDown(travel, Math.max(10, Math.min(s.fast, 150)));
    if (z1 === null) { await step("G90"); return null; }
    // 2 mm hoch; ist der Taster dann noch zu (die schnelle Suche hat nachgedrückt), in 2-mm-Schritten bis 8 mm weiter
    guard.away = true;
    let lifted = 0;
    try {
      do {
        if (!await step("$J=G91 G21 Z2 F300") || !await settled()) return null;
        lifted += 2;
      } while (lifted < 8 && await stillClosed());
    } finally { guard.away = false; }
    if (!quiet) log(t("pr.phaseMeasure"));
    const z2 = await probeDown(lifted + 1, Math.max(1, Math.min(s.slow, 30)));
    if (!await step("G90")) return null;
    if (z2 === null) return null;
    // Die schnelle Suche fährt nach dem Kontakt noch etwas weiter (Reaktionszeit, Platte gibt nach) – die langsame
    // Messung liegt dann höher, das ist normal. Liegt sie deutlich TIEFER, war der erste Kontakt eine Störung.
    if (z2 < z1 - 0.5) { log(t("pr.unstable", { a: z1.toFixed(2), b: z2.toFixed(2) })); return null; }
    return z2;
  };
  /** extra: so viel weiter suchen (z. B. weil vorher hochgefahren wurde) */
  const touch = async (extra = 0): Promise<boolean> => (await touchAt(Math.max(1, s.travel) + Math.max(0, extra))) !== null;
  /** relativ um lift hochfahren; fromContact = direkt nach dem Antasten (Taster ist noch geschlossen) */
  const liftUp = async (fromContact = false): Promise<boolean> => {
    // nach dem Messen immer hoch (mindestens 2 mm, nichts eingestellt: 5 mm) – sonst steht der Fräser auf der Platte
    const mm = fromContact ? (liftMm() > 0 ? Math.max(2, liftMm()) : 5) : liftMm();
    if (!(mm > 0)) return true;
    log(t("pr.phaseLift", { mm }));
    guard.away = fromContact;
    try {
      if (!await step(`$J=G91 G21 Z${mm.toFixed(3)} F1000`)) return false;
      return await settled();
    } finally { guard.away = false; }
  };

  /**
   * Vor der Fahrt zum Sensor: nur so weit hoch, dass Z höchstens knapp unter der oberen Grenze steht
   * (nach der Referenzfahrt ist oben Maschinen-Z 0). Steht Z schon oben, wird gar nicht hochgefahren.
   * Rückgabe: gefahrene mm (für den längeren Suchweg) oder null bei Fehler.
   */
  const preLift = async (): Promise<number | null> => {
    const z = machine.status.mpos[2];
    const up = Math.min(z + liftMm(), -1) - z;
    if (!(up > 0.05)) { log(t("pr.phaseNoLift")); return 0; }
    log(t("pr.phaseLift", { mm: +up.toFixed(1) }));
    if (!await step(`G91 G0 Z${up.toFixed(3)}`)) return null;
    if (!await step("G90")) return null;
    return await settled() ? up : null;
  };

  const run = async (what: () => Promise<boolean>) => {
    busy = true; refresh();
    startGuard();
    try { await what(); }
    catch (e) { log(`${t("log.error")} ${e}`); }
    finally {
      stopGuard();
      // nie im relativen Modus stehen lassen (nach einem Reset ist GRBL ohnehin wieder in G90)
      if (machine.connected && machine.status.state !== "Alarm" && !guard.tripped) await sendAndWait("G90", 3000, true).catch(() => undefined);
      if (guard.tripped) log(t("pr.unlockHint"));
      busy = false; refresh();
    }
  };

  // ---- Tasterplatte ----
  $("pr-plate-go")?.addEventListener("click", () => {
    if (!ready()) return;
    if (!window.confirm(t("pr.plateConfirm", { d: s.plate }))) return;
    run(async () => {
      log(t("pr.plateStart"));
      if (!await touch()) return false;
      if (!await step(`G10 L20 P1 Z${s.plate.toFixed(3)}`)) return false;
      await liftUp(true);
      log(t("pr.plateDone", { d: s.plate }));
      return true;
    });
  });

  // ---- Werkzeuglängensensor ----
  $("pr-here")?.addEventListener("click", () => {
    if (!machine.connected) { log(t("conn.connectFirst")); return; }
    s.sx = +machine.status.mpos[0].toFixed(3); s.sy = +machine.status.mpos[1].toFixed(3); s.sensorSet = 1;
    save(s); fill();
    log(t("pr.hereDone", { x: s.sx, y: s.sy }));
  });
  $("pr-sensor-go")?.addEventListener("click", () => {
    if (!ready()) return;
    if (!s.sensorSet) { log(t("pr.sensorNotSet")); return; }
    const z = s.sensorH - s.material;
    if (!window.confirm(t("pr.sensorConfirm", { x: s.sx, y: s.sy, z: z.toFixed(2) }))) return;
    run(async () => {
      log(t("pr.sensorStart"));
      const lifted = await preLift();
      if (lifted === null) return false;
      log(t("pr.phaseTravel", { x: s.sx, y: s.sy }));
      if (!await step(`G90 G53 G0 X${s.sx.toFixed(3)} Y${s.sy.toFixed(3)}`, 60000)) return false;
      if (!await settled()) return false;
      // vorher hochgefahren → um so viel weiter nach unten suchen
      if (!await touch(lifted)) return false;
      if (!await step(`G10 L20 P1 Z${z.toFixed(3)}`)) return false;
      await liftUp(true);
      log(t("pr.sensorDone", { z: z.toFixed(2) }));
      return true;
    });
  });

  // ---- Oberfläche abtasten (Höhenkarte) ----
  let mapRunning = false, mapCancel = false;
  const mzero = $("pr-mzero");
  if (mzero) { mzero.checked = !!s.mzero; mzero.addEventListener("change", () => { s.mzero = mzero.checked ? 1 : 0; save(s); }); }
  /** Z relativ hochfahren (away = Taster darf dabei noch geschlossen sein) */
  const up = async (mm: number, away: boolean): Promise<boolean> => {
    if (!(mm > 0.01)) return true;
    guard.away = away;
    try { return await step(`$J=G91 G21 Z${mm.toFixed(3)} F1000`) && await settled(); }
    finally { guard.away = false; }
  };
  const moveXY = async (dx: number, dy: number): Promise<boolean> => {
    if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return true;
    return await step(`$J=G91 G21 X${dx.toFixed(3)} Y${dy.toFixed(3)} F${MAP_FEED}`, 60000) && await settled();
  };
  $("pr-map-go")?.addEventListener("click", () => {
    if (mapRunning) { mapCancel = true; log(t("hm.cancelling")); return; }
    if (!ready()) return;
    const nx = Math.round(s.mnx), ny = Math.round(s.mny);
    const hop = Math.min(LIFT_MAX, Math.max(1, s.hop));
    if (!(nx >= 2 && ny >= 2 && nx <= MAP_MAX && ny <= MAP_MAX && s.mx > 0 && s.my > 0 && s.mx <= 2000 && s.my <= 2000)) {
      log(t("hm.badInput", { max: MAP_MAX })); return;
    }
    if (!window.confirm(t("hm.confirm", { n: nx * ny, w: s.mx, h: s.my, hop }))) return;
    const dx = s.mx / (nx - 1), dy = s.my / (ny - 1);
    mapCancel = false; mapRunning = true;
    run(async () => {
      // Lage des ersten Punkts in Werkstück-Koordinaten (zwei frische Berichte, damit der Versatz sicher stimmt)
      await freshStatus(); await freshStatus();
      const ox = machine.status.wpos[0], oy = machine.status.wpos[1];
      log(t("hm.start", { n: nx * ny, x: ox.toFixed(2), y: oy.toFixed(2) }));
      const z = new Array<number>(nx * ny).fill(NaN);
      let ci = 0, cj = 0, k = 0, top = -Infinity;
      for (let j = 0; j < ny; j++) {
        const cols = Array.from({ length: nx }, (_, i) => (j % 2 ? nx - 1 - i : i)); // Schlangenlinie
        for (const i of cols) {
          if (mapCancel) { log(t("hm.cancelled")); await up(Math.max(0, top + hop - machine.status.mpos[2]), false); return false; }
          if (!await moveXY((i - ci) * dx, (j - cj) * dy)) return false;
          ci = i; cj = j; k++;
          // erster Punkt: normaler Suchweg; danach höchstens Abstand + 5 mm (die Oberfläche liegt ja ungefähr gleich hoch)
          const zc = await touchAt(k === 1 ? Math.max(1, s.travel) : hop + 5, true);
          if (zc === null) { log(t("hm.failedAt", { k, x: (ox + i * dx).toFixed(1), y: (oy + j * dy).toFixed(1) })); await up(hop, true); return false; }
          if (k === 1 && s.mzero && !await step("G10 L20 P1 Z0")) return false;
          z[j * nx + i] = zc;
          top = Math.max(top, zc);
          log(t("hm.point", { k, n: nx * ny, z: (zc - z[0]).toFixed(3) }));
          if (!await up(hop, true)) return false;
        }
      }
      // zurück zum ersten Punkt – vorher über den höchsten gemessenen Punkt
      if (!await up(Math.max(0, top + hop - machine.status.mpos[2]), false)) return false;
      if (!await moveXY(-ci * dx, -cj * dy)) return false;
      const m: HeightMap = { x0: ox, y0: oy, dx, dy, nx, ny, z: z.map(v => +(v - z[0]).toFixed(4)), date: new Date().toISOString() };
      setHeightMap(m);
      setHeightMapEnabled(true);
      const r = heightRange(m);
      log(t("hm.done", { n: nx * ny, min: r.min.toFixed(3), max: r.max.toFixed(3) }));
      if (r.max - r.min > hop * 0.8) log(t("hm.bigSpread", { d: (r.max - r.min).toFixed(2) }));
      if (!s.mzero) log(t("hm.zeroHint"));
      return true;
    }).finally(() => { mapRunning = false; refresh(); });
  });
  $("pr-map-use")?.addEventListener("change", () => setHeightMapEnabled(($("pr-map-use") as HTMLInputElement).checked));
  $("pr-map-clear")?.addEventListener("click", () => {
    if (!getHeightMap() || !window.confirm(t("hm.clearConfirm"))) return;
    setHeightMap(null);
  });
  /** Anzeige: Größe, Höhen und eine kleine Farbkarte (blau = tief, rot = hoch) */
  const showMap = () => {
    const m = getHeightMap(), info = $("pr-map-info"), use = $("pr-map-use"), cv = $<HTMLCanvasElement>("pr-map-view");
    if (use) { use.checked = heightMapEnabled(); use.disabled = !m; }
    const clr = $<HTMLButtonElement>("pr-map-clear");
    if (clr) clr.disabled = !m;
    if (!info || !cv) return;
    if (!m) { info.textContent = t("hm.none"); cv.style.display = "none"; return; }
    const r = heightRange(m);
    info.textContent = t("hm.info", { nx: m.nx, ny: m.ny, w: ((m.nx - 1) * m.dx).toFixed(0), h: ((m.ny - 1) * m.dy).toFixed(0),
      x: m.x0.toFixed(1), y: m.y0.toFixed(1), min: r.min.toFixed(3), max: r.max.toFixed(3), date: new Date(m.date).toLocaleDateString() });
    cv.style.display = "";
    const ctx = cv.getContext("2d")!;
    const W = cv.width, H = cv.height, span = r.max - r.min || 1;
    const cw = W / m.nx, ch = H / m.ny;
    ctx.clearRect(0, 0, W, H);
    for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.nx; i++) {
      const v = (m.z[j * m.nx + i] - r.min) / span;
      ctx.fillStyle = `hsl(${Math.round(240 - 240 * v)}, 70%, 45%)`;
      ctx.fillRect(i * cw, H - (j + 1) * ch, cw + 0.5, ch + 0.5); // Y nach oben wie auf der Maschine
    }
  };
  window.addEventListener(HEIGHTMAP_CHANGED, showMap);
  window.addEventListener("cnc-language-changed", showMap);
  showMap();

  // Knöpfe nur, wenn es geht
  function refresh() {
    const ok = machine.connected && machine.protocol === "grbl" && !busy && !machine.job.active;
    ["pr-plate-go", "pr-sensor-go"].forEach(id => { const b = $<HTMLButtonElement>(id); if (b) b.disabled = !ok; });
    const go = $<HTMLButtonElement>("pr-map-go");
    if (go) {
      go.disabled = !ok && !mapRunning; // während des Abtastens = Abbrechen
      go.textContent = mapRunning ? "⏹ " + t("hm.stop") : "🗺 " + t("hm.go");
    }
  }
  /** Taster live: offen / Kontakt (aus dem Statusbericht, Pn:P) */
  let liveShown = "";
  const live = () => {
    const el = $("pr-live");
    if (!el) return;
    const st = !machine.connected || machine.protocol !== "grbl" ? "off" : (machine.status.pins || "").includes("P") ? "on" : "open";
    if (st === liveShown) return;
    liveShown = st;
    el.className = "pr-live pr-live-" + st;
    el.textContent = st === "off" ? t("pr.liveOff") : st === "on" ? "● " + t("pr.liveOn") : "○ " + t("pr.liveOpen");
  };
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type } = (e as CustomEvent).detail || {};
    if (type === "status") onReport();
    if (type === "status" || type === "connected" || type === "disconnected" || type === "welcome" || type === "switched") { refresh(); live(); }
  });
  window.addEventListener("cnc-language-changed", () => { liveShown = ""; live(); });
  live();
  refresh();
}
