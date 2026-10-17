/**
 * KAMERA AUSRICHTEN – Assistent in 3 Schritten (wie „Camera Alignment“ in LightBurn)
 *
 *  1. Linse: Weitwinkel-Webcams biegen gerade Linien (Tonne). Mit dem Regler so lange einstellen,
 *     bis Bettkanten/Profile im Bild gerade sind (Hilfslinien einblendbar).
 *  2. Punkte: 4 bekannte Punkte im Bild anklicken.
 *       a) Laser: brennt 4 kleine Kreuze mit wenig Leistung an festen Stellen (15 % vom Rand) –
 *          danach „Neues Bild“ und die Kreuzmitten anklicken (genaueste Methode)
 *       b) Eigene Punkte: z. B. die 4 Bettecken oder mit Stift markierte Punkte – Koordinaten eintragen
 *     Punkte lassen sich nachträglich verschieben; eine Lupe hilft beim genauen Treffen.
 *  3. Prüfen: das entzerrte Bild mit 50-mm-Raster und den Sollpunkten – passt es, speichern.
 *
 * Mathematik: cameraMath.ts, Entzerren: cameraWarp.ts
 */
import { t } from "../i18n/i18n";
import { homography, toNorm, fromNorm, goodQuad, markPositions, markGcode, applyH } from "./cameraMath";
import { Warper } from "./cameraWarp";
import type { CamCalib, Frame } from "./camera";
import { machine } from "../machine";
import { getMachineMode } from "../machineMode";
import { laserSettings } from "../laserLayers";
import { loadGcodeFromText, startStreaming, streamState } from "../machineStream";

export interface AlignOptions {
  grab: () => Promise<Frame | null>;
  hasSource: () => boolean;
  k1: number;
  rot180: boolean;
  mirror: boolean;
  bed: { w: number; h: number };
  calib: CamCalib | null;
  log: (s: string) => void;
  onSave: (c: CamCalib) => void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const KEY_MARK = "cnc_craft_camera_marks";

export function openAlignWizard(o: AlignOptions) {
  document.getElementById("cam-wiz")?.remove();
  const warper = new Warper();
  let frame: Frame | null = null;
  let step = 1;
  let k1 = o.k1;
  let grid = true;
  let method: "laser" | "manual" = getMachineMode() === "laser" ? "laser" : "manual";
  let mark = { power: 8, speed: 1500, size: 10 };
  try { mark = { ...mark, ...JSON.parse(localStorage.getItem(KEY_MARK) || "{}") }; } catch { /* Standard */ }
  const laserPts = markPositions(o.bed.w, o.bed.h);
  let manualPts: [number, number][] = [[0, 0], [o.bed.w, 0], [o.bed.w, o.bed.h], [0, o.bed.h]];
  // bei vorhandener Ausrichtung: Punkte und Methode übernehmen
  let clicks: ([number, number] | null)[] = [null, null, null, null]; // normiert, unverzerrt
  if (o.calib && o.calib.pts.length === 4) {
    const same = o.calib.pts.every((p, i) => p.x === laserPts[i][0] && p.y === laserPts[i][1]);
    if (!same) { method = "manual"; manualPts = o.calib.pts.map(p => [p.x, p.y]); }
    clicks = o.calib.pts.map(p => [p.nx, p.ny]);
  }
  const bedPts = () => (method === "laser" ? laserPts : manualPts);
  const cornerName = (i: number) => t("camw.corner." + i);

  const ov = document.createElement("div");
  ov.id = "cam-wiz";
  ov.className = "dlg-overlay cam-wiz";
  ov.innerHTML = `
    <div class="cam-wiz-box" role="dialog">
      <div class="cam-wiz-view">
        <canvas id="cw-canvas"></canvas>
        <canvas id="cw-loupe" class="cw-loupe"></canvas>
        <div class="cw-empty" id="cw-empty"></div>
      </div>
      <div class="cam-wiz-side">
        <h3>🎯 ${esc(t("camw.title"))}</h3>
        <div class="cw-steps">
          <span data-s="1">1 · ${esc(t("camw.s1"))}</span><span data-s="2">2 · ${esc(t("camw.s2"))}</span><span data-s="3">3 · ${esc(t("camw.s3"))}</span>
        </div>
        <div id="cw-body" class="cw-body"></div>
        <div class="dlg-buttons">
          <button id="cw-cancel" class="btn-secondary">${esc(t("dlg.cancel"))}</button>
          <button id="cw-back" class="btn-secondary">← ${esc(t("camw.back"))}</button>
          <button id="cw-next" class="btn-primary" style="flex:1;"></button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const q = <T extends HTMLElement = HTMLElement>(id: string) => ov.querySelector("#" + id) as T;
  const canvas = q<HTMLCanvasElement>("cw-canvas");
  const loupe = q<HTMLCanvasElement>("cw-loupe");
  const g = canvas.getContext("2d")!;
  const close = () => { ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  q("cw-cancel").onclick = close;

  // ---------- Bild ----------
  const fitCanvas = () => {
    const box = canvas.parentElement!.getBoundingClientRect();
    if (!frame) { canvas.width = 10; canvas.height = 10; return; }
    const ar = step === 3 ? o.bed.w / o.bed.h : frame.w / frame.h;
    let w = box.width - 16, h = w / ar;
    if (h > box.height - 16) { h = box.height - 16; w = h * ar; }
    canvas.width = Math.max(10, Math.round(w)); canvas.height = Math.max(10, Math.round(h));
  };

  const draw = () => {
    fitCanvas();
    const empty = q("cw-empty");
    if (!frame) {
      g.clearRect(0, 0, canvas.width, canvas.height);
      empty.style.display = "";
      empty.textContent = o.hasSource() ? t("camw.noImage") : t("camw.noSource");
      return;
    }
    empty.style.display = "none";
    const W = canvas.width, Hh = canvas.height;
    g.clearRect(0, 0, W, Hh);
    if (step < 3) {
      const outW = Math.min(1600, frame.w), outH = Math.round(outW * frame.h / frame.w);
      warper.render(frame.src, frame.w, frame.h, { mode: "lens", k1, rot180: o.rot180, mirror: o.mirror, outW, outH });
      g.drawImage(warper.canvas, 0, 0, W, Hh);
      if (step === 1 && grid) {
        g.strokeStyle = "rgba(0, 220, 255, 0.55)"; g.lineWidth = 1;
        g.beginPath();
        for (let i = 1; i < 8; i++) { const x = Math.round(W * i / 8) + 0.5; g.moveTo(x, 0); g.lineTo(x, Hh); }
        for (let i = 1; i < 6; i++) { const y = Math.round(Hh * i / 6) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
        g.stroke();
      }
      if (step === 2) {
        const ar = frame.w / frame.h;
        clicks.forEach((c, i) => {
          if (!c) return;
          const [u, v] = fromNorm(c[0], c[1], ar);
          drawMarker(u * W, v * Hh, i + 1, i === nextIndex());
        });
      }
    } else {
      const H = currentH();
      if (!H) return;
      const long = 1400;
      const outW = o.bed.w >= o.bed.h ? long : Math.round(long * o.bed.w / o.bed.h);
      const outH = o.bed.w >= o.bed.h ? Math.round(long * o.bed.h / o.bed.w) : long;
      warper.render(frame.src, frame.w, frame.h, { mode: "bed", k1, rot180: o.rot180, mirror: o.mirror, H, bedW: o.bed.w, bedH: o.bed.h, outW, outH });
      g.fillStyle = "#16161c"; g.fillRect(0, 0, W, Hh);
      g.drawImage(warper.canvas, 0, 0, W, Hh);
      // 50-mm-Raster + Sollpunkte
      const sx = (x: number) => x / o.bed.w * W, sy = (y: number) => Hh - y / o.bed.h * Hh;
      g.strokeStyle = "rgba(0, 220, 255, 0.45)"; g.lineWidth = 1; g.beginPath();
      for (let x = 50; x < o.bed.w; x += 50) { g.moveTo(sx(x) + 0.5, 0); g.lineTo(sx(x) + 0.5, Hh); }
      for (let y = 50; y < o.bed.h; y += 50) { g.moveTo(0, sy(y) + 0.5); g.lineTo(W, sy(y) + 0.5); }
      g.stroke();
      g.strokeStyle = "#ff4d4d"; g.lineWidth = 2; g.strokeRect(1, 1, W - 2, Hh - 2);
      bedPts().forEach(([x, y], i) => drawMarker(sx(x), sy(y), i + 1, false, "#34d17b"));
    }
  };

  const drawMarker = (x: number, y: number, n: number, active: boolean, color = "#ffb547") => {
    g.save();
    g.strokeStyle = "rgba(0,0,0,0.7)"; g.lineWidth = 4;
    g.beginPath(); g.moveTo(x - 14, y); g.lineTo(x + 14, y); g.moveTo(x, y - 14); g.lineTo(x, y + 14); g.stroke();
    g.strokeStyle = active ? "#ffffff" : color; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x - 14, y); g.lineTo(x + 14, y); g.moveTo(x, y - 14); g.lineTo(x, y + 14); g.stroke();
    g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.stroke();
    g.font = "bold 13px sans-serif"; g.fillStyle = "#000"; g.fillText(String(n), x + 12, y - 9);
    g.fillStyle = active ? "#fff" : color; g.fillText(String(n), x + 11, y - 10);
    g.restore();
  };

  const nextIndex = () => clicks.findIndex(c => !c);
  const currentH = () => {
    if (clicks.some(c => !c)) return null;
    return homography(bedPts(), clicks as [number, number][]);
  };

  const grab = async () => {
    q("cw-empty").style.display = "";
    q("cw-empty").textContent = t("camw.loading");
    frame = await o.grab();
    draw();
  };

  // ---------- Klicken / Ziehen der Punkte (Schritt 2) ----------
  let dragging = -1;
  const toImage = (ev: PointerEvent): [number, number] | null => {
    if (!frame) return null;
    const r = canvas.getBoundingClientRect();
    const u = (ev.clientX - r.left) / r.width, v = (ev.clientY - r.top) / r.height;
    if (u < 0 || v < 0 || u > 1 || v > 1) return null;
    return [u, v];
  };
  const hit = (u: number, v: number) => {
    if (!frame) return -1;
    const ar = frame.w / frame.h;
    const r = canvas.getBoundingClientRect();
    let best = -1, bd = 16;
    clicks.forEach((c, i) => {
      if (!c) return;
      const [cu, cv] = fromNorm(c[0], c[1], ar);
      const d = Math.hypot((cu - u) * r.width, (cv - v) * r.height);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const setPoint = (i: number, u: number, v: number) => {
    if (!frame) return;
    clicks[i] = toNorm(u, v, frame.w / frame.h);
  };
  canvas.addEventListener("pointerdown", (ev) => {
    if (step !== 2 || !frame) return;
    const p = toImage(ev);
    if (!p) return;
    const h = hit(p[0], p[1]);
    if (h >= 0) dragging = h;
    else {
      const n = nextIndex();
      if (n < 0) return;
      setPoint(n, p[0], p[1]);
      dragging = n;
    }
    canvas.setPointerCapture(ev.pointerId);
    draw(); renderBody();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (step !== 2 || !frame) { loupe.style.display = "none"; return; }
    const p = toImage(ev);
    if (!p) { loupe.style.display = "none"; return; }
    if (dragging >= 0) { setPoint(dragging, p[0], p[1]); draw(); }
    showLoupe(ev);
  });
  canvas.addEventListener("pointerup", () => { if (dragging >= 0) { dragging = -1; renderBody(); } });
  canvas.addEventListener("pointerleave", () => { loupe.style.display = "none"; });

  /** Lupe: 4-fach vergrößert um den Mauszeiger */
  const showLoupe = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const size = 140, zoom = 4;
    loupe.width = size; loupe.height = size;
    const lg = loupe.getContext("2d")!;
    const cx = (ev.clientX - r.left) * canvas.width / r.width, cy = (ev.clientY - r.top) * canvas.height / r.height;
    lg.imageSmoothingEnabled = false;
    lg.fillStyle = "#000"; lg.fillRect(0, 0, size, size);
    lg.drawImage(canvas, cx - size / zoom / 2, cy - size / zoom / 2, size / zoom, size / zoom, 0, 0, size, size);
    lg.strokeStyle = "#fff"; lg.lineWidth = 1;
    lg.beginPath(); lg.moveTo(size / 2, 0); lg.lineTo(size / 2, size); lg.moveTo(0, size / 2); lg.lineTo(size, size / 2); lg.stroke();
    const host = canvas.parentElement!.getBoundingClientRect();
    let lx = ev.clientX - host.left + 24, ly = ev.clientY - host.top - size - 12;
    if (lx + size > host.width) lx = ev.clientX - host.left - size - 24;
    if (ly < 0) ly = ev.clientY - host.top + 24;
    loupe.style.left = lx + "px"; loupe.style.top = ly + "px"; loupe.style.display = "block";
  };

  // ---------- Seitenleiste ----------
  const renderBody = () => {
    ov.querySelectorAll<HTMLElement>(".cw-steps span").forEach(s => s.classList.toggle("on", +s.dataset.s! === step));
    const body = q("cw-body");
    const back = q<HTMLButtonElement>("cw-back"), next = q<HTMLButtonElement>("cw-next");
    back.style.display = step > 1 ? "" : "none";
    if (step === 1) {
      body.innerHTML = `
        <p>${esc(t("camw.s1Text"))}</p>
        <label class="cw-row"><span>${esc(t("camw.k1"))}</span><input id="cw-k1" type="range" min="-0.6" max="0.4" step="0.005" value="${k1}"><b id="cw-k1v">${k1.toFixed(3)}</b></label>
        <div class="cw-inline">
          <button id="cw-k1-0" class="btn-secondary">${esc(t("camw.k1Reset"))}</button>
          <label class="cw-check"><input id="cw-grid" type="checkbox" ${grid ? "checked" : ""}> ${esc(t("camw.grid"))}</label>
        </div>
        <button id="cw-grab" class="btn-secondary">📷 ${esc(t("camw.newImage"))}</button>
        <p class="cw-hint">${esc(t("camw.s1Hint"))}</p>`;
      const r = q<HTMLInputElement>("cw-k1");
      r.addEventListener("input", () => { k1 = parseFloat(r.value); q("cw-k1v").textContent = k1.toFixed(3); clicks = [null, null, null, null]; draw(); });
      q("cw-k1-0").onclick = () => { k1 = 0; r.value = "0"; q("cw-k1v").textContent = "0.000"; clicks = [null, null, null, null]; draw(); };
      q<HTMLInputElement>("cw-grid").onchange = (e) => { grid = (e.target as HTMLInputElement).checked; draw(); };
      q("cw-grab").onclick = () => grab();
      next.textContent = `${t("camw.next")} →`;
      next.disabled = !frame;
    } else if (step === 2) {
      const pts = bedPts();
      const n = nextIndex();
      const laserOk = getMachineMode() === "laser" && machine.connected && !streamState.isRunning;
      body.innerHTML = `
        <div class="cw-methods">
          <label><input type="radio" name="cw-m" value="laser" ${method === "laser" ? "checked" : ""}> 🔥 ${esc(t("camw.mLaser"))}</label>
          <label><input type="radio" name="cw-m" value="manual" ${method === "manual" ? "checked" : ""}> ✋ ${esc(t("camw.mManual"))}</label>
        </div>
        ${method === "laser" ? `
          <p>${esc(t("camw.laserText"))}</p>
          <div class="cw-grid3">
            <label>${esc(t("laser.power"))}<span class="dlg-num"><input id="cw-pw" type="number" min="1" max="100" step="1" value="${mark.power}"><em>%</em></span></label>
            <label>${esc(t("laser.speed"))}<span class="dlg-num"><input id="cw-sp" type="number" min="100" step="100" value="${mark.speed}"><em>mm/min</em></span></label>
            <label>${esc(t("camw.size"))}<span class="dlg-num"><input id="cw-sz" type="number" min="2" max="40" step="1" value="${mark.size}"><em>mm</em></span></label>
          </div>
          <button id="cw-burn" class="btn-secondary" ${laserOk ? "" : "disabled"}>🔥 ${esc(t("camw.burn"))}</button>
          ${laserOk ? "" : `<p class="cw-hint warn">${esc(t(getMachineMode() !== "laser" ? "camw.needLaserMode" : streamState.isRunning ? "camw.jobRunning" : "camw.needConnect"))}</p>`}
        ` : `<p>${esc(t("camw.manualText"))}</p>`}
        <div class="cw-pts">
          ${pts.map(([x, y], i) => `
            <div class="cw-pt${i === n ? " next" : ""}${clicks[i] ? " done" : ""}">
              <b>${i + 1}</b><span>${esc(cornerName(i))}</span>
              ${method === "manual"
                ? `<input type="number" data-i="${i}" data-c="0" value="${x}" step="1"><input type="number" data-i="${i}" data-c="1" value="${y}" step="1">`
                : `<em>X ${x} · Y ${y}</em>`}
              <span class="cw-ok">${clicks[i] ? "✔" : ""}</span>
            </div>`).join("")}
        </div>
        <p class="cw-hint">${esc(n >= 0 ? t("camw.clickNext", { n: n + 1, name: cornerName(n), x: pts[n][0], y: pts[n][1] }) : t("camw.allSet"))}</p>
        <div class="cw-inline">
          <button id="cw-grab" class="btn-secondary">📷 ${esc(t("camw.newImage"))}</button>
          <button id="cw-reset" class="btn-secondary">↺ ${esc(t("camw.resetPts"))}</button>
        </div>`;
      ov.querySelectorAll<HTMLInputElement>("input[name=cw-m]").forEach(r => r.onchange = () => { method = r.value as any; renderBody(); draw(); });
      ov.querySelectorAll<HTMLInputElement>(".cw-pt input").forEach(inp => inp.onchange = () => {
        manualPts[+inp.dataset.i!][+inp.dataset.c!] = parseFloat(inp.value) || 0;
      });
      q("cw-grab").onclick = () => grab();
      q("cw-reset").onclick = () => { clicks = [null, null, null, null]; draw(); renderBody(); };
      const burn = ov.querySelector("#cw-burn") as HTMLButtonElement | null;
      if (burn) burn.onclick = async () => {
        mark = {
          power: parseFloat(q<HTMLInputElement>("cw-pw").value) || 8,
          speed: parseFloat(q<HTMLInputElement>("cw-sp").value) || 1500,
          size: parseFloat(q<HTMLInputElement>("cw-sz").value) || 10
        };
        try { localStorage.setItem(KEY_MARK, JSON.stringify(mark)); } catch { /* egal */ }
        if (!window.confirm(t("camw.burnConfirm", { p: mark.power }))) return;
        const code = markGcode(laserPts, mark.power, mark.speed, mark.size, laserSettings.sMax, laserSettings.dynamic);
        if (!loadGcodeFromText(code, t("camw.jobName"), o.log)) return;
        await startStreaming(() => machine.connected, o.log);
        o.log(t("camw.burnStarted"));
      };
      next.textContent = `${t("camw.check")} →`;
      next.disabled = !frame || n >= 0;
    } else {
      const H = currentH();
      body.innerHTML = `
        <p>${esc(t("camw.s3Text"))}</p>
        ${H ? "" : `<p class="cw-hint warn">${esc(t("camw.badPoints"))}</p>`}
        <p class="cw-hint">${esc(t("camw.s3Hint"))}</p>`;
      next.textContent = `✔ ${t("camw.save")}`;
      next.disabled = !H;
    }
  };

  q("cw-back").onclick = () => { step = Math.max(1, step - 1); renderBody(); draw(); };
  q("cw-next").onclick = () => {
    if (step === 1) { step = 2; renderBody(); draw(); return; }
    if (step === 2) {
      const ok = goodQuad(clicks as [number, number][]) && goodQuad(bedPts());
      if (!ok || !currentH()) { window.alert(t("camw.badPoints")); return; }
      step = 3; renderBody(); draw(); return;
    }
    const H = currentH();
    if (!H || !frame) return;
    // Rückprobe: Sollpunkte über H müssen auf die Klicks fallen
    const err = Math.max(...bedPts().map(([x, y], i) => {
      const [a, b] = applyH(H, x, y);
      const c = clicks[i]!;
      return Math.hypot(a - c[0], b - c[1]);
    }));
    if (!(err < 1e-3)) { window.alert(t("camw.badPoints")); return; }
    const pts = bedPts();
    o.onSave({
      k1, H, srcW: frame.w, srcH: frame.h, date: new Date().toISOString(),
      pts: clicks.map((c, i) => ({ nx: c![0], ny: c![1], x: pts[i][0], y: pts[i][1] }))
    });
    o.log(t("camw.saved"));
    close();
  };

  window.addEventListener("resize", () => { if (document.body.contains(ov)) draw(); });
  renderBody();
  void grab().then(renderBody);
}
