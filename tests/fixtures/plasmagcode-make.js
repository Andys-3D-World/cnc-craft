// Makes tests/fixtures/plasmagcode-cases.json.gz: for a set of small test drawings, the job for Rust (src/plasmaJob.ts),
// the G-code and the warnings that src/plasmaCam.ts gives for it. `cargo test plasmagcode` checks that
// src-tauri/src/plasmagcode.rs gives the same G-code line by line and the same warnings.
// plasmaCam.ts needs the window (cut settings, language, bed size), so this runs in the preview:
//   1. start the preview (vite) fresh; language as it comes; bed 300 x 300 (the default)
//   2. in the page:  await (await import("/tests/fixtures/plasmagcode-make.js")).make()   → returns the JSON text
//      (let the page post it to a small local receiver instead of copying it by hand)
//   3. save it as tests/fixtures/plasmagcode-cases.json and pack it:  gzip -9 -n tests/fixtures/plasmagcode-cases.json
// The maker adds its own cut settings and removes them again; the plasma settings are put back after every case.
// Run it again whenever plasmaCam.ts or plasmaJob.ts changes.
export async function make() {
  const { generatePlasmaGcode } = await import("/src/plasmaCam.ts");
  const { plasmaJob } = await import("/src/plasmaJob.ts");
  const pc = await import("/src/plasmaCuts.ts");
  const mm = v => v * 2; // drawing units: 2 per mm
  let id = 0;
  const base = (type, cut, mode, extra) => ({ id: "s" + ++id, type, rotation: 0, plasmaCutId: cut.id, millingMode: mode, ...extra });
  const poly = (cut, pts, closed = true, mode = "outside", extra = {}) => {
    const points = pts.map(p => ({ x: mm(p[0]), y: mm(p[1]) }));
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    return base("polyline", cut, mode, { points, closed, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), ...extra });
  };
  const rect = (cut, x0, y0, x1, y1, mode = "outside", extra) => poly(cut, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true, mode, extra);
  const circle = (cut, cx, cy, r, mode = "outside", extra = {}) => base("circle", cut, mode, { x: mm(cx), y: mm(cy), w: mm(r), h: mm(r), ...extra });
  const line = (cut, x0, y0, x1, y1, extra = {}) => base("line", cut, "on-line", { x: mm(x0), y: mm(y0), w: mm(x1 - x0), h: mm(y1 - y0), ...extra });
  const arc = (cut, x0, y0, x1, y1, mx, my, extra = {}) => base("arc", cut, "on-line", { x: mm(x0), y: mm(y0), w: mm(x1 - x0), h: mm(y1 - y0), midX: mm(mx), midY: mm(my), ...extra });
  const star = (cx, cy, r, n) => Array.from({ length: 2 * n }, (_, i) => { const q = i % 2 ? r * 0.45 : r; return [+(cx + q * Math.cos(Math.PI * i / n)).toFixed(4), +(cy + q * Math.sin(Math.PI * i / n)).toFixed(4)]; });
  // a part with holes: plate, round holes, square hole
  const plate = (cut, x, y, w, h, holes = true, extra = {}) => [rect(cut, x, y, x + w, y + h, "outside", extra), ...(holes ? [circle(cut, x + w * 0.25, y + h / 2, Math.min(w, h) * 0.15, "inside"), circle(cut, x + w * 0.75, y + h / 2, Math.min(w, h) * 0.08, "inside"), rect(cut, x + w * 0.45, y + h * 0.3, x + w * 0.55, y + h * 0.7, "inside")] : [])];

  const added = [];
  const C = data => { const c = pc.addCut({ color: "#123456", ...data }); added.push(c.id); return c; };
  const mild = C({ name: "Baustahl 3 mm", speed: 2200, kerf: 1.5, pierceHeight: 3.8, pierceDelay: 0.4, cutHeight: 1.5, leadIn: 4, leadOut: 0 });
  const thick = C({ name: "Stahl 8 mm (ä)", speed: 800, kerf: 2.2, pierceHeight: 5, pierceDelay: 1.2, cutHeight: 1.8, leadIn: 6, leadOut: 3 });
  const thin = C({ name: "Blech 1 mm", speed: 4500, kerf: 0.9, pierceHeight: 3, pierceDelay: 0, cutHeight: 1, leadIn: 0, leadOut: 0 });
  const noKerf = C({ name: "Ohne Spalt", speed: 3000, kerf: 0, pierceHeight: 3.2, pierceDelay: 0.25, cutHeight: 1.2, leadIn: 3, leadOut: 2 });

  const S = pc.plasmaSettings;
  const set = patch => () => { const old = JSON.parse(JSON.stringify(S)); Object.assign(S, patch); return () => { for (const k of Object.keys(S)) delete S[k]; Object.assign(S, old); }; };
  const tabs = { tabLen: 3, tabH: 1, tabN: 3 };
  const cases = [];
  const add = (name, shapes, prep) => cases.push({ name, shapes, prep });

  add("plate with holes: lead-in, holes first, small holes slower", plate(mild, 10, 10, 120, 80));
  add("square, circle, star, open line, arc", [rect(mild, 0, 0, 40, 30), circle(mild, 70, 15, 12), poly(mild, star(120, 20, 18, 5)), line(mild, 0, 50, 60, 60), arc(mild, 80, 50, 140, 50, 110, 70)]);
  add("on the line: no kerf offset, no lead-in", [rect(mild, 0, 0, 40, 30, "on-line"), circle(mild, 70, 15, 12, "on-line")]);
  add("lead-out and overcut, thick plate", plate(thick, 0, 0, 150, 100));
  add("no lead-in, no pierce delay, thin sheet", plate(thin, 0, 0, 80, 50));
  add("no kerf: contour as drawn, lead-in and lead-out", [...plate(noKerf, 0, 0, 90, 60), poly(noKerf, star(130, 30, 20, 6))]);
  add("too small for the kerf, no room for the lead-in", [rect(thick, 0, 0, 1.5, 1.5, "inside"), circle(thick, 20, 5, 1, "inside"), rect(thick, 40, 0, 45, 4, "inside"), circle(mild, 60, 5, 2.2, "inside"), rect(mild, 80, 0, 120, 30)]);
  add("several cut settings run in the order of the list", [...plate(thin, 0, 0, 60, 40), ...plate(mild, 80, 0, 140, 40), ...plate(thick, 0, 60, 80, 120), rect(noKerf, 100, 60, 140, 90)]);
  add("many parts: order optimised", [...Array.from({ length: 12 }, (_, i) => rect(mild, (i * 41) % 200, Math.floor(i / 4) * 50 + (i % 3) * 3, (i * 41) % 200 + 28, Math.floor(i / 4) * 50 + (i % 3) * 3 + 22)), ...Array.from({ length: 8 }, (_, i) => circle(mild, 15 + i * 26, 175 + (i % 2) * 8, 4 + (i % 3), "inside")), line(mild, 0, 200, 80, 205)]);
  add("order not optimised: the drawn order, small before large", [rect(mild, 150, 0, 190, 30), ...plate(mild, 0, 0, 100, 80), line(mild, 200, 50, 220, 60), circle(mild, 170, 60, 5, "inside")], set({ optimizeOrder: false, avoidCut: false }));
  add("heat spread: always far away from the last cuts", [...Array.from({ length: 9 }, (_, i) => rect(mild, (i % 3) * 60, Math.floor(i / 3) * 50, (i % 3) * 60 + 40, Math.floor(i / 3) * 50 + 30)), ...Array.from({ length: 9 }, (_, i) => circle(mild, (i % 3) * 60 + 20, Math.floor(i / 3) * 50 + 15, 5, "inside"))], set({ spread: true }));
  add("heat spread with order optimising off", [...plate(mild, 0, 0, 80, 50), ...plate(mild, 120, 0, 200, 50), ...plate(mild, 60, 80, 140, 130)], set({ spread: true, optimizeOrder: false }));
  add("detours round parts that are cut already", [rect(mild, 40, 40, 60, 60), rect(mild, 0, 45, 10, 55), rect(mild, 90, 45, 100, 55), circle(mild, 50, 100, 12), rect(mild, 45, 130, 55, 140)], set({ optimizeOrder: false }));
  add("no detours", [rect(mild, 40, 40, 60, 60), rect(mild, 0, 45, 10, 55), rect(mild, 90, 45, 100, 55)], set({ optimizeOrder: false, avoidCut: false }));
  add("detours near the bed edge", [rect(mild, 1, 40, 20, 60), rect(mild, 0.5, 10, 8, 20), rect(mild, 0.5, 80, 8, 90), rect(mild, 280, 1, 299, 20), rect(mild, 285, 40, 295, 50), rect(mild, 250, 5, 260, 15)], set({ optimizeOrder: false }));
  add("holding tabs: pierce again after each tab, no overcut, no lead-out", [rect(thick, 0, 0, 80, 50, "outside", tabs), circle(thick, 120, 25, 22, "outside", tabs), rect(thick, 160, 0, 220, 50, "outside", { tabLen: 4, tabH: 1, tabMode: "manual", tabPts: [0.1, 0.6] }), rect(thick, 10, 10, 30, 30, "inside", tabs)]);
  add("start point and direction by hand, start inside a tab", [rect(mild, 0, 0, 40, 30, "outside", { cutStart: 0.3 }), rect(mild, 50, 0, 90, 30, "outside", { cutDir: "ccw" }), rect(mild, 100, 0, 140, 30, "inside", { cutDir: "cw" }), rect(mild, 150, 0, 190, 30, "outside", { cutDir: "cw", cutStart: 0.6 }), line(mild, 0, 50, 40, 60, { cutDir: "reverse" }), rect(mild, 0, 80, 60, 120, "outside", { tabLen: 6, tabH: 1, tabMode: "manual", tabPts: [0.3, 0.8], cutStart: 0.3 })]);
  add("Z off: no heights, no probing", plate(mild, 0, 0, 80, 50), set({ useZ: false, probe: true }));
  add("probing before every pierce", plate(mild, 0, 0, 80, 50), set({ probe: true, probeOffset: 1.5, probeDist: 60 }));
  add("probing, skipped when the last point is near", [...Array.from({ length: 6 }, (_, i) => circle(mild, 10 + i * 12, 10, 3, "inside")), rect(mild, 0, 0, 90, 20), rect(mild, 150, 0, 170, 20)], set({ probe: true, probeSkip: 25, probeOffset: 0.8 }));
  add("probing skip with an external THC: warning, height control resets it", plate(mild, 0, 0, 80, 50), set({ probe: true, probeSkip: 30, thc: "external" }));
  add("external THC on M8, without probing: warning", plate(mild, 0, 0, 80, 50), set({ thc: "external" }));
  add("external THC on M7 with probing", plate(thick, 0, 0, 120, 80), set({ thc: "external", thcOut: "M7", probe: true }));
  add("grblHAL THC: anti-dive before the end of each contour", plate(mild, 0, 0, 100, 60), set({ thc: "grblhal", antiDive: 5 }));
  add("grblHAL THC: anti-dive longer than small contours, open lines, tabs", [...plate(mild, 0, 0, 100, 60), rect(mild, 120, 0, 126, 5), line(mild, 0, 80, 3, 80), line(mild, 10, 80, 60, 82), rect(mild, 140, 0, 200, 40, "outside", tabs)], set({ thc: "grblhal", antiDive: 12, smallHole: 0 }));
  add("grblHAL THC without anti-dive", plate(mild, 0, 0, 100, 60), set({ thc: "grblhal", antiDive: 0 }));
  add("small holes off, small holes large", [...plate(mild, 0, 0, 100, 60), circle(mild, 150, 30, 20, "inside")], set({ smallHole: 0 }));
  add("small holes up to 45 mm at 35 percent", [...plate(mild, 0, 0, 100, 60), circle(mild, 150, 30, 20, "inside"), rect(mild, 120, 0, 200, 70)], set({ smallHole: 45, holeSpeed: 35, thc: "external", probe: true }));
  add("spotting small hole centres instead of cutting", [...plate(mild, 0, 0, 120, 60), circle(mild, 150, 20, 2, "inside"), circle(mild, 170, 40, 1.5, "inside"), rect(mild, 140, 0, 190, 60)], set({ spotMax: 6, spotTime: 250 }));
  add("spotting with probing and Z off / on, shapes set by hand", [circle(mild, 10, 10, 2, "inside", { plasmaOp: "spot" }), rect(mild, 30, 0, 40, 10, "inside", { plasmaOp: "spot" }), circle(mild, 60, 10, 2, "inside", { plasmaOp: "cut" }), rect(mild, 0, 20, 80, 40, "outside", { plasmaOp: "skip" }), rect(mild, -5, -5, 85, 50)], set({ spotMax: 10, probe: true }));
  add("shapes left out", [rect(mild, 0, 0, 40, 30, "outside", { plasmaOp: "skip" }), circle(mild, 70, 15, 12, "outside", { plasmaOp: "skip" }), rect(mild, 100, 0, 140, 30)]);
  add("only spots, nothing cut", [circle(mild, 10, 10, 2, "inside", { plasmaOp: "spot" }), circle(mild, 30, 10, 2, "inside", { plasmaOp: "spot" }), rect(mild, 50, 0, 60, 10, "outside", { plasmaOp: "skip" })]);
  add("fold lines are left out", [rect(mild, 0, 0, 60, 40), line(mild, 20, 0, 20, 40, { foldLine: true }), line(mild, 40, 0, 40, 40, { foldLine: true })]);
  add("mixed job: everything on", [...plate(thick, 0, 0, 120, 80, true, tabs), ...plate(mild, 140, 0, 220, 60), ...Array.from({ length: 5 }, (_, i) => circle(thin, 20 + i * 30, 120, 2 + i, "inside")), rect(thin, 0, 100, 170, 140), poly(noKerf, star(250, 120, 25, 7))], set({ thc: "grblhal", probe: true, probeSkip: 15, spotMax: 4.5, spread: true }));
  add("a shape on a cut setting that does not exist uses the active one", [{ ...rect(mild, 0, 0, 20, 12), plasmaCutId: "no-such-cut" }, rect(mild, 30, 0, 50, 12)]);

  // ---- found by the fault check: each case catches one deliberate fault in plasmagcode.rs ----
  add("a square hole exactly as large as the small-hole limit", [rect(noKerf, 0, 0, 60, 40), rect(noKerf, 10, 10, 20, 20, "inside"), rect(noKerf, 30, 10, 40.5, 20.5, "inside")], set({ smallHole: 10 }));
  add("anti-dive exactly as long as an open line", [line(thin, 0, 0, 5, 0), line(thin, 0, 10, 5.001, 10), line(thin, 0, 20, 4.999, 20)], set({ thc: "grblhal", antiDive: 5, smallHole: 0 }));
  add("spots after a cut of another setting: nearest from where the torch stands, detours", [rect(mild, 40, -20, 60, 40), circle(thick, 70, 0, 2, "inside", { plasmaOp: "spot" }), circle(thick, 30, 0, 2, "inside", { plasmaOp: "spot" }), circle(thick, 0, 25, 2, "inside", { plasmaOp: "spot" }), circle(thick, 90, 30, 2, "inside", { plasmaOp: "spot" }), rect(thick, -20, 60, 100, 80)], set({ optimizeOrder: false }));
  add("probing skipped at exactly the given distance", [rect(thin, 0, 0, 10, 10), rect(thin, 25, 0, 35, 10), rect(thin, 50.01, 0, 60.01, 10), rect(thin, 0, 30, 80, 50)], set({ probe: true, probeSkip: 25, optimizeOrder: false }));
  add("external THC without Z: no probing warning", plate(mild, 0, 0, 80, 50), set({ thc: "external", useZ: false }));
  add("external THC with probing skip: after each cut with THC the height is probed again", [rect(mild, 0, 0, 10, 10), rect(mild, 14, 0, 24, 10), rect(mild, 28, 0, 38, 10)], set({ thc: "external", probe: true, probeSkip: 50, smallHole: 0, optimizeOrder: false }));
  add("an open line that was cut is no obstacle for the rapids", [poly(mild, [[40, -10], [45, 30], [50, -10], [55, 30], [60, -10]], false, "on-line"), rect(mild, 0, 5, 10, 15), rect(mild, 90, 5, 100, 15)], set({ optimizeOrder: false }));
  add("everything left out: no program", [rect(mild, 0, 0, 40, 30, "outside", { plasmaOp: "skip" }), circle(mild, 70, 15, 12, "outside", { plasmaOp: "skip" })]);

  const out = [];
  try {
    for (const c of cases) {
      const undo = c.prep ? c.prep() : null;
      try {
        const res = generatePlasmaGcode(c.shapes);
        const job = plasmaJob(c.shapes);
        if (job.no) throw new Error(`${c.name}: no job (${job.no})`);
        out.push({ name: c.name, job, gcode: res.gcode, warnings: res.warnings });
      } finally { if (undo) undo(); }
    }
  } finally { added.forEach(a => pc.removeCut(a)); }
  return JSON.stringify(out).replace(/},\{"name"/g, '},\n{"name"') + "\n";
}
