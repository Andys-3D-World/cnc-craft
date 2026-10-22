/**
 * KLEINER 3D-BETRACHTER (WebGL, ohne Zusatz-Bibliothek)
 *
 * Zeigt Dreiecks-Netze mit Bild (Material-Oberfläche mit Gravur) oder Farbe, Licht von schräg oben.
 * Maus: links ziehen = frei drehen (alle Richtungen, auch über Kopf), rechts ziehen oder Shift+links = verschieben,
 * Rad = Zoom, Doppelklick = Ansicht zurücksetzen. Welt: x rechts, y nach hinten, z nach oben (mm).
 */

export interface Mesh {
  pos: number[];          // x,y,z je Ecke
  nrm: number[];          // Normale je Ecke
  uv?: number[];          // Bild-Koordinaten je Ecke (nur mit Bild)
  tex?: HTMLCanvasElement;
  color?: [number, number, number];
  offset?: [number, number, number]; // Verschiebung beim Zeichnen (z. B. Teile herausheben)
}

type M4 = Float32Array;
const ident = (): M4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function mul(a: M4, b: M4): M4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const trans = (x: number, y: number, z: number): M4 => { const m = ident(); m[12] = x; m[13] = y; m[14] = z; return m; };
const rotX = (a: number): M4 => { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; };
const rotZ = (a: number): M4 => { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; };
function persp(fov: number, asp: number, near: number, far: number): M4 {
  const f = 1 / Math.tan(fov / 2), m = new Float32Array(16);
  m[0] = f / asp; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
  return m;
}

const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv;
uniform mat4 uMvp; uniform vec3 uOff;
varying vec3 vN; varying vec2 vUv;
void main() { vN = aNrm; vUv = aUv; gl_Position = uMvp * vec4(aPos + uOff, 1.0); }`;
const FS = `
precision mediump float;
varying vec3 vN; varying vec2 vUv;
uniform sampler2D uTex; uniform bool uUseTex; uniform vec3 uColor; uniform vec3 uLight;
void main() {
  vec3 base = uUseTex ? texture2D(uTex, vUv).rgb : uColor;
  vec3 n = normalize(vN);
  float d = abs(dot(n, uLight));                 // beidseitig beleuchtet
  float rim = 0.12 * abs(dot(n, vec3(-0.4, 0.6, 0.2)));
  gl_FragColor = vec4(base * (0.42 + 0.62 * d + rim), 1.0);
}`;

interface GpuMesh { buf: WebGLBuffer; count: number; tex: WebGLTexture | null; color: [number, number, number]; off: [number, number, number] }

export class Viewer3D {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private meshes: GpuMesh[] = [];
  private center = [0, 0, 0];
  private radius = 100;
  yaw = -0.5; pitch = -1.0; dist = 300; panX = 0; panY = 0;
  spin = false;
  private raf = 0;
  private alive = true;
  ok = true;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { antialias: true });
    if (!gl) { this.ok = false; this.gl = null as any; this.prog = null as any; return; }
    this.gl = gl;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { this.ok = false; }
    this.prog = p;
    this.mouse();
    const loop = () => {
      if (!this.alive) return;
      if (this.spin) this.yaw += 0.006;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Szene setzen; keepView = Kamera nicht zurücksetzen */
  setMeshes(list: Mesh[], keepView = false) {
    const gl = this.gl;
    if (!this.ok) return;
    for (const m of this.meshes) gl.deleteBuffer(m.buf);
    for (const t of new Set(this.meshes.map(m => m.tex))) if (t) gl.deleteTexture(t);
    this.meshes = [];
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const texCache = new Map<HTMLCanvasElement, WebGLTexture>();
    for (const m of list) {
      const n = m.pos.length / 3;
      if (!n) continue;
      const o = m.offset || [0, 0, 0];
      const data = new Float32Array(n * 8);
      for (let i = 0; i < n; i++) {
        data.set([m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2], m.nrm[i * 3], m.nrm[i * 3 + 1], m.nrm[i * 3 + 2], m.uv?.[i * 2] ?? 0, m.uv?.[i * 2 + 1] ?? 0], i * 8);
        x0 = Math.min(x0, m.pos[i * 3] + o[0]); x1 = Math.max(x1, m.pos[i * 3] + o[0]);
        y0 = Math.min(y0, m.pos[i * 3 + 1] + o[1]); y1 = Math.max(y1, m.pos[i * 3 + 1] + o[1]);
        z0 = Math.min(z0, m.pos[i * 3 + 2] + o[2]); z1 = Math.max(z1, m.pos[i * 3 + 2] + o[2]);
      }
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      let tex: WebGLTexture | null = null;
      if (m.tex) {
        tex = texCache.get(m.tex) || null;
        if (!tex) {
          tex = gl.createTexture()!;
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m.tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          texCache.set(m.tex, tex);
        }
      }
      this.meshes.push({ buf, count: n, tex, color: m.color || [0.7, 0.7, 0.7], off: [o[0], o[1], o[2]] });
    }
    if (!keepView && isFinite(x0)) {
      this.center = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
      this.radius = Math.max(10, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);
      this.reset();
    }
  }

  reset() { this.yaw = -0.5; this.pitch = -1.0; this.dist = this.radius * 2.6; this.panX = 0; this.panY = 0; }

  private draw() {
    const gl = this.gl, c = this.canvas;
    if (!this.ok) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(c.clientWidth * dpr)), H = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.06, 0.055, 0.085, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.prog);
    const view = mul(trans(this.panX, this.panY, -this.dist), mul(rotX(this.pitch), mul(rotZ(this.yaw), trans(-this.center[0], -this.center[1], -this.center[2]))));
    const proj = persp(0.6, W / H, Math.max(0.5, this.dist - this.radius * 4), this.dist + this.radius * 6);
    const P = this.prog;
    gl.uniformMatrix4fv(gl.getUniformLocation(P, "uMvp"), false, mul(proj, view));
    // Licht von vorn oben links (Weltrichtung)
    const L = [-0.35, -0.45, 0.82], ln = Math.hypot(L[0], L[1], L[2]);
    gl.uniform3f(gl.getUniformLocation(P, "uLight"), L[0] / ln, L[1] / ln, L[2] / ln);
    const aPos = gl.getAttribLocation(P, "aPos"), aNrm = gl.getAttribLocation(P, "aNrm"), aUv = gl.getAttribLocation(P, "aUv");
    for (const m of this.meshes) {
      gl.bindBuffer(gl.ARRAY_BUFFER, m.buf);
      gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 32, 0);
      if (aNrm >= 0) { gl.enableVertexAttribArray(aNrm); gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 32, 12); }
      if (aUv >= 0) { gl.enableVertexAttribArray(aUv); gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 32, 24); }
      gl.uniform3f(gl.getUniformLocation(P, "uOff"), m.off[0], m.off[1], m.off[2]);
      gl.uniform1i(gl.getUniformLocation(P, "uUseTex"), m.tex ? 1 : 0);
      gl.uniform3f(gl.getUniformLocation(P, "uColor"), m.color[0], m.color[1], m.color[2]);
      if (m.tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, m.tex); gl.uniform1i(gl.getUniformLocation(P, "uTex"), 0); }
      gl.drawArrays(gl.TRIANGLES, 0, m.count);
    }
  }

  private cleanup = () => {};
  private mouse() {
    const c = this.canvas;
    let mode: "rot" | "pan" | null = null, lx = 0, ly = 0;
    c.addEventListener("contextmenu", e => e.preventDefault());
    c.addEventListener("mousedown", e => {
      mode = e.button === 0 && !e.shiftKey ? "rot" : "pan";
      lx = e.clientX; ly = e.clientY;
      c.style.cursor = "grabbing";
    });
    const move = (e: MouseEvent) => {
      if (!mode) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      if (mode === "rot") { this.yaw += dx * 0.008; this.pitch += dy * 0.008; }
      else { const k = (this.dist / Math.max(200, c.clientHeight)) * 1.1; this.panX += dx * k; this.panY -= dy * k; }
    };
    const up = () => { mode = null; c.style.cursor = "grab"; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    this.cleanup = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    c.addEventListener("wheel", e => {
      e.preventDefault();
      this.dist = Math.min(this.radius * 12, Math.max(this.radius * 0.35, this.dist * Math.exp(e.deltaY * 0.0012)));
    }, { passive: false });
    c.addEventListener("dblclick", () => this.reset());
  }

  destroy() {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.cleanup();
    if (!this.ok) return;
    for (const m of this.meshes) this.gl.deleteBuffer(m.buf);
    for (const t of new Set(this.meshes.map(m => m.tex))) if (t) this.gl.deleteTexture(t);
    this.meshes = [];
  }
}
