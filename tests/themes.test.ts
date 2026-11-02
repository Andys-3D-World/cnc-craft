// Tests für die Themen der Deko-Generatoren – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, THEME_SETS, themeList, themeSky } from "../src/themes.ts";
import { ORNAMENT_SHAPES, ORNAMENT_DECOS, ORNAMENT_TOPPERS, ornament } from "../src/ornament.ts";
import { SCENE_KINDS, scene } from "../src/landscape.ts";
import { shadowBox, BOX_SHAPES } from "../src/shadowBox.ts";

test("jedes Thema nennt nur vorhandene Formen, Verzierungen, Aufsätze und Landschaften", () => {
  for (const [name, set] of Object.entries(THEME_SETS)) {
    for (const s of set.shapes) assert.ok(ORNAMENT_SHAPES.includes(s), `${name}: Form ${s}`);
    for (const d of [...set.decos, ...set.sky.motifs]) assert.ok(ORNAMENT_DECOS.includes(d), `${name}: Verzierung ${d}`);
    for (const tp of set.toppers) assert.ok(ORNAMENT_TOPPERS.includes(tp), `${name}: Aufsatz ${tp}`);
    for (const sc of set.scenes) assert.ok(SCENE_KINDS.includes(sc), `${name}: Landschaft ${sc}`);
    assert.ok(set.shapes.length >= 3 && set.decos.length >= 2 && set.toppers.length >= 1 && set.scenes.length >= 2, `${name}: zu wenig Auswahl`);
  }
});

test("jede Form, Verzierung, jeder Aufsatz und jede Landschaft gehört zu einem Thema; „alle“ enthält alles", () => {
  for (const s of ORNAMENT_SHAPES) assert.ok(themeList("all", "shapes").includes(s), `Form ${s} ohne Thema`);
  for (const d of ORNAMENT_DECOS.filter(x => x !== "none")) assert.ok(themeList("all", "decos").includes(d), `Verzierung ${d} ohne Thema`);
  for (const tp of ORNAMENT_TOPPERS.filter(x => x !== "none")) assert.ok(themeList("all", "toppers").includes(tp), `Aufsatz ${tp} ohne Thema`);
  for (const sc of SCENE_KINDS.filter(x => x !== "none")) assert.ok(themeList("all", "scenes").includes(sc), `Landschaft ${sc} ohne Thema`);
  assert.equal(THEMES.length, 8);
});

test("jedes Thema als Anhänger mit zwei Schichten, Landschaft, Aufsatz und Verzierung: ein Teil", () => {
  const word: any = [[[[0, 0], [6, 0], [6, 10], [0, 10], [0, 0]]], [[[8, 0], [14, 0], [14, 10], [8, 10], [8, 0]]]];
  for (const [name, set] of Object.entries(THEME_SETS)) for (const shape of set.shapes) {
    const r = ornament({ shape, size: 80, points: 5, hanger: "hole", holeD: 4, inner: "band", textSize: 100, border: false,
      deco: set.decos[0], topper: set.toppers[0], layers: 2, scene: set.scenes[0], seed: 3 }, { area: word, lines: [] });
    assert.equal(r.pieces, 1, `${name}/${shape}`);
    assert.equal(r.back.length, 1, `${name}/${shape}: Grundplatte`);
  }
});

test("Landschaften der Jahreszeiten: ein Stück, mit Lichtern wo es passt (Kürbisgesichter, Ostereier)", () => {
  for (const kind of ["easter", "spring", "summer", "autumn", "halloween"] as const) for (const seed of [1, 2, 3]) {
    const s = scene({ x0: -50, x1: 50, bottom: -30, base: -15, hill: 4, item: 22, kind, seed });
    assert.equal(s.area.length, 1, `${kind}/${seed}`);
  }
  assert.ok(scene({ x0: -60, x1: 60, bottom: -30, base: -15, hill: 4, item: 22, kind: "halloween", seed: 2 }).lights.length > 0);
});

test("Schattenbox: neue Umrisse und Himmel je Thema", () => {
  for (const shape of BOX_SHAPES) for (const theme of ["christmas", "halloween", "easter", "summer"] as const) {
    const r = shadowBox({ shape, h: 200, layers: 3, frame: 8, scene: themeList(theme, "scenes")[0], seed: 2, sky: "engrave", bow: false, stand: true, t: 3, gap: 6, cable: true, theme });
    for (const l of r.layers) assert.equal(l.length, 1, `${shape}/${theme}`);
    assert.equal(r.back.length, 1);
    assert.ok(r.backEngrave.length >= 2, `${shape}/${theme}: Himmel fehlt`);
  }
  assert.equal(themeSky("halloween").body, "full");
  assert.equal(themeSky("easter").body, "sun");
});
