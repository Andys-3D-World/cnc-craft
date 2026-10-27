/**
 * ANTAST-ROUTINE (gemeinsam für den Abschnitt „Antasten“ in ui/probePanel.ts und den Werkzeugwechsel in toolChange.ts)
 *
 * Antasten in zwei Schritten (schnell suchen, 2 mm zurück, langsam genau messen) – in der Software mit Jog-Fahrten
 * und Entprellung statt G38.2 (siehe probeDown: das Arduino-CNC-Shield fängt beim Fahren ständig Störimpulse ein,
 * G38.2 hält bei jedem an). Alle Fahrten RELATIV: das Ziel hängt so nicht an der gemeldeten Werkstück-Position
 * (GRBL schickt den Versatz WCO nur ab und zu, ein veralteter Wert ließ Z nach oben fahren).
 *
 * Wächter (während des ganzen Ablaufs, bei jedem Statusbericht):
 *   - Taster meldet Kontakt (Pn:P), die Maschine fährt aber weiter → sofort Halt (!) + Reset
 *     (bei Eilfahrten hoch/zum Sensor reagiert GRBL selbst nicht auf den Taster; oder das Board wertet ihn nicht aus)
 *   - beim Antasten fährt Z nach OBEN statt nach unten → sofort Halt + Reset (Z-Richtung $3 falsch?)
 *
 * Abbruch von außen (abortProbe): Jog-Abbruch, danach schickt die Routine nichts mehr (step() gibt false zurück).
 */
import { t } from "./i18n/i18n";
import { machine, MACHINE_EVENT, sendAndWait, errorText, realtime, RT } from "./machine";

const KEY = "cnc_craft_probe";
export const LIFT_MAX = 30;

export interface ProbeSettings {
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
  // ---- Werkzeugwechsel (toolChange.ts) ----
  tcMode: number;     // 0 = von Hand (nur Hinweis), 1 = fester Sensor, 2 = mobile Tastplatte
  tcSafe: number;     // sichere Höhe (Maschinen-Z) – es wird nur hoch-, nie runtergefahren
  tcLift: number;     // Anheben beim Wechsel: 0 = auf tcSafe, 1 = ganz nach oben (unter den Endschalter), 2 = nicht (nur „von Hand“),
                      // 3 = auf tcWorkZ über dem Werkstück-Nullpunkt (geht auch ohne Referenzfahrt)
  tcWorkZ: number;    // Höhe über dem Werkstück-Nullpunkt (mm) für tcLift 3 (und Ersatz für 1 ohne Referenzfahrt)
  tcSz: number;       // Maschinen-Z, bis zu der über dem Sensor zügig runtergefahren wird (≥ tcSafe = gar nicht)
  tcTravel: number;   // höchste Antast-Distanz beim Werkzeugwechsel (mm)
  tcPos: number;      // 0 = XY bleibt, 1 = zur Wechselposition fahren
  tcX: number; tcY: number; // Wechselposition (Maschinenkoordinaten)
  tcFeed: number;     // Fahrt zwischen Positionen (mm/min)
  tcM6: number;       // G-Code: 1 = Werkzeugwechsel als „M6 T<n>“ statt „M0“
  // ---- Nachmessen bei langen Jobs (Wärmegang, toolChange.ts runDrift) ----
  drOn: number;       // 1 = Mess-Punkte in den G-Code (Standard 0 = aus)
  drMin: number;      // alle so viele Minuten (geschätzte Laufzeit)
}
const DEF: ProbeSettings = { plate: 20, sx: 0, sy: 0, sensorH: 30, material: 10, travel: 50, fast: 200, slow: 25, lift: 10, sensorSet: 0,
  mx: 100, my: 100, mnx: 5, mny: 5, hop: 3, mzero: 1,
  tcMode: 0, tcSafe: -2, tcLift: 0, tcWorkZ: 40, tcSz: -2, tcTravel: 80, tcPos: 0, tcX: 0, tcY: 0, tcFeed: 1500, tcM6: 0,
  drOn: 0, drMin: 60 };

function load(): ProbeSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: any = { ...DEF };
    for (const k of Object.keys(DEF)) if (s[k] !== undefined && Number.isFinite(Number(s[k]))) o[k] = Number(s[k]);
    o.lift = Math.min(LIFT_MAX, Math.max(0, o.lift)); // früher ging auch mehr (100 mm fuhr gegen den Endschalter)
    return o;
  } catch { return { ...DEF }; }
}
/** Die Einstellungen (ein Objekt für alle – Änderungen danach mit saveProbe() speichern) */
export const probeSettings: ProbeSettings = load();
export function saveProbe() { try { localStorage.setItem(KEY, JSON.stringify(probeSettings)); } catch { /* egal */ } }

const s = probeSettings;
let log: (s: string) => void = () => {};
export function setProbeLog(fn: (s: string) => void) { log = fn; }

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- Abbruch von außen ----
let aborted = false;
/** Laufende Antast-Fahrt sofort beenden (Jog-Abbruch); danach schickt die Routine keine Zeile mehr */
export function abortProbe(sendCancel = true) {
  aborted = true;
  if (sendCancel && machine.connected) realtime(RT.jogCancel).catch(() => undefined);
}
export const probeAborted = () => aborted;

/** Warten, bis die Maschine steht (Idle) und ein frischer Statusbericht da ist */
export async function settled(timeoutMs = 60000): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  await sleep(300);
  while (performance.now() < end) {
    if (aborted) return false;
    const st = machine.status.state;
    if (st === "Alarm" || !machine.connected) return false;
    if (st === "Idle") { await sleep(250); return machine.status.state === "Idle"; }
    await sleep(150);
  }
  return false;
}

/** Eine Zeile schicken; false (mit Meldung) bei Fehler/Alarm/Abbruch */
export async function step(line: string, timeoutMs = 10000): Promise<boolean> {
  if (aborted) return false;
  const a = await sendAndWait(line, timeoutMs);
  if (!a.ok) { log(t("pr.failed", { cmd: line, e: a.code && a.code > 0 ? errorText(a.code) : String(a.code ?? "") })); return false; }
  return !aborted;
}

/** Hochfahren höchstens LIFT_MAX mm – mehr fährt meist gegen den Z-Endschalter */
const liftMm = () => Math.min(LIFT_MAX, Math.max(0, s.lift));

// ---- Wächter ----
/** probing = gerade läuft die Suche nach unten (dann darf Z nicht steigen, Kontakt beendet die Fahrt selbst) */
/** away = gerade weg vom Kontakt hochfahren (Taster darf da noch geschlossen sein) */
export const guard = { on: false, probing: false, away: false, z0: 0, hits: 0, tripped: "" as "" | "noStop" | "wrongDir", timer: 0 };
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
window.addEventListener(MACHINE_EVENT, (e: Event) => { if ((e as CustomEvent).detail?.type === "status") onReport(); });

export const startGuard = () => {
  guard.on = true; guard.tripped = ""; guard.hits = 0; aborted = false;
  clearInterval(guard.timer);
  // öfter nach dem Status fragen, solange der Ablauf läuft (schnellere Reaktion des Wächters)
  guard.timer = window.setInterval(() => { if (guard.on && machine.connected) realtime(RT.status).catch(() => undefined); }, 100);
};
export const stopGuard = () => { guard.on = false; guard.probing = false; clearInterval(guard.timer); };

/** frischen Statusbericht abwarten (nach „?“), höchstens 400 ms */
export const freshStatus = () => new Promise<void>(res => {
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
        if (aborted || guard.tripped || !machine.connected || machine.status.state === "Alarm") return null;
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
 * Z relativ nach unten bis Kontakt: schnell suchen, 2 mm zurück, langsam messen.
 * Beide Messungen müssen auf 0,5 mm übereinstimmen, sonst Abbruch OHNE Z zu setzen.
 * Rückgabe: Maschinen-Z der genauen Messung oder null. quiet = keine Zwischenmeldungen (Höhenkarte)
 */
export const touchAt = async (travel: number, quiet = false): Promise<number | null> => {
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
export const touch = async (extra = 0): Promise<boolean> => (await touchAt(Math.max(1, s.travel) + Math.max(0, extra))) !== null;
/** relativ um lift hochfahren; fromContact = direkt nach dem Antasten (Taster ist noch geschlossen) */
export const liftUp = async (fromContact = false): Promise<boolean> => {
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
export const preLift = async (): Promise<number | null> => {
  const z = machine.status.mpos[2];
  const up = Math.min(z + liftMm(), -1) - z;
  if (!(up > 0.05)) { log(t("pr.phaseNoLift")); return 0; }
  log(t("pr.phaseLift", { mm: +up.toFixed(1) }));
  if (!await step(`G91 G0 Z${up.toFixed(3)}`)) return null;
  if (!await step("G90")) return null;
  return await settled() ? up : null;
};

/** G90 ohne Konsolen-Zeile (nach jedem Ablauf: nie im relativen Modus stehen lassen) */
export const sendG90Quiet = () => sendAndWait("G90", 3000, true).then(() => undefined, () => undefined);
