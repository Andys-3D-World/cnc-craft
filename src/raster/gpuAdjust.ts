/**
 * BILD VERBESSERN AUF DER GRAFIKKARTE (WebGL2) – für große Fotos in der Bildgravur
 *
 * Rechnet genau dieselben Schritte wie applyAdjustCpu in dither.ts: Schwarz-/Weißpunkt, Gamma, Kontrast,
 * Helligkeit, Bildkurve, lokaler Kontrast, Entrauschen, Schärfen, Umkehren. Bei einem 24 × 34 cm-Foto mit 0,1 mm
 * (9 Mio. Bildpunkte) dauert das auf der CPU ~0,5 s, auf der Grafikkarte nur einen Bruchteil.
 *
 * Weichzeichnen (Kastenfilter, 3 Durchgänge ≈ Gauß) wie auf der CPU: Mittelwert über das Fenster ±r, am Rand nur
 * über die vorhandenen Punkte. Kleine Radien: Punkte direkt aufsummieren. Große Radien (lokaler Kontrast, r ≈ 4 % der
 * Bildgröße): erst laufende Summen je Zeile/Spalte bilden (in log2(Breite) Schritten), dann Ende minus Anfang.
 *
 * Kleine Rundungsunterschiede zur CPU (Grafikkarte rechnet mit 32 Bit) sind unter 0,001 – unsichtbar.
 * Geht WebGL2 nicht (alte WebView, Linux ohne Grafiktreiber, Bild zu groß), gibt run() null zurück → CPU rechnet.
 * Läuft im Hauptfenster (canvas) und im Hintergrund-Thread (OffscreenCanvas), wenn der das kann.
 */
import { Adjust, AdjustAccelerator, applyAdjustCpu, curveIsIdentity, curveLut, setAdjustAccelerator } from "./dither";

type GL = WebGL2RenderingContext;
interface Tex { tex: WebGLTexture; fb: WebGLFramebuffer }

const VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D u_a; uniform sampler2D u_b; uniform ivec2 u_size;
out vec4 o;
float A(ivec2 p) { return texelFetch(u_a, p, 0).r; }
float B(ivec2 p) { return texelFetch(u_b, p, 0).r; }
`;

const FS: Record<string, string> = {
  // Tonwerte + Bildkurve (u_b = Kurve als 256 × 1)
  tone: `uniform float u_black, u_span, u_inv, u_c, u_bright; uniform int u_curve;
    void main() { ivec2 p = ivec2(gl_FragCoord.xy);
      float v = clamp((A(p) - u_black) / u_span, 0.0, 1.0);
      v = v > 0.0 ? pow(v, u_inv) : 0.0;
      v = clamp((v - 0.5) * u_c + 0.5 + u_bright, 0.0, 1.0);
      if (u_curve == 1) { float f = v * 255.0; int k = min(254, int(floor(f)));
        float l0 = texelFetch(u_b, ivec2(k, 0), 0).r, l1 = texelFetch(u_b, ivec2(k + 1, 0), 0).r;
        v = l0 + (l1 - l0) * (f - float(k)); }
      o = vec4(v, 0.0, 0.0, 1.0); }`,
  // Kastenfilter direkt (kleiner Radius), u_dir = (1,0) waagerecht / (0,1) senkrecht
  boxDirect: `uniform ivec2 u_dir; uniform int u_r;
    void main() { ivec2 p = ivec2(gl_FragCoord.xy); int len = u_dir.x == 1 ? u_size.x : u_size.y; int i = u_dir.x == 1 ? p.x : p.y;
      int lo = max(0, i - u_r), hi = min(len - 1, i + u_r); float s = 0.0;
      for (int k = lo; k <= hi; k++) s += A(u_dir.x == 1 ? ivec2(k, p.y) : ivec2(p.x, k));
      o = vec4(s / float(hi - lo + 1), 0.0, 0.0, 1.0); }`,
  // laufende Summe (ein Schritt mit Abstand u_d)
  scan: `uniform ivec2 u_dir; uniform int u_d;
    void main() { ivec2 p = ivec2(gl_FragCoord.xy); int i = u_dir.x == 1 ? p.x : p.y;
      float v = A(p); if (i >= u_d) v += A(p - u_dir * u_d); o = vec4(v, 0.0, 0.0, 1.0); }`,
  // Kastenfilter aus laufender Summe: (Summe bis hi) − (Summe bis lo−1)
  boxScan: `uniform ivec2 u_dir; uniform int u_r;
    void main() { ivec2 p = ivec2(gl_FragCoord.xy); int len = u_dir.x == 1 ? u_size.x : u_size.y; int i = u_dir.x == 1 ? p.x : p.y;
      int lo = max(0, i - u_r), hi = min(len - 1, i + u_r);
      ivec2 ph = u_dir.x == 1 ? ivec2(hi, p.y) : ivec2(p.x, hi);
      float s = A(ph); if (lo > 0) s -= A(u_dir.x == 1 ? ivec2(lo - 1, p.y) : ivec2(p.x, lo - 1));
      o = vec4(s / float(hi - lo + 1), 0.0, 0.0, 1.0); }`,
  // lokaler Kontrast: u_a = Bild, u_b = weichgezeichnet
  local: `uniform float u_k, u_limUp, u_limDown;
    void main() { ivec2 p = ivec2(gl_FragCoord.xy); float g = A(p);
      float d = (g - B(p)) * u_k;
      float lim = d > 0.0 ? u_limUp * (1.0 - 0.7 * max(0.0, g - 0.8) / 0.2) : u_limDown;
      o = vec4(clamp(g + d / (1.0 + abs(d) / max(0.01, lim)), 0.0, 1.0), 0.0, 0.0, 1.0); }`,
  // Schärfen: u_a = Bild, u_b = leicht weichgezeichnet
  sharpen: `uniform float u_k;
    void main() { ivec2 p = ivec2(gl_FragCoord.xy); float g = A(p);
      o = vec4(clamp(g + u_k * (g - B(p)), 0.0, 1.0), 0.0, 0.0, 1.0); }`,
  invert: `void main() { o = vec4(1.0 - A(ivec2(gl_FragCoord.xy)), 0.0, 0.0, 1.0); }`,
  // Zurücklesen: 32-Bit-Zahl bitgenau in 4 Bytes verpacken (RGBA8 liest jede Grafikkarte am schnellsten)
  pack: `void main() { uint b = floatBitsToUint(A(ivec2(gl_FragCoord.xy)));
      o = vec4(float(b & 255u), float((b >> 8) & 255u), float((b >> 16) & 255u), float(b >> 24)) / 255.0; }`,
  // für das Zurücklesen in Streifen (RGBA-Gleitkomma geht überall)
  copy: `uniform int u_y0; void main() { ivec2 p = ivec2(gl_FragCoord.xy); o = vec4(A(ivec2(p.x, p.y + u_y0)), 0.0, 0.0, 1.0); }`
};

let gl: GL | null = null;
let broken = false;
const progs: Record<string, WebGLProgram> = {};
const uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
let pool: Tex[] = [];
let poolW = 0, poolH = 0;
let lutTex: WebGLTexture | null = null;

function init(): GL | null {
  if (gl) return gl.isContextLost() ? (broken = true, null) : gl;
  if (broken) return null;
  try {
    const canvas: any = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1)
      : typeof document !== "undefined" ? document.createElement("canvas") : null;
    const g = canvas?.getContext("webgl2", { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false }) as GL | null;
    if (!g || !g.getExtension("EXT_color_buffer_float")) { broken = true; return null; }
    const compile = (type: number, src: string) => {
      const sh = g.createShader(type)!;
      g.shaderSource(sh, src); g.compileShader(sh);
      if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(sh) || "shader");
      return sh;
    };
    const vs = compile(g.VERTEX_SHADER, VS);
    for (const [name, body] of Object.entries(FS)) {
      const p = g.createProgram()!;
      g.attachShader(p, vs); g.attachShader(p, compile(g.FRAGMENT_SHADER, HEAD + body));
      g.linkProgram(p);
      if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) || "link");
      progs[name] = p;
    }
    g.bindVertexArray(g.createVertexArray());
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    g.pixelStorei(g.PACK_ALIGNMENT, 1);
    gl = g;
    return g;
  } catch {
    broken = true;
    return null;
  }
}

function makeTex(g: GL, w: number, h: number, internal: number, format: number, data: ArrayBufferView | null = null): WebGLTexture {
  const t = g.createTexture()!;
  g.bindTexture(g.TEXTURE_2D, t);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  g.texImage2D(g.TEXTURE_2D, 0, internal, w, h, 0, format, g.FLOAT, data);
  return t;
}

function target(g: GL, tex: WebGLTexture): Tex {
  const fb = g.createFramebuffer()!;
  g.bindFramebuffer(g.FRAMEBUFFER, fb);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
  if (g.checkFramebufferStatus(g.FRAMEBUFFER) !== g.FRAMEBUFFER_COMPLETE) throw new Error("framebuffer");
  return { tex, fb };
}

/** 4 Arbeits-Flächen in Bildgröße (werden wiederverwendet, solange die Größe gleich bleibt) */
function texturesFor(g: GL, w: number, h: number): Tex[] {
  if (poolW === w && poolH === h && pool.length) return pool;
  for (const t of pool) { g.deleteTexture(t.tex); g.deleteFramebuffer(t.fb); }
  pool = [];
  for (let i = 0; i < 4; i++) pool.push(target(g, makeTex(g, w, h, g.R32F, g.RED)));
  poolW = w; poolH = h;
  return pool;
}

function u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
  let m = uniforms.get(p);
  if (!m) { m = new Map(); uniforms.set(p, m); }
  if (!m.has(name)) m.set(name, gl!.getUniformLocation(p, name));
  return m.get(name)!;
}

/** Einen Durchgang zeichnen: Ergebnis nach out, Eingänge a (und b) */
function pass(g: GL, prog: string, out: Tex, a: WebGLTexture, b: WebGLTexture | null, w: number, h: number, set: (p: WebGLProgram) => void = () => {}) {
  const p = progs[prog];
  g.useProgram(p);
  g.bindFramebuffer(g.FRAMEBUFFER, out.fb);
  g.viewport(0, 0, w, h);
  g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, a);
  g.uniform1i(u(p, "u_a"), 0);
  g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D, b);
  g.uniform1i(u(p, "u_b"), 1);
  g.uniform2i(u(p, "u_size"), w, h);
  set(p);
  g.drawArrays(g.TRIANGLES, 0, 3);
}

/**
 * Weichzeichnen von src; Ergebnis landet in einer der Flächen free[0..2] (src bleibt erhalten).
 * Gibt die Fläche mit dem Ergebnis zurück.
 */
function blur(g: GL, src: Tex, free: Tex[], w: number, h: number, r: number): Tex {
  let cur = src;
  const [t0, t1, t2] = free;
  for (let rep = 0; rep < 3; rep++) {
    for (const dir of [[1, 0], [0, 1]]) {
      const len = dir[0] ? w : h;
      if (r <= 12) {
        const out = cur === t0 ? t1 : t0;
        pass(g, "boxDirect", out, cur.tex, null, w, h, p => { g.uniform2i(u(p, "u_dir"), dir[0], dir[1]); g.uniform1i(u(p, "u_r"), r); });
        cur = out;
      } else {
        // laufende Summe (Hillis-Steele) zwischen t1/t2, dann Kasten nach t0 (bzw. t1, falls cur = t0)
        let a = cur, s: Tex | null = null;
        const ping = cur === t1 ? [t2, t0] : cur === t2 ? [t0, t1] : [t1, t2];
        let k = 0;
        for (let d = 1; d < len; d <<= 1) {
          const out = ping[k++ & 1];
          pass(g, "scan", out, a.tex, null, w, h, p => { g.uniform2i(u(p, "u_dir"), dir[0], dir[1]); g.uniform1i(u(p, "u_d"), d); });
          a = out; s = out;
        }
        const sum = s || cur;
        const out = [t0, t1, t2].find(t => t !== sum && t !== src)!;
        pass(g, "boxScan", out, sum.tex, null, w, h, p => { g.uniform2i(u(p, "u_dir"), dir[0], dir[1]); g.uniform1i(u(p, "u_r"), r); });
        cur = out;
      }
    }
  }
  return cur;
}

/** Ergebnis zurücklesen (in Streifen über eine RGBA-Gleitkomma-Fläche: das kann jede WebGL2-Grafikkarte) */
let packTex: Tex | null = null, packW = 0, packH = 0;
/** Verpacken setzt die übliche Byte-Reihenfolge voraus (alle gängigen Rechner) */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** RGBA8-Fläche zum Verpacken der Zahlen (wird wiederverwendet) */
function packTarget(g: GL, w: number, h: number) {
  if (packTex) { g.deleteFramebuffer(packTex.fb); g.deleteTexture(packTex.tex); }
  const t = g.createTexture()!;
  g.bindTexture(g.TEXTURE_2D, t);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
  g.texStorage2D(g.TEXTURE_2D, 1, g.RGBA8, w, h);
  packTex = target(g, t); packW = w; packH = h;
}

function readBack(g: GL, src: Tex, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  // schnellster Weg: bitgenau in RGBA8 verpacken und als Bytes lesen – die Bytes SIND dann die Float32-Zahlen
  // (Little-Endian, wie bei allen üblichen Rechnern)
  if (LITTLE_ENDIAN) try {
    if (!packTex || packW !== w || packH !== h) packTarget(g, w, h);
    pass(g, "pack", packTex!, src.tex, null, w, h);
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array(out.buffer));
    if (g.getError() === g.NO_ERROR) return out;
  } catch { /* nächster Weg */ }
  g.bindFramebuffer(g.FRAMEBUFFER, src.fb);
  if (g.getParameter(g.IMPLEMENTATION_COLOR_READ_FORMAT) === g.RED && g.getParameter(g.IMPLEMENTATION_COLOR_READ_TYPE) === g.FLOAT) {
    g.readPixels(0, 0, w, h, g.RED, g.FLOAT, out);
    if (g.getError() === g.NO_ERROR) return out;
  }
  const stripH = Math.max(1, Math.min(h, Math.floor(4_000_000 / w)));
  const tex = makeTex(g, w, stripH, g.RGBA32F, g.RGBA);
  const t = target(g, tex);
  const buf = new Float32Array(w * stripH * 4);
  for (let y0 = 0; y0 < h; y0 += stripH) {
    const rows = Math.min(stripH, h - y0);
    pass(g, "copy", t, src.tex, null, w, rows, p => g.uniform1i(u(p, "u_y0"), y0));
    g.readPixels(0, 0, w, rows, g.RGBA, g.FLOAT, buf);
    for (let i = 0, n = w * rows; i < n; i++) out[y0 * w + i] = buf[i * 4];
  }
  g.deleteFramebuffer(t.fb); g.deleteTexture(tex);
  return out;
}

/** Alle Schritte auf der Grafikkarte rechnen; Ergebnis bleibt dort (Fläche) */
function compute(g: GL, src: Float32Array, w: number, h: number, a: Adjust): Tex {
  const [t0, t1, t2, t3] = texturesFor(g, w, h);
  // Quelle hochladen nach t3
  g.bindTexture(g.TEXTURE_2D, t3.tex);
  g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, w, h, g.RED, g.FLOAT, src);
  // Tonwerte + Kurve -> t0
  const useCurve = !curveIsIdentity(a.curve);
  if (useCurve) {
    if (lutTex) g.deleteTexture(lutTex);
    lutTex = makeTex(g, 256, 1, g.R32F, g.RED, curveLut(a.curve!));
  }
  const span = Math.max(0.02, a.white - a.black), inv = 1 / Math.max(0.1, a.gamma);
  const c = a.contrast >= 0 ? 1 + a.contrast / 50 : 1 + a.contrast / 100;
  pass(g, "tone", t0, t3.tex, useCurve ? lutTex : null, w, h, p => {
    g.uniform1f(u(p, "u_black"), a.black); g.uniform1f(u(p, "u_span"), span); g.uniform1f(u(p, "u_inv"), inv);
    g.uniform1f(u(p, "u_c"), c); g.uniform1f(u(p, "u_bright"), a.brightness / 200); g.uniform1i(u(p, "u_curve"), useCurve ? 1 : 0);
  });
  let cur = t0;
  const rest = (x: Tex) => [t0, t1, t2, t3].filter(t => t !== x);
  // lokaler Kontrast
  if ((a.local ?? 0) > 0) {
    const amount = Math.min(100, Math.max(0, a.local!));
    const r = Math.max(2, Math.round(Math.max(w, h) * 0.04));
    const base = blur(g, cur, rest(cur).slice(0, 3), w, h, r);
    const out = rest(cur).find(t => t !== base)!;
    const k = (amount / 100) * 1.6, limUp = 0.06 + 0.06 * (amount / 100);
    pass(g, "local", out, cur.tex, base.tex, w, h, p => {
      g.uniform1f(u(p, "u_k"), k); g.uniform1f(u(p, "u_limUp"), limUp); g.uniform1f(u(p, "u_limDown"), 0.18);
    });
    cur = out;
  }
  // Entrauschen
  if (a.denoise > 0) {
    const r = Math.round(a.denoise);
    if (r >= 1) cur = blur(g, cur, rest(cur).slice(0, 3), w, h, r);
  }
  // Schärfen
  if (a.sharpen > 0) {
    const soft = blur(g, cur, rest(cur).slice(0, 3), w, h, 1);
    const out = rest(cur).find(t => t !== soft)!;
    pass(g, "sharpen", out, cur.tex, soft.tex, w, h, p => g.uniform1f(u(p, "u_k"), a.sharpen / 40));
    cur = out;
  }
  if (a.invert) {
    const out = rest(cur)[0];
    pass(g, "invert", out, cur.tex, null, w, h);
    cur = out;
  }
  return cur;
}

function usable(g: GL, w: number, h: number): boolean {
  const max = g.getParameter(g.MAX_TEXTURE_SIZE);
  return w <= max && h <= max;
}

/**
 * Wie applyAdjustCpu, aber auf der Grafikkarte, mit sofortigem Zurücklesen (für Stellen, die nicht warten können).
 * Das Zurücklesen kostet im Browser viel Zeit – lohnt sich nur bei aufwendigen Einstellungen (lokaler Kontrast,
 * Entrauschen). Sonst null = CPU rechnet.
 */
export const gpuAdjust: AdjustAccelerator = (src, w, h, a) => {
  if (!((a.local ?? 0) > 0 || a.denoise >= 0.5)) return null;
  const g = init();
  if (!g || !usable(g, w, h)) return null;
  try {
    const res = readBack(g, compute(g, src, w, h, a), w, h);
    if (g.isContextLost() || g.getError() !== g.NO_ERROR) return null;
    return res;
  } catch {
    return null;
  }
};

let queue: Promise<unknown> = Promise.resolve();

/**
 * Wie applyAdjustCpu, auf der Grafikkarte, mit Zurücklesen im Hintergrund (Puffer + Warten auf die Grafikkarte):
 * gut dreimal schneller als sofortiges Zurücklesen. null = geht nicht (dann CPU).
 */
export function gpuAdjustAsync(src: Float32Array, w: number, h: number, a: Adjust): Promise<Float32Array | null> {
  const job = queue.then(async () => {
    const g = init();
    if (!g || !LITTLE_ENDIAN || !usable(g, w, h)) return null;
    let pbo: WebGLBuffer | null = null;
    try {
      const res = compute(g, src, w, h, a);
      if (!packTex || packW !== w || packH !== h) packTarget(g, w, h);
      pass(g, "pack", packTex!, res.tex, null, w, h);
      pbo = g.createBuffer();
      g.bindBuffer(g.PIXEL_PACK_BUFFER, pbo);
      g.bufferData(g.PIXEL_PACK_BUFFER, w * h * 4, g.STREAM_READ);
      g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, 0);
      g.bindBuffer(g.PIXEL_PACK_BUFFER, null);
      const fence = g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
      g.flush();
      // warten, bis die Grafikkarte fertig ist – ohne das Fenster/den Thread zu blockieren
      const t0 = performance.now();
      while (g.clientWaitSync(fence, 0, 0) === g.TIMEOUT_EXPIRED) {
        if (g.isContextLost() || performance.now() - t0 > 10_000) { g.deleteSync(fence); return null; }
        await new Promise(r => setTimeout(r, 2));
      }
      g.deleteSync(fence);
      const out = new Float32Array(w * h);
      g.bindBuffer(g.PIXEL_PACK_BUFFER, pbo);
      g.getBufferSubData(g.PIXEL_PACK_BUFFER, 0, new Uint8Array(out.buffer));
      g.bindBuffer(g.PIXEL_PACK_BUFFER, null);
      if (g.isContextLost() || g.getError() !== g.NO_ERROR) return null;
      return out;
    } catch {
      return null;
    } finally {
      if (pbo) g.deleteBuffer(pbo);
    }
  });
  queue = job.catch(() => null);
  return job;
}

/** Bild verbessern: wenn möglich auf der Grafikkarte (asynchron), sonst CPU */
export async function applyAdjustAsync(src: Float32Array, w: number, h: number, a: Adjust): Promise<Float32Array> {
  if (w * h >= 250_000) {
    const r = await gpuAdjustAsync(src, w, h, a);
    if (r) return r;
  }
  return applyAdjustCpu(src, w, h, a);
}

/** Grafikkarte für die Bildgravur einschalten (einmal beim Start bzw. im Hintergrund-Thread) */
export function enableGpuAdjust() { setAdjustAccelerator(gpuAdjust); }

/** Für Tests/Messungen: ist WebGL2 mit Gleitkomma-Flächen da? */
export function gpuAvailable(): boolean { return !!init(); }

