/**
 * grblHAL BESCHREIBT SEINE EINSTELLUNGEN SELBST
 *
 * grblHAL kennt viel mehr $-Einstellungen als GRBL 1.1 – und welche es gibt, hängt davon ab, wie die
 * Firmware gebaut wurde (Web Builder: Doppelmotoren, WLAN, SD-Karte …). Statt alles fest einzubauen,
 * fragt die $$-Seite das Board:
 *   $EG  -> [SETTINGGROUP:id|eltern|Name]
 *   $ES  -> [SETTING:id|gruppe|Name|Einheit|Datentyp|Format|Min|Max|Neustart|leer erlaubt]
 *   $ESG -> "id","Name","Einheit","Beschreibung",       (Beschreibung englisch, \n = neue Zeile)
 * Datentyp: 0 Ja/Nein, 1 Bitfeld, 2 Bitfeld mit „ein“-Bit, 3 Auswahl, 4 Achsen-Maske, 5 Ganzzahl,
 *           6 Kommazahl, 7 Text, 8 Passwort, 9 IPv4-Adresse. Bei 1–3 stehen die Auswahl-Texte in Format.
 * Quelle: grblHAL core report.c (SettingsFormat_MachineReadable / SettingsFormat_Grbl), settings.h.
 *
 * Alle Texte kommen vom Board – in der Oberfläche immer mit esc() einsetzen.
 */

export interface HalSetting {
  id: number;
  group: number;
  name: string;
  unit: string;
  type: number;
  labels: string[];   // Bitfeld/Auswahl: Text je Bit bzw. je Wert
  min: string;
  max: string;
  reboot: boolean;    // Änderung wirkt erst nach Neustart des Boards
  desc: string;
}

export const hal = {
  loaded: false,
  settings: new Map<number, HalSetting>(),
  groups: new Map<number, string>()
};

/** $ESG: Beschreibung über mehrere Zeilen (manche Texte enthalten echte Zeilenumbrüche) */
let pending: { id: number; name: string; unit: string; desc: string; lines: number } | null = null;

function storeDesc(id: number, name: string, unit: string, desc: string) {
  desc = desc.replace(/\\n/g, "\n").slice(0, 1500);
  const s = hal.settings.get(id);
  if (s) s.desc = desc;
  else if (hal.settings.size < MAX_SETTINGS) {
    hal.settings.set(id, { id, group: 0, name: name.slice(0, 120), unit: unit.slice(0, 30), type: 5, labels: [], min: "", max: "", reboot: false, desc });
  }
}

/** Offene mehrzeilige Beschreibung abschließen (nach $ESG oder wenn etwas anderes kommt) */
export function flushHal() {
  if (pending) storeDesc(pending.id, pending.name, pending.unit, pending.desc);
  pending = null;
}

/** Mehrere Maschinen: grblHAL-Infos je Maschine merken (Kennung "m1", "m2" …) */
const perMachine = new Map<string, { loaded: boolean; settings: Map<number, HalSetting>; groups: Map<number, string> }>();

/** Beim Umschalten: Infos der alten Maschine wegpacken, die der neuen zurückholen */
export function swapHal(from: string | undefined, to: string) {
  flushHal();
  if (from) perMachine.set(from, { loaded: hal.loaded, settings: new Map(hal.settings), groups: new Map(hal.groups) });
  const c = perMachine.get(to);
  resetHal();
  if (c) {
    hal.loaded = c.loaded;
    c.settings.forEach((v, k) => hal.settings.set(k, v));
    c.groups.forEach((v, k) => hal.groups.set(k, v));
  }
}

export function resetHal() {
  pending = null;
  hal.loaded = false;
  hal.settings.clear();
  hal.groups.clear();
}

const MAX_SETTINGS = 2000; // Schutz vor endlosen Antworten

/**
 * Antwortzeile von $EG / $ES / $ESG einlesen. true = war eine solche Zeile (nicht in der Konsole zeigen)
 */
export function parseHalLine(raw: string): boolean {
  const line = raw.trim();
  // Fortsetzung einer mehrzeiligen Beschreibung: bis eine Zeile mit "," bzw. " endet
  if (pending && !/^\[|^"\d+","/.test(line)) {
    const end = line.match(/^(.*)",?$/);
    pending.desc += "\n" + (end ? end[1] : line);
    if (end || ++pending.lines > 40) flushHal();
    return true;
  }
  flushHal();
  let m = line.match(/^\[SETTING:(.*)\]$/);
  if (m) {
    const f = m[1].split("|");
    const id = parseInt(f[0], 10);
    if (!Number.isFinite(id) || hal.settings.size >= MAX_SETTINGS) return true;
    const type = parseInt(f[4], 10);
    const old = hal.settings.get(id);
    hal.settings.set(id, {
      id,
      group: parseInt(f[1], 10) || 0,
      name: (f[2] || "").slice(0, 120),
      unit: (f[3] || "").slice(0, 30),
      type: Number.isFinite(type) ? type : 5,
      labels: type >= 1 && type <= 3 && f[5] ? f[5].split(",").map(s => s.trim()).slice(0, 32) : [],
      min: (f[6] || "").slice(0, 30),
      max: (f[7] || "").slice(0, 30),
      reboot: f[8] === "1",
      desc: old?.desc || ""
    });
    return true;
  }
  m = line.match(/^\[SETTINGGROUP:(\d+)\|(\d+)\|(.*)\]$/);
  if (m) {
    hal.groups.set(parseInt(m[1], 10), m[3].slice(0, 80));
    return true;
  }
  // $ESG: "id","Name","Einheit","Beschreibung",   (Beschreibung kann über mehrere Zeilen gehen)
  m = line.match(/^"(\d+)","(.*?)","(.*?)","(.*)$/);
  if (m) {
    const id = parseInt(m[1], 10);
    const end = m[4].match(/^(.*)",?$/);
    if (end) storeDesc(id, m[2], m[3], end[1]);
    else pending = { id, name: m[2], unit: m[3], desc: m[4], lines: 0 };
    return true;
  }
  return false;
}
