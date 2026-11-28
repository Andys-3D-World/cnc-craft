// Makes tests/fixtures/lasergcode-cases.json.gz: for a set of small test drawings, the job for Rust (src/laserJob.ts),
// the G-code and the warnings that src/laserCam.ts gives for it. `cargo test lasergcode` then checks that
// src-tauri/src/lasergcode.rs gives the same G-code line by line and the same warnings.
// laserCam.ts needs the window (layers, language, bed size), so this runs in the preview:
//   1. start the preview (vite) fresh; language as it comes; bed 300 x 300 (the default)
//   2. in the page:  await (await import("/tests/fixtures/lasergcode-make.js")).make()   → returns the JSON text
//      (it is large: let the page post it to a small local receiver instead of copying it by hand)
//   3. save it as tests/fixtures/lasergcode-cases.json and pack it:  gzip -9 -n tests/fixtures/lasergcode-cases.json
// The maker adds its own layers and removes them again; the laser settings are put back after every case.
// Run it again whenever laserCam.ts or laserJob.ts changes.
export async function make() {
  const { generateLaserGcode } = await import("/src/laserCam.ts");
  const { laserJob } = await import("/src/laserJob.ts");
  const ll = await import("/src/laserLayers.ts");
  const mm = v => v * 2; // drawing units: 2 per mm
  let id = 0;
  const base = (type, layer, extra) => ({ id: "s" + ++id, type, rotation: 0, laserLayerId: layer.id, ...extra });
  const poly = (layer, pts, closed = true, extra = {}) => {
    const points = pts.map(p => ({ x: mm(p[0]), y: mm(p[1]) }));
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    return base("polyline", layer, { points, closed, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), ...extra });
  };
  const rect = (layer, x0, y0, x1, y1, extra) => poly(layer, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true, extra);
  const circle = (layer, cx, cy, r, extra = {}) => base("circle", layer, { x: mm(cx), y: mm(cy), w: mm(r), h: mm(r), ...extra });
  const line = (layer, x0, y0, x1, y1, extra = {}) => base("line", layer, { x: mm(x0), y: mm(y0), w: mm(x1 - x0), h: mm(y1 - y0), ...extra });
  const arc = (layer, x0, y0, x1, y1, mx, my, extra = {}) => base("arc", layer, { x: mm(x0), y: mm(y0), w: mm(x1 - x0), h: mm(y1 - y0), midX: mm(mx), midY: mm(my), ...extra });
  const ring = (cx, cy, r, n) => Array.from({ length: n }, (_, i) => [+(cx + r * Math.cos(2 * Math.PI * i / n)).toFixed(4), +(cy + r * Math.sin(2 * Math.PI * i / n)).toFixed(4)]);
  const star = (cx, cy, r, n) => Array.from({ length: 2 * n }, (_, i) => { const q = i % 2 ? r * 0.45 : r; return [+(cx + q * Math.cos(Math.PI * i / n)).toFixed(4), +(cy + q * Math.sin(Math.PI * i / n)).toFixed(4)]; });
  // the letter O and a frame: shapes with holes
  const frame = (layer, x, y, w, h, t, extra) => [rect(layer, x, y, x + w, y + h, extra), rect(layer, x + t, y + t, x + w - t, y + h - t, extra)];

  // ---- own layers (removed at the end); the order here is the order in the layer list ----
  const added = [];
  const L = data => { const l = ll.addLayer({ color: "#123456", ...data }); added.push(l.id); return l; };
  const cut = L({ name: "Cut 3 mm", mode: "line", power: 80, speed: 600 });
  const cut2 = L({ name: "Cut twice, air", mode: "line", power: 100, speed: 300, passes: 2, air: true });
  const lead = L({ name: "Cut with lead-in", mode: "line", power: 90, speed: 450, leadIn: 2 });
  const over = L({ name: "Cut with overcut", mode: "line", power: 90, speed: 450, overcut: 1.5 });
  const leadOver = L({ name: "Lead-in + overcut, 3 passes", mode: "line", power: 70, speed: 800, leadIn: 1.2, overcut: 0.8, passes: 3 });
  const zcut = L({ name: "Z per pass", mode: "line", power: 100, speed: 250, passes: 4, zStep: 0.75, thickness: 2 });
  const fill = L({ name: "Engrave", mode: "fill", power: 30, speed: 3000, interval: 0.5, angle: 0 });
  const fill45 = L({ name: "Engrave 45°", mode: "fill", power: 35.5, speed: 2500, interval: 0.37, angle: 45, passes: 2 });
  const fill90 = L({ name: "Engrave 90", mode: "fill", power: 40, speed: 2000, interval: 0.8, angle: 90 });
  const fillOdd = L({ name: "Engrave -17", mode: "fill", power: 22, speed: 4000, interval: 1.3, angle: -17 });
  const cross = L({ name: "Cross", mode: "fill", power: 25, speed: 3500, interval: 0.9, angle: 30, fillKind: "cross" });
  const rings = L({ name: "Rings", mode: "fill", power: 45, speed: 1800, interval: 0.6, fillKind: "rings" });
  const both = L({ name: "Fläche + Linie (ä ö ü)", mode: "fill+line", power: 90, speed: 400, fillPower: 25, fillSpeed: 2500, interval: 0.7, angle: 0 });
  const bothRings = L({ name: "Rings + line, lead-in", mode: "fill+line", power: 85, speed: 500, fillPower: 20, fillSpeed: 3000, interval: 0.8, fillKind: "rings", leadIn: 1.5, passes: 2, air: true });
  const fine = L({ name: "Too fine", mode: "fill", power: 10, speed: 6000, interval: 0.01, angle: 0 });

  const S = ll.laserSettings;
  const set = patch => () => { const old = JSON.parse(JSON.stringify(S)); Object.assign(S, patch); return () => { for (const k of Object.keys(S)) delete S[k]; Object.assign(S, old); }; };
  const tabs = { tabLen: 3, tabH: 1, tabN: 4 };
  const cases = [];
  const add = (name, shapes, prep) => cases.push({ name, shapes, prep });

  // ---- lines ----
  add("line: one square", [rect(cut, 10, 10, 50, 40)]);
  add("line: square, circle, open line, arc, open polyline", [rect(cut, 10, 10, 50, 40), circle(cut, 80, 25, 12), line(cut, 100, 10, 140, 30), arc(cut, 150, 10, 190, 10, 170, 22), poly(cut, [[10, 60], [30, 70], [50, 60], [70, 75]], false)]);
  add("line: inner contours first, sorted by area", [rect(cut, 0, 0, 100, 80), rect(cut, 10, 10, 40, 30), circle(cut, 70, 40, 15), rect(cut, 15, 15, 25, 25), circle(cut, 70, 40, 5)]);
  add("line: order not optimised", [rect(cut, 150, 0, 190, 30), rect(cut, 0, 0, 100, 80), rect(cut, 10, 10, 40, 30), line(cut, 200, 50, 220, 60), circle(cut, 70, 40, 5), line(cut, 0, 100, 30, 100)], set({ optimizeOrder: false }));
  add("line: many parts, order optimised, free start points", [...Array.from({ length: 14 }, (_, i) => rect(cut, (i * 37) % 180, Math.floor(i / 5) * 45 + (i % 3) * 4, (i * 37) % 180 + 22, Math.floor(i / 5) * 45 + (i % 3) * 4 + 18)), ...Array.from({ length: 6 }, (_, i) => circle(cut, 30 + i * 33, 160 + (i % 2) * 12, 6 + i)), line(cut, 0, 190, 60, 200), poly(cut, [[100, 190], [120, 200], [140, 188]], false)]);
  add("line: two passes with air", [rect(cut2, 10, 10, 50, 40), circle(cut2, 30, 25, 6), line(cut2, 60, 10, 90, 40)]);
  add("line: lead-in on parts and holes", [rect(lead, 0, 0, 80, 60), rect(lead, 10, 10, 30, 30), circle(lead, 55, 30, 10), poly(lead, star(120, 30, 20, 5)), poly(lead, ring(170, 30, 15, 48)), line(lead, 0, 80, 40, 80)]);
  add("line: lead-in that finds no room, tiny shapes", [rect(lead, 0, 0, 1.5, 1.5), circle(lead, 10, 1, 0.8), rect(lead, 20, 0, 60, 3), poly(lead, [[70, 0], [70.5, 0], [70.5, 0.5]])]);
  add("line: overcut", [rect(over, 10, 10, 50, 40), circle(over, 80, 25, 12), poly(over, star(130, 30, 18, 6)), rect(over, 160, 10, 160.8, 10.5), line(over, 0, 60, 40, 60)]);
  add("line: lead-in, overcut and three passes", [rect(leadOver, 0, 0, 60, 40), circle(leadOver, 30, 20, 8), poly(leadOver, star(100, 20, 18, 5))]);
  add("line: Z per pass, limited by the material thickness", [rect(zcut, 10, 10, 50, 40), circle(zcut, 30, 25, 6)]);
  add("line: holding tabs, automatic and by hand", [rect(cut, 0, 0, 60, 40, tabs), circle(cut, 100, 20, 18, { tabLen: 2, tabH: 1, tabN: 3 }), rect(cut, 140, 0, 200, 40, { tabLen: 4, tabH: 1, tabMode: "manual", tabPts: [0.1, 0.6] }), rect(cut, 0, 60, 30, 75, { tabLen: 3, tabH: 1, tabN: 40 }), rect(cut, 50, 60, 90, 90)]);
  add("line: holding tabs with lead-in, two passes, optimised with other parts", [rect(lead, 0, 0, 60, 40, tabs), circle(lead, 30, 20, 8), rect(cut2, 80, 0, 140, 40, tabs), circle(cut2, 110, 20, 8, { tabLen: 2, tabH: 1, tabN: 2 }), rect(lead, 160, 0, 200, 30)]);
  add("line: start point and direction by hand", [rect(cut, 0, 0, 40, 30, { cutStart: 0.3 }), rect(cut, 50, 0, 90, 30, { cutDir: "cw" }), rect(cut, 100, 0, 140, 30, { cutDir: "ccw", cutStart: 0.62 }), line(cut, 0, 50, 40, 60, { cutDir: "reverse" }), poly(cut, [[50, 50], [70, 60], [90, 50]], false, { cutDir: "forward" }), poly(cut, [[100, 50], [120, 60], [140, 50]], false, { cutDir: "reverse" }), circle(cut, 170, 20, 12, { cutStart: 0.4 }), rect(lead, 0, 80, 40, 110, { cutStart: 0.3 }), rect(lead, 50, 80, 90, 110, { cutDir: "cw" })]);
  add("line: start point by hand inside a holding tab", [rect(cut, 0, 0, 60, 40, { tabLen: 6, tabH: 1, tabMode: "manual", tabPts: [0.3, 0.8], cutStart: 0.3 }), rect(lead, 80, 0, 140, 40, { tabLen: 6, tabH: 1, tabMode: "manual", tabPts: [0.3, 0.8], cutStart: 0.31 })]);
  // ---- detours round cut parts ----
  add("detours: rapids go round parts that are already cut", [rect(cut, 40, 40, 60, 60), rect(cut, 0, 45, 10, 55), rect(cut, 90, 45, 100, 55), circle(cut, 50, 100, 12), rect(cut, 45, 130, 55, 140), line(cut, 0, 0, 5, 0)], set({ avoidCut: true, optimizeOrder: false }));
  add("detours with order optimised, lead-in and two passes", [rect(lead, 40, 40, 60, 60), rect(lead, 0, 45, 10, 55), rect(lead, 90, 45, 100, 55), rect(cut2, 45, 0, 55, 10), rect(cut2, 45, 90, 55, 100), circle(cut2, 50, 50, 4)], set({ avoidCut: true }));
  add("detours near the bed edge: pulled back onto the bed or straight", [rect(cut, 1, 40, 20, 60), rect(cut, 0.5, 10, 8, 20), rect(cut, 0.5, 80, 8, 90), rect(cut, 280, 1, 299, 20), rect(cut, 285, 40, 295, 50), rect(cut, 250, 5, 260, 15)], set({ avoidCut: true, optimizeOrder: false }));
  add("detours: a part beyond the bed does not limit that edge", [rect(cut, -20, 40, 20, 60), rect(cut, 0, 10, 8, 20), rect(cut, 0, 80, 8, 90), rect(cut, 290, 100, 320, 120), rect(cut, 280, 60, 288, 70), rect(cut, 280, 150, 288, 160)], set({ avoidCut: true, optimizeOrder: false }));
  add("detours: parts with holding tabs are no obstacle, nested parts", [rect(cut, 40, 40, 60, 60, tabs), rect(cut, 0, 45, 10, 55), rect(cut, 90, 45, 100, 55), rect(cut, 30, 100, 70, 140), circle(cut, 50, 120, 8), rect(cut, 0, 115, 10, 125), rect(cut, 90, 115, 100, 125)], set({ avoidCut: true, optimizeOrder: false }));
  add("detours through a row of parts: several corners", [...Array.from({ length: 6 }, (_, i) => rect(cut, 20 + i * 25, 30 + (i % 2) * 15, 38 + i * 25, 70 - (i % 3) * 5)), rect(cut, 0, 45, 6, 55), rect(cut, 180, 45, 186, 55), rect(cut, 90, 0, 100, 8), rect(cut, 90, 90, 100, 98)], set({ avoidCut: true, optimizeOrder: false }));
  // ---- corner power without M4 ----
  const m3 = { dynamic: false, cornerPower: true, cornerAccel: 800, cornerMin: 20 };
  add("M3 without corner power", [rect(cut, 10, 10, 50, 40), circle(cut, 80, 25, 12), line(cut, 100, 10, 140, 30)], set({ dynamic: false }));
  add("M3 with corner power: square, circle, star, open lines", [rect(cut, 10, 10, 50, 40), circle(cut, 80, 25, 12), poly(cut, star(130, 25, 18, 5)), line(cut, 150, 10, 190, 30), poly(cut, [[0, 60], [0.1, 60], [20, 61], [20.05, 61.05], [40, 60]], false), rect(cut, 60, 60, 60.1, 60.1)], set(m3));
  add("M3 with corner power: lead-in, overcut, holding tabs, fast and slow", [rect(lead, 0, 0, 60, 40), rect(over, 80, 0, 140, 40), rect(leadOver, 160, 0, 200, 30), rect(cut, 0, 60, 60, 100, tabs), rect(lead, 80, 60, 140, 100, tabs), rect(zcut, 160, 60, 200, 90)], set({ ...m3, cornerAccel: 300, cornerMin: 55 }));
  add("M3 with corner power: very high and very low acceleration, minimum 0 and 100", [rect(cut, 0, 0, 30, 20), poly(cut, star(60, 10, 10, 4))], set({ ...m3, cornerAccel: 5, cornerMin: 0 }));
  add("M3 with corner power: minimum 100 changes nothing in power", [rect(cut, 0, 0, 30, 20), poly(cut, star(60, 10, 10, 4))], set({ ...m3, cornerAccel: 20000, cornerMin: 100 }));
  // ---- fill ----
  add("fill: square", [rect(fill, 10, 10, 30, 22)]);
  add("fill: letter shapes with holes, a circle, an open line that cannot be filled", [...frame(fill, 0, 0, 30, 20, 5), circle(fill, 50, 10, 9), circle(fill, 50, 10, 4), line(fill, 70, 0, 90, 10), poly(fill, [[70, 12], [80, 18], [90, 12]], false)]);
  add("fill at 45 degrees, two passes", [rect(fill45, 0, 0, 20, 12), poly(fill45, star(40, 8, 8, 5))]);
  add("fill at 90 degrees and at -17 degrees", [rect(fill90, 0, 0, 20, 12), circle(fill90, 35, 6, 6), rect(fillOdd, 0, 30, 30, 50), poly(fillOdd, ring(50, 40, 9, 24))]);
  add("fill: shapes side by side and nested three deep", [rect(fill, 0, 0, 12, 10), rect(fill, 20, 0, 32, 10), rect(fill, 40, 0, 70, 24), rect(fill, 45, 4, 65, 20), rect(fill, 50, 8, 60, 16)]);
  add("fill: thin sliver, shape of no height, two points", [poly(fill, [[0, 0], [30, 0.2], [0, 0.4]]), rect(fill, 40, 0, 60, 0), poly(fill, [[70, 0], [80, 5]]), rect(fill, 0, 10, 10, 10.4)]);
  add("fill: too many lines are limited", [rect(fine, 0, 0, 2, 420)]);
  add("fill over cross", [rect(cross, 0, 0, 20, 14), circle(cross, 35, 7, 7), circle(cross, 35, 7, 3)]);
  add("fill in rings: square, circle with hole, star", [rect(rings, 0, 0, 20, 14), circle(rings, 35, 7, 7), circle(rings, 35, 7, 3), poly(rings, star(60, 8, 8, 5))]);
  add("fill in rings: shapes too narrow for rings get lines, nested", [rect(rings, 0, 0, 30, 0.9), rect(rings, 0, 5, 30, 25), rect(rings, 5, 9, 25, 21), rect(rings, 9, 12, 21, 18), poly(rings, [[40, 0], [41, 0], [41, 0.5]]), circle(rings, 60, 10, 0.5)]);
  add("fill with the back-and-forth offset from the settings", [rect(fill, 0, 0, 20, 8), rect(fill45, 30, 0, 50, 8), rect(cross, 60, 0, 75, 8)], set({ scanOffsets: [{ speed: 1000, mm: 0.05 }, { speed: 3000, mm: 0.2 }, { speed: 6000, mm: 0.35 }] }));
  add("fill + line: own power and speed for the area, umlauts in the layer name", [rect(both, 0, 0, 30, 20), circle(both, 50, 10, 9), circle(both, 50, 10, 4), line(both, 70, 0, 90, 10)]);
  add("fill + line in rings with lead-in, two passes, air", [rect(bothRings, 0, 0, 24, 16), circle(bothRings, 40, 8, 7), rect(bothRings, 55, 0, 85, 20), rect(bothRings, 62, 5, 78, 15)]);
  add("fill + line with M3 corner power and detours", [rect(both, 0, 0, 20, 14), rect(both, 30, 0, 50, 14), rect(both, 60, 0, 80, 14), rect(both, 30, 30, 50, 44)], set({ ...m3, avoidCut: true }));
  // ---- several layers, order ----
  add("layers run in the order of the layer list, whatever the order of the shapes", [rect(fill, 0, 0, 20, 12), rect(cut, 30, 0, 50, 12), rect(lead, 60, 0, 80, 12), rect(cut, 30, 20, 50, 32), rect(fill, 0, 20, 20, 32), rect(both, 90, 0, 110, 12), circle(cut2, 130, 6, 6)]);
  add("fold lines come first, even from a layer further down", [rect(cut, 0, 0, 60, 40), line(zcut, 20, 0, 20, 40, { foldLine: true }), line(zcut, 40, 0, 40, 40, { foldLine: true }), rect(fill, 5, 5, 15, 15)]);
  // ---- shapes with their own values (material test grid, test card) ----
  const field = (x, y, o, layer = fill) => rect(layer, x, y, x + 8, y + 6, { laserOverride: o });
  add("own values per shape: every combination is its own block", [field(0, 0, { power: 20, speed: 1000 }), field(10, 0, { power: 40, speed: 1000 }), field(20, 0, { power: 20, speed: 2000, interval: 0.3 }), field(30, 0, { power: 20, speed: 1000 }), field(0, 10, {}), field(10, 10, { power: 500, speed: -5, interval: 99 }), rect(fill, 40, 0, 48, 6), field(0, 20, { power: 60, speed: 300 }, cut)]);
  add("test card: stages, air, fixed offset, focus ladder", [field(0, 0, { power: 20, speed: 1000, stage: 2 }), field(10, 0, { power: 80, speed: 300, stage: 5, air: true }, cut), field(20, 0, { power: 30, speed: 2000, stage: 1, scanMm: 0.15 }), field(30, 0, { power: 30, speed: 2000, stage: 1, scanMm: -0.4, air: false }), field(40, 0, { power: 50, speed: 500, stage: 3, zOff: 1.5 }, cut), field(50, 0, { power: 50, speed: 500, stage: 3, zOff: 3 }, cut), rect(cut, 0, 20, 60, 30)]);
  // ---- larger mixed jobs ----
  add("mixed job: engraving, then cutting with lead-in, detours and optimised order", [...frame(fill45, 10, 10, 40, 24, 6), circle(fill45, 80, 22, 10), ...Array.from({ length: 8 }, (_, i) => rect(lead, (i % 4) * 50, 60 + Math.floor(i / 4) * 40, (i % 4) * 50 + 40, 90 + Math.floor(i / 4) * 40)), ...Array.from({ length: 8 }, (_, i) => circle(lead, (i % 4) * 50 + 20, 75 + Math.floor(i / 4) * 40, 5)), rect(cut, 0, 0, 200, 150)], set({ avoidCut: true }));
  add("mixed job with M3, corner power, tabs and Z per pass", [rect(zcut, 0, 0, 60, 40, tabs), circle(zcut, 30, 20, 8), poly(zcut, star(100, 20, 18, 7)), rect(fill90, 130, 0, 150, 12), rect(cross, 130, 20, 150, 32), poly(cut2, ring(40, 80, 25, 90)), poly(cut2, ring(40, 80, 12, 40))], set({ ...m3, avoidCut: true }));
  add("a shape on a layer that does not exist uses the active layer", [{ ...rect(cut, 0, 0, 20, 12), laserLayerId: "no-such-layer" }, rect(cut, 30, 0, 50, 12)]);

  // ---- found by the fault check: each case catches one deliberate fault in lasergcode.rs ----
  add("fill: a scan line runs exactly through corners of the shape", [poly(fill, [[0, 0], [10, 0], [10, 0.75], [5, 2], [0, 0.75]]), poly(fill, [[20, 0], [30, 0], [30, 1.25], [20, 1.25]])]);
  add("rings: four contours nested, the hole belongs to the smallest contour around it", [rect(rings, 0, 0, 40, 30), rect(rings, 4, 4, 36, 26), rect(rings, 8, 8, 32, 22), rect(rings, 12, 12, 28, 18)]);
  add("rings: two identical contours on top of each other", [rect(rings, 0, 0, 12, 10), rect(rings, 0, 0, 12, 10), rect(rings, 20, 0, 30, 8)]);
  add("rings: a thin frame gets lines, its hole stays free", [rect(rings, 0, 0, 30, 1.5), rect(rings, 0.4, 0.4, 29.6, 1.1), rect(rings, 0, 10, 12, 20)]);
  add("rings: a circle of 200 points is simplified first", [poly(rings, ring(10, 10, 7, 200))]);
  add("M3 with corner power: points on one straight line are joined", [poly(cut, [[0, 0], [20, 0], [40, 0], [60, 0], [60, 30], [60, 60]], false), poly(cut, [[0, 80], [0.4, 80], [0.8, 80], [1.2, 80.3]], false)], set(m3));
  add("S values are rounded: S max 255", [rect(fill, 0, 0, 10, 4), rect(cut, 20, 0, 30, 8), rect(both, 40, 0, 50, 6), rect(fill45, 60, 0, 70, 4)], set({ sMax: 255 }));
  add("overcut longer than the whole contour", [poly(over, [[0, 0], [0.4, 0], [0.2, 0.3]]), rect(over, 10, 0, 10.3, 0.2)]);
  add("detours: a rapid that only clips the corner of a part goes straight", [rect(cut, 40, 40, 60, 60), rect(cut2, 30, 50.1, 31, 51.1), rect(cut2, 50.1, 30, 52, 31.6), rect(cut2, 49.6, 70, 52, 73)], set({ avoidCut: true, optimizeOrder: false }));
  add("detours at the bed edges: the edge a part reaches past does not limit, the other one does", [rect(cut, 1, 40, 20, 60), rect(cut, -5, 100, 3, 110), rect(cut, 280, 40, 299, 60), rect(cut2, 9, 30, 11, 32), rect(cut2, 9, 70, 11.5, 72), poly(cut2, [[290, 30], [287, 30], [287, 27], [290, 27]]), poly(cut2, [[290, 70], [286.8, 70], [286.8, 73.2], [290, 73.2]])], set({ avoidCut: true, optimizeOrder: false }));
  add("detours: an open line that was cut is no obstacle", [poly(cut, [[40, 40], [60, 60], [80, 40]], false), rect(cut, 50, 30, 52, 32), rect(cut, 70, 55, 73, 58)], set({ avoidCut: true, optimizeOrder: false }));
  add("order: parts with holding tabs end where their last piece ends", [...Array.from({ length: 6 }, (_, i) => rect(cut, i * 35, (i % 2) * 50, i * 35 + 28, (i % 2) * 50 + 22, { tabLen: 3, tabH: 1, tabN: 2 + (i % 3) })), circle(cut, 100, 100, 10), rect(cut, 0, 110, 20, 125)]);
  add("order: the next layer starts from the end of an open line", [line(cut, 0, 0, 100, 0), rect(cut2, 95, 5, 105, 12), rect(cut2, 0, 5, 10, 12), rect(cut2, 50, 5, 60, 12)]);
  // ---- image engraving (raster/imageShape.ts): small pictures drawn here, rastered by the program ----
  const im = await import("/src/raster/imageShape.ts");
  const picture = async (name, w, h, draw) => {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    draw(ctx, w, h);
    const blob = await new Promise(r => cv.toBlob(r, "image/png"));
    return { name, bytes: new Uint8Array(await blob.arrayBuffer()) };
  };
  const grad = await picture("gradient.png", 48, 32, (c, w, h) => { const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, "#000"); g.addColorStop(1, "#fff"); c.fillStyle = g; c.fillRect(0, 0, w, h); });
  const shapesPic = await picture("Schöne Formen (1).png", 60, 40, (c, w, h) => { c.fillStyle = "#000"; c.fillRect(6, 6, 14, 10); c.beginPath(); c.arc(40, 20, 11, 0, 7); c.fill(); c.fillStyle = "#888"; c.fillRect(8, 26, 30, 8); c.fillStyle = "#fff"; c.beginPath(); c.arc(40, 20, 4, 0, 7); c.fill(); });
  const white = await picture("white.png", 20, 12, () => {});
  const dots = await picture("dots.png", 30, 20, (c, w, h) => { c.fillStyle = "#000"; for (let y = 1; y < h; y += 3) for (let x = (y % 2) * 2; x < w; x += 5) c.fillRect(x, y, 2, 1); });
  // image shape on a layer: width in mm at x0/y0, with its settings changed by `img`, turned by `deg` round its corner
  const image = async (layer, pic, width, x0, y0, img = {}, deg = 0) => {
    const s = await im.createImageShape(pic.name, pic.bytes, width, x0, y0);
    s.id = "s" + ++id;
    s.laserLayerId = layer.id;
    s.img = { ...s.img, ...img, raster: { ...s.img.raster, ...(img.raster || {}) } };
    if (deg) { const a = deg * Math.PI / 180, o = s.points[0]; s.points = s.points.map(p => ({ x: o.x + (p.x - o.x) * Math.cos(a) - (p.y - o.y) * Math.sin(a), y: o.y + (p.x - o.x) * Math.sin(a) + (p.y - o.y) * Math.cos(a) })); }
    return s;
  };
  const m = method => ({ raster: { method } });
  add("image: black and white by threshold", [await image(fill, shapesPic, 30, 10, 10, { ...m("threshold"), interval: 0.5 })]);
  add("image: photo raster (Jarvis), no overscan", [await image(fill, grad, 24, 0, 0, { ...m("jarvis"), interval: 0.4, overscan: 0 })]);
  add("image: graphic raster (Atkinson), wide overscan", [await image(fill, grad, 24, 5, 5, { ...m("atkinson"), interval: 0.6, overscan: 5.5 })]);
  add("image: grey scale, power follows the brightness", [await image(fill, grad, 24, 0, 0, { ...m("gray"), interval: 0.5, minPower: 0 })]);
  add("image: grey scale with a minimum power, S max 255", [await image(fill, grad, 20, 3, 4, { ...m("gray"), interval: 0.4, minPower: 12.5 }), await image(fill, shapesPic, 20, 30, 4, { ...m("gray"), interval: 0.7, minPower: 250 })], set({ sMax: 255 }));
  add("image: an empty picture gives nothing", [await image(fill, white, 10, 0, 0, { ...m("threshold"), interval: 0.5 }), rect(fill, 20, 0, 30, 6)]);
  add("image: single dots, many short runs", [await image(fill, dots, 15, 0, 0, { ...m("threshold"), interval: 0.5, overscan: 1 })]);
  add("image turned by 30 degrees and by -90 degrees", [await image(fill, shapesPic, 24, 40, 10, { ...m("threshold"), interval: 0.6 }, 30), await image(fill, grad, 16, 10, 60, { ...m("jarvis"), interval: 0.5 }, -90)]);
  add("image with the back-and-forth offset", [await image(fill, shapesPic, 24, 0, 0, { ...m("threshold"), interval: 0.5 }), await image(fill45, dots, 12, 40, 0, { ...m("threshold"), interval: 0.4 })], set({ scanOffsets: [{ speed: 1000, mm: 0.05 }, { speed: 3000, mm: 0.2 }, { speed: 6000, mm: 0.35 }] }));
  add("image on a layer with two passes; image on a line layer", [await image(fill45, shapesPic, 18, 0, 0, { ...m("threshold"), interval: 0.6 }), await image(cut, dots, 12, 30, 0, { ...m("threshold"), interval: 0.5 })]);
  add("image on a fill + line layer: own feed for the picture, then the shapes", [await image(both, shapesPic, 18, 0, 0, { ...m("atkinson"), interval: 0.6 }), rect(both, 30, 0, 44, 10), circle(both, 60, 6, 5)]);
  add("images and cuts together: detours start fresh after a picture", [await image(fill, shapesPic, 18, 0, 0, { ...m("threshold"), interval: 0.6 }), rect(cut, 40, 40, 60, 60), rect(cut, 0, 45, 10, 55), rect(cut, 90, 45, 100, 55), await image(lead, dots, 10, 70, 0, { ...m("threshold"), interval: 0.5 }), rect(lead, 45, 70, 55, 80), rect(lead, 45, 20, 55, 30)], set({ avoidCut: true, optimizeOrder: false }));
  add("image with a mask: only inside the contour", [await image(fill, grad, 24, 0, 0, { ...m("threshold"), interval: 0.5, mask: [[{ u: 0.2, v: 0.2 }, { u: 0.8, v: 0.2 }, { u: 0.5, v: 0.9 }]] })]);
  add("image with M3 and the test-card focus ladder on another shape", [await image(fill, shapesPic, 18, 0, 0, { ...m("gray"), interval: 0.6, minPower: 5 }), rect(cut, 30, 0, 40, 8, { laserOverride: { power: 50, speed: 500, zOff: 1.5 } })], set({ dynamic: false }));

  add("image: a negative overscan counts as none", [await image(fill, shapesPic, 18, 0, 0, { ...m("threshold"), interval: 0.6, overscan: -3 })]);

  const { laserBody } = await import("/src/laserJob.ts");
  // image points of a case, packed (zlib) and as base64 text
  const packed = async job => {
    const body = laserBody(job), len = new DataView(body.buffer).getUint32(0, true), data = body.slice(4 + len);
    if (!data.length) return null;
    const z = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    let bin = "";
    for (let i = 0; i < z.length; i += 0x8000) bin += String.fromCharCode(...z.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const out = [];
  try {
    for (const c of cases) {
      const undo = c.prep ? c.prep() : null;
      try {
        // first the G-code (it rasters the pictures), then the job with the same points
        const res = generateLaserGcode(c.shapes);
        if (!res.gcode) throw new Error(`${c.name}: no G-code`);
        const job = laserJob(c.shapes);
        if (job.no) throw new Error(`${c.name}: no job (${job.no})`);
        const data = await packed(job);
        out.push({ name: c.name, job, gcode: res.gcode, warnings: res.warnings, ...(data ? { data } : {}) });
      } finally { if (undo) undo(); }
    }
  } finally { added.forEach(a => ll.removeLayer(a)); }
  return JSON.stringify(out).replace(/},\{"name"/g, '},\n{"name"') + "\n";
}
