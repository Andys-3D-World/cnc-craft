// Tests für die Makro-Knöpfe – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { macroLines, macroProblem, macroBlock, sanitizeMacros, buildMacroFile, parseMacroFile, MACRO_MAX, MACRO_NAME_MAX } from "../src/macros.ts";

let n = 0;
const id = () => "x" + ++n;

test("Zeilen: Kommentare und Leerzeilen fallen weg", () => {
  assert.deepEqual(macroLines("G53 G0 Z0 (hoch)\r\n\n ; nur Kommentar\nG53 G0 X0 Y0 ; Park"), ["G53 G0 Z0", "G53 G0 X0 Y0"]);
});

test("$- und [ESP-Zeilen bleiben unverändert", () => {
  assert.deepEqual(macroLines("$H\n[ESP401]P=53 T=S V=a;b"), ["$H", "[ESP401]P=53 T=S V=a;b"]);
});

test("Prüfung: leer, abgefangene Zeichen, zu lang", () => {
  assert.equal(macroProblem("").problem, "empty");
  assert.equal(macroProblem("(nur Kommentar)").problem, "empty");
  assert.equal(macroProblem("G0 X1 !").problem, "chars");
  assert.equal(macroProblem("G0 X1 ?").problem, "chars");
  assert.equal(macroProblem("$33=Müller").problem, "chars");
  assert.equal(macroProblem("G0 X" + "1".repeat(80)).problem, "long");
  assert.equal(macroProblem("G53 G0 Z0\nG53 G0 X0 Y0").problem, "");
  assert.equal(macroProblem("G0 X1 (Achtung!)").problem, "", "Kommentar wird nicht gesendet");
});

const ok = { connected: true, state: "Idle", jobActive: false, busy: false };
test("Sperre: ohne Verbindung, im Job (auch pausiert), bei Alarm, beim Antasten, während die Maschine fährt", () => {
  assert.equal(macroBlock(ok), "");
  assert.equal(macroBlock({ ...ok, connected: false }), "noConn");
  assert.equal(macroBlock({ ...ok, jobActive: true, state: "Hold" }), "job");
  assert.equal(macroBlock({ ...ok, state: "Alarm" }), "alarm");
  assert.equal(macroBlock({ ...ok, busy: true }), "busy");
  assert.equal(macroBlock({ ...ok, state: "Run" }), "state");
  assert.equal(macroBlock({ ...ok, state: "Jog" }), "state");
});

test("Bereinigen: Unsinn fliegt raus, Namen ohne Steuerzeichen und gekürzt", () => {
  const r = sanitizeMacros([null, 5, { name: "", gcode: "G0" }, { name: "A", gcode: 3 }, { name: "<b>A</b>\n" + "x".repeat(99), gcode: "G0 X1" }], false, id);
  assert.equal(r.length, 1);
  assert.ok(r[0].name.length <= MACRO_NAME_MAX);
  assert.ok(!r[0].name.includes("\n"));
  assert.equal(sanitizeMacros("kein Array", false, id).length, 0);
});

test("Bereinigen: nicht mehr als die Höchstzahl, doppelte Kennungen werden ersetzt", () => {
  const many = Array.from({ length: MACRO_MAX + 9 }, () => ({ id: "same", name: "A", gcode: "G0" }));
  const r = sanitizeMacros(many, false, id);
  assert.equal(r.length, MACRO_MAX);
  assert.equal(new Set(r.map(m => m.id)).size, MACRO_MAX);
});

test("Bestätigung bleibt beim Laden, gilt aber nie für importierte Makros", () => {
  const raw = [{ id: "a", name: "A", gcode: "G0", confirmed: true }];
  assert.equal(sanitizeMacros(raw, false, id)[0].confirmed, true);
  const imported = sanitizeMacros(raw, true, id)[0];
  assert.equal(imported.confirmed, false);
  assert.notEqual(imported.id, "a");
});

test("Datei: hin und zurück, fremde Dateien werden abgelehnt, Kennung/Bestätigung werden nicht übernommen", () => {
  const text = buildMacroFile([{ id: "a", name: "Park", gcode: "G53 G0 Z0", confirmed: true }]);
  assert.ok(!text.includes("confirmed"));
  const back = parseMacroFile(text, id);
  assert.equal(back[0].name, "Park");
  assert.equal(back[0].confirmed, false);
  assert.throws(() => parseMacroFile("{kaputt", id), /invalid/);
  assert.throws(() => parseMacroFile('{"format":"anders","macros":[]}', id), /invalid/);
});
