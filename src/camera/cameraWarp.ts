/**
 * KAMERABILD ENTZERREN (WebGL – schnell genug für Live-Bild)
 *
 * Zwei Arten:
 *   "lens" – nur die Linsen-Verzeichnung herausrechnen; Ausgabe hat die Form des Kamerabilds
 *            (für den Ausrichte-Assistenten)
 *   "bed"  – Bild so umrechnen, dass es genau auf das Bett passt (Linse + Perspektive);
 *            Ausgabe = Bett von oben, links unten = Nullpunkt (für die Arbeitsfläche)
 *
 * Für jeden Ausgabe-Pixel wird zurückgerechnet, wo er im Kamerabild liegt (siehe cameraMath.ts),
 * und dort gelesen. Drehen um 180° und Spiegeln passieren beim Lesen.
 */
import { Mat3 } from "./cameraMath";

const VS = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `
precision highp float;
uniform sampler2D tex;
uniform vec2 outSize;
uniform int mode;          // 0 = Linse, 1 = Bett
uniform mat3 H;            // Bett-mm -> unverzerrt normiert (nur mode 1)
uniform vec2 bed;          // Bett in mm
uniform float k1;
uniform float ar;          // Breite/Höhe des Kamerabilds
uniform float rot;         // 1 = 180° gedreht
uniform float mir;         // 1 = gespiegelt
void main() {
  vec2 f = gl_FragCoord.xy / outSize;            // 0..1, y unten = 0
  vec2 n;
  if (mode == 0) {
    vec2 uv = vec2(f.x, 1.0 - f.y);              // Bildkoordinate (oben = 0)
    n = vec2((uv.x - 0.5) * 2.0 * ar, (uv.y - 0.5) * 2.0);
  } else {
    vec3 c = H * vec3(f.x * bed.x, f.y * bed.y, 1.0);
    if (c.z <= 0.0) { gl_FragColor = vec4(0.0); return; }
    n = c.xy / c.z;
  }
  float r2 = dot(n, n);
  vec2 d = n * (1.0 + k1 * r2);                  // Linsen-Verzeichnung anwenden
  vec2 uv = vec2(d.x / (2.0 * ar) + 0.5, d.y / 2.0 + 0.5);
  if (rot > 0.5) uv = 1.0 - uv;
  if (mir > 0.5) uv.x = 1.0 - uv.x;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  gl_FragColor = texture2D(tex, uv);
}`;

export interface WarpOptions {
  mode: "lens" | "bed";
  k1: number;
  rot180: boolean;
  mirror: boolean;
  H?: Mat3;           // für "bed"
  bedW?: number;      // mm
  bedH?: number;
  outW: number;       // Ausgabe-Pixel
  outH: number;
}

export class Warper {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};

  constructor() {
    this.canvas = document.createElement("canvas");
    this.gl = this.canvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (this.gl) this.setup(this.gl);
  }

  get ok(): boolean { return !!this.gl && !!this.prog; }

  private setup(gl: WebGLRenderingContext) {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return;
    const p = gl.createProgram()!;
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(p)); return; }
    this.prog = p;
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(p, "p");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const n of ["tex", "outSize", "mode", "H", "bed", "k1", "ar", "rot", "mir"]) this.loc[n] = gl.getUniformLocation(p, n);
  }

  /** Bildquelle (Video, Bild, ImageBitmap, Canvas) umrechnen. srcW/srcH = echte Größe der Quelle. */
  render(src: TexImageSource, srcW: number, srcH: number, o: WarpOptions): boolean {
    const gl = this.gl;
    if (!gl || !this.prog || srcW <= 0 || srcH <= 0) return false;
    if (this.canvas.width !== o.outW) this.canvas.width = o.outW;
    if (this.canvas.height !== o.outH) this.canvas.height = o.outH;
    gl.viewport(0, 0, o.outW, o.outH);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch (e) {
      console.warn("Kamerabild nicht lesbar", e);
      return false;
    }
    const L = this.loc;
    gl.uniform1i(L.tex, 0);
    gl.uniform2f(L.outSize, o.outW, o.outH);
    gl.uniform1i(L.mode, o.mode === "bed" ? 1 : 0);
    const H = o.H || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    // WebGL erwartet die Matrix spaltenweise
    gl.uniformMatrix3fv(L.H, false, new Float32Array([H[0], H[3], H[6], H[1], H[4], H[7], H[2], H[5], H[8]]));
    gl.uniform2f(L.bed, o.bedW || 1, o.bedH || 1);
    gl.uniform1f(L.k1, o.k1);
    gl.uniform1f(L.ar, srcW / srcH);
    gl.uniform1f(L.rot, o.rot180 ? 1 : 0);
    gl.uniform1f(L.mir, o.mirror ? 1 : 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
}
