/**
 * GAMEPAD – die reine Logik ohne Fenster und Maschine (Tests: `npm test`)
 *
 * Stick -> Geschwindigkeit -> kurzer Jog-Schritt ($J=… relativ), Totmann-Regeln, Tastenbelegung.
 * Das eigentliche Lesen des Gamepads und das Senden macht gamepad.ts, die Anzeige ui/gamepadPanel.ts.
 *
 * Warum kurze Schritte? GRBL kennt kein „fahre, bis ich Stopp sage“. Also wird alle STEP_S ein Stück geschickt,
 * das genau so lang ist, wie die Maschine in dieser Zeit fährt. Beim Loslassen löscht 0x85 die Warteschlange
 * sofort. Reißt die Verbindung ab, kann 0x85 nicht mehr ankommen – dann hält die Maschine von selbst an,
 * sobald die wenigen Schritte in der Warteschlange abgefahren sind.
 */
import { clampJog } from "./jogLimit.ts";

/** Wie oft das Gamepad gelesen wird */
export const TICK_MS = 50;
/** Länge eines Jog-Schritts in Sekunden Fahrzeit */
export const STEP_S = 0.1;
/** So viele Schritte dürfen unbestätigt unterwegs sein */
export const MAX_INFLIGHT = 4;
/** Nach dem Abbruch (0x85) so lange warten: die Maschine bremst noch, Schritte in dieser Zeit gingen verloren */
export const SETTLE_MS = 150;

/** Geschwindigkeitsstufen als Anteil der Höchstgeschwindigkeit */
export const SPEED_LEVELS = [0.1, 0.25, 0.5, 1];
/** Startstufe: bewusst nicht die schnellste und nicht gespeichert */
export const DEFAULT_LEVEL = 1;

export const ACTIONS = ["startPause", "stop", "home", "zeroXY", "zeroZ", "speedUp", "speedDown", "zUp", "zDown"] as const;
export type GamepadAction = typeof ACTIONS[number];

export interface GamepadConfig {
  enabled: boolean;
  deadman: number;     // Knopf-Nummer, die beim Fahren gehalten werden muss
  deadzone: number;    // 0.05 … 0.5
  maxFeed: number;     // X/Y in mm/min
  maxFeedZ: number;    // Z in mm/min
  buttons: Record<GamepadAction, number>; // -1 = nicht belegt
}

/** Nummern nach der „Standard“-Belegung der Gamepad-Schnittstelle (Xbox / PlayStation) */
export const BUTTON_NAMES = ["A / ✕", "B / ○", "X / □", "Y / △", "LB / L1", "RB / R1", "LT / L2", "RT / R2", "Back / Share", "Start / Options", "LS / L3", "RS / R3", "↑", "↓", "←", "→", "Home"];
export const BUTTON_COUNT = 20;

export function buttonLabel(i: number): string {
  return BUTTON_NAMES[i] ? `${i} · ${BUTTON_NAMES[i]}` : String(i);
}

export function defaultConfig(): GamepadConfig {
  return {
    enabled: false, deadman: 4, deadzone: 0.15, maxFeed: 2000, maxFeedZ: 500,
    buttons: { startPause: 9, stop: 1, home: 3, zeroXY: 2, zeroZ: 0, speedUp: 12, speedDown: 13, zUp: -1, zDown: -1 },
  };
}

const num = (v: unknown, def: number, min: number, max: number): number => {
  const n = Number(v);
  return v === null || v === "" || !Number.isFinite(n) ? def : Math.min(max, Math.max(min, n));
};
const buttonNr = (v: unknown, def: number, min: number): number => {
  const n = Number(v);
  return v === null || v === "" || !Number.isInteger(n) || n < min || n >= BUTTON_COUNT ? def : n;
};

/** Gespeicherte (evtl. kaputte oder veraltete) Einstellungen in sichere Werte bringen */
export function normalizeConfig(raw: any): GamepadConfig {
  const def = defaultConfig(), r = raw && typeof raw === "object" ? raw : {};
  const b = r.buttons && typeof r.buttons === "object" ? r.buttons : {};
  const cfg: GamepadConfig = {
    enabled: r.enabled === true,
    deadman: buttonNr(r.deadman, def.deadman, 0),
    deadzone: num(r.deadzone, def.deadzone, 0.05, 0.5),
    maxFeed: num(r.maxFeed, def.maxFeed, 10, 50000),
    maxFeedZ: num(r.maxFeedZ, def.maxFeedZ, 10, 50000),
    buttons: { ...def.buttons },
  };
  // der Reihe nach über assignButton: so hat auch eine von Hand geänderte Datei keine Doppelbelegung
  for (const a of ACTIONS) cfg.buttons[a] = -1;
  for (const a of ACTIONS) {
    const next = assignButton(cfg, a, buttonNr(b[a], def.buttons[a], -1));
    cfg.buttons = next.buttons;
  }
  return cfg;
}

/**
 * Knopf belegen. Ein Knopf hat immer nur eine Aufgabe – sonst würde z. B. ein Druck Referenzfahrt UND Start auslösen:
 * bisherige Belegung wird gelöscht. Der Totmann-Knopf bleibt immer belegt und lässt sich nicht für etwas anderes nehmen.
 */
export function assignButton(cfg: GamepadConfig, target: GamepadAction | "deadman", btn: number): GamepadConfig {
  const out: GamepadConfig = { ...cfg, buttons: { ...cfg.buttons } };
  if (target === "deadman") {
    if (btn < 0) return out;
    out.deadman = btn;
  } else {
    if (btn === cfg.deadman) { out.buttons[target] = -1; return out; }
    out.buttons[target] = btn;
  }
  if (btn >= 0) for (const a of ACTIONS) if (a !== target && out.buttons[a] === btn) out.buttons[a] = -1;
  return out;
}

/**
 * Stick-Wert mit Totzone: innerhalb 0, danach von 0 bis ±1.
 * Quadratisch, damit wenig Ausschlag sehr langsam und damit feinfühlig fährt.
 */
export function stickValue(v: number, deadzone: number): number {
  if (!Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  const x = Math.min(1, (a - deadzone) / (1 - deadzone));
  return Math.sign(v) * x * x;
}

/**
 * Eine Achse fährt erst, wenn sie seit dem Drücken des Totmann-Knopfs einmal in der Mitte war.
 * So ruckt nichts los, wenn der Stick beim Drücken schon ausgelenkt ist. Und: Billige Gamepads melden Schultertasten
 * oft als Achse, die in Ruhe bei -1 steht – so eine Achse bleibt gesperrt, statt loszufahren.
 */
export function updateArmed(armed: boolean[], values: number[], deadman: boolean): boolean[] {
  return values.map((v, i) => deadman && (armed[i] === true || v === 0));
}

/** Geschwindigkeit je Achse in mm/min. Schräg ist nicht schneller als gerade. */
export function velocity(stick: number[], cfg: Pick<GamepadConfig, "maxFeed" | "maxFeedZ">, level: number): number[] {
  const f = SPEED_LEVELS[level] ?? SPEED_LEVELS[DEFAULT_LEVEL];
  const xy = Math.hypot(stick[0], stick[1]);
  const k = xy > 1 ? 1 / xy : 1;
  return [stick[0] * k * cfg.maxFeed * f, stick[1] * k * cfg.maxFeed * f, stick[2] * cfg.maxFeedZ * f];
}

/** Nicht schneller als die Maschine darf ($110–$112): sonst käme sie mit den Schritten nicht nach. Die Richtung bleibt. */
export function limitToMachine(v: number[], caps: (number | undefined)[]): number[] {
  let k = 1;
  v.forEach((s, i) => {
    const c = caps[i];
    if (s && c && c > 0 && Math.abs(s) > c) k = Math.min(k, c / Math.abs(s));
  });
  return k < 1 ? v.map(s => s * k) : v;
}

/**
 * Wie viele Sekunden Fahrt in der Warteschlange liegen sollen. GRBL plant so, dass es am Ende der Warteschlange
 * stehen kann – ist sie kürzer als der Bremsweg, erreicht die Maschine nie die volle Geschwindigkeit.
 * @param accel Beschleunigung in mm/s² ($120–$122), undefined = unbekannt
 */
export function lookahead(feed: number, accel: number | undefined): number {
  if (!accel || accel <= 0) return 0.3;
  const v = feed / 60;
  return Math.min(1, Math.max(0.2, v / (2 * accel) + 0.1));
}

export interface JogStep { line: string; delta: number[]; end: number[]; feed: number; clamped: number[] }

/**
 * Nächster Schritt für STEP_S Sekunden Fahrt; das Bett begrenzt wie bei den Pfeil-Knöpfen (jogLimit.ts).
 * @param from Ziel des letzten Schritts (nicht die gemeldete Lage – die hinkt hinterher)
 * @returns delta/line leer, wenn am Rand nichts mehr geht
 */
export function planStep(v: number[], from: number[], bed: { w: number; h: number }, dt = STEP_S): JogStep {
  const want = v.map(s => +(s / 60 * dt).toFixed(3));
  const { delta, clamped } = clampJog(from, want, bed);
  const end = from.map((p, i) => p + delta[i]);
  const axes = delta.map((d, i) => (d ? `${"XYZ"[i]}${d.toFixed(3)}` : "")).filter(Boolean);
  // am Rand fällt eine Achse weg: F neu aus dem gekürzten Weg, sonst würde die andere Achse schneller
  const feed = Math.max(1, Math.round(Math.hypot(delta[0], delta[1], delta[2]) / dt * 60));
  return { line: axes.length ? `$J=G21 G91 ${axes.join(" ")} F${feed}` : "", delta, end, feed, clamped };
}

// ---------------- Regeln: was ist gerade erlaubt? ----------------

/** Was der Regel-Prüfung über die Maschine bekannt ist */
export interface GamepadContext {
  connected: boolean;
  protocol: string;
  state: string;       // Idle, Run, Hold, Jog, Alarm …
  jobActive: boolean;
  jobPaused: boolean;
  jobLoaded: boolean;  // G-Code zum Starten vorhanden
  busy: boolean;       // Werkzeugwechsel oder Antasten läuft
  dialog: boolean;     // ein Fenster ist offen
  focused: boolean;    // CNC Craft ist das aktive Fenster
}

export type BlockReason = "notConnected" | "protocol" | "alarm" | "job" | "busy" | "dialog" | "focus" | "state";

/** Warum gerade nichts fahren darf (null = es darf). Totmann und Stick prüft isDriving. */
export function blockReason(c: GamepadContext): BlockReason | null {
  if (!c.connected) return "notConnected";
  if (c.protocol !== "grbl") return "protocol";
  if (c.state === "Alarm") return "alarm";
  if (c.jobActive) return "job";
  if (c.busy) return "busy";
  if (c.dialog) return "dialog";
  if (!c.focused) return "focus";
  if (c.state !== "Idle" && c.state !== "Jog") return "state";
  return null;
}

/** Soll in diesem Moment gefahren werden? */
export function isDriving(c: GamepadContext, deadman: boolean, stick: number[]): boolean {
  return deadman && blockReason(c) === null && stick.some(v => v !== 0);
}

/**
 * Darf eine neue Fahrt beginnen? Nur aus dem Stillstand (eine Fahrt von den Pfeil-Knöpfen läuft sonst noch)
 * und nicht während die Maschine nach einem Abbruch noch bremst.
 */
export function canStartDrive(state: string, now: number, cancelAt: number): boolean {
  return state === "Idle" && now - cancelAt >= SETTLE_MS;
}

export type GamepadCommand = "start" | "pause" | "resume" | "hold" | "home" | "zeroXY" | "zeroZ" | "speedUp" | "speedDown";

/**
 * Was ein Knopfdruck bewirkt (null = gerade nichts).
 * Alles, was anhält, geht immer und ohne Totmann. Alles, was bewegt oder den Nullpunkt ändert, braucht den Totmann –
 * ein Gamepad liegt schnell mal auf dem Tisch und bekommt versehentlich einen Knopf gedrückt.
 */
export function resolveAction(a: GamepadAction, c: GamepadContext, deadman: boolean): GamepadCommand | null {
  if (a === "speedUp" || a === "speedDown") return a;
  if (a === "zUp" || a === "zDown") return null; // gehalten, nicht gedrückt: zählt wie ein Stick
  if (!c.connected) return null;
  if (a === "stop") return "hold";
  if (a === "startPause") {
    if (c.jobActive && !c.jobPaused) return "pause";
    const noOther = deadman && !c.busy && !c.dialog && c.focused && c.state !== "Alarm";
    if (c.jobActive) return noOther ? "resume" : null;
    if (c.state === "Hold") return noOther ? "resume" : null;
    return noOther && c.state === "Idle" && c.jobLoaded ? "start" : null;
  }
  // Referenzfahrt, Nullpunkt: nur im Stillstand, ohne Job, ohne Alarm
  if (!deadman || c.state !== "Idle" || blockReason(c) !== null) return null;
  return a;
}
