// Tests für die Gamepad-Logik – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stickValue, updateArmed, velocity, limitToMachine, lookahead, planStep, blockReason, isDriving, canStartDrive,
  resolveAction, assignButton, normalizeConfig, defaultConfig, STEP_S, SETTLE_MS,
} from "../src/gamepadLogic.ts";
import type { GamepadContext } from "../src/gamepadLogic.ts";

const idle: GamepadContext = {
  connected: true, protocol: "grbl", state: "Idle", jobActive: false, jobPaused: false, jobLoaded: true,
  busy: false, dialog: false, focused: true,
};
const bed = { w: 300, h: 200 };

test("Totzone: innen 0, am Rand ±1, dazwischen ohne Sprung", () => {
  assert.equal(stickValue(0.1, 0.15), 0);
  assert.equal(stickValue(-0.15, 0.15), 0);
  assert.equal(stickValue(1, 0.15), 1);
  assert.equal(stickValue(-1, 0.15), -1);
  assert.ok(stickValue(0.16, 0.15) < 0.001);
  assert.ok(stickValue(0.5, 0.15) > 0 && stickValue(0.5, 0.15) < stickValue(0.8, 0.15));
  assert.ok(stickValue(-0.5, 0.15) < 0);
  assert.equal(stickValue(NaN, 0.15), 0);
});

test("Stick schon ausgelenkt beim Totmann: Achse fährt erst nach der Mitte", () => {
  let a = updateArmed([false, false, false], [0.8, 0, -1], true);
  assert.deepEqual(a, [false, true, false]);
  a = updateArmed(a, [0.8, 0.5, -1], true);
  assert.deepEqual(a, [false, true, false]);
  a = updateArmed(a, [0, 0.5, -1], true);
  assert.deepEqual(a, [true, true, false]);
  a = updateArmed(a, [0.5, 0.5, -1], true);
  assert.deepEqual(a, [true, true, false]);          // Achse in Ruhe bei -1 bleibt gesperrt
  assert.deepEqual(updateArmed(a, [0.5, 0, 0], false), [false, false, false]); // Totmann los: alles von vorn
});

test("Geschwindigkeit: Stufe wirkt, schräg nicht schneller, Z eigene Grenze", () => {
  const cfg = { maxFeed: 2000, maxFeedZ: 500 };
  assert.deepEqual(velocity([1, 0, 0], cfg, 3), [2000, 0, 0]);
  assert.deepEqual(velocity([0, -1, 0], cfg, 2), [0, -1000, 0]);
  assert.deepEqual(velocity([0, 0, 1], cfg, 3), [0, 0, 500]);
  const v = velocity([1, 1, 0], cfg, 3);
  assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 2000) < 1e-6);
});

test("Maschinen-Grenze kürzt alle Achsen gleich, die Richtung bleibt", () => {
  assert.deepEqual(limitToMachine([1000, 500, 0], [500, 5000, 300]), [500, 250, 0]);
  assert.deepEqual(limitToMachine([1000, 0, 0], [undefined, undefined, undefined]), [1000, 0, 0]);
});

test("Schritt ist so lang wie die Fahrzeit und wird als Jog geschickt", () => {
  const s = planStep([600, 0, 0], [10, 10, 0], bed);
  assert.equal(s.line, "$J=G21 G91 X1.000 F600");
  assert.deepEqual(s.end, [11, 10, 0]);
  assert.equal(STEP_S, 0.1);
  assert.equal(planStep([0, 0, -300], [10, 10, 0], bed).line, "$J=G21 G91 Z-0.500 F300");
});

test("Bett-Grenze gilt: am Rand kein Schritt, kurz davor gekürzt", () => {
  const atEdge = planStep([600, 0, 0], [300, 10, 0], bed);
  assert.equal(atEdge.line, "");
  assert.deepEqual(atEdge.clamped, [0]);
  const near = planStep([600, 0, 0], [299.5, 10, 0], bed);
  assert.equal(near.line, "$J=G21 G91 X0.500 F300");
  // schräg am Rand: die freie Achse fährt nicht schneller als vorher
  const diag = planStep([600, 600, 0], [300, 10, 0], bed);
  assert.equal(diag.line, "$J=G21 G91 Y1.000 F600");
});

test("Warteschlange reicht für den Bremsweg, bleibt aber kurz", () => {
  assert.equal(lookahead(1000, undefined), 0.3);
  assert.equal(lookahead(100, 500), 0.2);
  assert.ok(Math.abs(lookahead(6000, 200) - 0.35) < 1e-9);
  assert.equal(lookahead(50000, 10), 1);
});

test("Gesperrt bei Job, Alarm, Verbindungsverlust, Fenster und Fokus", () => {
  assert.equal(blockReason(idle), null);
  assert.equal(blockReason({ ...idle, state: "Jog" }), null);
  assert.equal(blockReason({ ...idle, connected: false }), "notConnected");
  assert.equal(blockReason({ ...idle, protocol: "ruida" }), "protocol");
  assert.equal(blockReason({ ...idle, state: "Alarm" }), "alarm");
  assert.equal(blockReason({ ...idle, jobActive: true, state: "Run" }), "job");
  assert.equal(blockReason({ ...idle, jobActive: true, jobPaused: true, state: "Hold" }), "job");
  assert.equal(blockReason({ ...idle, busy: true }), "busy");
  assert.equal(blockReason({ ...idle, dialog: true }), "dialog");
  assert.equal(blockReason({ ...idle, focused: false }), "focus");
  assert.equal(blockReason({ ...idle, state: "Home" }), "state");
  assert.equal(blockReason({ ...idle, state: "Door" }), "state");
});

test("Fahren nur mit Totmann UND Auslenkung UND ohne Sperre", () => {
  assert.equal(isDriving(idle, true, [0.5, 0, 0]), true);
  assert.equal(isDriving(idle, false, [0.5, 0, 0]), false);
  assert.equal(isDriving(idle, true, [0, 0, 0]), false);
  assert.equal(isDriving({ ...idle, focused: false }, true, [0.5, 0, 0]), false);
  assert.equal(isDriving({ ...idle, state: "Alarm" }, true, [0.5, 0, 0]), false);
});

test("Neue Fahrt erst nach dem Abbremsen und nur aus dem Stillstand", () => {
  assert.equal(canStartDrive("Idle", 1000, 1000 - SETTLE_MS), true);
  assert.equal(canStartDrive("Idle", 1000, 1000 - SETTLE_MS + 1), false);
  assert.equal(canStartDrive("Jog", 1000, 0), false);
});

test("Anhalten geht immer, alles Bewegende nur mit Totmann", () => {
  // Stopp ohne Totmann, auch im Job, im Alarm und ohne Fokus
  assert.equal(resolveAction("stop", idle, false), "hold");
  assert.equal(resolveAction("stop", { ...idle, jobActive: true, state: "Run", focused: false }, false), "hold");
  assert.equal(resolveAction("stop", { ...idle, state: "Alarm" }, false), "hold");
  // Pause ohne Totmann, Fortsetzen nur mit
  const run = { ...idle, jobActive: true, state: "Run" };
  assert.equal(resolveAction("startPause", run, false), "pause");
  const paused = { ...idle, jobActive: true, jobPaused: true, state: "Hold" };
  assert.equal(resolveAction("startPause", paused, false), null);
  assert.equal(resolveAction("startPause", paused, true), "resume");
  assert.equal(resolveAction("startPause", { ...paused, busy: true }, true), null);
  // Start nur mit Totmann, im Stillstand, mit geladenem G-Code
  assert.equal(resolveAction("startPause", idle, false), null);
  assert.equal(resolveAction("startPause", idle, true), "start");
  assert.equal(resolveAction("startPause", { ...idle, jobLoaded: false }, true), null);
  assert.equal(resolveAction("startPause", { ...idle, state: "Alarm" }, true), null);
  assert.equal(resolveAction("startPause", { ...idle, dialog: true }, true), null);
  // Haltezustand ohne Job: Fortsetzen
  assert.equal(resolveAction("startPause", { ...idle, state: "Hold" }, true), "resume");
  // Referenzfahrt und Nullpunkt
  assert.equal(resolveAction("home", idle, false), null);
  assert.equal(resolveAction("home", idle, true), "home");
  assert.equal(resolveAction("home", { ...idle, state: "Alarm" }, true), null);
  assert.equal(resolveAction("zeroXY", { ...idle, state: "Jog" }, true), null);
  assert.equal(resolveAction("zeroZ", run, true), null);
  assert.equal(resolveAction("zeroZ", idle, true), "zeroZ");
  // ohne Verbindung nichts außer der Geschwindigkeit
  const off = { ...idle, connected: false };
  assert.equal(resolveAction("stop", off, true), null);
  assert.equal(resolveAction("home", off, true), null);
  assert.equal(resolveAction("speedUp", off, false), "speedUp");
});

test("Ein Knopf hat nur eine Aufgabe, der Totmann bleibt immer belegt", () => {
  const cfg = defaultConfig();
  const a = assignButton(cfg, "home", cfg.buttons.stop);
  assert.equal(a.buttons.home, cfg.buttons.stop);
  assert.equal(a.buttons.stop, -1);
  // Aufgabe auf den Totmann-Knopf: geht nicht
  const b = assignButton(cfg, "home", cfg.deadman);
  assert.equal(b.buttons.home, -1);
  assert.equal(b.deadman, cfg.deadman);
  // Totmann auf einen belegten Knopf: die Aufgabe wird frei
  const c = assignButton(cfg, "deadman", cfg.buttons.zeroZ);
  assert.equal(c.deadman, cfg.buttons.zeroZ);
  assert.equal(c.buttons.zeroZ, -1);
  // Totmann lässt sich nicht abwählen
  assert.equal(assignButton(cfg, "deadman", -1).deadman, cfg.deadman);
  // das Original bleibt unverändert
  assert.equal(cfg.buttons.home, 3);
});

test("Gespeicherte Einstellungen: Standard ist aus, Unsinn wird abgefangen", () => {
  assert.equal(normalizeConfig(null).enabled, false);
  assert.equal(normalizeConfig({ enabled: "ja" }).enabled, false);
  assert.deepEqual(normalizeConfig(undefined), defaultConfig());
  const n = normalizeConfig({ enabled: true, deadzone: 0, maxFeed: "abc", maxFeedZ: 1e9, deadman: 99, buttons: { home: 7, stop: 7, zeroZ: "<b>" } });
  assert.equal(n.enabled, true);
  assert.equal(n.deadzone, 0.05);
  assert.equal(n.maxFeed, defaultConfig().maxFeed);
  assert.equal(n.maxFeedZ, 50000);
  assert.equal(n.deadman, defaultConfig().deadman);
  assert.equal(n.buttons.zeroZ, defaultConfig().buttons.zeroZ);
  // doppelt belegt in der Datei: nur noch eine Aufgabe auf dem Knopf
  assert.equal([n.buttons.home, n.buttons.stop].filter(b => b === 7).length, 1);
});
