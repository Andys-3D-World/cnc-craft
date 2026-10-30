/**
 * FRÄSBAHNEN AUF DER GRAFIKKARTE (WebGL2) für die 3D-Ansicht der Simulation (simView.ts)
 *
 * Alle Bewegungen werden EINMAL hochgeladen (je Bewegung Anfang, Ende, Art). Danach kostet ein Bild – Drehen,
 * Zoomen, Live-Fortschritt – nur ein paar Werte (Kamera, aktuelle Bewegung), egal ob 1 000 oder 2 Mio. Bewegungen.
 * Jede Bewegung ist ein schmales Rechteck (zwei Dreiecke), damit die Linien so dick wie bisher sind
 * (WebGL-Linien wären überall nur 1 Pixel).
 *
 * Aussehen wie beim Zeichnen mit dem Canvas: Schnitte nach Tiefe gefärbt, Eilgänge orange und Leerfahrten grau
 * gestrichelt, schon gefahrene Bahnen kräftig, kommende blass.
 * Geht WebGL2 nicht, liefert render() null – dann zeichnet simView.ts wie bisher selbst.
 */
import { SimProgram, MOVE_CUT, MOVE_RAPID, MOVE_TRAVEL } from "./gcodeParser";

type GL = WebGL2RenderingContext;

const VS = `#version 300 es
precision highp float;
in vec3 a_p0; in vec3 a_p1; in float a_type;
uniform vec2 u_size;               // Canvas in Pixeln
uniform vec2 u_origin;             // Bildschirm-Mitte + Verschiebung
uniform vec3 u_center;             // Drehmitte (mm)
uniform vec4 u_rot;                // cos/sin Drehung, cos/sin Neigung
uniform float u_scale;             // Pixel je mm
uniform float u_width;             // Linienbreite in Pixeln
uniform float u_cap;               // Enden überstehen lassen (1) – nicht bei blassen Bahnen, sonst dunkle Punkte an den Stößen
uniform float u_kind;              // nur diese Art zeichnen (0 Eilgang, 1 Schnitt, 2 Leerfahrt)
uniform vec2 u_zRange;             // tiefster / höchster Schnitt
uniform vec3 u_colors[8];
uniform vec3 u_kindColor;
out vec4 v_color; out float v_along; out float v_dashed;
uniform float u_alpha;
vec2 proj(vec3 p) {
  vec3 d = p - u_center;
  float x = d.x * u_rot.x - d.y * u_rot.y;
  float y = (d.x * u_rot.y + d.y * u_rot.x) * u_rot.z + d.z * u_rot.w;
  return vec2(u_origin.x + x * u_scale, u_origin.y - y * u_scale);
}
void main() {
  if (abs(a_type - u_kind) > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // andere Art: weg
  vec2 a = proj(a_p0), b = proj(a_p1);
  vec2 dir = b - a; float len = length(dir);
  vec2 t = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  // 6 Ecken: zwei Dreiecke; an den Enden etwas überstehen (wie runde/flache Linienenden)
  int k = gl_VertexID;
  float along = (k == 0 || k == 1 || k == 3) ? 0.0 : 1.0;
  float side = (k == 0 || k == 2 || k == 4) ? -1.0 : 1.0;
  float hw = u_width * 0.5;
  vec2 p = mix(a, b, along) + n * side * hw + t * (along * 2.0 - 1.0) * hw * u_cap;
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
  v_along = along * len;
  v_dashed = a_type > 0.5 && a_type < 1.5 ? 0.0 : 1.0;
  vec3 c = u_kindColor;
  if (v_dashed < 0.5) {
    float z = min(a_p0.z, a_p1.z);
    float span = u_zRange.y - u_zRange.x;
    int i = span < 1e-6 ? 2 : clamp(int(floor((u_zRange.y - z) / span * 8.0)), 0, 7);
    c = u_colors[i];
  }
  v_color = vec4(c, u_alpha);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 v_color; in float v_along; in float v_dashed;
out vec4 o;
void main() {
  if (v_dashed > 0.5 && mod(v_along, 8.0) >= 4.0) discard;   // gestrichelt 4 an / 4 aus
  o = vec4(v_color.rgb * v_color.a, v_color.a);               // vormultipliziertes Alpha
}`;

const hex = (c: string): [number, number, number] =>
  [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];

export interface PathView {
  W: number; H: number;
  originX: number; originY: number;
  center: { x: number; y: number; z: number };
  yaw: number; pitch: number; scale: number;
  /** bis hierher gefahren (Bewegungen davor kräftig, danach blass); -1 = noch nicht gestartet */
  cur: number;
  /** Bewegungen [0, cur) gelten als gefahren */
  started: boolean;
  showRapids: boolean;
  depthColors: string[];
  rapidColor: string;
  travelColor: string;
}

export class PathRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: GL | null = null;
  private prog: WebGLProgram | null = null;
  private buf: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private loaded: SimProgram | null = null;
  private loadedN = 0;
  private broken = false;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private attr = { p0: -1, p1: -1, type: -1 };

  constructor() {
    this.canvas = document.createElement("canvas");
  }

  private init(): GL | null {
    if (this.broken) return null;
    if (this.gl) return this.gl.isContextLost() ? null : this.gl;
    try {
      const g = this.canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true }) as GL | null;
      if (!g) { this.broken = true; return null; }
      const sh = (type: number, src: string) => {
        const s = g.createShader(type)!;
        g.shaderSource(s, src); g.compileShader(s);
        if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) || "shader");
        return s;
      };
      const p = g.createProgram()!;
      g.attachShader(p, sh(g.VERTEX_SHADER, VS)); g.attachShader(p, sh(g.FRAGMENT_SHADER, FS));
      g.linkProgram(p);
      if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) || "link");
      this.prog = p;
      for (const n of ["u_size", "u_origin", "u_center", "u_rot", "u_scale", "u_width", "u_kind", "u_zRange", "u_colors", "u_kindColor", "u_alpha", "u_cap"]) {
        this.loc[n] = g.getUniformLocation(p, n);
      }
      this.attr = { p0: g.getAttribLocation(p, "a_p0"), p1: g.getAttribLocation(p, "a_p1"), type: g.getAttribLocation(p, "a_type") };
      this.canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); this.gl = null; this.loaded = null; this.broken = true; });
      this.gl = g;
      return g;
    } catch {
      this.broken = true;
      return null;
    }
  }

  /** Bewegungen hochladen (nur wenn sich das Programm geändert hat): je Bewegung 7 Zahlen */
  private upload(g: GL, p: SimProgram) {
    if (this.loaded === p && this.loadedN === p.n) return;
    const n = p.n, data = new Float32Array(n * 7);
    for (let i = 0; i < n; i++) {
      const o = i * 7;
      data[o] = p.x0[i]; data[o + 1] = p.y0[i]; data[o + 2] = p.z0[i];
      data[o + 3] = p.x1[i]; data[o + 4] = p.y1[i]; data[o + 5] = p.z1[i];
      data[o + 6] = p.type[i];
    }
    if (!this.buf) this.buf = g.createBuffer();
    if (!this.vao) this.vao = g.createVertexArray();
    g.bindVertexArray(this.vao);
    g.bindBuffer(g.ARRAY_BUFFER, this.buf);
    g.bufferData(g.ARRAY_BUFFER, data, g.STATIC_DRAW);
    this.loaded = p; this.loadedN = n;
  }

  /** Zeiger auf die Bewegungen ab „from“ setzen (WebGL2 kann nicht ab einer bestimmten Instanz zeichnen) */
  private pointAt(g: GL, from: number) {
    const stride = 7 * 4, off = from * stride;
    g.bindBuffer(g.ARRAY_BUFFER, this.buf);
    g.enableVertexAttribArray(this.attr.p0);
    g.vertexAttribPointer(this.attr.p0, 3, g.FLOAT, false, stride, off);
    g.vertexAttribDivisor(this.attr.p0, 1);
    g.enableVertexAttribArray(this.attr.p1);
    g.vertexAttribPointer(this.attr.p1, 3, g.FLOAT, false, stride, off + 12);
    g.vertexAttribDivisor(this.attr.p1, 1);
    g.enableVertexAttribArray(this.attr.type);
    g.vertexAttribPointer(this.attr.type, 1, g.FLOAT, false, stride, off + 24);
    g.vertexAttribDivisor(this.attr.type, 1);
  }

  /** Bahnen zeichnen; Ergebnis-Canvas (durchsichtiger Hintergrund) oder null = WebGL geht nicht */
  render(p: SimProgram, v: PathView): HTMLCanvasElement | null {
    const g = this.init();
    if (!g || !this.prog) return null;
    try {
      if (this.canvas.width !== v.W || this.canvas.height !== v.H) { this.canvas.width = v.W; this.canvas.height = v.H; }
      this.upload(g, p);
      g.viewport(0, 0, v.W, v.H);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      g.enable(g.BLEND);
      g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
      g.useProgram(this.prog);
      g.bindVertexArray(this.vao);
      const L = this.loc;
      g.uniform2f(L.u_size, v.W, v.H);
      g.uniform2f(L.u_origin, v.originX, v.originY);
      g.uniform3f(L.u_center, v.center.x, v.center.y, v.center.z);
      g.uniform4f(L.u_rot, Math.cos(v.yaw), Math.sin(v.yaw), Math.cos(v.pitch), Math.sin(v.pitch));
      g.uniform1f(L.u_scale, v.scale);
      g.uniform2f(L.u_zRange, p.cutMinZ, p.cutMaxZ);
      g.uniform3fv(L.u_colors, v.depthColors.flatMap(hex));

      // wie beim Canvas: erst die kommenden (blass), dann die gefahrenen (kräftig); je Teil erst Eilgänge, dann Schnitte
      const cur = v.cur;
      const drawSet = (done: boolean) => {
        const from = done ? 0 : Math.max(0, cur);
        const to = done ? Math.min(p.n, cur) : p.n;
        if (to <= from) return;
        const alpha = done ? 1 : (v.started ? 0.28 : 0.9);
        g.uniform1f(L.u_cap, alpha >= 0.99 ? 1 : 0);
        this.pointAt(g, from);
        if (v.showRapids) {
          for (const kind of [MOVE_RAPID, MOVE_TRAVEL]) {
            g.uniform1f(L.u_kind, kind);
            g.uniform3fv(L.u_kindColor, hex(kind === MOVE_RAPID ? v.rapidColor : v.travelColor));
            g.uniform1f(L.u_alpha, alpha * 0.7);
            g.uniform1f(L.u_width, 1);
            g.drawArraysInstanced(g.TRIANGLES, 0, 6, to - from);
          }
        }
        g.uniform1f(L.u_kind, MOVE_CUT);
        g.uniform1f(L.u_alpha, alpha);
        g.uniform1f(L.u_width, done ? 1.8 : 1.4);
        g.drawArraysInstanced(g.TRIANGLES, 0, 6, to - from);
      };
      drawSet(false);
      drawSet(true);
      if (g.getError() !== g.NO_ERROR) return null;
      return this.canvas;
    } catch {
      return null;
    }
  }

  /** Grafikkarten-Speicher freigeben (Simulation zu) */
  dispose() {
    const g = this.gl;
    if (g) { if (this.buf) g.deleteBuffer(this.buf); if (this.vao) g.deleteVertexArray(this.vao); }
    this.buf = null; this.vao = null; this.loaded = null;
  }
}
