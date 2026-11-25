/**
 * REITER „BIBLIOTHEK“ für die Drehbank: Drehmeißel, Stechstähle und Bohrer.
 * Aufbau wie die Plasma-Bibliothek: links die Liste, rechts der Editor mit Bild. Dieselben Werkzeuge wie im Dreh-Fenster.
 */
import { t } from "../i18n/i18n";
import { latheSettings, latheTools, setLatheTools } from "../lathe/latheJob";
import { LATHE_PRESETS, type LathePreset } from "../lathe/lathePresets";
import { rpmFor, type LatheTool } from "../lathe/turn";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const f2 = (v: number) => String(Math.round(v * 100) / 100);

/** Schneide am Teil: oben das Werkzeug, darunter das Material (Z waagerecht, Futter links) */
export function latheToolSvg(x: LatheTool, W = 260, H = 190): string {
  const px = W / 2, base = H - 52, py = x.type === "turn" ? base + 14 : base, n = (v: number) => v.toFixed(1);
  const part = `${x.hand === "N" ? "" : `<rect x="14" y="${base}" width="${px - 14}" height="15" fill="#8f9bb0"/>`}<rect x="14" y="${base + 14}" width="${W - 28}" height="${H - base - 28}" fill="#8f9bb0"/><path d="M14 ${H - 14} H${W - 14}" stroke="#fff6" stroke-dasharray="9 4 2 4"/>`;
  let tool = "";
  if (x.type === "drill") {
    const d = Math.max(8, Math.min(36, x.dia * 3));
    tool = `<rect x="14" y="${py}" width="${W - 90}" height="${H - py - 14}" fill="#8f9bb0"/><path d="M${px - 20} ${H - 14} l14 -${d / 2} H${W - 20} V${H - 14} z" fill="#ffd23c" stroke="#8a6d00"/><path d="M14 ${H - 14} H${W - 14}" stroke="#fff6" stroke-dasharray="9 4 2 4"/>`;
    return svg(W, H, tool);
  }
  if (x.type === "groove") {
    const w = Math.max(8, Math.min(50, x.width * 9));
    return svg(W, H, `<path d="M14 ${py} H${px - w / 2} V${py + 24} H${px + w / 2} V${py} H${W - 14} V${H - 14} H14 z" fill="#8f9bb0"/><rect x="${n(px - w / 2)}" y="24" width="${n(w)}" height="${py + 24 - 24}" fill="#ffd23c" stroke="#8a6d00"/><path d="M14 ${H - 14} H${W - 14}" stroke="#fff6" stroke-dasharray="9 4 2 4"/>`);
  }
  // Kanten ab der Spitze: Hauptschneide unter kappa, Nebenschneide eps weiter (bei L gespiegelt)
  const eps = Math.max(10, x.eps), k = x.hand === "N" ? (180 - eps) / 2 : x.kappa, m = x.hand === "L" ? -1 : 1, L = 74;
  const dir = (deg: number) => { const a = deg * Math.PI / 180; return { x: -Math.cos(a) * m, y: -Math.sin(a) }; };
  const a = dir(k), b = dir(k + eps), rn = Math.min(16, x.nose * 14), q = Math.min(L * 0.6, rn / Math.tan(eps * Math.PI / 360));
  const A = { x: px + a.x * L, y: py + a.y * L }, B = { x: px + b.x * L, y: py + b.y * L }, C = { x: A.x + b.x * L, y: A.y + b.y * L };
  const p = `M${n(A.x)} ${n(A.y)} L${n(px + a.x * q)} ${n(py + a.y * q)} ${rn > 0.5 ? `A${n(rn)} ${n(rn)} 0 0 ${m > 0 ? 0 : 1} ${n(px + b.x * q)} ${n(py + b.y * q)}` : ""} L${n(B.x)} ${n(B.y)} L${n(C.x)} ${n(C.y)} z`;
  const cx = (A.x + B.x) / 2, cy = (A.y + B.y) / 2;
  tool = `<path d="${p}" fill="#ffd23c" stroke="#8a6d00" stroke-linejoin="round"/><circle cx="${n(cx)}" cy="${n(cy)}" r="7" fill="#121218" stroke="#8a6d00"/>`;
  return svg(W, H, (m > 0 ? part : `<g transform="translate(${W} 0) scale(-1 1)">${part}</g>`) + tool);
}
const svg = (W: number, H: number, inner: string) => `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:100%" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" fill="#121218" stroke="rgba(255,255,255,0.08)"/>${inner}</svg>`;

const info = (x: LatheTool) => [t("lathe.type." + x.type), x.type === "turn" ? `${t("lathe.hand." + x.hand)} · κ ${f2(x.kappa)}° ε ${f2(x.eps)}° R ${f2(x.nose)}` : x.type === "groove" ? `${f2(x.width)} mm` : `Ø ${f2(x.dia)} mm`].join(" · ");

let sel: string | null = null;
export function initLatheLibPage() {
  window.addEventListener("cnc-lathe-tools", () => { if (!document.getElementById("lathe-lib-page")?.contains(document.activeElement)) renderLatheLibPage(); });
  renderLatheLibPage();
}
export const rebuildLatheLibPage = () => renderLatheLibPage();

const nextId = () => { let n = 1; while (latheTools.some(x => x.id === "l" + n)) n++; return "l" + n; };
const nextNum = () => Math.min(999, Math.max(0, ...latheTools.map(x => x.num)) + 1);
export function addLatheTool(tool: Omit<LatheTool, "id" | "num">): string {
  const id = nextId();
  setLatheTools([...latheTools, { ...tool, id, num: nextNum() }]);
  return id;
}

export function renderLatheLibPage() {
  const page = document.getElementById("lathe-lib-page");
  if (!page) return;
  if (!sel || !latheTools.some(x => x.id === sel)) sel = latheTools[0]?.id ?? null;
  page.innerHTML = `
    <div class="tlp" data-unit-scope="none">
      <div class="tlp-left">
        <div class="tlp-head" style="flex-wrap:wrap;">${(["turn", "groove", "drill"] as const).map(k => `<button class="btn-primary btn-compact" data-new="${k}">＋ ${esc(t("lathe.type." + k))}</button>`).join("")}</div>
        <button id="ltl-pre" class="btn-secondary" style="width:100%;margin:4px 0;" data-tip="${esc(t("latlib.preTip"))}">📋 ${esc(t("latlib.pre"))}</button>
        <div id="ltl-list" class="tlp-list"></div>
      </div>
      <div class="tlp-right"><div id="ltl-edit"></div></div>
    </div>`;
  const list = page.querySelector<HTMLElement>("#ltl-list")!;
  list.innerHTML = latheTools.map(x => `
    <div class="tlp-item${x.id === sel ? " sel" : ""}" data-id="${esc(x.id)}"><div class="tlp-ico"><b>T${x.num}</b></div>
      <div class="tlp-txt"><div class="tlp-name">${esc(x.name || t("lathe.type." + x.type))}</div><div class="tlp-info">${esc(info(x))}</div></div></div>`).join("");
  list.addEventListener("click", e => { const it = (e.target as HTMLElement).closest<HTMLElement>(".tlp-item[data-id]"); if (it) { sel = it.dataset.id!; renderLatheLibPage(); } });
  page.querySelectorAll<HTMLButtonElement>("[data-new]").forEach(b => b.onclick = () => {
    const k = b.dataset.new as LatheTool["type"], base = LATHE_PRESETS.find(p => p.tool.type === k)!.tool;
    sel = addLatheTool({ ...base, name: t("lathe.type." + k) });
    renderLatheLibPage();
  });
  page.querySelector<HTMLButtonElement>("#ltl-pre")!.onclick = () => openPresets();
  const x = latheTools.find(q => q.id === sel);
  if (x) edit(page.querySelector<HTMLElement>("#ltl-edit")!, x);
}

function edit(root: HTMLElement, src: LatheTool) {
  const x = { ...src };
  const row = (k: keyof LatheTool, label: string, unit: string, step: string, lo: number, hi: number, tip = "") => `
    <label class="te-row"${tip ? ` data-tip="${esc(t(tip))}"` : ""}><span>${esc(t(label))}</span><span class="dlg-num"><input type="number" data-k="${k}" data-lo="${lo}" data-hi="${hi}" step="${step}" value="${x[k]}"><em>${unit}</em></span></label>`;
  const ap = x.type === "turn" ? "latlib.ap" : "latlib.step";
  root.innerHTML = `
    <div class="tlp-edit-head"><h3>🔩 T${x.num} ${esc(x.name)}</h3></div>
    <div class="te">
      <label class="te-row te-name"><span>${esc(t("lathe.toolName"))}</span><input id="ltl-name" type="text" maxlength="60" value="${esc(x.name)}"></label>
      <div class="te-main">
        <div class="te-preview"><div id="ltl-svg"></div><div class="te-end-label" id="ltl-info"></div></div>
        <div class="te-fields">
          <fieldset><legend>${esc(t("latlib.shape"))}</legend>
            ${row("num", "latlib.num", "", "1", 0, 999)}
            ${x.type === "turn" ? `<label class="te-row"><span>${esc(t("lathe.hand"))}</span><select id="ltl-hand">${(["R", "L", "N"] as const).map(h => `<option value="${h}"${h === x.hand ? " selected" : ""}>${esc(t("lathe.hand." + h))}</option>`).join("")}</select></label>
            ${row("nose", "latlib.nose", "mm", "0.1", 0, 10)}${row("kappa", "latlib.kappa", "°", "0.5", 30, 117, "latlib.kappaTip")}${row("eps", "latlib.eps", "°", "1", 10, 120, "latlib.epsTip")}` : ""}
            ${x.type === "groove" ? row("width", "lathe.width", "mm", "0.1", 0.3, 20) : ""}${x.type === "drill" ? row("dia", "lathe.stockD", "mm", "0.1", 0.3, 100) : ""}
          </fieldset>
          <fieldset><legend>${esc(t("latlib.cut"))}</legend>
            ${row("ap", ap, "mm", "0.05", 0.01, 20)}${row("feed", "latlib.feed", esc(t("lathe.feedRev")), "0.01", 0.001, 2)}${row("vcPct", "latlib.vc", "%", "5", 1, 500, "latlib.vcTip")}
          </fieldset>
        </div>
      </div>
      <div class="dlg-hint">${esc(t("latlib.hint"))}</div>
      <div class="dlg-buttons">
        ${latheTools.length > 1 ? `<button id="ltl-del" class="btn-secondary dlg-danger" aria-label="${esc(t("lathe.remove"))}">🗑</button>` : ""}
        <button id="ltl-dup" class="btn-secondary" style="flex:1;">⧉ ${esc(t("latlib.dup"))}</button>
        <button id="ltl-ok" class="btn-primary" style="flex:2;">✔ ${esc(t("tool.save"))}</button>
      </div>
    </div>`;
  const show = () => {
    root.querySelector("#ltl-svg")!.innerHTML = latheToolSvg(x);
    const j = latheSettings.job, vc = j.vc * x.vcPct / 100, d = x.type === "drill" ? x.dia : j.stockD;
    root.querySelector("#ltl-info")!.textContent = t("latlib.calc", { d: f2(d), n: rpmFor(vc, d, j.maxRpm), f: Math.round(x.feed * rpmFor(vc, d, j.maxRpm)) });
  };
  root.querySelectorAll<HTMLInputElement>("input[data-k]").forEach(i => i.addEventListener("input", () => {
    const v = parseFloat(i.value), ok = Number.isFinite(v) && v >= +i.dataset.lo! && v <= +i.dataset.hi!;
    i.classList.toggle("dlg-invalid", !ok);
    if (ok) { (x as any)[i.dataset.k!] = i.dataset.k === "num" ? Math.round(v) : v; show(); }
  }));
  root.querySelector<HTMLSelectElement>("#ltl-hand")?.addEventListener("change", e => { x.hand = (e.target as HTMLSelectElement).value as any; show(); });
  root.querySelector<HTMLInputElement>("#ltl-name")!.addEventListener("input", e => { x.name = (e.target as HTMLInputElement).value; });
  root.querySelector<HTMLButtonElement>("#ltl-ok")!.onclick = () => {
    const badEl = root.querySelector<HTMLInputElement>(".dlg-invalid");
    if (badEl) { badEl.focus(); return; }
    setLatheTools(latheTools.map(q => (q.id === src.id ? x : q)));
    renderLatheLibPage();
  };
  root.querySelector<HTMLButtonElement>("#ltl-dup")!.onclick = () => { const { id: _i, num: _n, ...rest } = src; sel = addLatheTool(rest); renderLatheLibPage(); };
  const del = root.querySelector<HTMLButtonElement>("#ltl-del");
  if (del) del.onclick = () => { if (!window.confirm(t("laser.confirmDelete", { name: src.name }))) return; setLatheTools(latheTools.filter(q => q.id !== src.id)); sel = null; renderLatheLibPage(); };
  show();
}

/** gängige Werkzeuge zum Übernehmen */
function openPresets() {
  document.getElementById("lathe-pre")?.remove();
  const ov = document.createElement("div");
  ov.id = "lathe-pre"; ov.className = "dlg-overlay";
  const groups = [...new Set(LATHE_PRESETS.map(p => p.group))];
  ov.innerHTML = `<div class="dlg-box" role="dialog" style="width:min(720px, calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;">
    <h3>📋 ${esc(t("latlib.pre"))}</h3><div class="dlg-hint">${esc(t("latlib.preHint"))}</div>
    ${groups.map(g => `<div class="c3d-sec">${esc(t("latlib.g." + g))}</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:5px;">${LATHE_PRESETS.map((p, i) => (p.group === g ? `<button class="btn-secondary btn-compact" data-i="${i}" style="text-align:left;">＋ ${esc(p.name)}</button>` : "")).join("")}</div>`).join("")}
    <div class="dlg-buttons"><button id="lathe-pre-close" class="btn-primary" style="margin-left:auto;">${esc(t("dlg.close"))}</button></div></div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); renderLatheLibPage(); };
  ov.querySelectorAll<HTMLButtonElement>("[data-i]").forEach(b => b.onclick = () => {
    const p: LathePreset = LATHE_PRESETS[+b.dataset.i!];
    sel = addLatheTool({ ...p.tool, name: p.name });
    b.textContent = "✓ " + p.name; b.disabled = true;
  });
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  ov.querySelector<HTMLButtonElement>("#lathe-pre-close")!.onclick = close;
}
