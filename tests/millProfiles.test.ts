// Tests für die Fräs-Profile und Schnittwerte je Form – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeProfile, sanitizeProfiles, clampCut, makeCutData, cleanCutData, resolveCut, cutDataFits,
  profileFitsDiameter, importMillProfiles, getMillProfiles, addMillProfile, updateMillProfile, removeMillProfile,
  exportMillProfiles, type CutTool } from "../src/millProfiles.ts";

const limits = { minRpm: 5000, maxRpm: 20000, maxFeed: 2000 };
const tool: CutTool = { id: "t1", type: "endmill", diameter: 6, fluteLen: 10, plungeFeed: 400, feedrate: 1000, rpm: 12000, stepZ: 2 };

test("gültiges Profil bleibt erhalten, unbekannte Felder fallen weg", () => {
  const p = sanitizeProfile({ id: "a", name: " MDF ", feedrate: 1500, rpm: 18000, stepZ: 3, evil: "<x>", diameter: 6, toolId: "t1" })!;
  assert.deepEqual(p, { id: "a", name: "MDF", feedrate: 1500, rpm: 18000, stepZ: 3, toolId: "t1", diameter: 6 });
});

test("kaputte Pflichtwerte machen das Profil ungültig – es wird nichts geraten", () => {
  for (const bad of [{ feedrate: "x" }, { feedrate: 0 }, { rpm: -1 }, { rpm: 0 }, { stepZ: null }, { stepZ: true }, { feedrate: Infinity }]) {
    assert.equal(sanitizeProfile({ id: "a", name: "n", feedrate: 1000, rpm: 10000, stepZ: 1, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(sanitizeProfile(null), null);
  assert.equal(sanitizeProfile({ name: "ohne id", feedrate: 1, rpm: 1, stepZ: 1 }), null);
});

test("Daten aus Dateien: Kennung bereinigt, Name begrenzt, doppelte Kennungen raus", () => {
  const p = sanitizeProfile({ id: 'x"><img', name: "a\nb" + "c".repeat(100), feedrate: 1e9, rpm: 1e9, stepZ: 1e9, toolId: 'y"' })!;
  assert.match(p.id, /^[A-Za-z0-9_.-]+$/);
  assert.match(p.toolId!, /^[A-Za-z0-9_.-]+$/);
  assert.equal(p.name.length, 60);
  assert.ok(!p.name.includes("\n"));
  assert.equal(p.feedrate, 100000);
  const list = sanitizeProfiles([{ id: "a", feedrate: 1, rpm: 1, stepZ: 1 }, { id: "a", feedrate: 2, rpm: 2, stepZ: 2 }, "kaputt"]);
  assert.equal(list.length, 1);
  assert.deepEqual(sanitizeProfiles("kein Array"), []);
});

test("Grenzen der Maschine und Schneidenlänge werden eingehalten", () => {
  const r = clampCut({ feedrate: 9000, rpm: 90000, stepZ: 25, plungeFeed: 9000 }, tool, limits);
  assert.deepEqual([r.feedrate, r.rpm, r.stepZ, r.plungeFeed, r.limited], [2000, 20000, 10, 2000, true]);
  assert.equal(clampCut({ feedrate: 500, rpm: 100, stepZ: 1 }, tool, limits).rpm, 5000);
  const inside = clampCut({ feedrate: 800, rpm: 10000, stepZ: 1, plungeFeed: 200 }, tool, limits);
  assert.deepEqual([inside.feedrate, inside.rpm, inside.stepZ, inside.plungeFeed, inside.limited], [800, 10000, 1, 200, false]);
});

test("Kegel-Werkzeuge: Zustellung nicht an der Schneidenlänge kürzen", () => {
  assert.equal(clampCut({ feedrate: 500, rpm: 10000, stepZ: 3 }, { ...tool, type: "vbit", fluteLen: 1 }, limits).stepZ, 3);
});

test("ohne Eintauch-Vorschub: vorsichtig aus dem Vorschub, nie schneller als am Werkzeug", () => {
  assert.equal(clampCut({ feedrate: 300, rpm: 10000, stepZ: 1 }, tool, limits).plungeFeed, 90);
  assert.equal(clampCut({ feedrate: 2000, rpm: 10000, stepZ: 1 }, tool, limits).plungeFeed, 400);
  assert.equal(clampCut({ feedrate: 300, rpm: 10000, stepZ: 1 }, { ...tool, type: "drill" }, limits).plungeFeed, 150);
});

test("resolveCut: ohne Werte oder bei anderem Werkzeug gelten die Werkzeug-Werte", () => {
  const cd = makeCutData(tool, { feedrate: 700, rpm: 9000, stepZ: 1.5 }, "Alu", "p:x", limits);
  assert.equal(resolveCut(undefined, tool, limits), null);
  assert.equal(resolveCut(cd, null, limits), null);
  assert.equal(resolveCut(cd, { ...tool, id: "t2" }, limits), null, "anderes Werkzeug");
  assert.equal(resolveCut(cd, { ...tool, diameter: 3 }, limits), null, "Ø geändert");
  assert.equal(resolveCut({ ...cd, feedrate: "kaputt" }, tool, limits), null, "kaputte Werte");
  const r = resolveCut(cd, tool, limits)!;
  assert.deepEqual([r.feedrate, r.rpm, r.stepZ, r.label], [700, 9000, 1.5, "Alu"]);
});

test("resolveCut begrenzt erneut: Projektdatei oder inzwischen kleinere Grenzen", () => {
  const cd = { toolId: "t1", d: 6, feedrate: 99999, rpm: 99999, stepZ: 99, plungeFeed: 99999, label: "x", src: "" };
  const r = resolveCut(cd, tool, limits)!;
  assert.deepEqual([r.feedrate, r.rpm, r.stepZ, r.plungeFeed], [2000, 20000, 10, 2000]);
});

test("cleanCutData nimmt nur bekannte Felder und begrenzt den Namen", () => {
  const c = cleanCutData({ toolId: "t1", d: 6, feedrate: 100, rpm: 100, stepZ: 1, label: "L".repeat(99), extra: 1 })!;
  assert.equal(c.label.length, 60);
  assert.ok(!("extra" in c));
  assert.equal(cleanCutData({ d: 6, feedrate: 100, rpm: 100, stepZ: 1 }), null);
  assert.ok(cutDataFits(c, { id: "t1", diameter: 6 }));
});

test("Warnung bei anderem Fräser-Ø nur, wenn das Profil einen Ø kennt", () => {
  assert.equal(profileFitsDiameter({ diameter: 6 }, 3), false);
  assert.equal(profileFitsDiameter({ diameter: 6 }, 6), true);
  assert.equal(profileFitsDiameter({}, 3), true);
});

test("Verwalten: anlegen, ändern, ungültige Werte abweisen, löschen", () => {
  importMillProfiles([], true);
  const p = addMillProfile({ name: "Birke", feedrate: 1000, rpm: 15000, stepZ: 2 })!;
  assert.ok(updateMillProfile(p.id, { name: "Birke 6 mm", plungeFeed: 200 }));
  assert.equal(getMillProfiles()[0].name, "Birke 6 mm");
  assert.equal(updateMillProfile(p.id, { feedrate: -5 }), false);
  assert.equal(getMillProfiles()[0].feedrate, 1000);
  assert.ok(updateMillProfile(p.id, { plungeFeed: undefined }));
  assert.ok(!("plungeFeed" in getMillProfiles()[0]));
  assert.equal(addMillProfile({ name: "kaputt", feedrate: 0, rpm: 1, stepZ: 1 }), null);
  removeMillProfile(p.id);
  assert.equal(getMillProfiles().length, 0);
});

test("Sicherung: ältere Dateien ohne Liste löschen nichts, Hinzufügen überspringt Gleiche", () => {
  importMillProfiles([{ id: "a", name: "A", feedrate: 1, rpm: 1, stepZ: 1 }], true);
  assert.equal(importMillProfiles(undefined, true), 0);
  assert.equal(getMillProfiles().length, 1);
  assert.equal(importMillProfiles(exportMillProfiles(), false), 0);
  // gleiche Kennung, andere Werte: kommt mit neuer Kennung dazu
  assert.equal(importMillProfiles([{ id: "a", name: "B", feedrate: 2, rpm: 2, stepZ: 2 }, { id: "c", feedrate: "x" }], false), 1);
  const list = getMillProfiles();
  assert.equal(list.length, 2);
  assert.notEqual(list[0].id, list[1].id);
  assert.equal(importMillProfiles([{ id: "n", name: "N", feedrate: 3, rpm: 3, stepZ: 3 }], true), 1);
  assert.deepEqual(getMillProfiles().map(p => p.name), ["N"]);
});
