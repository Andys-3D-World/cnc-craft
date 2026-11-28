/**
 * BILD NACHZEICHNEN (wie "Trace Image" in LightBurn)
 *
 * Ein Foto, Logo oder Scan (PNG, JPG, BMP, GIF, WEBP) wird in Schwarz/Weiß
 * umgewandelt und die Umrisse werden als Konturen eingefügt.
 * Im Dialog: Schwelle, Umkehren, Weichzeichnen, Glätten, kleine Flecken ignorieren, Breite in mm.
 * „Mittellinie“: statt der Umrisse eine einzige Linie in der Mitte jedes Strichs (Handschrift, Skizzen – centerline.ts).
 */
import { ImportResult, emptyResult } from "./common";
import { t } from "../i18n/i18n";
import { otsu, traceAll, traceBody, type TraceOpts, type TracePath } from "./traceCalc";
import { checkImport } from "./importRust";

const MAX_SIDE = 2000;


export async function openImageTraceDialog(fileName: string, bytes: Uint8Array): Promise<ImportResult | null> {
  const img = await loadImage(fileName, bytes);
  const { gray, W, H } = toGray(img);
  const auto = otsu(gray);

  return new Promise(resolve => {
    document.getElementById("trace-dialog-overlay")?.remove();
    const ov = document.createElement("div");
    ov.id = "trace-dialog-overlay";
    const defWidth = Math.round(Math.min(200, Math.max(20, W / 10)));
    ov.innerHTML = `
      <div class="trc-dlg">
        <h3>🖼️ ${t("trace.title")} <span class="trc-file">${escapeHtml(fileName)} · ${W} × ${H} px</span></h3>
        <canvas id="trc-preview" width="560" height="340"></canvas>
        <div class="trc-grid">
          <label>${t("trace.threshold")} <span id="trc-thr-val">${auto}</span>
            <input id="trc-thr" type="range" min="1" max="254" value="${auto}"></label>
          <label>${t("trace.blur")} <span id="trc-blur-val">1</span>
            <input id="trc-blur" type="range" min="0" max="4" value="1"></label>
          <label>${t("trace.smooth")} <span id="trc-smooth-val">1.0</span>
            <input id="trc-smooth" type="range" min="0.2" max="4" step="0.1" value="1"></label>
          <label>${t("trace.minArea")} <span id="trc-min-val">20</span>
            <input id="trc-min" type="range" min="0" max="500" step="5" value="20"></label>
        </div>
        <div class="trc-row">
          <label class="trc-check"><input id="trc-inv" type="checkbox"> ${t("trace.invert")}</label>
          <label class="trc-check" title="${escapeHtml(t("trace.centerTip"))}"><input id="trc-center" type="checkbox"> ${t("trace.center")}</label>
          <span style="flex:1"></span>
          <label>${t("trace.width")} <input id="trc-width" type="number" min="1" step="1" value="${defWidth}" style="width:80px"> mm</label>
        </div>
        <div id="trc-info" class="trc-info"></div>
        <div class="trc-row">
          <button id="trc-cancel" class="trc-btn-cancel">${t("dlg.cancel")}</button>
          <button id="trc-ok" class="trc-btn-ok">✔ ${t("dlg.insert")}</button>
        </div>
      </div>
      <style>
        #trace-dialog-overlay { position: fixed; inset: 0; z-index: 5000; background: rgba(0,0,0,0.7);
          display: flex; align-items: center; justify-content: center; font-family: var(--font-ui, sans-serif); }
        .trc-dlg { background: var(--bg-panel, #1f1f26); border: 1px solid var(--border-color, #35353f); border-radius: 12px;
          padding: 18px; width: 600px; max-width: 96vw; max-height: 96vh; overflow: auto; color: var(--text-main, #e6e6ee);
          display: flex; flex-direction: column; gap: 10px; box-shadow: 0 20px 60px rgba(0,0,0,0.7); }
        .trc-dlg h3 { margin: 0; font-size: 1.05rem; }
        .trc-file { font-size: 0.75rem; font-weight: 400; color: var(--text-muted, #8d8d9c); font-family: monospace; margin-left: 8px; }
        #trc-preview { width: 100%; height: auto; background: #f4f4f4; border-radius: 8px; border: 1px solid var(--border-color, #35353f); }
        .trc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }
        .trc-grid label { display: flex; flex-direction: column; font-size: 0.78rem; color: var(--text-muted, #8d8d9c); }
        .trc-grid span { color: var(--text-main, #e6e6ee); font-family: monospace; }
        .trc-row { display: flex; align-items: center; gap: 10px; font-size: 0.8rem; }
        .trc-check { display: flex; gap: 6px; align-items: center; cursor: pointer; }
        .trc-info { font-size: 0.78rem; font-family: monospace; color: var(--text-muted, #8d8d9c); }
        .trc-btn-cancel { flex: 1; padding: 9px; border-radius: 6px; border: 1px solid var(--border-color, #35353f); background: transparent; color: var(--text-muted, #8d8d9c); cursor: pointer; }
        .trc-btn-ok { flex: 2; padding: 9px; border-radius: 6px; border: none; font-weight: 700; cursor: pointer; background: var(--accent-color, #6d4aff); color: #fff; }
      </style>`;
    document.body.appendChild(ov);
    const $ = <T extends HTMLElement>(id: string) => ov.querySelector("#" + id) as T;

    const read = (): TraceOpts => ({
      threshold: parseInt($<HTMLInputElement>("trc-thr").value, 10),
      invert: $<HTMLInputElement>("trc-inv").checked,
      blur: parseInt($<HTMLInputElement>("trc-blur").value, 10),
      smooth: parseFloat($<HTMLInputElement>("trc-smooth").value),
      minArea: parseFloat($<HTMLInputElement>("trc-min").value),
      widthMm: Math.max(1, parseFloat($<HTMLInputElement>("trc-width").value) || defWidth),
      center: $<HTMLInputElement>("trc-center").checked
    });

    let loops: TracePath[] = [];
    let used: TraceOpts | null = null; // womit loops gerechnet wurde (für den Vergleich mit Rust)
    let timer = 0;
    const update = () => {
      const o = read();
      $("trc-thr-val").textContent = String(o.threshold);
      $("trc-blur-val").textContent = String(o.blur);
      $("trc-smooth-val").textContent = o.smooth.toFixed(1);
      $("trc-min-val").textContent = String(o.minArea);
      loops = traceAll(gray, W, H, o);
      used = o;
      drawPreview($<HTMLCanvasElement>("trc-preview"), img, W, H, loops, !o.center);
      const pts = loops.reduce((n, l) => n + l.pts.length, 0);
      const hMm = (o.widthMm * H) / W;
      $("trc-info").textContent = t("trace.stats", { n: loops.length, pts, w: o.widthMm.toFixed(1), h: hMm.toFixed(1) });
    };
    const later = () => { clearTimeout(timer); timer = window.setTimeout(update, 60); };
    ov.querySelectorAll("input").forEach(el => el.addEventListener("input", later));

    const finish = (r: ImportResult | null) => { ov.remove(); resolve(r); };
    $("trc-cancel").addEventListener("click", () => finish(null));
    ov.addEventListener("mousedown", e => { if (e.target === ov) finish(null); });
    ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") finish(null); });
    $("trc-ok").addEventListener("click", () => {
      const o = read();
      const s = o.widthMm / W;
      const res = emptyResult();
      res.paths = loops.map(l => ({ pts: l.pts.map(q => ({ x: q.x * s, y: (H - q.y) * s })), closed: l.closed }));
      res.info = t("trace.info", { n: loops.length, w: o.widthMm.toFixed(1) });
      if (used) checkImport("import_trace", traceBody(gray, W, H, used), { otsu: auto, paths: loops });
      finish(res);
    });
    update();
  });
}

export async function loadImage(name: string, bytes: Uint8Array): Promise<CanvasImageSource & { width: number; height: number }> {
  const ext = name.split(".").pop()?.toLowerCase() || "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "bmp" ? "image/bmp" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    // onload statt decode(): decode() bleibt in manchen WebViews hängen, wenn das Bild nicht im Dokument ist
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error(t("imp.error"))); img.src = url; });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function toGray(img: CanvasImageSource & { width: number; height: number }) {
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const W = Math.max(1, Math.round(img.width * scale)), H = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff"; // Transparenz = weiß
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return { gray, W, H };
}

function drawPreview(canvas: HTMLCanvasElement, img: CanvasImageSource, W: number, H: number, loops: TracePath[], fill: boolean) {
  const ctx = canvas.getContext("2d")!;
  const cw = canvas.width, ch = canvas.height;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  const s = Math.min((cw - 10) / W, (ch - 10) / H);
  const ox = (cw - W * s) / 2, oy = (ch - H * s) / 2;
  ctx.globalAlpha = 0.25;
  ctx.drawImage(img, ox, oy, W * s, H * s);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  for (const l of loops) {
    l.pts.forEach((p, i) => (i ? ctx.lineTo(ox + p.x * s, oy + p.y * s) : ctx.moveTo(ox + p.x * s, oy + p.y * s)));
    if (l.closed) ctx.closePath();
  }
  // Umrisse gefüllt zeigen, Mittellinien nur als Linie
  if (fill) {
    ctx.fillStyle = "rgba(109, 74, 255, 0.25)";
    ctx.fill("evenodd");
  }
  ctx.strokeStyle = "#5a2cff";
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
