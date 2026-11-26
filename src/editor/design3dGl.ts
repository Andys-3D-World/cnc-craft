/** ENTWURF IN 3D: kleine WebGL-Ausgabe (Netze mit Farbe oder Bild, durchsichtige Netze zuletzt, Linien) */
import type { M4 } from "./design3dMath";
import type { Mesh } from "../view3d/viewer3d";

const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv;
uniform mat4 uMvp; uniform vec3 uOff;
varying vec3 vN; varying vec2 vUv;
void main() { vN = aNrm; vUv = aUv; gl_Position = uMvp * vec4(aPos + uOff, 1.0); }`;
const FS = `
precision mediump float;
varying vec3 vN; varying vec2 vUv;
uniform sampler2D uTex; uniform bool uUseTex; uniform bool uFlat; uniform vec4 uColor;
void main() {
  vec4 base = uUseTex ? texture2D(uTex, vUv) : uColor;
  if (uFlat) { gl_FragColor = base; return; }
  vec3 n = normalize(vN);
  float d = abs(dot(n, normalize(vec3(-0.35, -0.45, 0.82))));
  gl_FragColor = vec4(base.rgb * (0.45 + 0.6 * d), base.a);
}`;

export interface Mesh3 extends Mesh { alpha?: number; flat?: boolean }
interface Gpu { buf: WebGLBuffer; ibuf: WebGLBuffer | null; n: number; tex: WebGLTexture | null; m: Mesh3 }

export class Design3dGl {
  ok = false;
  private gl: WebGLRenderingContext | null;
  private prog: WebGLProgram | null = null;
  private layers = new Map<string, Gpu[]>();
  private sheetTex: WebGLTexture | null = null;
  private sheetBuf: WebGLBuffer | null = null;
  private sheetOn = false;

  constructor(canvas: HTMLCanvasElement) {
    const gl = this.gl = canvas.getContext("webgl", { antialias: true });
    if (!gl) return;
    gl.getExtension("OES_element_index_uint");
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const p = this.prog = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    this.ok = !!gl.getProgramParameter(p, gl.LINK_STATUS);
  }

  private tex(src: HTMLCanvasElement, old: WebGLTexture | null = null): WebGLTexture {
    const gl = this.gl!, x = old || gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, x);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return x;
  }

  private drop(list: Gpu[] | undefined) {
    const gl = this.gl!;
    for (const g of list || []) { gl.deleteBuffer(g.buf); if (g.ibuf) gl.deleteBuffer(g.ibuf); if (g.tex) gl.deleteTexture(g.tex); }
  }

  /** Eine Ebene der Szene ersetzen (z. B. "block", "walls", "bed") */
  set(layer: string, meshes: Mesh3[]) {
    const gl = this.gl;
    if (!gl || !this.ok) return;
    this.drop(this.layers.get(layer));
    this.layers.set(layer, meshes.flatMap(m => {
      const n = m.data ? m.data.length / 8 : m.pos.length / 3;
      if (!n) return [];
      let data = m.data;
      if (!data) {
        data = new Float32Array(n * 8);
        for (let i = 0; i < n; i++) data.set([m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2], m.nrm[i * 3] ?? 0, m.nrm[i * 3 + 1] ?? 0, m.nrm[i * 3 + 2] ?? 1, m.uv?.[i * 2] ?? 0, m.uv?.[i * 2 + 1] ?? 0], i * 8);
      }
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      let ibuf: WebGLBuffer | null = null;
      if (m.index) { ibuf = gl.createBuffer()!; gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.index, gl.STATIC_DRAW); }
      return [{ buf, ibuf, n: m.index ? m.index.length : n, tex: m.tex ? this.tex(m.tex) : null, m: { ...m, pos: [], nrm: [], uv: undefined, data: undefined, index: undefined, tex: undefined } }];
    }));
  }

  /** Die Zeichnung als durchsichtiges Bild auf der Oberseite (z); b = Bereich in mm */
  sheet(src: HTMLCanvasElement, b: { x0: number; y0: number; x1: number; y1: number }, z: number) {
    const gl = this.gl;
    if (!gl || !this.ok) return;
    this.sheetTex = this.tex(src, this.sheetTex);
    this.sheetBuf ??= gl.createBuffer();
    const v = (x: number, y: number, u: number, w: number) => [x, y, z, 0, 0, 1, u, w];
    const q = [v(b.x0, b.y0, 0, 1), v(b.x1, b.y0, 1, 1), v(b.x1, b.y1, 1, 0), v(b.x0, b.y0, 0, 1), v(b.x1, b.y1, 1, 0), v(b.x0, b.y1, 0, 0)].flat();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sheetBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(q), gl.DYNAMIC_DRAW);
    this.sheetOn = true;
  }

  draw(w: number, h: number, mvp: M4, bg: [number, number, number]) {
    const gl = this.gl, P = this.prog;
    if (!gl || !P || !this.ok) return;
    gl.viewport(0, 0, w, h);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(P);
    const U = (n: string) => gl.getUniformLocation(P, n);
    gl.uniformMatrix4fv(U("uMvp"), false, mvp);
    const bind = (buf: WebGLBuffer) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (const [name, size, off] of [["aPos", 3, 0], ["aNrm", 3, 12], ["aUv", 2, 24]] as const) {
        const a = gl.getAttribLocation(P, name);
        if (a >= 0) { gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, size, gl.FLOAT, false, 32, off); }
      }
    };
    const one = (g: Gpu) => {
      bind(g.buf);
      const o = g.m.offset || [0, 0, 0], c = g.m.color || [0.7, 0.7, 0.7], al = g.m.alpha ?? 1;
      gl.uniform3f(U("uOff"), o[0], o[1], o[2]);
      gl.uniform1i(U("uFlat"), g.m.lines || g.m.flat ? 1 : 0);
      gl.uniform1i(U("uUseTex"), g.tex ? 1 : 0);
      gl.uniform4f(U("uColor"), c[0] * al, c[1] * al, c[2] * al, al);
      if (g.tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g.tex); gl.uniform1i(U("uTex"), 0); }
      const mode = g.m.lines ? gl.LINES : gl.TRIANGLES;
      if (g.ibuf) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibuf); gl.drawElements(mode, g.n, gl.UNSIGNED_INT, 0); } else gl.drawArrays(mode, 0, g.n);
    };
    const all = [...this.layers.values()].flat();
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    all.filter(g => (g.m.alpha ?? 1) >= 1).forEach(one);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    all.filter(g => (g.m.alpha ?? 1) < 1).forEach(one);
    if (this.sheetOn) {
      bind(this.sheetBuf!);
      gl.uniform3f(U("uOff"), 0, 0, 0); gl.uniform1i(U("uFlat"), 1); gl.uniform1i(U("uUseTex"), 1);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sheetTex); gl.uniform1i(U("uTex"), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.depthMask(true);
  }

  destroy() {
    const gl = this.gl;
    if (!gl) return;
    for (const l of this.layers.values()) this.drop(l);
    this.layers.clear();
    if (this.sheetTex) gl.deleteTexture(this.sheetTex);
    if (this.sheetBuf) gl.deleteBuffer(this.sheetBuf);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
