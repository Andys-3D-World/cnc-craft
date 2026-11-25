/**
 * DREHEN: Rohteil, Spindel, Bearbeitungen und Werkzeuge einstellen, mit Schnitt-Vorschau und Materialabtrag.
 * Gerechnet wird in lathe/turn.ts. „Als Auftrag laden“ lädt nur – gestartet wird nie von selbst.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n/i18n";
import { state } from "../main";
import { isLathe } from "../machineMode";
import { loadGcodeFromText } from "../machineStream";
import { gcodeFromPlan, issueTexts, latheSettings, latheTools, planFromDesign, saveLathe, setLatheSettings, setLatheTools } from "../lathe/latheJob";
import { LATHE_MATERIALS, powerW, refDz, rpmFor, shapeOf, sweep, type LatheOp, type LathePlan, type LatheTool } from "../lathe/turn";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const WANT: Record<LatheOp["kind"], LatheTool["type"]> = { face: "turn", rough: "turn", finish: "turn", drill: "drill", groove: "groove", part: "groove" };

export function openLatheDialog(log: (s: string) => void, onClose?: () => void) {
  if (!isLathe()) { log(t("lathe.onlyLathe")); return; }
  document.getElementById("lathe-overlay")?.remove();
  const s = latheSettings, j = s.job;
  const num = (id: string, label: string, val: number, unit = "mm", step = "0.1", tipKey = "") =>
    `<div class="dlg-row"${tipKey ? ` data-tip="${esc(t(tipKey))}"` : ""}><span>${esc(t(label))}</span><span class="dlg-num"><input id="lt-${id}" type="number" step="${step}" class="prop-input" value="${val}"><em>${unit}</em></span></div>`;
  const sel = (id: string, label: string, val: string, opts: [string, string][], tipKey = "") =>
    `<div class="dlg-row"${tipKey ? ` data-tip="${esc(t(tipKey))}"` : ""}><span>${esc(t(label))}</span><select id="lt-${id}" class="prop-input" style="width:150px;">${opts.map(([v, l]) => `<option value="${v}"${v === val ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`;
  const ov = document.createElement("div");
  ov.id = "lathe-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" data-unit-scope="none" style="width:min(1180px, calc(100vw - 32px));max-height:calc(100vh - 24px);overflow:auto;">
      <h3>🔩 ${esc(t("lathe.title"))}</h3>
      <div class="dlg-hint">${esc(t("lathe.intro"))}</div>
      <div class="c3d-grid" style="grid-template-columns:340px 1fr;">
        <div class="c3d-form">
          <div class="c3d-sec">${esc(t("lathe.stock"))}</div>
          ${num("stockD", "lathe.stockD", j.stockD)}${num("stickOut", "lathe.stickOut", j.stickOut, "mm", "1", "lathe.stickOutTip")}${num("faceAllow", "lathe.faceAllow", j.faceAllow, "mm", "0.1", "lathe.faceAllowTip")}${num("margin", "lathe.margin", j.margin, "mm", "0.5", "lathe.marginTip")}
          ${sel("axis", "lathe.axis", s.axis, [["bottom", t("lathe.axis.bottom")], ["middle", t("lathe.axis.middle")], ["zero", t("lathe.axis.zero")]], "lathe.axisTip")}
          <label class="dlg-row" style="cursor:pointer;"><span>${esc(t("lathe.tail"))}</span><input type="checkbox" id="lt-tailOn"${j.tailOn ? " checked" : ""}></label>
          <div id="lt-tailbox">${num("tailD", "lathe.tailD", j.tailD)}${num("tailZ", "lathe.tailZ", j.tailZ, "mm", "0.5", "lathe.tailZTip")}</div>
          <div class="c3d-sec">${esc(t("lathe.spindle"))}</div>
          ${sel("material", "lathe.material", s.material, LATHE_MATERIALS.map(m => [m.id, t("lathe.mat." + m.id)]))}
          ${num("vc", "lathe.vc", j.vc, "m/min", "5", "lathe.vcTip")}${num("maxRpm", "lathe.maxRpm", j.maxRpm, "1/min", "50", "lathe.maxRpmTip")}${num("watt", "lathe.watt", s.watt, "W", "50", "lathe.wattTip")}
          ${sel("spindle", "lathe.spindleMode", s.out.spindle, [["auto", t("lathe.spindle.auto")], ["m8", t("lathe.spindle.m8")], ["hand", t("lathe.spindle.hand")]], "lathe.spindleTip")}
          ${sel("dir", "lathe.dir", s.out.dir, [["M3", t("lathe.dir.M3")], ["M4", t("lathe.dir.M4")]], "lathe.dirTip")}
          <div class="c3d-sec">${esc(t("lathe.machine"))}</div>
          ${sel("xMode", "lathe.xMode", s.out.xMode, [["radius", t("lathe.x.radius")], ["dia", t("lathe.x.dia")], ["g8", t("lathe.x.g8")], ["g7", t("lathe.x.g7")]], "lathe.xModeTip")}
          ${sel("xSign", "lathe.xSign", String(s.out.xSign), [["1", t("lathe.xSign.out")], ["-1", t("lathe.xSign.in")]], "lathe.xSignTip")}
          ${num("safeX", "lathe.safeX", j.safeX)}${num("safeZ", "lathe.safeZ", j.safeZ)}${num("clear", "lathe.clear", j.clear, "mm", "0.1")}
          <div class="c3d-sec">${esc(t("lathe.allow"))}</div>
          ${num("allowX", "lathe.allowX", j.allowX, "mm", "0.05")}${num("allowZ", "lathe.allowZ", j.allowZ, "mm", "0.05")}
        </div>
        <div style="min-width:0;">
          <canvas id="lt-cv" width="1100" height="430" style="width:100%;border-radius:6px;display:block;background:#16161c;"></canvas>
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px;"><button id="lt-play" class="btn-secondary btn-compact" aria-label="${esc(t("lathe.play"))}">▶</button><input id="lt-pos" type="range" min="0" max="1" step="1" style="flex:1;min-width:0;"><small id="lt-state" style="width:210px;text-align:right;color:var(--text-muted);"></small></div>
          <div class="dlg-hint" id="lt-msg" style="white-space:pre-line;"></div>
          <div class="c3d-sec">${esc(t("lathe.ops"))}</div>
          <div id="lt-ops" style="display:flex;flex-direction:column;gap:4px;"></div>
          <button id="lt-addgroove" class="btn-secondary btn-compact" style="margin-top:4px;">＋ ${esc(t("lathe.op.groove"))}</button>
          <details style="margin-top:8px;"><summary class="c3d-sec" style="cursor:pointer;">${esc(t("lathe.tools"))}</summary>
            <div class="dlg-hint">${esc(t("lathe.toolsHint"))}</div>
            <div id="lt-tools" style="display:flex;flex-direction:column;gap:4px;"></div>
            <div style="display:flex;gap:6px;margin-top:4px;">${(["turn", "groove", "drill"] as const).map(k => `<button class="btn-secondary btn-compact lt-addtool" data-k="${k}">＋ ${esc(t("lathe.type." + k))}</button>`).join("")}</div>
          </details>
        </div>
      </div>
      <div class="dlg-buttons">
        <button id="lt-close" class="btn-secondary">${esc(t("dlg.close"))}</button>
        <button id="lt-save" class="btn-secondary" style="margin-left:auto;">💾 ${esc(t("c3d.save"))}</button>
        <button id="lt-load" class="btn-primary">${esc(t("c3d.load"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#lt-" + id) as E;
  let plan: LathePlan = planFromDesign(state.shapes), fresh = true;
  let pos = 0, playing = 0;
  const total = () => plan.runs.reduce((n, r) => n + r.moves.length, 0);

  // ---------------- Material nach den ersten n Fahrten ----------------
  let cache: { n: number; S: Float64Array; drill: { d: number; z: number }; tip: { z: number; r: number; tool: LatheTool } | null; op: number } | null = null;
  const stateAt = (n: number) => {
    if (!cache || cache.n > n) cache = { n: 0, S: plan.stock.slice(), drill: { d: 0, z: 0 }, tip: null, op: -1 };
    const c = cache;
    let k = 0;
    for (const run of plan.runs) {
      const sh = shapeOf(run.tool), dz = refDz(run.tool);
      let pz = j.faceAllow + j.safeZ, pr = j.stockD / 2 + j.safeX;
      for (const m of run.moves) {
        if (k >= n) return c;
        if (k >= c.n) {
          if (!m.rapid) { if (run.tool.type === "drill") c.drill = { d: run.tool.dia, z: Math.min(c.drill.z, m.z) }; else sweep(c.S, plan.grid, sh, pz - dz, pr, m.z - dz, m.r); }
          c.tip = { z: m.z, r: m.r, tool: run.tool }; c.op = j.ops.indexOf(run.op); c.n = k + 1;
        }
        pz = m.z; pr = m.r; k++;
      }
    }
    return c;
  };

  const draw = () => {
    const cv = $<HTMLCanvasElement>("cv"), ctx = cv.getContext("2d")!, R = j.stockD / 2, zL = -j.stickOut - 14, zR = j.faceAllow + j.safeZ + 4;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const k = Math.min((cv.width - 30) / (zR - zL), (cv.height - 20) / (2 * (R + j.safeX + 4))), X = (z: number) => 15 + (z - zL) * k + Math.max(0, cv.width - 30 - (zR - zL) * k) / 2, Y = (r: number) => cv.height / 2 - r * k;
    // Futter
    ctx.fillStyle = "#4a4a55"; ctx.fillRect(X(zL), Y(R + 8), X(-j.stickOut) - X(zL), (2 * R + 16) * k);
    ctx.fillStyle = "rgba(255,80,80,0.12)"; ctx.fillRect(X(-j.stickOut), Y(R + j.safeX), j.margin * k, 2 * (R + j.safeX) * k);
    const c = stateAt(pos), g = plan.grid, S = c.S;
    const area = (arr: Float64Array, fill: string) => {
      ctx.fillStyle = fill; ctx.beginPath();
      let on = false;
      const step = Math.max(1, Math.floor(0.4 / k / g.h));
      const seg: [number, number][] = [];
      const flush = () => { if (seg.length > 1) { ctx.moveTo(X(seg[0][0]), Y(0)); for (const [z, r] of seg) ctx.lineTo(X(z), Y(r)); ctx.lineTo(X(seg[seg.length - 1][0]), Y(0)); for (let q = seg.length - 1; q >= 0; q--) ctx.lineTo(X(seg[q][0]), Y(-seg[q][1])); ctx.closePath(); } seg.length = 0; };
      for (let i = 0; i < g.n; i += step) { let m = -1; for (let q = i; q < Math.min(g.n, i + step); q++) if (arr[q] > m) m = arr[q]; if (m > 0.005) { on = true; seg.push([g.z0 + i * g.h, m]); } else if (on) { flush(); on = false; } }
      flush(); ctx.fill();
    };
    area(S, "#8f9bb0");
    // Kontur und was noch darüber steht
    ctx.strokeStyle = "#34d17b"; ctx.lineWidth = 2; ctx.beginPath();
    for (const sg of [1, -1]) { let on = false; for (let i = 0; i < g.n; i++) { const z = g.z0 + i * g.h; if (z < -plan.partLen - 1e-6 || plan.profile[i] < 0) { on = false; continue; } if (on) ctx.lineTo(X(z), Y(sg * plan.profile[i])); else ctx.moveTo(X(z), Y(sg * plan.profile[i])); on = true; } }
    ctx.stroke();
    if (c.drill.d) { ctx.fillStyle = "#16161c"; ctx.fillRect(X(c.drill.z), Y(c.drill.d / 2), X(j.faceAllow) - X(c.drill.z), c.drill.d * k); }
    // Bahnen
    let n = 0;
    for (const run of plan.runs) { let a = { z: j.faceAllow + j.safeZ, r: R + j.safeX }; for (const m of run.moves) { if (n++ >= pos && pos > 0) break; ctx.strokeStyle = m.rapid ? "rgba(255,170,60,0.35)" : "rgba(54,179,255,0.75)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(a.z), Y(a.r)); ctx.lineTo(X(m.z), Y(m.r)); ctx.stroke(); a = { z: m.z, r: m.r }; } }
    ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.setLineDash([12, 5, 3, 5]); ctx.beginPath(); ctx.moveTo(X(zL), Y(0)); ctx.lineTo(X(zR), Y(0)); ctx.stroke(); ctx.setLineDash([]);
    if (j.tailOn) { ctx.fillStyle = "rgba(255,80,80,0.5)"; ctx.fillRect(X(j.tailZ), Y(j.tailD / 2), Math.max(8, X(zR) - X(j.tailZ)), j.tailD * k); }
    if (c.tip && pos < total()) {
      ctx.fillStyle = "#ffd23c"; ctx.beginPath(); const tz = c.tip.z, tr = c.tip.r, tl = c.tip.tool, w = tl.type === "groove" ? tl.width : tl.type === "drill" ? tl.dia : Math.max(1.5, tl.nose * 2);
      if (tl.type === "drill") { ctx.rect(X(tz), Y(w / 2), 14 * k, w * k); }
      else if (tl.type === "groove") ctx.rect(X(tz), Y(tr) - 12 * k, w * k, 12 * k);
      else { const d = tl.hand === "L" ? -1 : 1; ctx.moveTo(X(tz), Y(tr)); ctx.lineTo(X(tz), Y(tr) - 8 * k); ctx.lineTo(X(tz + d * 7), Y(tr) - 8 * k); ctx.lineTo(X(tz + d * w), Y(tr)); }
      ctx.fill();
    }
    $<HTMLElement>("state").textContent = c.op >= 0 && pos < total() ? t("lathe.op." + j.ops[c.op].kind) : t("lathe.time", { m: Math.max(1, Math.round(plan.seconds / 60)) });
  };

  const refresh = () => {
    plan = planFromDesign(state.shapes); cache = null; fresh = true;
    const m = issueTexts(plan), n = total();
    const ops = j.ops.filter(o => o.on && o.kind === "rough").map(o => latheTools.find(x => x.id === o.tool)).filter(x => x) as LatheTool[];
    const kc = LATHE_MATERIALS.find(x => x.id === s.material)?.kc ?? 2000;
    for (const x of ops) { const p = powerW(j.vc * x.vcPct / 100, x.ap, x.feed, kc); if (p > s.watt * 0.6) m.soft.push(t("lathe.power", { p: Math.round(p), w: s.watt })); }
    $<HTMLElement>("msg").textContent = [...m.hard.map(x => "⛔ " + x), ...m.soft.map(x => "⚠ " + x)].join("\n");
    $<HTMLElement>("msg").style.color = m.hard.length ? "var(--lt-red, #ff6b6b)" : "var(--lt-amber, #ffb454)";
    const ok = !m.hard.length && plan.runs.length > 0;
    $<HTMLButtonElement>("load").disabled = !ok; $<HTMLButtonElement>("save").disabled = !ok;
    $("pos").max = String(Math.max(1, n)); pos = n; $("pos").value = String(n);
    $<HTMLElement>("tailbox").style.display = j.tailOn ? "" : "none";
    draw();
  };
  let timer = 0;
  const later = () => { fresh = false; $<HTMLButtonElement>("load").disabled = true; $<HTMLButtonElement>("save").disabled = true; saveLathe(); clearTimeout(timer); timer = window.setTimeout(() => { if (ov.isConnected) refresh(); }, 200); };

  // ---------------- Bearbeitungen ----------------
  const cell = (label: string, val: number, set: (v: number) => void, lo: number, hi: number, step = "0.1", w = 62) => {
    const l = document.createElement("label"); l.style.cssText = "display:flex;gap:4px;align-items:center;font-size:0.74rem;color:var(--text-muted);";
    const i = document.createElement("input"); i.type = "number"; i.step = step; i.className = "prop-input"; i.style.width = w + "px"; i.value = String(val);
    i.addEventListener("input", () => { const v = parseFloat(i.value); if (Number.isFinite(v) && v >= lo && v <= hi) { set(v); later(); } });
    l.append(label, i); return l;
  };
  const drawOps = () => {
    const box = $<HTMLElement>("ops"); box.textContent = "";
    j.ops.forEach((o, i) => {
      const r = document.createElement("div"); r.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
      const l = document.createElement("label"); l.style.cssText = "display:flex;gap:6px;align-items:center;width:150px;cursor:pointer;";
      const c = document.createElement("input"); c.type = "checkbox"; c.checked = o.on; c.onchange = () => { o.on = c.checked; later(); };
      l.append(c, t("lathe.op." + o.kind));
      const se = document.createElement("select"); se.className = "prop-input"; se.style.width = "170px"; se.setAttribute("aria-label", t("lathe.tools"));
      for (const x of latheTools.filter(x => x.type === WANT[o.kind])) { const op = document.createElement("option"); op.value = x.id; op.textContent = `T${x.num} ${x.name}`; op.selected = x.id === o.tool; se.append(op); }
      if (!latheTools.some(x => x.id === o.tool && x.type === WANT[o.kind]) && se.options.length) { o.tool = se.options[0].value; }
      se.onchange = () => { o.tool = se.value; drawOps(); later(); };
      r.append(l, se);
      const x = latheTools.find(q => q.id === o.tool);
      if (o.kind === "drill") r.append(cell(t("lathe.depth"), o.depth ?? 10, v => { o.depth = v; }, 0.1, 1000));
      if (o.kind === "groove") r.append(cell("Z", o.z ?? -10, v => { o.z = v; }, -3000, 0), cell(t("lathe.width"), o.width ?? 2, v => { o.width = v; }, 0.1, 500), cell("Ø", o.d ?? 10, v => { o.d = v; }, 0, 1000));
      if (o.kind === "part") r.append(cell(t("lathe.partD"), o.d ?? 0, v => { o.d = v; }, 0, 1000));
      const inf = document.createElement("small"); inf.style.color = "var(--text-muted)";
      if (x) inf.textContent = t("lathe.opInfo", { n: rpmFor(j.vc * x.vcPct / 100, o.kind === "drill" ? x.dia : j.stockD, j.maxRpm), f: x.feed, a: x.ap });
      r.append(inf);
      if (o.kind === "groove" && j.ops.filter(q => q.kind === "groove").length > 1) { const d = document.createElement("button"); d.type = "button"; d.className = "btn-secondary btn-compact"; d.textContent = "✕"; d.setAttribute("aria-label", t("lathe.remove")); d.onclick = () => { j.ops.splice(i, 1); drawOps(); later(); }; r.append(d); }
      box.append(r);
    });
  };
  // ---------------- Werkzeuge ----------------
  const drawTools = () => {
    const box = $<HTMLElement>("tools"); box.textContent = "";
    const list = latheTools;
    const keep = () => { setLatheTools(list); later(); };
    list.forEach((x, i) => {
      const r = document.createElement("div"); r.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border-color);padding-top:4px;";
      const nm = document.createElement("input"); nm.type = "text"; nm.className = "prop-input"; nm.style.width = "130px"; nm.value = x.name; nm.maxLength = 60; nm.setAttribute("aria-label", t("lathe.toolName")); nm.oninput = () => { x.name = nm.value; keep(); };
      const ty = document.createElement("small"); ty.style.width = "62px"; ty.textContent = t("lathe.type." + x.type);
      r.append(cell("T", x.num, v => { x.num = Math.round(v); keep(); }, 0, 999, "1", 44), nm, ty);
      if (x.type === "turn") {
        const h = document.createElement("select"); h.className = "prop-input"; h.style.width = "96px"; h.setAttribute("aria-label", t("lathe.hand"));
        for (const k of ["R", "L", "N"] as const) { const op = document.createElement("option"); op.value = k; op.textContent = t("lathe.hand." + k); op.selected = x.hand === k; h.append(op); }
        h.onchange = () => { x.hand = h.value as any; keep(); };
        r.append(h, cell("R", x.nose, v => { x.nose = v; keep(); }, 0, 10, "0.1", 48), cell(t("lathe.kappa"), x.kappa, v => { x.kappa = v; keep(); }, 30, 117, "1", 52), cell(t("lathe.eps"), x.eps, v => { x.eps = v; keep(); }, 10, 120, "1", 52));
      }
      if (x.type === "groove") r.append(cell(t("lathe.width"), x.width, v => { x.width = v; keep(); }, 0.3, 20));
      if (x.type === "drill") r.append(cell("Ø", x.dia, v => { x.dia = v; keep(); }, 0.3, 100));
      r.append(cell("ap", x.ap, v => { x.ap = v; keep(); }, 0.01, 20, "0.05", 54), cell(t("lathe.feedRev"), x.feed, v => { x.feed = v; keep(); }, 0.001, 2, "0.01", 58), cell("vc %", x.vcPct, v => { x.vcPct = v; keep(); }, 1, 500, "5", 54));
      if (list.length > 1) { const d = document.createElement("button"); d.type = "button"; d.className = "btn-secondary btn-compact"; d.textContent = "✕"; d.setAttribute("aria-label", t("lathe.remove")); d.onclick = () => { setLatheTools(list.filter((_, q) => q !== i)); drawTools(); drawOps(); later(); }; r.append(d); }
      box.append(r);
    });
  };
  ov.querySelectorAll<HTMLButtonElement>(".lt-addtool").forEach(b => b.onclick = () => {
    const k = b.dataset.k as LatheTool["type"], base = latheTools.find(x => x.type === k);
    let n = 1; while (latheTools.some(x => x.id === "l" + n)) n++;
    const num = Math.max(0, ...latheTools.map(x => x.num)) + 1;
    setLatheTools([...latheTools, { ...(base ?? { hand: "R" as const, nose: 0.4, kappa: 95, eps: 80, width: 2, dia: 5, ap: 0.5, feed: 0.05, vcPct: 50 }), id: "l" + n, num, type: k, name: t("lathe.type." + k) } as LatheTool]);
    drawTools(); drawOps(); later();
  });
  $<HTMLButtonElement>("addgroove").onclick = () => { const i = j.ops.findIndex(o => o.kind === "part"); j.ops.splice(i, 0, { ...j.ops.find(o => o.kind === "groove")!, on: true }); drawOps(); later(); };

  // ---------------- Felder ----------------
  const LIM: Record<string, [number, number]> = { stockD: [1, 1000], stickOut: [1, 3000], faceAllow: [0, 20], margin: [0.5, 50], tailD: [0, 500], tailZ: [-3000, 200], vc: [1, 1000], maxRpm: [10, 10000], safeX: [1, 100], safeZ: [1, 200], clear: [0.1, 5], allowX: [0, 3], allowZ: [0, 3] };
  for (const [k, [lo, hi]] of Object.entries(LIM)) {
    $(k).addEventListener("input", () => { const v = parseFloat($(k).value); $(k).classList.toggle("dlg-invalid", !(v >= lo && v <= hi)); if (v >= lo && v <= hi) { (j as any)[k] = v; later(); } });
    $(k).addEventListener("change", () => { $(k).value = String((j as any)[k]); $(k).classList.remove("dlg-invalid"); drawOps(); });
  }
  $("watt").addEventListener("input", () => { const v = parseFloat($("watt").value); if (v >= 10 && v <= 50000) { s.watt = v; later(); } });
  $("tailOn").addEventListener("change", () => { j.tailOn = $("tailOn").checked; later(); });
  const pick = (id: string, fn: (v: string) => void) => $<HTMLSelectElement>(id).addEventListener("change", () => { fn($<HTMLSelectElement>(id).value); later(); });
  pick("axis", v => { s.axis = v as any; }); pick("spindle", v => { s.out.spindle = v as any; }); pick("dir", v => { s.out.dir = v as any; });
  pick("xMode", v => { s.out.xMode = v as any; }); pick("xSign", v => { s.out.xSign = v === "-1" ? -1 : 1; });
  pick("material", v => { s.material = v; j.vc = LATHE_MATERIALS.find(x => x.id === v)!.vc; $("vc").value = String(j.vc); drawOps(); });

  const stop = () => { clearInterval(playing); playing = 0; $<HTMLButtonElement>("play").textContent = "▶"; };
  $("pos").addEventListener("input", () => { stop(); pos = parseInt($("pos").value) || 0; draw(); });
  $<HTMLButtonElement>("play").onclick = () => {
    if (playing) { stop(); return; }
    if (pos >= total()) pos = 0;
    $<HTMLButtonElement>("play").textContent = "⏸";
    const step = Math.max(1, Math.round(total() / 250));
    playing = window.setInterval(() => { if (!ov.isConnected) { clearInterval(playing); return; } pos = Math.min(total(), pos + step); $("pos").value = String(pos); draw(); if (pos >= total()) stop(); }, 60);
  };
  $<HTMLButtonElement>("load").onclick = () => { if (fresh && !plan.issues.some(i => i.hard) && loadGcodeFromText(gcodeFromPlan(plan), t("lathe.title"), log)) log(t("lathe.loaded")); };
  $<HTMLButtonElement>("save").onclick = async () => {
    if (!fresh || plan.issues.some(i => i.hard)) return;
    const text = gcodeFromPlan(plan);
    try { const p = await save({ title: t("rp.saveGcode"), defaultPath: "turning.gcode", filters: [{ name: t("stream.dlgFilter"), extensions: ["gcode", "nc", "ngc", "tap"] }] }); if (p) { await writeFile(p, new TextEncoder().encode(text)); log(t("gcw.saved", { p })); } }
    catch (e) { log(t("gcw.saveError", { e: String(e) })); }
  };
  const close = () => { stop(); clearTimeout(timer); setLatheSettings(latheSettings); ov.remove(); window.dispatchEvent(new Event("cnc-lathe-changed")); onClose?.(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  $<HTMLButtonElement>("close").onclick = close;
  drawOps(); drawTools(); refresh();
}
