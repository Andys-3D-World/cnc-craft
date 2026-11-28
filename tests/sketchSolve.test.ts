// Bedingungen (parametrische Skizze) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, satisfied, type GCon, type Shapes } from "../src/editor/sketchSolve.ts";

const P = (x: number, y: number) => ({ x, y });
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const len = (s: Shapes, id: string, i: number, j: number) => { const a = s.get(id)![i], b = s.get(id)![j]; return Math.hypot(b.x - a.x, b.y - a.y); };
const all = (r: { shapes: Shapes }, cons: GCon[]) => cons.forEach(c => assert.ok(satisfied(c, r.shapes), `${c.k} nicht erfüllt`));

test("Waagerecht: schräge Linie wird gerade, beide Enden bewegen sich gleich wenig", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(100, 10)]]]);
  const cons: GCon[] = [{ k: "h", a: { id: "a", i: 0, j: 1 } }];
  const r = solve(sh, cons);
  assert.ok(r.ok); all(r, cons);
  near(r.shapes.get("a")![0].y, 5); near(r.shapes.get("a")![1].y, 5);
  near(r.shapes.get("a")![0].x, 0); // nur so wenig wie nötig: x bleibt
  assert.deepEqual(sh.get("a"), [P(0, 0), P(100, 10)]); // Eingabe unverändert
});

test("Senkrecht mit Gewicht: der schwere Punkt bleibt stehen", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(10, 100)]]]);
  const r = solve(sh, [{ k: "v", a: { id: "a", i: 0, j: 1 } }], (_id, i) => (i === 0 ? 1000 : 1));
  assert.ok(r.ok);
  near(r.shapes.get("a")![0].x, 0, 0.02); near(r.shapes.get("a")![1].x, 0, 0.02);
});

test("Feste Länge", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(30, 40)]]]);
  const cons: GCon[] = [{ k: "len", a: { id: "a", i: 0, j: 1 }, v: 100 }];
  const r = solve(sh, cons);
  assert.ok(r.ok); all(r, cons);
  near(len(r.shapes, "a", 0, 1), 100);
});

test("Viereck: rechtwinklig, waagerecht, gleich lang und Länge ergeben ein Quadrat", () => {
  const sh: Shapes = new Map([["q", [P(0, 0), P(52, 3), P(49, 47), P(-2, 51)]]]);
  const s = (i: number, j: number) => ({ id: "q", i, j });
  const cons: GCon[] = [
    { k: "h", a: s(0, 1) }, { k: "perp", a: s(0, 1), b: s(1, 2) }, { k: "perp", a: s(1, 2), b: s(2, 3) },
    { k: "perp", a: s(2, 3), b: s(3, 0) }, { k: "eq", a: s(0, 1), b: s(1, 2) }, { k: "len", a: s(0, 1), v: 50 }
  ];
  const r = solve(sh, cons);
  assert.ok(r.ok); all(r, cons);
  for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0]]) near(len(r.shapes, "q", i, j), 50, 1e-5);
});

test("Parallel und gleich lang zwischen zwei Formen", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(100, 0)]], ["b", [P(0, 20), P(60, 35)]]]);
  const cons: GCon[] = [{ k: "par", a: { id: "a", i: 0, j: 1 }, b: { id: "b", i: 0, j: 1 } }, { k: "eq", a: { id: "a", i: 0, j: 1 }, b: { id: "b", i: 0, j: 1 } }];
  const r = solve(sh, cons, id => (id === "a" ? 1000 : 1));
  assert.ok(r.ok); all(r, cons);
  near(len(r.shapes, "b", 0, 1), len(r.shapes, "a", 0, 1), 1e-5);
  near(r.shapes.get("a")![1].x, 100, 0.2); // a (schwer) bleibt fast, wo es war
});

test("Punkte verbinden: Enden zweier Linien treffen sich", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(50, 0)]], ["b", [P(52, 3), P(52, 50)]]]);
  const cons: GCon[] = [{ k: "coin", p: { id: "a", i: 1 }, q: { id: "b", i: 0 } }];
  const r = solve(sh, cons);
  assert.ok(r.ok); all(r, cons);
  near(r.shapes.get("a")![1].x, 51); near(r.shapes.get("a")![1].y, 1.5); // genau in der Mitte
});

test("Widerspruch: waagerecht und senkrecht zugleich wird abgelehnt, nichts geändert", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(30, 40)]]]);
  const r = solve(sh, [{ k: "h", a: { id: "a", i: 0, j: 1 } }, { k: "v", a: { id: "a", i: 0, j: 1 } }]);
  assert.equal(r.ok, false);
  assert.equal(r.shapes, sh);
});

test("Widerspruch: zwei verschiedene Längen", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(30, 40)]]]);
  const r = solve(sh, [{ k: "len", a: { id: "a", i: 0, j: 1 }, v: 10 }, { k: "len", a: { id: "a", i: 0, j: 1 }, v: 20 }]);
  assert.equal(r.ok, false);
});

test("Fehlende Punkte: Bedingung wird übergangen", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(30, 40)]]]);
  const r = solve(sh, [{ k: "h", a: { id: "a", i: 0, j: 5 } }, { k: "h", a: { id: "x", i: 0, j: 1 } }]);
  assert.ok(r.ok);
  assert.deepEqual(r.shapes.get("a"), [P(0, 0), P(30, 40)]);
});

test("Bereits erfüllt: nichts bewegt sich", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(100, 0)]]]);
  const r = solve(sh, [{ k: "h", a: { id: "a", i: 0, j: 1 } }]);
  assert.ok(r.ok); assert.equal(r.iterations, 0);
  assert.deepEqual(r.shapes.get("a"), [P(0, 0), P(100, 0)]);
});

test("Große Zeichnung: 40 Strecken waagerecht/senkrecht abwechselnd, schnell", () => {
  const pts = Array.from({ length: 41 }, (_, i) => P(i * 10 + (i % 3), (i % 2) * 10 + (i % 5) * 0.3));
  const cons: GCon[] = Array.from({ length: 40 }, (_, i) => ({ k: i % 2 ? "v" : "h", a: { id: "z", i, j: i + 1 } } as GCon));
  const t0 = Date.now();
  const r = solve(new Map([["z", pts]]), cons);
  assert.ok(r.ok); all(r, cons);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
});

// ---- Stufe 6b: Festhalten, auf Linie, Winkel, Kreise ----
const C = (x: number, y: number, r: number) => [P(x, y), P(r, 0)]; // Kreis im Rechenkern: [Mitte, {x: Radius}]

test("Festhalten: der Punkt bleibt, der Rest gibt nach", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(30, 40)]]]);
  const cons: GCon[] = [{ k: "fix", p: { id: "a", i: 0 }, at: P(0, 0) }, { k: "len", a: { id: "a", i: 0, j: 1 }, v: 100 }];
  const r = solve(sh, cons);
  assert.ok(r.ok); all(r, cons);
  near(r.shapes.get("a")![0].x, 0); near(r.shapes.get("a")![0].y, 0);
  near(r.shapes.get("a")![1].x, 60); near(r.shapes.get("a")![1].y, 80); // in derselben Richtung verlängert
});

test("Punkt auf Linie (auch auf der Verlängerung)", () => {
  const sh: Shapes = new Map([["l", [P(0, 0), P(10, 0)]], ["p", [P(30, 5), P(50, 50)]]]);
  const cons: GCon[] = [{ k: "onLine", p: { id: "p", i: 0 }, a: { id: "l", i: 0, j: 1 } }];
  const r = solve(sh, cons, id => (id === "l" ? 1e6 : 1));
  assert.ok(r.ok); all(r, cons);
  near(r.shapes.get("p")![0].y, 0, 1e-3); near(r.shapes.get("p")![0].x, 30, 0.05);
});

test("Winkel 30° zwischen zwei Strecken", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(100, 0)]], ["b", [P(0, 0), P(50, 50)]]]);
  const cons: GCon[] = [{ k: "ang", a: { id: "a", i: 0, j: 1 }, b: { id: "b", i: 0, j: 1 }, v: 30 }];
  const r = solve(sh, cons, id => (id === "a" ? 1000 : 1));
  assert.ok(r.ok); all(r, cons);
  const b = r.shapes.get("b")!;
  near((Math.atan2(b[1].y - b[0].y, b[1].x - b[0].x) * 180) / Math.PI, 30, 0.01);
});

test("Kreis: Durchmesser, gleiche Mitte, gleicher Radius", () => {
  const sh: Shapes = new Map([["c1", C(0, 0, 10)], ["c2", C(3, 4, 7)]]);
  const cons: GCon[] = [{ k: "rad", c: { id: "c1" }, v: 20 }, { k: "conc", c: { id: "c1" }, d: { id: "c2" } }, { k: "eqR", c: { id: "c1" }, d: { id: "c2" } }];
  const r = solve(sh, cons);
  assert.ok(r.ok); all(r, cons);
  near(r.shapes.get("c1")![1].x, 20); near(r.shapes.get("c2")![1].x, 20);
  near(r.shapes.get("c1")![0].x, r.shapes.get("c2")![0].x);
});

test("Linie berührt Kreis (tangential)", () => {
  const sh: Shapes = new Map([["l", [P(-50, 12), P(50, 12)]], ["c", C(0, 0, 10)]]);
  const cons: GCon[] = [{ k: "tanL", a: { id: "l", i: 0, j: 1 }, c: { id: "c" } }];
  const r = solve(sh, cons, id => (id === "l" ? 1000 : 1));
  assert.ok(r.ok); all(r, cons);
  const c = r.shapes.get("c")!, l = r.shapes.get("l")!;
  near(Math.abs(l[0].y - c[0].y), c[1].x, 1e-6);
});

test("Zwei Kreise berühren sich außen und innen", () => {
  const out: GCon[] = [{ k: "tanC", c: { id: "a" }, d: { id: "b" }, inner: false }];
  const r = solve(new Map([["a", C(0, 0, 10)], ["b", C(25, 0, 10)]]), out, id => (id === "a" ? 1000 : 1));
  assert.ok(r.ok); all(r, out);
  const a = r.shapes.get("a")!, b = r.shapes.get("b")!;
  near(Math.hypot(b[0].x - a[0].x, b[0].y - a[0].y), a[1].x + b[1].x, 1e-6); // Abstand der Mitten = Summe der Radien
  const inn: GCon[] = [{ k: "tanC", c: { id: "a" }, d: { id: "b" }, inner: true }];
  const r2 = solve(new Map([["a", C(0, 0, 20)], ["b", C(3, 0, 10)]]), inn, id => (id === "a" ? 1000 : 1));
  assert.ok(r2.ok); all(r2, inn);
});

test("Punkt auf Kreis und Linienende an der Kreismitte", () => {
  const sh: Shapes = new Map([["l", [P(1, 1), P(30, 2)]], ["c", C(0, 0, 20)]]);
  const cons: GCon[] = [{ k: "coin", p: { id: "l", i: 0 }, q: { id: "c", i: 0 } }, { k: "onCirc", p: { id: "l", i: 1 }, c: { id: "c" } }];
  const r = solve(sh, cons);
  assert.ok(r.ok); all(r, cons);
  const l = r.shapes.get("l")!;
  near(Math.hypot(l[1].x - l[0].x, l[1].y - l[0].y), r.shapes.get("c")![1].x, 1e-6);
});

test("Ziehen: schwerer Punkt folgt der Maus, Bedingungen bleiben", () => {
  // Rechteck mit rechten Winkeln und waagerechter Unterkante; Ecke 2 wurde nach (120, 70) gezogen
  const q = [P(0, 0), P(100, 0), P(120, 70), P(0, 50)];
  const s = (i: number, j: number) => ({ id: "q", i, j });
  const cons: GCon[] = [{ k: "h", a: s(0, 1) }, { k: "perp", a: s(0, 1), b: s(1, 2) }, { k: "perp", a: s(1, 2), b: s(2, 3) }, { k: "perp", a: s(2, 3), b: s(3, 0) }];
  const r = solve(new Map([["q", q]]), cons, (_id, i) => (i === 2 ? 1e6 : 1));
  assert.ok(r.ok); all(r, cons);
  near(r.shapes.get("q")![2].x, 120, 1e-3); near(r.shapes.get("q")![2].y, 70, 1e-3);
});

test("Festhalten widerspricht dem Ziehen nicht, aber zwei Festhalte-Punkte und eine andere Länge schon", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(100, 0)]]]);
  const r = solve(sh, [{ k: "fix", p: { id: "a", i: 0 }, at: P(0, 0) }, { k: "fix", p: { id: "a", i: 1 }, at: P(100, 0) }, { k: "len", a: { id: "a", i: 0, j: 1 }, v: 50 }]);
  assert.equal(r.ok, false);
});

// ---- Bögen: [Start, Ende, Punkt auf dem Bogen] ----
import { circumcircle } from "../src/editor/sketchSolve.ts";

test("Umkreis durch drei Punkte", () => {
  const k = circumcircle(P(10, 0), P(-10, 0), P(0, 10))!;
  near(k.c.x, 0); near(k.c.y, 0); near(k.r, 10);
  assert.equal(circumcircle(P(0, 0), P(1, 1), P(2, 2)), null);
});

test("Bogen: Radius setzen, Endpunkt an eine Linie hängen", () => {
  const sh: Shapes = new Map([["arc", [P(10, 0), P(-10, 0), P(0, 10)]], ["l", [P(10.5, 0.3), P(30, 0)]]]);
  const cons: GCon[] = [
    { k: "rad", c: { id: "arc", arc: true }, v: 15 },
    { k: "coin", p: { id: "arc", i: 0 }, q: { id: "l", i: 0 } }
  ];
  const r = solve(sh, cons);
  assert.ok(r.ok); all(r, cons);
  const v = r.shapes.get("arc")!;
  near(circumcircle(v[0], v[1], v[2])!.r, 15, 1e-6);
});

test("Linie tangential an einen Bogen", () => {
  const sh: Shapes = new Map([["arc", [P(10, 0), P(-10, 0), P(0, 10)]], ["l", [P(-30, 13), P(30, 13)]]]);
  const cons: GCon[] = [{ k: "tanL", a: { id: "l", i: 0, j: 1 }, c: { id: "arc", arc: true } }];
  const r = solve(sh, cons, id => (id === "l" ? 1000 : 1));
  assert.ok(r.ok); all(r, cons);
  const v = r.shapes.get("arc")!, k = circumcircle(v[0], v[1], v[2])!, l = r.shapes.get("l")!;
  near(Math.abs(l[0].y - k.c.y), k.r, 1e-6);
});

// ---- Freiheiten (voll bestimmt?) ----
import { freedom } from "../src/editor/sketchSolve.ts";

test("Freiheiten: Rechteck wird Schritt für Schritt voll bestimmt", () => {
  const sh: Shapes = new Map([["q", [P(0, 0), P(50, 0), P(50, 30), P(0, 30)]]]);
  const s = (i: number, j: number) => ({ id: "q", i, j });
  const rect: GCon[] = [{ k: "h", a: s(0, 1) }, { k: "perp", a: s(0, 1), b: s(1, 2) }, { k: "perp", a: s(1, 2), b: s(2, 3) }, { k: "perp", a: s(2, 3), b: s(3, 0) }];
  assert.equal(freedom(sh, []), 8);
  assert.equal(freedom(sh, rect), 4);                                       // Lage x/y, Breite, Höhe
  const sized = [...rect, { k: "len", a: s(0, 1), v: 50 } as GCon, { k: "len", a: s(1, 2), v: 30 } as GCon];
  assert.equal(freedom(sh, sized), 2);                                      // nur noch verschieben
  assert.equal(freedom(sh, [...sized, { k: "fix", p: { id: "q", i: 0 }, at: P(0, 0) }]), 0);
});

test("Freiheiten: doppelte Bedingung zählt nur einmal, Kreis hat drei", () => {
  const sh: Shapes = new Map([["a", [P(0, 0), P(10, 0)]], ["c", [P(20, 20), P(5, 0)]]]);
  const h: GCon = { k: "h", a: { id: "a", i: 0, j: 1 } };
  assert.equal(freedom(sh, [h, h], new Set(["c"])), 4 + 3 - 1);
  assert.equal(freedom(sh, [{ k: "rad", c: { id: "c" }, v: 5 }, { k: "fix", p: { id: "c", i: 0 }, at: P(20, 20) }], new Set(["c"])), 4);
});
