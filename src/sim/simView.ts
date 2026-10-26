/**
 * 3D-ANSICHT DER FRÄSBAHNEN (ohne Zusatz-Bibliotheken, reines Canvas)
 *
 * Maus:  links ziehen = drehen · rechts/mittel ziehen oder Shift+links = verschieben · Rad = Zoom
 *        links klicken (ohne Ziehen) = Bahn anklicken -> onPick(Zeile)
 * Farben: Schnitte nach Tiefe (hell = flach, dunkel = tief), Eilgänge orange gestrichelt,
 *         Leerfahrten grau. Bereits gefahrene Bahnen kräftig, noch kommende blass.
 */
import { SimProgram, MOVE_CUT, MOVE_RAPID } from "./gcodeParser";

export type ViewPreset = "top" | "iso" | "front";

const DEPTH_COLORS = ["#7ff3ff", "#4fd8ff", "#36b3ff", "#3b8cff", "#5a68ff", "#7a4dff", "#9b3dff", "#c03ce0"];
const RAPID_COLOR = "#ff9a3c";
const TRAVEL_COLOR = "#9aa0b4";
const HILITE_COLOR = "#ffd23c";
/** so nah (Pixel) muss ein Klick an einer Bahn liegen */
const PICK_PX = 8;

export class SimView {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private prog: SimProgram | null = null;
  private bedW = 300;
  private bedH = 300;

  // Kamera
  yaw = -0.6;
  pitch = 0.95;
  scale = 1;
  panX = 0;
  panY = 0;
  private center = { x: 150, y: 150, z: 0 };

  // Fortschritt
  private curIdx = -1;
  private tool = { x: 0, y: 0, z: 0 };
  showRapids = true;
  live = false;
  /** hervorgehobene G-Code-Zeile (-1 = keine) */
  hiLine = -1;

  private dirty = true;
  /** wie lange das Zeichnen dauert (ms, geglättet) – danach richtet sich die Bildrate im Live-Betrieb */
  drawMs = 0;
  onChange: () => void = () => {};
  /** Klick auf eine Bahn: Zeile (0-basiert) und Index der nächsten Bewegung, -1 = daneben */
  onPick: (line: number, move: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.bindMouse();
    const loop = () => {
      if (this.dirty) {
        this.dirty = false;
        const t0 = performance.now();
        this.draw();
        this.drawMs = 0.8 * this.drawMs + 0.2 * (performance.now() - t0);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  invalidate() { this.dirty = true; }

  setBed(w: number, h: number) { this.bedW = w; this.bedH = h; this.invalidate(); }

  setProgram(p: SimProgram | null) {
    this.prog = p;
    this.curIdx = -1;
    this.fit();
  }

  setProgress(i: number, _frac: number, x: number, y: number, z: number) {
    this.curIdx = i;
    this.tool = { x, y, z };
    this.invalidate();
  }

  /** Zeile hervorheben (ihre Bahnen kräftig gelb) */
  setHighlight(line: number) {
    if (line === this.hiLine) return;
    this.hiLine = line;
    this.invalidate();
  }

  /** Programm tauschen ohne die Kamera zu verstellen (nach dem Bearbeiten) */
  replaceProgram(p: SimProgram | null) {
    this.prog = p;
    this.invalidate();
  }

  /** Welche Bewegung liegt am Punkt (Pixel im Canvas)? Nächstes Stück in Bildschirm-Abstand, -1 = keine */
  pick(sx: number, sy: number): number {
    const p = this.prog;
    if (!p) return -1;
    const { PX, PY } = this.projection();
    let best = -1, bestD = PICK_PX * PICK_PX;
    for (let i = 0; i < p.n; i++) {
      if (!this.showRapids && p.type[i] !== MOVE_CUT) continue;
      const ax = PX(p.x0[i], p.y0[i]), ay = PY(p.x0[i], p.y0[i], p.z0[i]);
      const bx = PX(p.x1[i], p.y1[i]), by = PY(p.x1[i], p.y1[i], p.z1[i]);
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / l2)) : 0;
      const ex = ax + u * dx - sx, ey = ay + u * dy - sy;
      const d = ex * ex + ey * ey;
      // bei Gleichstand gewinnt der Schnitt vor Eilgang/Leerfahrt
      if (d < bestD || (d === bestD && best >= 0 && p.type[i] === MOVE_CUT && p.type[best] !== MOVE_CUT)) { bestD = d; best = i; }
    }
    return best;
  }

  /** Welt (mm) -> Canvas-Pixel */
  private projection() {
    const W = this.canvas.width, H = this.canvas.height;
    const ox = W / 2 + this.panX, oy = H / 2 + this.panY, s = this.scale;
    const cyaw = Math.cos(this.yaw), syaw = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cx0 = this.center.x, cy0 = this.center.y, cz0 = this.center.z;
    const PX = (x: number, y: number) => ox + ((x - cx0) * cyaw - (y - cy0) * syaw) * s;
    const PY = (x: number, y: number, z: number) => oy - (((x - cx0) * syaw + (y - cy0) * cyaw) * cp + (z - cz0) * sp) * s;
    return { PX, PY };
  }

  setView(v: ViewPreset) {
    if (v === "top") { this.yaw = 0; this.pitch = 0; }
    else if (v === "front") { this.yaw = 0; this.pitch = Math.PI / 2; }
    else { this.yaw = -0.6; this.pitch = 0.95; }
    this.fit();
  }

  /** Alles einpassen (Bett + Bahnen) */
  fit() {
    // Mit Programm: auf die Bahnen einpassen (Bett ist dann teils außerhalb), sonst aufs Bett
    const b = this.prog && this.prog.n ? this.prog.bounds : null;
    const pad = b ? Math.max(5, 0.05 * Math.max(b.maxX - b.minX, b.maxY - b.minY)) : 0;
    const minX = b ? b.minX - pad : 0, maxX = b ? b.maxX + pad : this.bedW;
    const minY = b ? b.minY - pad : 0, maxY = b ? b.maxY + pad : this.bedH;
    const minZ = b ? Math.min(0, b.minZ) : 0, maxZ = b ? Math.max(0, b.maxZ) : 0;
    this.center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
    // Ausdehnung in der aktuellen Blickrichtung grob abschätzen
    let sxMin = Infinity, sxMax = -Infinity, syMin = Infinity, syMax = -Infinity;
    for (const x of [minX, maxX]) for (const y of [minY, maxY]) for (const z of [minZ, maxZ]) {
      const p = this.rot(x, y, z);
      sxMin = Math.min(sxMin, p.x); sxMax = Math.max(sxMax, p.x);
      syMin = Math.min(syMin, p.y); syMax = Math.max(syMax, p.y);
    }
    const W = this.canvas.width || 600, H = this.canvas.height || 400;
    this.scale = 0.88 * Math.min(W / Math.max(sxMax - sxMin, 1), H / Math.max(syMax - syMin, 1));
    this.panX = -((sxMin + sxMax) / 2) * this.scale;
    this.panY = ((syMin + syMax) / 2) * this.scale;
    this.invalidate();
    this.onChange();
  }

  /** Drehung um die Mitte: ergibt Bildschirm-Koordinaten (y nach oben) vor dem Skalieren */
  private rot(x: number, y: number, z: number) {
    const dx = x - this.center.x, dy = y - this.center.y, dz = z - this.center.z;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const x1 = dx * cy - dy * sy;
    const y1 = dx * sy + dy * cy;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    return { x: x1, y: y1 * cp + dz * sp };
  }

  private bindMouse() {
    const c = this.canvas;
    let drag: null | { x: number; y: number; mode: "orbit" | "pan"; moved: number } = null;
    c.addEventListener("contextmenu", e => e.preventDefault());
    c.addEventListener("mousedown", e => {
      const mode = e.button === 0 && !e.shiftKey ? "orbit" : "pan";
      drag = { x: e.clientX, y: e.clientY, mode, moved: 0 };
      e.preventDefault();
    });
    window.addEventListener("mousemove", e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.mode === "orbit") {
        this.yaw -= dx * 0.008;
        this.pitch = Math.max(0, Math.min(Math.PI / 2, this.pitch - dy * 0.008));
      } else {
        this.panX += dx; this.panY += dy;
      }
      this.invalidate();
    });
    window.addEventListener("mouseup", e => {
      // kaum bewegt = Klick (kein Drehen) -> Bahn suchen
      if (drag && drag.mode === "orbit" && drag.moved < 4 && e.target === c) {
        const r = c.getBoundingClientRect();
        const sx = (e.clientX - r.left) * (c.width / Math.max(1, r.width));
        const sy = (e.clientY - r.top) * (c.height / Math.max(1, r.height));
        const i = this.pick(sx, sy);
        this.onPick(i >= 0 && this.prog ? this.prog.line[i] : -1, i);
      }
      drag = null;
    });
    c.addEventListener("wheel", e => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const mx = e.clientX - r.left - c.width / 2 - this.panX;
      const my = e.clientY - r.top - c.height / 2 - this.panY;
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.scale *= f;
      this.panX -= mx * (f - 1);
      this.panY -= my * (f - 1);
      this.invalidate();
    }, { passive: false });
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = "#0e0e12";
    ctx.fillRect(0, 0, W, H);

    const s = this.scale;
    const { PX, PY } = this.projection();

    // ---- Bett mit Raster ----
    ctx.lineWidth = 1;
    const step = this.gridStep();
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.beginPath();
    for (let x = 0; x <= this.bedW + 1e-6; x += step) { ctx.moveTo(PX(x, 0), PY(x, 0, 0)); ctx.lineTo(PX(x, this.bedH), PY(x, this.bedH, 0)); }
    for (let y = 0; y <= this.bedH + 1e-6; y += step) { ctx.moveTo(PX(0, y), PY(0, y, 0)); ctx.lineTo(PX(this.bedW, y), PY(this.bedW, y, 0)); }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 77, 77, 0.7)";
    ctx.beginPath();
    ctx.moveTo(PX(0, 0), PY(0, 0, 0)); ctx.lineTo(PX(this.bedW, 0), PY(this.bedW, 0, 0));
    ctx.lineTo(PX(this.bedW, this.bedH), PY(this.bedW, this.bedH, 0)); ctx.lineTo(PX(0, this.bedH), PY(0, this.bedH, 0));
    ctx.closePath(); ctx.stroke();

    // Achsen am Nullpunkt
    const axLen = Math.max(10, step * 2);
    const axes: [string, number, number, number][] = [["#ff5757", axLen, 0, 0], ["#34d17b", 0, axLen, 0], ["#37a6ff", 0, 0, axLen]];
    ctx.lineWidth = 2;
    for (const [col, ax, ay, az] of axes) {
      ctx.strokeStyle = col; ctx.beginPath();
      ctx.moveTo(PX(0, 0), PY(0, 0, 0)); ctx.lineTo(PX(ax, ay), PY(ax, ay, az)); ctx.stroke();
    }

    const p = this.prog;
    if (!p || p.n === 0) return;

    // ---- Bahnen, sortiert nach Stil ----
    const zLo = p.cutMinZ, zHi = p.cutMaxZ;
    const bucketOf = (z: number) => {
      if (zHi - zLo < 1e-6) return 2;
      const t = (zHi - z) / (zHi - zLo);
      return Math.max(0, Math.min(DEPTH_COLORS.length - 1, Math.floor(t * DEPTH_COLORS.length)));
    };
    const cur = this.curIdx < 0 ? (this.live ? -1 : p.n) : this.curIdx;
    const drawSet = (done: boolean) => {
      const from = done ? 0 : Math.max(0, cur);
      const to = done ? Math.min(p.n, cur) : p.n;
      if (to <= from) return;
      const alpha = done ? 1 : (this.curIdx < 0 ? 0.9 : 0.28);
      // Eilgänge / Leerfahrten
      if (this.showRapids) {
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        for (const kind of [MOVE_RAPID, 2]) {
          ctx.strokeStyle = kind === MOVE_RAPID ? RAPID_COLOR : TRAVEL_COLOR;
          ctx.globalAlpha = alpha * 0.7;
          ctx.beginPath();
          for (let i = from; i < to; i++) {
            if (p.type[i] !== kind) continue;
            ctx.moveTo(PX(p.x0[i], p.y0[i]), PY(p.x0[i], p.y0[i], p.z0[i]));
            ctx.lineTo(PX(p.x1[i], p.y1[i]), PY(p.x1[i], p.y1[i], p.z1[i]));
          }
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      // Schnitte nach Tiefe
      ctx.lineWidth = done ? 1.8 : 1.4;
      ctx.globalAlpha = alpha;
      for (let b = 0; b < DEPTH_COLORS.length; b++) {
        ctx.strokeStyle = DEPTH_COLORS[b];
        ctx.beginPath();
        let any = false;
        for (let i = from; i < to; i++) {
          if (p.type[i] !== MOVE_CUT) continue;
          if (bucketOf(Math.min(p.z0[i], p.z1[i])) !== b) continue;
          ctx.moveTo(PX(p.x0[i], p.y0[i]), PY(p.x0[i], p.y0[i], p.z0[i]));
          ctx.lineTo(PX(p.x1[i], p.y1[i]), PY(p.x1[i], p.y1[i], p.z1[i]));
          any = true;
        }
        if (any) ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    drawSet(false);
    drawSet(true);

    // Aktuelle (halb gefahrene) Bewegung
    if (this.curIdx >= 0 && this.curIdx < p.n) {
      const i = this.curIdx;
      ctx.strokeStyle = p.type[i] === MOVE_CUT ? "#ffffff" : RAPID_COLOR;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(PX(p.x0[i], p.y0[i]), PY(p.x0[i], p.y0[i], p.z0[i]));
      ctx.lineTo(PX(this.tool.x, this.tool.y), PY(this.tool.x, this.tool.y, this.tool.z));
      ctx.stroke();
    }

    // Hervorgehobene Zeile (angeklickt in der Bahn oder in der G-Code-Liste)
    if (this.hiLine >= 0) {
      let lo = 0, hi = p.n;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (p.line[mid] < this.hiLine) lo = mid + 1; else hi = mid; }
      if (lo < p.n && p.line[lo] === this.hiLine) {
        ctx.strokeStyle = HILITE_COLOR;
        ctx.lineWidth = 4;
        ctx.lineCap = "round";
        ctx.beginPath();
        for (let i = lo; i < p.n && p.line[i] === this.hiLine; i++) {
          ctx.moveTo(PX(p.x0[i], p.y0[i]), PY(p.x0[i], p.y0[i], p.z0[i]));
          ctx.lineTo(PX(p.x1[i], p.y1[i]), PY(p.x1[i], p.y1[i], p.z1[i]));
        }
        ctx.stroke();
        ctx.lineCap = "butt";
        // Startpunkt markieren (bei sehr kurzen Stücken sonst kaum zu sehen)
        ctx.fillStyle = HILITE_COLOR;
        ctx.beginPath(); ctx.arc(PX(p.x0[lo], p.y0[lo]), PY(p.x0[lo], p.y0[lo], p.z0[lo]), 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    // ---- Werkzeug ----
    if (this.curIdx >= 0) {
      const t = this.tool;
      const len = Math.max(8, 25 / Math.max(0.2, s)) ;
      const tx = PX(t.x, t.y), ty = PY(t.x, t.y, t.z), hx = PX(t.x, t.y), hy = PY(t.x, t.y, t.z + len);
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.fillStyle = this.live ? "#34d17b" : "#ff4d4d";
      ctx.beginPath(); ctx.arc(tx, ty, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#0e0e12"; ctx.lineWidth = 1.5; ctx.stroke();
      // Schatten auf dem Bett (Hilfe für die Tiefe)
      if (this.pitch > 0.05) {
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(PX(t.x, t.y), PY(t.x, t.y, 0)); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  private gridStep(): number {
    const pxPerMm = this.scale;
    for (const st of [1, 5, 10, 20, 50, 100, 200, 500]) if (st * pxPerMm >= 18) return st;
    return 1000;
  }

  /** Farbskala für die Legende */
  static depthColors() { return DEPTH_COLORS; }
}
