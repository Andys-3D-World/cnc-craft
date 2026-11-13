// Gedrückt halten zum Fahren – läuft mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePrefs, defaultPrefs, setLevelFeed, holdSupported, holdBlock, holdAction, shouldRetryCancel,
  holdVelocity, aheadMs, travelBox, planHoldStep, dirFromCmd, type HoldContext, FEED_MIN, FEED_MAX, Z_FALLBACK_MAX, TRAVEL_MARGIN,
} from "../src/holdJogLogic.ts";

const ready: HoldContext = { connected: true, protocol: "grbl", firmware: "grblHAL", state: "Idle", jobActive: false, busy: false, dialog: false, focused: true };
const bed = { w: 400, h: 300 };
const noBox = [null, null, null];

test("Einstellungen: kaputte Werte werden sicher, Stufe und Haltemodus bleiben", () => {
  assert.deepEqual(normalizePrefs(null), defaultPrefs());
  assert.deepEqual(normalizePrefs("quatsch"), defaultPrefs());
  const p = normalizePrefs({ hold: true, level: "fast", feeds: { slow: 5, medium: "1500", fast: 99999 } });
  assert.equal(p.hold, true);
  assert.equal(p.level, "fast");
  assert.deepEqual(p.feeds, { slow: FEED_MIN, medium: 1500, fast: FEED_MAX });
  assert.equal(normalizePrefs({ hold: "ja", level: "turbo" }).hold, false, "nur echtes true schaltet den Haltemodus ein");
  assert.equal(normalizePrefs({ level: "turbo" }).level, "medium");
  assert.equal(normalizePrefs({ feeds: { slow: NaN, medium: null, fast: true } }).feeds.fast, defaultPrefs().feeds.fast);
});

test("Schieberegler ändert nur die gewählte Stufe", () => {
  const p = setLevelFeed({ ...defaultPrefs(), level: "slow" }, 350);
  assert.equal(p.feeds.slow, 350);
  assert.equal(p.feeds.medium, defaultPrefs().feeds.medium);
  assert.equal(setLevelFeed(p, 1e9).feeds.slow, FEED_MAX);
});

test("nur GRBL-Familie: Marlin, Ruida, K40 bekommen keinen Haltemodus", () => {
  assert.equal(holdSupported("grbl", "GRBL"), true);
  assert.equal(holdSupported("grbl", "FluidNC"), true);
  assert.equal(holdSupported("grbl", ""), true);
  assert.equal(holdSupported("grbl", "Marlin"), false);
  assert.equal(holdSupported("grbl", "Smoothieware"), false);
  for (const p of ["marlin", "ruida", "k40"]) assert.equal(holdSupported(p, "Marlin"), false, p);
  assert.equal(holdBlock({ ...ready, protocol: "ruida", firmware: "Ruida" }), "protocol");
});

test("Sperren: Verbindung, Alarm, Job (auch pausiert), Antasten, Fenster, Fokus, falscher Zustand", () => {
  assert.equal(holdBlock(ready), null);
  assert.equal(holdBlock({ ...ready, state: "Jog" }), null);
  assert.equal(holdBlock({ ...ready, connected: false }), "notConnected");
  assert.equal(holdBlock({ ...ready, state: "Alarm" }), "alarm");
  assert.equal(holdBlock({ ...ready, jobActive: true, state: "Hold:0" }), "job");
  assert.equal(holdBlock({ ...ready, busy: true }), "busy");
  assert.equal(holdBlock({ ...ready, dialog: true }), "dialog");
  assert.equal(holdBlock({ ...ready, focused: false }), "focus");
  for (const s of ["Run", "Hold:0", "Home", "Door:1", "Check", "Sleep", ""]) assert.equal(holdBlock({ ...ready, state: s }), "state", s);
});

test("Ablauf: Loslassen oder Sperre hält sofort an, Start nur aus dem Stillstand", () => {
  assert.equal(holdAction(false, null, true, "Jog", 1000, 0), "stop");
  assert.equal(holdAction(true, "focus", true, "Jog", 1000, 0), "stop");
  assert.equal(holdAction(true, "notConnected", true, "Jog", 1000, 0), "stop");
  assert.equal(holdAction(false, null, false, "Idle", 1000, 0), "idle");
  assert.equal(holdAction(true, "job", false, "Idle", 1000, 0), "idle");
  assert.equal(holdAction(true, null, true, "Jog", 1000, 0), "drive");
  assert.equal(holdAction(true, null, false, "Idle", 1000, -Infinity), "start");
  // ein Klick-Schritt fährt noch, oder die Maschine bremst noch vom letzten Abbruch
  assert.equal(holdAction(true, null, false, "Jog", 1000, -Infinity), "wait");
  assert.equal(holdAction(true, null, false, "Idle", 1050, 1000), "wait");
  assert.equal(holdAction(true, null, false, "Idle", 1200, 1000), "start");
});

test("Abbruch wiederholen, solange die Maschine kurz danach noch „Jog“ meldet", () => {
  const base = { driving: false, connected: true, state: "Jog", retries: 0, now: 1300, lastSent: 1000, cancelAt: 1000 };
  assert.equal(shouldRetryCancel(base), true);
  assert.equal(shouldRetryCancel({ ...base, state: "Idle" }), false);
  assert.equal(shouldRetryCancel({ ...base, now: 1100 }), false, "nicht öfter als alle 200 ms");
  assert.equal(shouldRetryCancel({ ...base, retries: 5 }), false);
  assert.equal(shouldRetryCancel({ ...base, now: 2500, lastSent: 2200 }), false, "nur in der ersten Sekunde");
  assert.equal(shouldRetryCancel({ ...base, driving: true }), false);
  assert.equal(shouldRetryCancel({ ...base, connected: false }), false);
  assert.equal(shouldRetryCancel({ ...base, cancelAt: -Infinity }), false);
});

test("Tempo: schräg nicht schneller, Grenzen der Maschine, Z ohne $112 gebremst", () => {
  const v = holdVelocity([1, 1, 0], 1000, [5000, 5000, 500]);
  assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1000) < 1e-6);
  assert.deepEqual(holdVelocity([1, 0, 0], 3000, [2000, 2000, 500]), [2000, 0, 0]);
  assert.deepEqual(holdVelocity([0, 0, -1], 3000, [undefined, undefined, undefined]), [0, 0, -Z_FALLBACK_MAX]);
  assert.deepEqual(holdVelocity([0, 0, 1], 3000, [undefined, undefined, 800]), [0, 0, 800]);
  assert.deepEqual(holdVelocity([0, 0, 0], 1000, []), [0, 0, 0]);
  assert.ok(aheadMs([1000, 0, 0], [500, 500, 100]) >= 200);
  assert.ok(aheadMs([1000, 0, 0], [undefined]) === 300);
});

test("Schritt: kurze $J=-Zeile in mm und relativ", () => {
  const s = planHoldStep([600, 0, 0], [10, 10, 0], bed, noBox);
  assert.equal(s.line, "$J=G21 G91 X1.000 F600");
  assert.deepEqual(s.end, [11, 10, 0]);
  assert.deepEqual(s.edges, []);
  const z = planHoldStep([0, 0, -300], [10, 10, 0], bed, noBox);
  assert.equal(z.line, "$J=G21 G91 Z-0.500 F300");
});

test("Bettrand: nur bis zum Rand, dann nichts mehr; die andere Achse fährt weiter", () => {
  const s = planHoldStep([600, 600, 0], [399.5, 100, 0], bed, noBox);
  assert.equal(s.delta[0], 0.5);
  assert.equal(s.delta[1], 1);
  assert.deepEqual(s.edges, [{ axis: 0, why: "bed", reached: false }]);
  const at = planHoldStep([600, 0, 0], [400, 100, 0], bed, noBox);
  assert.equal(at.line, "");
  assert.deepEqual(at.edges, [{ axis: 0, why: "bed", reached: true }]);
  // zurück ins Bett geht immer
  assert.equal(planHoldStep([-600, 0, 0], [400, 100, 0], bed, noBox).delta[0], -1);
});

test("Verfahrweg (referenziert): Maschine bleibt innerhalb $130–$132, auch Z oben", () => {
  // normales GRBL: Maschinenbereich −Weg … 0; Werkstück-Nullpunkt 100/50/−20 im Maschinenraum
  const env = { travel: [400, 300, 80], homeDirMask: 0, pulloff: 1, homed: true, mpos: [-300, -250, -5], wpos: [-200, -200, 15] };
  const box = travelBox(env);
  // WCO = mpos − wpos = [−100, −50, −20] → Werkstück-Bereich = Maschinenbereich − WCO
  assert.deepEqual(box[0], [-300 + TRAVEL_MARGIN, 100 - TRAVEL_MARGIN]);
  assert.deepEqual(box[2], [-60 + TRAVEL_MARGIN, 20 - TRAVEL_MARGIN]);
  // Z nach oben: bei 19.9 ist Schluss (Maschine Z = −0.2)
  const z = planHoldStep([0, 0, 600], [0, 0, 19.5], { w: 0, h: 0 }, box);
  assert.equal(z.delta[2], 0.3);
  assert.deepEqual(z.edges, [{ axis: 2, why: "travel", reached: false }]);
  const zAt = planHoldStep([0, 0, 600], [0, 0, 19.8], { w: 0, h: 0 }, box);
  assert.equal(zAt.line, "");
  // Verfahrweg enger als das Bett: der Verfahrweg gewinnt und wird als Grund gemeldet
  const x = planHoldStep([600, 0, 0], [99.5, 0, 0], { w: 400, h: 300 }, box);
  assert.equal(x.delta[0], 0.3);
  assert.deepEqual(x.edges, [{ axis: 0, why: "travel", reached: false }]);
});

test("Verfahrweg unbekannt: nicht referenziert, $13x fehlt oder Lage nicht eindeutig -> nur das Bett zählt", () => {
  const env = { travel: [400, 300, 80], homeDirMask: 0, pulloff: 1, homed: false, mpos: [-300, -250, -5], wpos: [0, 0, 0] };
  assert.deepEqual(travelBox(env), [null, null, null]);
  assert.deepEqual(travelBox({ ...env, homed: true, travel: [NaN, 0, -1] }), [null, null, null]);
  // umgekehrte Achse nahe 0: beide Lagen möglich -> unbekannt statt falsch
  assert.equal(travelBox({ ...env, homed: true, homeDirMask: 1, mpos: [0, -250, -5] })[0], null);
});

test("Richtung aus dem Knopf", () => {
  assert.deepEqual(dirFromCmd("X1"), [1, 0, 0]);
  assert.deepEqual(dirFromCmd("X-1 Y1"), [-1, 1, 0]);
  assert.deepEqual(dirFromCmd("Z-1"), [0, 0, -1]);
  assert.deepEqual(dirFromCmd(""), [0, 0, 0]);
  assert.deepEqual(dirFromCmd("X5 Q1"), [0, 0, 0], "nur ±1 zählt");
});
