/**
 * KOORDINATENSYSTEM: Abgleich mit der Steuerung (nur GRBL/grblHAL/FluidNC)
 *
 * machine.wcs      = was die Steuerung zuletzt per $G gemeldet hat ("" = unbekannt, wird beim nächsten „Idle“ gelesen)
 * machine.wcsWanted = was der Nutzer gewählt hat ("" = nie gewählt: dann wird nie etwas umgestellt, nur angezeigt)
 *
 * Nach Jobende (M30) und Reset steht GRBL wieder auf G54. Hat der Nutzer z. B. G55 gewählt, wird es hier wieder
 * eingestellt – sonst liefe der nächste Job an der falschen Stelle.
 */
import { t } from "./i18n/i18n";
import { machine, MACHINE_EVENT, sendAndWait, muteNextParserReply } from "./machine";
import { lineResetsWcs, wcsInLine, type Wcs } from "./wcs";
import { toolChangeBusy } from "./toolChange";
import { probeRunning } from "./probe";
import { macroRunning } from "./macroRun";

let log: (s: string) => void = () => {};
let busy = false;
let lastTry = 0;
let failed = 0;   // Steuerung kennt $G nicht (z. B. fremde Firmware): nicht endlos nachfragen

export function wcsAvailable(): boolean {
  return machine.connected && machine.protocol === "grbl";
}

/** Darf das System gerade gelesen oder gewechselt werden? Nie während Job (auch pausiert), Antasten, Werkzeugwechsel */
export function wcsLocked(): boolean {
  return !wcsAvailable() || machine.job.active || toolChangeBusy() || probeRunning() || macroRunning() || machine.status.state !== "Idle";
}

async function read(): Promise<boolean> {
  muteNextParserReply(true);
  try {
    const a = await sendAndWait("$G", 3000, true);
    failed = a.ok ? 0 : failed + 1;
    return a.ok;
  } finally { muteNextParserReply(false); }
}

/** System lesen und, falls nötig, die Wahl des Nutzers wieder herstellen */
export async function syncWcs(): Promise<void> {
  if (busy || wcsLocked()) return;
  busy = true;
  lastTry = Date.now();
  try {
    if (!await read()) return;
    const want = machine.wcsWanted;
    if (!want || machine.wcs === want || wcsLocked()) return;
    const from = machine.wcs;
    if (!(await sendAndWait(want, 3000, true)).ok) return;
    await read();
    if (machine.wcs === want) log(t("wcs.restored", { w: want, from: from || "?" }));
  } catch { /* Antwort kam nicht – beim nächsten Status wieder */ }
  finally { busy = false; }
}

/** Vom Nutzer gewählt (Auswahlfeld) */
export async function selectWcs(w: Wcs): Promise<void> {
  if (wcsLocked()) return;
  busy = true;
  try {
    const a = await sendAndWait(w, 3000);
    if (!a.ok) { log(t("wcs.failed", { w })); return; }
    machine.wcsWanted = w;
    await read();
    log(t("wcs.selected", { w }));
  } catch { log(t("wcs.failed", { w })); }
  finally { busy = false; }
}

/** Vor dem Jobstart: true = System ist bekannt und passt (oder der Nutzer hat nie eins gewählt) */
export async function ensureWcsForJob(): Promise<boolean> {
  if (!wcsAvailable()) return true;
  await syncWcs();
  if (machine.wcsWanted && machine.wcs !== machine.wcsWanted) { log(t("wcs.notSure", { w: machine.wcsWanted })); return false; }
  if (machine.wcs && machine.wcs !== "G54") log(t("wcs.jobIn", { w: machine.wcs }));
  return true;
}

/** Eine von Hand geschickte Zeile (Konsole, Makro) kann das System ändern */
export function noteManualLine(line: string): void {
  if (!wcsAvailable()) return;
  const w = wcsInLine(line);
  if (w) { machine.wcsWanted = w; machine.wcs = ""; }
  else if (lineResetsWcs(line)) machine.wcs = "";
}

/** Falls unbekannt: beim nächsten Stillstand lesen (Verbindung, Reset, Jobende, nach dem Entsperren) */
export function initWcsSync(logFn: (s: string) => void) {
  log = logFn;
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const type = (e as CustomEvent).detail?.type;
    if (type === "connected" || type === "switched") failed = 0;
    if (type !== "status") return;
    if (!machine.wcs && !busy && failed < 2 && Date.now() - lastTry > 2000) void syncWcs();
  });
}
