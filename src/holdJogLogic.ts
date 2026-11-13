/**
 * GEDRÜCKT HALTEN ZUM FAHREN – die Entscheidungen ohne Oberfläche (Tests: `npm test`)
 *
 * Solange ein Pfeil gedrückt ist, fährt die Maschine; beim Loslassen hält sie sofort an.
 * Wie beim Gamepad (gamepadLogic.ts): GRBL kennt kein „fahre, bis ich Stopp sage“. Darum gehen kurze
 * `$J=`-Schritte hinaus, immer nur so viele, wie die Maschine in einem Bruchteil einer Sekunde abfährt.
 * Loslassen schickt Jog-Abbruch (0x85): GRBL leert sofort alle Jog-Fahrten, ohne Reset – die Position bleibt gültig.
 * Reißt die Verbindung ab oder hängt das Fenster, kommen keine neuen Schritte: Die Maschine bleibt nach den
 * wenigen Schritten in der Warteschlange von selbst stehen.
 *
 * Nur GRBL-Familie (GRBL, grblHAL, FluidNC, Grbl_ESP32, MKS …). Marlin bestätigt Zeilen schon beim Einplanen
 * (bis zu 16 Fahrten liefen nach), Ruida und K40 kennen gar keinen Jog-Abbruch: dort gibt es diesen Modus nicht,
 * und es geht auch kein GRBL-Byte hinaus.
 *
 * Grenzen: wie die Pfeil-Knöpfe nur im Bett (jogLimit.ts) und – wenn die Maschine referenziert ist und $130–$132
 * kennt – nie über den Verfahrweg hinaus (softLimits.ts). Z wird so auch oben begrenzt.
 */
import { clampJog } from "./jogLimit.ts";
import { axisRange } from "./softLimits.ts";
import { STEP_S, SETTLE_MS, limitToMachine, lookahead } from "./gamepadLogic.ts";

export { STEP_S, MAX_INFLIGHT, lookahead } from "./gamepadLogic.ts";

/** Wie oft nachgeschoben und geprüft wird */
export const TICK_MS = 50;
/** Abstand zum Ende des Verfahrwegs: GRBL lehnt Ziele genau auf der Grenze je nach Rundung ab */
export const TRAVEL_MARGIN = 0.2;
/** Z ohne bekanntes $112: nicht schneller als das (sonst plant der Schritt mehr Weg, als Z in der Zeit schafft) */
export const Z_FALLBACK_MAX = 600;

// ---------------- Geschwindigkeitsstufen ----------------

export const LEVELS = ["slow", "medium", "fast"] as const;
export type SpeedLevel = typeof LEVELS[number];

export const FEED_MIN = 50, FEED_MAX = 5000;

export interface JogPrefs {
  hold: boolean;                        // Pfeile fahren, solange sie gedrückt sind (sonst: ein Schritt je Klick)
  level: SpeedLevel;
  feeds: Record<SpeedLevel, number>;    // mm/min je Stufe
}

export function defaultPrefs(): JogPrefs {
  return { hold: false, level: "medium", feeds: { slow: 200, medium: 1000, fast: 3000 } };
}

const feedOf = (v: unknown, def: number): number => {
  const n = Number(v);
  return v === null || v === "" || typeof v === "boolean" || !Number.isFinite(n) ? def : Math.round(Math.min(FEED_MAX, Math.max(FEED_MIN, n)));
};

/** Gespeicherte (evtl. kaputte oder von Hand geänderte) Einstellungen in sichere Werte bringen */
export function normalizePrefs(raw: any): JogPrefs {
  const def = defaultPrefs(), r = raw && typeof raw === "object" ? raw : {};
  const f = r.feeds && typeof r.feeds === "object" ? r.feeds : {};
  return {
    hold: r.hold === true,
    level: (LEVELS as readonly string[]).includes(r.level) ? r.level : def.level,
    feeds: { slow: feedOf(f.slow, def.feeds.slow), medium: feedOf(f.medium, def.feeds.medium), fast: feedOf(f.fast, def.feeds.fast) },
  };
}

/** Schieberegler bewegt: der Wert gehört zur gewählten Stufe */
export function setLevelFeed(p: JogPrefs, feed: number): JogPrefs {
  return { ...p, feeds: { ...p.feeds, [p.level]: feedOf(feed, p.feeds[p.level]) } };
}

// ---------------- Darf gerade gefahren werden? ----------------

/** Gibt es den Haltemodus für diese Steuerung? Nur mit echtem Jog-Abbruch (0x85). */
export function holdSupported(protocol: string, firmware: string): boolean {
  return protocol === "grbl" && firmware !== "Marlin" && firmware !== "Smoothieware";
}

export interface HoldContext {
  connected: boolean;
  protocol: string;
  firmware: string;
  state: string;       // Idle, Run, Hold, Jog, Alarm …
  jobActive: boolean;  // auch pausiert: dann nicht fahren
  busy: boolean;       // Werkzeugwechsel, Antasten, Makro
  dialog: boolean;     // ein Fenster ist offen
  focused: boolean;    // CNC Craft ist das aktive, sichtbare Fenster
}

export type HoldBlock = "notConnected" | "protocol" | "alarm" | "job" | "busy" | "dialog" | "focus" | "state";

/** Warum gerade nicht gefahren werden darf (null = es darf) */
export function holdBlock(c: HoldContext): HoldBlock | null {
  if (!c.connected) return "notConnected";
  if (!holdSupported(c.protocol, c.firmware)) return "protocol";
  const s = (c.state || "").split(":")[0];
  if (s === "Alarm") return "alarm";
  if (c.jobActive) return "job";
  if (c.busy) return "busy";
  if (c.dialog) return "dialog";
  if (!c.focused) return "focus";
  if (s !== "Idle" && s !== "Jog") return "state";
  return null;
}

export type HoldAction = "start" | "drive" | "wait" | "stop" | "idle";

/**
 * Was in diesem Takt passiert.
 *  stop:  es fuhr, aber Knopf los oder etwas sperrt -> sofort Jog-Abbruch
 *  start: neue Fahrt beginnen (nur aus dem Stillstand und nicht, während die Maschine nach einem Abbruch noch bremst)
 *  drive: Fahrt läuft, Schritte nachschieben
 *  wait:  Knopf gedrückt, aber die Maschine ist noch nicht bereit (z. B. ein Klick-Schritt fährt noch)
 *  idle:  nichts tun
 */
export function holdAction(held: boolean, block: HoldBlock | null, driving: boolean, state: string, now: number, cancelAt: number): HoldAction {
  if (!held || block !== null) return driving ? "stop" : "idle";
  if (driving) return "drive";
  return state === "Idle" && now - cancelAt >= SETTLE_MS ? "start" : "wait";
}

/**
 * Ein Schritt, der schon unterwegs war, kann NACH dem 0x85 beim Board ankommen. Meldet die Maschine kurz danach
 * weiter „Jog“, den Abbruch wiederholen – alle 200 ms, höchstens 5-mal, nur in der ersten Sekunde.
 */
export function shouldRetryCancel(o: { driving: boolean; connected: boolean; state: string; retries: number; now: number; lastSent: number; cancelAt: number }): boolean {
  if (o.driving || !o.connected || o.retries >= 5 || !Number.isFinite(o.cancelAt)) return false;
  if (o.now - o.cancelAt > 1000 || o.now - o.lastSent < 200) return false;
  return o.state.split(":")[0] === "Jog";
}

// ---------------- Richtung, Tempo, Grenzen ----------------

/**
 * Geschwindigkeit je Achse in mm/min. Schräg ist nicht schneller als gerade.
 * caps: $110–$112 (undefined = unbekannt); Z ohne $112 höchstens Z_FALLBACK_MAX.
 */
export function holdVelocity(dir: number[], feed: number, caps: (number | undefined)[]): number[] {
  const len = Math.hypot(dir[0] || 0, dir[1] || 0, dir[2] || 0);
  if (!(len > 0) || !(feed > 0)) return [0, 0, 0];
  const v = [0, 1, 2].map(i => ((dir[i] || 0) / len) * feed);
  return limitToMachine(v, [caps[0], caps[1], caps[2] ?? Z_FALLBACK_MAX]);
}

/** Wie viele Millisekunden Fahrt vorausgeschickt werden (Bremsweg + Reserve, siehe gamepadLogic.lookahead) */
export function aheadMs(v: number[], accels: (number | undefined)[]): number {
  const moving = [0, 1, 2].filter(i => v[i]);
  const a = moving.map(i => accels[i]);
  const accel = a.length && a.every(x => x && x > 0) ? Math.min(...(a as number[])) : undefined;
  return lookahead(Math.hypot(v[0], v[1], v[2]), accel) * 1000;
}

export interface TravelEnv {
  travel: number[];     // $130/$131/$132 in mm (≤ 0 oder NaN = unbekannt)
  homeDirMask: number;  // $23
  pulloff: number;      // $27
  homed: boolean;       // referenziert? Sonst ist die Maschinen-Position nur ein Zählerstand
  mpos: number[];
  wpos: number[];
}

/**
 * Erlaubter Bereich je Achse in Werkstück-Koordinaten, mit TRAVEL_MARGIN Abstand zum Ende.
 * null = nicht bekannt (nicht referenziert, $13x fehlt, Lage nicht eindeutig) – dann gilt nur die Bett-Grenze.
 */
export function travelBox(env: TravelEnv): ([number, number] | null)[] {
  return [0, 1, 2].map(i => {
    if (!env.homed) return null;
    const r = axisRange(env.travel[i], env.mpos[i], !!((env.homeDirMask >> i) & 1), env.pulloff);
    if (!r) return null;
    const wco = env.mpos[i] - env.wpos[i];
    return [r[0] - wco + TRAVEL_MARGIN, r[1] - wco - TRAVEL_MARGIN] as [number, number];
  });
}

/** Ein Wert gegen einen Bereich kürzen. Steht er schon draußen, darf er nur zurück, nicht weiter weg. */
function clampAxis(p: number, d: number, lo: number, hi: number): number {
  const target = p + d;
  if (d > 0 && target > hi) return +(Math.max(p, hi) - p).toFixed(3);
  if (d < 0 && target < lo) return +(Math.min(p, lo) - p).toFixed(3);
  return d;
}

export interface Edge { axis: number; why: "bed" | "travel"; reached: boolean }

export interface HoldStep {
  line: string;        // "" = an der Grenze geht nichts mehr
  delta: number[];
  end: number[];       // Ziel dieses Schritts (Start für den nächsten)
  feed: number;
  edges: Edge[];       // wo gekürzt wurde (für eine Meldung)
}

/**
 * Nächster Schritt für dt Sekunden Fahrt.
 * @param from Ziel des letzten Schritts (nicht die gemeldete Lage – die hinkt hinterher)
 */
export function planHoldStep(v: number[], from: number[], bed: { w: number; h: number }, box: ([number, number] | null)[], dt = STEP_S): HoldStep {
  const want = v.map(s => +(s / 60 * dt).toFixed(3));
  const b = clampJog(from, want, bed);
  const delta = b.delta.slice();
  const edges: Edge[] = b.clamped.map(axis => ({ axis, why: "bed" as const, reached: !delta[axis] }));
  for (let i = 0; i < 3; i++) {
    const r = box[i];
    if (!r || !delta[i]) continue;
    const d = clampAxis(from[i], delta[i], r[0], r[1]);
    if (d !== delta[i]) {
      delta[i] = d;
      const e = edges.find(x => x.axis === i);
      if (e) { e.why = "travel"; e.reached = !d; } else edges.push({ axis: i, why: "travel", reached: !d });
    }
  }
  const end = from.map((p, i) => +(p + delta[i]).toFixed(3));
  const axes = delta.map((d, i) => (d ? `${"XYZ"[i]}${d.toFixed(3)}` : "")).filter(Boolean);
  // an der Grenze fällt eine Achse weg: F neu aus dem gekürzten Weg, sonst würde die andere Achse schneller
  const feed = Math.max(1, Math.round(Math.hypot(delta[0], delta[1], delta[2]) / dt * 60));
  return { line: axes.length ? `$J=G21 G91 ${axes.join(" ")} F${feed}` : "", delta, end, feed, edges };
}

/** Richtung aus dem data-cmd eines Pfeil-Knopfs ("X1 Y-1", "Z-1") */
export function dirFromCmd(cmd: string): number[] {
  const d = [0, 0, 0];
  for (const p of (cmd || "").trim().split(/\s+/)) {
    const i = "XYZ".indexOf(p[0]);
    const n = parseInt(p.slice(1), 10);
    if (i >= 0 && (n === 1 || n === -1)) d[i] = n;
  }
  return d;
}
