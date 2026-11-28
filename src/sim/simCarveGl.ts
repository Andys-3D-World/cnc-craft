/**
 * MATERIAL UND FRÄSER AUF DER GRAFIKKARTE (WebGL2) für die Simulation (simView.ts)
 *
 * Das Höhenraster aus simCarve.ts liegt als Textur auf der Grafikkarte; nach jedem Bild wird nur der geänderte
 * Ausschnitt hochgeladen. Jede Zelle ist ein Viereck (zwei Dreiecke), dessen Ecken ihre Höhe selbst aus der Textur
 * holen – es gibt keine Punkt-Liste, die bei jedem Schritt neu gebaut werden müsste. Dazu die vier Seitenwände
 * des Rohteils. Durchgefräste Stellen (tiefer als die Unterseite) bleiben offen.
 *
 * Fräser, Schaft, Spannmutter und Spindel sind Drehkörper (aus dem Fräser-Profil von carveSim.ts);
 * Spannmutter und Spindel halb durchsichtig, damit man von oben noch sieht, wo gefräst wird.
 * Laser: flache Platte, Brandspur nach Dosis, Schnitte offen; Laserkopf mit Strahl (wenn an).
 * Plasma: Blech mit Schnittspalt und Anlauffarbe; Brenner mit Lichtbogen.
 * Drehachse: dieselben Zellen um den Körper gelegt (rund/Kegel: Ecke = Winkel × R, Höhe = Radius; eckig: Flächen
 * nebeneinander, Höhe = senkrecht zur Fläche), die Enden als Scheiben.
 * Wie an der Maschine dreht sich das Teil: die Stelle, an der gerade gearbeitet wird, liegt oben, das Werkzeug
 * steht senkrecht darüber.
 * Drumherum (abschaltbar, machineMesh.ts): Bett, Portal, Spannpratzen, Futter und Reitstock oder Rollen der Drehachse.
 * Gleiche Kamera wie simGl.ts (Drehung, Neigung, Maßstab), dazu ein Tiefenpuffer.
 */
import { PLASMA_CUT, type LiveCarve, type ToolHolder } from "./simCarve";
import { materialTile, isWoody, type Material } from "../materialView";
import { profile } from "../view3d/carveSim";
import { CHUNK, ChunkGrid } from "./carveChunks.ts";
import { cornerRadius, faces, perimeter } from "../rotaryStock";
import { bedMesh, carriageMesh, clampMesh, gantryMesh, rollers, rotaryChuck, rotaryFixed } from "./machineMesh";
import type { ToolGeom } from "../toolGraphics";
import { millToolMesh } from "./toolMesh.ts";
import { rustMillMesh } from "../toolRust.ts";

type GL = WebGL2RenderingContext;

// gemeinsame Kamera: Bildschirm-Pixel + Tiefe (größer = näher am Betrachter)
const CAM = `
uniform vec2 u_size; uniform vec2 u_origin; uniform vec3 u_center; uniform vec4 u_rot; uniform float u_scale; uniform float u_dscale;
vec4 project(vec3 p) {
  vec3 d = p - u_center;
  float x = d.x * u_rot.x - d.y * u_rot.y;
  float yv = d.x * u_rot.y + d.y * u_rot.x;
  float y = yv * u_rot.z + d.z * u_rot.w;
  float depth = d.z * u_rot.z - yv * u_rot.w;
  vec2 s = vec2(u_origin.x + x * u_scale, u_origin.y - y * u_scale);
  return vec4(s.x / u_size.x * 2.0 - 1.0, 1.0 - s.y / u_size.y * 2.0, -depth * u_dscale, 1.0);
}
const vec3 LIGHT = normalize(vec3(-0.45, -0.6, 0.75));
`;

const STOCK_VS = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D u_h;
uniform ivec2 u_n;          // Zellen
uniform vec3 u_grid;        // x0, y0, Zellgröße
uniform float u_T;          // Dicke
uniform int u_side;         // 0 = Oberfläche, 1..4 = Wand unten/oben/links/rechts (Drehachse: 3/4 = Enden)
uniform int u_kind;         // 0 = Höhe (Fräse), 1 = Dosis (Laser/Plasma, Oberfläche bleibt bei 0)
uniform vec2 u_cyl;         // Radius (0 = flach), 1 = Achse entlang Y
uniform float u_spin;       // Drehachse: so weit ist das Teil gedreht (rad)
uniform int u_body;         // 1 = rund/Kegel, 2 = eckig
uniform vec4 u_rev;         // r0, r1, Länge, Radius für den Winkel
uniform vec4 u_face[12];    // Anfang, Ende, Abstand zur Achse, Winkel (rad)
uniform int u_nf; uniform float u_per;
${CAM}
out vec3 v_n; out float v_z; out float v_d; out vec2 v_xy; out float v_side;
float V(int i, int j) {
  if (u_cyl.x > 0.0) j = (j % u_n.y + u_n.y) % u_n.y;
  return texelFetch(u_h, ivec2(clamp(i, 0, u_n.x - 1), clamp(j, 0, u_n.y - 1)), 0).r;
}
float H(int i, int j) { return u_kind == 0 ? max(V(i, j), -u_T) : 0.0; }
// Zelle (i, j) mit Höhe z -> Welt (Drehachse: um den Zylinder, Achse bei y = 0, z = -R)
vec3 P(float fi, float fj, float z) {
  float u = u_grid.x + (fi + 0.5) * u_grid.z, v = u_grid.y + (fj + 0.5) * u_grid.z;
  if (u_cyl.x <= 0.0) return vec3(u, v, z);
  vec2 q = vec2(0.0);       // quer, Höhe über der Achse (am Teil, ungedreht)
  if (z > -1e5) {
    if (u_body == 2) {
      float w = mod(v, u_per);
      vec4 f = u_face[0];
      for (int k = 0; k < u_nf; k++) { f = u_face[k]; if (w < f.y) break; }
      float t = w - (f.x + f.y) * 0.5, rr = max(0.0, f.z + z), c = cos(f.w), s = sin(f.w);
      q = vec2((t * c + rr * s) * (u_cyl.y > 0.5 ? -1.0 : 1.0), -t * s + rr * c);
    } else {
      float r = mix(u_rev.x, u_rev.y, clamp(u / u_rev.z, 0.0, 1.0)), a = v / u_rev.w, rr = max(0.0, r + z);
      q = rr * vec2(sin(a), cos(a));
    }
  }
  float cs = cos(u_spin), sn = sin(u_spin);
  float py = q.x * cs - q.y * sn, pz = q.x * sn + q.y * cs - u_cyl.x;
  return u_cyl.y > 0.5 ? vec3(-py, u, pz) : vec3(u, py, pz);
}
vec3 PC(int i, int j) { return P(float(i), float(j), H(i, j)); }
void main() {
  int k = gl_VertexID;
  int a = (k == 1 || k == 2 || k == 4) ? 1 : 0;       // Ecke entlang
  int b = (k == 2 || k == 4 || k == 5) ? 1 : 0;       // Ecke quer / oben
  int q = gl_InstanceID;
  bool cyl = u_cyl.x > 0.0;
  int i, j; float z; vec3 n; vec3 p; float d = 0.0;
  if (u_side == 0) {
    // Eckpunkt = Rasterpunkt (Nummernliste aus carveChunks.ts, jeder Punkt wird nur einmal gerechnet)
    i = k % u_n.x; j = k / u_n.x;
    z = H(i, j); d = V(i, j);
    p = P(float(i), float(j), z);
    n = normalize(cross(PC(i + 1, j) - PC(i - 1, j), PC(i, j + 1) - PC(i, j - 1)));
    // eckig, Achse entlang Y: das Band läuft andersherum – sonst zeigte die Normale nach innen
    if (u_body == 2 && u_cyl.y > 0.5) n = -n;
  } else if (cyl) {
    // Enden: Fächer von der Achse zum Rand
    i = u_side == 3 ? 0 : u_n.x - 1; j = q + a;
    z = b == 1 ? H(i, j) : -1e6;
    p = P(float(i), float(j), z);
    vec3 ax = u_cyl.y > 0.5 ? vec3(0, 1, 0) : vec3(1, 0, 0);
    n = u_side == 3 ? -ax : ax;
  } else {
    bool alongX = u_side <= 2;
    int e = q + a;
    i = alongX ? e : (u_side == 3 ? 0 : u_n.x - 1);
    j = alongX ? (u_side == 1 ? 0 : u_n.y - 1) : e;
    z = b == 1 ? H(i, j) : -u_T;
    p = P(float(i), float(j), z);
    n = u_side == 1 ? vec3(0, -1, 0) : u_side == 2 ? vec3(0, 1, 0) : u_side == 3 ? vec3(-1, 0, 0) : vec3(1, 0, 0);
  }
  gl_Position = project(p);
  v_n = n; v_z = z; v_d = d; v_xy = vec2(u_grid.x + float(i) * u_grid.z, u_grid.y + float(j) * u_grid.z); v_side = float(u_side);
}`;

const STOCK_FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_tex;    // Oberfläche des Materials (materialView.ts)
uniform vec3 u_base; uniform vec3 u_core; uniform vec3 u_burn; uniform vec3 u_layers;
uniform float u_ply;        // Sperrholz: Lagendicke (mm), 0 = keins
uniform float u_darken;     // gefräste Stellen nach Tiefe dunkler (Holz 1, Metall wenig)
uniform float u_gloss; uniform vec3 u_view;
uniform float u_T;
uniform int u_kind; uniform float u_cut; uniform float u_plasma; uniform float u_cylR;
in vec3 v_n; in float v_z; in float v_d; in vec2 v_xy; in float v_side;
out vec4 o;
const vec3 LIGHT = normalize(vec3(-0.45, -0.6, 0.75));
void main() {
  bool top = v_side < 0.5;
  // Kachel = 200 mm; in 3D feiner (80 mm) und ruhiger, sonst wirken die Jahresringe wie Wellen
  vec3 t = mix(u_base, texture(u_tex, v_xy / 80.0).rgb, 0.65);
  vec3 grain = (t + 0.03) / (u_base + 0.03);                         // Muster der Oberfläche (um 1)
  bool cut = !top || (u_kind == 0 && v_z < -0.004);
  vec3 c = cut ? u_core * grain : t;
  // Sperrholz: Lagen mit Leimfuge, jede zweite Lage quer (etwas dunkler)
  if (u_ply > 0.0 && cut) {
    float f = -v_z / u_ply;
    c *= mod(floor(f), 2.0) < 0.5 ? 1.0 : 0.9;
    if (fract(f) < 0.07 && -v_z > 0.05) c = u_layers;
  }
  if (u_kind == 0) {
    if (top && u_cylR <= 0.0 && v_z < -u_T + 0.01) discard;          // durchgefräst
    float depth = clamp(-v_z / u_T, 0.0, 1.0);
    if (top && cut) c *= 1.0 - u_darken * (0.1 + 0.2 * depth);       // gefräste Flächen etwas dunkler, tiefer dunkler
  } else if (top) {
    // durchgeschnitten (Schwelle halbiert: dünne Schnitte sind sonst zwischen den Zellen-Ecken gestrichelt)
    if (v_d >= u_cut * 0.5) discard;
    if (u_plasma > 0.5) c = mix(c, vec3(0.36, 0.27, 0.42), clamp(v_d / 0.6, 0.0, 1.0) * 0.75);   // Anlauffarbe
    else c = mix(c, u_burn, 1.0 - exp(-6.0 * v_d));                  // Brandspur
  }
  if (!top) c *= 0.92;
  vec3 n = normalize(v_n);
  float l = 0.4 + 0.62 * max(dot(n, LIGHT), 0.0);
  // Glanz: Glanzlicht + angedeuteter heller Himmel in der Spiegelung (Metall, Acryl)
  vec3 h = normalize(LIGHT + u_view);
  float spec = u_gloss * pow(max(dot(n, h), 0.0), 8.0 + 70.0 * u_gloss) * 0.9;
  float sky = clamp(reflect(-u_view, n).z * 0.5 + 0.5, 0.0, 1.0);
  c *= mix(1.0, 0.75 + 0.45 * sky, u_gloss * 0.6);
  o = vec4(c * l + spec * mix(vec3(1.0), c, 0.3), 1.0);
}`;

const MESH_VS = `#version 300 es
precision highp float;
in vec3 a_p; in vec3 a_n; in vec4 a_c;
uniform vec3 u_at;
uniform vec2 u_zmap;        // z = x + z · y (Strahl/Lichtbogen auf Länge ziehen; sonst 0, 1)
uniform vec3 u_turn;        // Drehachse: cos, sin des Winkels, 1 = Achse entlang Y
uniform float u_spinA;      // Fräser dreht sich um seine Achse (rad), sonst 0
${CAM}
out vec3 v_n; out vec4 v_c; out vec3 v_v;
vec3 turn(vec3 p) {
  // um die Achse (intern entlang X) drehen, dann wie gezeigt legen
  vec3 q = vec3(p.x, p.y * u_turn.x + p.z * u_turn.y, -p.y * u_turn.y + p.z * u_turn.x);
  return u_turn.z > 0.5 ? vec3(-q.y, q.x, q.z) : q;
}
void main() {
  float cs = cos(u_spinA), sn = sin(u_spinA);
  mat2 R = mat2(cs, sn, -sn, cs);
  vec3 p = vec3(R * a_p.xy, u_zmap.x + a_p.z * u_zmap.y);
  gl_Position = project(turn(p) + u_at); v_n = turn(vec3(R * a_n.xy, a_n.z)); v_c = a_c;
  // Richtung zum Betrachter (die Kamera schaut überall gleich: keine Perspektive)
  v_v = vec3(-u_rot.y * u_rot.w, -u_rot.x * u_rot.w, u_rot.z);
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 v_n; in vec4 v_c; in vec3 v_v;
out vec4 o;
const vec3 LIGHT = normalize(vec3(-0.45, -0.6, 0.75));
const vec3 KEY = normalize(vec3(-0.55, -0.75, 0.2));
const vec3 RIM = normalize(vec3(0.85, 0.35, 0.1));
void main() {
  vec3 n = normalize(v_n);
  // Farbe über 1 = leuchtet (Strahl, Lichtbogen): ohne Licht
  if (v_c.r > 1.0) { o = vec4((v_c.rgb - 1.0) * v_c.a, v_c.a); return; }
  if (v_c.a > 1.0) {
    // Deckkraft über 1 = blankes Metall (Fräser, Schaft, Spannmutter): spiegelt zwei helle Flächen und den Himmel
    float a = v_c.a - 1.0;
    vec3 V = normalize(v_v);
    if (dot(n, V) < 0.0) n = -n;
    vec3 r = reflect(-V, n);
    vec3 rh = normalize(vec3(r.xy, r.z * 0.4));
    float key = pow(max(dot(rh, KEY), 0.0), 3.0);
    float rim = pow(max(dot(rh, RIM), 0.0), 14.0);
    float sky = smoothstep(-0.95, 0.7, r.z);
    float diff = 0.5 + 0.5 * max(dot(n, LIGHT), 0.0);
    float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    vec3 c = v_c.rgb * (0.22 + 0.34 * diff + 0.4 * sky + 0.75 * key) + vec3(pow(key, 3.0) * 0.5 + rim * 0.45 + fres * 0.15);
    o = vec4(c * a, a);
    return;
  }
  float l = 0.45 + 0.55 * abs(dot(n, LIGHT));
  float spec = pow(max(dot(reflect(-LIGHT, n), vec3(0.0, 0.0, 1.0)), 0.0), 18.0) * 0.35;
  o = vec4((v_c.rgb * l + spec) * v_c.a, v_c.a);
}`;

export interface MaterialView {
  W: number; H: number;
  originX: number; originY: number;
  center: { x: number; y: number; z: number };
  yaw: number; pitch: number; scale: number;
  /** Aussehen des Rohteils (materialView.ts) */
  look: Material;
  /** Werkzeug zeigen (Spitze / Fokus bei x, y, z) – null = keins; on = Laser/Plasma an; spin = Fräser dreht sich gerade */
  tool: { x: number; y: number; z: number; kind: "mill" | "laser" | "plasma"; geom: ToolGeom | null; holder: ToolHolder; on: boolean; spin?: boolean } | null;
  /** Maschine drumherum zeigen – null = nur Material und Werkzeug */
  env?: MachineEnv | null;
}
export interface MachineEnv { bedW: number; bedH: number; zones: { pts: { x: number; y: number }[]; height: number }[]; rollerDia: number | null }


/** Drehkörper aus einem Umriss (r, z) – Dreiecke mit Normalen und Farbe: je Punkt 10 Zahlen */
function lathe(out: number[], pts: [number, number][], col: [number, number, number], alpha: number, seg = 36) {
  for (let k = 0; k + 1 < pts.length; k++) {
    const [r0, z0] = pts[k], [r1, z1] = pts[k + 1];
    // Normale des Umriss-Stücks (nach außen)
    const dr = r1 - r0, dz = z1 - z0, l = Math.hypot(dr, dz) || 1;
    const nr = dz / l, nz = -dr / l;
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const v = (r: number, z: number, c: number, sn: number) =>
        out.push(r * c, r * sn, z, nr * c, nr * sn, nz, col[0], col[1], col[2], alpha);
      v(r0, z0, c0, s0); v(r0, z0, c1, s1); v(r1, z1, c1, s1);
      v(r0, z0, c0, s0); v(r1, z1, c1, s1); v(r1, z1, c0, s0);
    }
  }
}

// Laserkopf / Plasma-Brenner (Spitze bzw. Fokus bei 0); leuchtende Farben + 1 (siehe MESH_FS)
const LASER_NOZZLE: [number, number, number] = [0.25, 0.25, 0.28];
const LASER_BODY: [number, number, number] = [0.12, 0.13, 0.16];
const LASER_BEAM: [number, number, number] = [1.55, 1.45, 2.0];
const TORCH: [number, number, number] = [0.72, 0.5, 0.25];
const TORCH_BODY: [number, number, number] = [0.15, 0.15, 0.17];
const ARC: [number, number, number] = [1.75, 1.85, 2.0];
const LASER_FOCUS = 6;   // Abstand Düse – Werkstück (mm)

function headMesh(kind: "laser" | "plasma"): { solid: Float32Array; ghost: Float32Array } {
  const solid: number[] = [], ghost: number[] = [];
  if (kind === "laser") {
    const z = LASER_FOCUS;
    lathe(solid, [[0, z], [1.2, z], [4, z + 6], [4, z + 10]], LASER_NOZZLE, 1, 24);
    lathe(ghost, [[4, z + 10], [21, z + 10], [21, z + 70], [0, z + 70]], LASER_BODY, 0.5, 4);
  } else {
    lathe(solid, [[0, 0], [1.4, 0], [5, 6], [8, 14], [11, 22]], TORCH, 1, 24);
    lathe(ghost, [[11, 22], [12, 22], [12, 110], [0, 110]], TORCH_BODY, 0.5, 24);
  }
  return { solid: new Float32Array(solid), ghost: new Float32Array(ghost) };
}

/** Strahl / Lichtbogen: dünner Zylinder z = 0…1 (wird über u_zmap auf Länge gezogen) */
function beamMesh(kind: "laser" | "plasma"): Float32Array {
  const out: number[] = [];
  if (kind === "laser") lathe(out, [[0, 0], [0.25, 0], [0.6, 1], [0, 1]], LASER_BEAM, 0.9, 12);
  else lathe(out, [[0, 0], [1.6, 0], [0.9, 1], [0, 1]], ARC, 0.85, 12);
  return new Float32Array(out);
}

/**
 * Fräser mit Nuten, Schaft, Spannmutter und Spindel; der Umriss ist derselbe, mit dem gefräst wird.
 * In der App rechnet Rust (toolmesh.rs) – bis die Antwort da ist, fehlt der Fräser für einen Augenblick, dann ruft
 * es `ready`. Im Browser rechnet toolMesh.ts sofort.
 */
function toolMesh(tl: ToolGeom | null, hd: ToolHolder, ready: () => void): { solid: Float32Array; ghost: Float32Array } {
  const f = profile(tl), R = hd.R;
  const outline: [number, number][] = [];
  for (let k = 0; k <= 14; k++) {
    const r = (k / 14) * R, z = f(r);
    outline.push([r, Number.isFinite(z) ? Math.min(z, hd.fluteLen) : 0]);
  }
  outline.push([R, hd.fluteLen]);
  const fast = rustMillMesh(tl, hd, outline, ready);
  if (fast === "wait") return { solid: new Float32Array(0), ghost: new Float32Array(0) };
  return fast ?? millToolMesh(tl, hd, outline);
}

export class MaterialRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: GL | null = null;
  private broken = false;
  private stockProg: WebGLProgram | null = null;
  private meshProg: WebGLProgram | null = null;
  private sloc: Record<string, WebGLUniformLocation | null> = {};
  private mloc: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  private meshVao: WebGLVertexArrayObject | null = null;
  private meshBuf: WebGLBuffer | null = null;
  private meshKey: unknown = null;
  /** wird gerufen, wenn ein später geliefertes Werkzeug-Bild da ist: bitte neu zeichnen */
  onReady: (() => void) | null = null;
  private spinA = 0;
  private spinAt = 0;
  private meshCounts = { solid: 0, ghost: 0, beam: 0 };
  private envVao: WebGLVertexArrayObject | null = null;
  private envBuf: WebGLBuffer | null = null;
  private envKey = "";
  private envParts: Record<string, [number, number]> = {};
  private tex: WebGLTexture | null = null;
  private texFor: LiveCarve | null = null;
  private chunks: ChunkGrid | null = null;
  private chunksFor: LiveCarve | null = null;
  private indexBuf: WebGLBuffer | null = null;
  private readonly scratch = new Uint32Array(CHUNK * CHUNK * 6);
  private readonly pending = new Set<number>();
  private lookTex: WebGLTexture | null = null;
  private lookId = "";

  constructor() { this.canvas = document.createElement("canvas"); }

  private init(): GL | null {
    if (this.broken) return null;
    if (this.gl) return this.gl.isContextLost() ? null : this.gl;
    try {
      // Retina: doppelt so viele Pixel – Kantenglättung bringt dort kaum mehr, kostet aber viel
      const g = this.canvas.getContext("webgl2", { antialias: (window.devicePixelRatio || 1) < 1.5, premultipliedAlpha: true, alpha: true, depth: true }) as GL | null;
      if (!g) { this.broken = true; return null; }
      const sh = (type: number, src: string) => {
        const s = g.createShader(type)!;
        g.shaderSource(s, src); g.compileShader(s);
        if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) || "shader");
        return s;
      };
      const link = (vs: string, fs: string) => {
        const p = g.createProgram()!;
        g.attachShader(p, sh(g.VERTEX_SHADER, vs)); g.attachShader(p, sh(g.FRAGMENT_SHADER, fs));
        g.linkProgram(p);
        if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) || "link");
        return p;
      };
      this.stockProg = link(STOCK_VS, STOCK_FS);
      this.meshProg = link(MESH_VS, MESH_FS);
      const cam = ["u_size", "u_origin", "u_center", "u_rot", "u_scale", "u_dscale"];
      for (const n of [...cam, "u_h", "u_n", "u_grid", "u_T", "u_side", "u_kind", "u_cyl", "u_body", "u_rev", "u_face", "u_nf", "u_per", "u_burn", "u_cut", "u_plasma", "u_cylR", "u_spin",
        "u_tex", "u_base", "u_core", "u_layers", "u_ply", "u_darken", "u_gloss", "u_view"]) this.sloc[n] = g.getUniformLocation(this.stockProg, n);
      for (const n of [...cam, "u_at", "u_zmap", "u_turn", "u_spinA"]) this.mloc[n] = g.getUniformLocation(this.meshProg, n);
      this.vao = g.createVertexArray();
      this.canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); this.gl = null; this.texFor = null; this.broken = true; });
      this.gl = g;
      return g;
    } catch (e) {
      console.warn("material view:", e);
      this.broken = true;
      return null;
    }
  }

  /** Oberflächen-Bild des Materials (Kachel aus materialView.ts) auf Textur-Platz 1 */
  private uploadLook(g: GL, m: Material) {
    g.activeTexture(g.TEXTURE1);
    if (this.lookId !== m.id || !this.lookTex) {
      if (!this.lookTex) this.lookTex = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, this.lookTex);
      g.pixelStorei(g.UNPACK_ROW_LENGTH, 0); g.pixelStorei(g.UNPACK_SKIP_PIXELS, 0); g.pixelStorei(g.UNPACK_SKIP_ROWS, 0);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, materialTile(m));
      g.generateMipmap(g.TEXTURE_2D);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.REPEAT);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.REPEAT);
      this.lookId = m.id;
    } else g.bindTexture(g.TEXTURE_2D, this.lookTex);
    g.activeTexture(g.TEXTURE0);
  }

  /** Höhenraster hochladen: beim ersten Mal ganz, danach nur den geänderten Ausschnitt */
  private uploadHeights(g: GL, c: LiveCarve) {
    if (this.texFor !== c) {
      if (this.tex) g.deleteTexture(this.tex);
      this.tex = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, this.tex);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      g.pixelStorei(g.UNPACK_ALIGNMENT, 4);
      g.pixelStorei(g.UNPACK_ROW_LENGTH, 0); g.pixelStorei(g.UNPACK_SKIP_PIXELS, 0); g.pixelStorei(g.UNPACK_SKIP_ROWS, 0);
      g.texImage2D(g.TEXTURE_2D, 0, g.R32F, c.nx, c.ny, 0, g.RED, g.FLOAT, c.h);
      this.texFor = c;
      c.dirty = null;
      return;
    }
    g.bindTexture(g.TEXTURE_2D, this.tex);
    const d = c.dirty;
    if (!d) return;
    const [i0, j0, i1, j1] = d;
    g.pixelStorei(g.UNPACK_ROW_LENGTH, c.nx);
    g.pixelStorei(g.UNPACK_SKIP_PIXELS, i0);
    g.pixelStorei(g.UNPACK_SKIP_ROWS, j0);
    g.texSubImage2D(g.TEXTURE_2D, 0, i0, j0, i1 - i0, j1 - j0, g.RED, g.FLOAT, c.h);
    g.pixelStorei(g.UNPACK_ROW_LENGTH, 0); g.pixelStorei(g.UNPACK_SKIP_PIXELS, 0); g.pixelStorei(g.UNPACK_SKIP_ROWS, 0);
    c.dirty = null;
  }

  /** Oberfläche: Nummernliste je Kachel, neu gebaut wird nur, was der Fräser berührt hat */
  private drawSurface(g: GL, c: LiveCarve) {
    if (this.chunksFor !== c || !this.chunks) {
      // Laser/Plasma: Dosis zählt jeder Wert; Drehachse: krumme Fläche, nichts zusammenfassen
      this.chunks = new ChunkGrid(c.nx, c.ny, !!c.cyl, !c.cyl, c.kind === "mill" ? -c.T : -Infinity);
      this.chunksFor = c;
      c.allTouched = true;
      if (!this.indexBuf) this.indexBuf = g.createBuffer();
      g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, this.indexBuf);
      g.bufferData(g.ELEMENT_ARRAY_BUFFER, this.chunks.total * 4, g.DYNAMIC_DRAW);
    }
    const G = this.chunks;
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, this.indexBuf);
    const put = (k: number) => {
      const n = G.build(k, c.h, this.scratch);
      if (n) g.bufferSubData(g.ELEMENT_ARRAY_BUFFER, G.start[k] * 4, this.scratch, 0, n);
    };
    if (c.allTouched) {
      for (let k = 0; k < G.count.length; k++) put(k);
    } else {
      for (const key of c.chunkTouched) {
        const ci = key & 65535, cj = key >>> 16;
        // der Ring außen zählt mit: auch die Nachbarn neu ansehen
        for (let b = Math.max(0, cj - 1); b <= Math.min(G.ncy - 1, cj + 1); b++)
          for (let a = Math.max(0, ci - 1); a <= Math.min(G.ncx - 1, ci + 1); a++) this.pending.add(b * G.ncx + a);
      }
      for (const k of this.pending) put(k);
      this.pending.clear();
    }
    c.allTouched = false;
    c.chunkTouched.clear();
    const r = G.ranges();
    for (let q = 0; q < r.length; q += 2) g.drawElements(g.TRIANGLES, r[q + 1], g.UNSIGNED_INT, r[q] * 4);
  }

  private camera(g: GL, L: Record<string, WebGLUniformLocation | null>, v: MaterialView, c: LiveCarve) {
    g.uniform2f(L.u_size, v.W, v.H);
    g.uniform2f(L.u_origin, v.originX, v.originY);
    g.uniform3f(L.u_center, v.center.x, v.center.y, v.center.z);
    g.uniform4f(L.u_rot, Math.cos(v.yaw), Math.sin(v.yaw), Math.cos(v.pitch), Math.sin(v.pitch));
    g.uniform1f(L.u_scale, v.scale);
    // Tiefe auf −1…1: alles bis zur Spindel und weit darüber passt hinein
    const ext = Math.hypot(c.nx * c.cell, c.ny * c.cell) + Math.hypot(v.center.x - c.x0, v.center.y - c.y0) + 600;
    g.uniform1f(L.u_dscale, 1 / ext);
  }

  /** Maschine drumherum: einmal bauen, danach nur verschieben */
  private buildEnv(g: GL, c: LiveCarve, e: MachineEnv, head: number) {
    const key = JSON.stringify([c.kind, c.T, c.x0, c.nx, c.cell, c.y0, c.ny, !!c.cyl, c.cyl?.R, c.cyl?.alongY, c.cyl?.stock, e, Math.round(head)]);
    if (key === this.envKey && this.envBuf) return;
    const parts: Record<string, Float32Array> = {};
    if (c.cyl) {
      const R = c.cyl.R, C = cornerRadius(c.cyl.stock), x0 = c.x0, x1 = c.x0 + c.nx * c.cell;
      if (e.rollerDia) parts.fixed = rollers(x0, x1, R, e.rollerDia);
      else { parts.chuck = rotaryChuck(x0, C); parts.fixed = rotaryFixed(x0, x1, C); }
    } else {
      parts.bed = bedMesh(c.kind, e.bedW, e.bedH, c.T);
      parts.clamps = clampMesh(e.zones, c.T);
      parts.gantry = gantryMesh(c.kind, e.bedW, c.T, head);
      parts.carriage = carriageMesh(c.kind, head);
    }
    let n = 0;
    for (const p of Object.values(parts)) n += p.length;
    const all = new Float32Array(n);
    this.envParts = {};
    n = 0;
    for (const [k, p] of Object.entries(parts)) { all.set(p, n); this.envParts[k] = [n / 10, p.length / 10]; n += p.length; }
    this.envBuf ??= g.createBuffer();
    this.envVao ??= g.createVertexArray();
    g.bindVertexArray(this.envVao);
    g.bindBuffer(g.ARRAY_BUFFER, this.envBuf);
    g.bufferData(g.ARRAY_BUFFER, all, g.STATIC_DRAW);
    for (const [name, size, off] of [["a_p", 3, 0], ["a_n", 3, 12], ["a_c", 4, 24]] as const) {
      const l = g.getAttribLocation(this.meshProg!, name);
      g.enableVertexAttribArray(l);
      g.vertexAttribPointer(l, size, g.FLOAT, false, 40, off);
    }
    this.envKey = key;
  }
  private drawEnv(g: GL, name: string, at: [number, number, number], turn: [number, number, number] = [1, 0, 0]) {
    const p = this.envParts[name];
    if (!p || !p[1]) return;
    g.uniform3f(this.mloc.u_at, ...at);
    g.uniform3f(this.mloc.u_turn, ...turn);
    g.drawArrays(g.TRIANGLES, p[0], p[1]);
  }

  /** Material (und Fräser) zeichnen; Ergebnis-Canvas mit durchsichtigem Hintergrund oder null = WebGL geht nicht */
  render(c: LiveCarve, v: MaterialView): HTMLCanvasElement | null {
    const g = this.init();
    if (!g || !this.stockProg || !this.meshProg) return null;
    try {
      // eigene Ebene in echter Bildschirm-Auflösung (v.W/v.H bleiben die Rechen-Einheit)
      const dpr = Math.min(2, window.devicePixelRatio || 1), pw = Math.round(v.W * dpr), ph = Math.round(v.H * dpr);
      if (this.canvas.width !== pw || this.canvas.height !== ph) {
        this.canvas.width = pw; this.canvas.height = ph;
        this.canvas.style.width = v.W + "px"; this.canvas.style.height = v.H + "px";
      }
      g.viewport(0, 0, pw, ph);
      g.clearColor(0, 0, 0, 0);
      g.clearDepth(1);
      g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
      g.enable(g.DEPTH_TEST);
      g.depthFunc(g.LEQUAL);
      g.disable(g.BLEND);
      g.depthMask(true);

      // ---- Rohteil ----
      g.useProgram(this.stockProg);
      g.bindVertexArray(this.vao);
      g.activeTexture(g.TEXTURE0);
      this.uploadHeights(g, c);
      const L = this.sloc;
      this.camera(g, L, v, c);
      g.uniform1i(L.u_h, 0);
      g.uniform2i(L.u_n, c.nx, c.ny);
      g.uniform3f(L.u_grid, c.x0, c.y0, c.cell);
      g.uniform1f(L.u_T, c.T);
      // Aussehen
      const m = v.look, f = (x: number[]) => [x[0] / 255, x[1] / 255, x[2] / 255] as const;
      this.uploadLook(g, m);
      g.uniform1i(L.u_tex, 1);
      g.uniform3f(L.u_base, ...f(m.base));
      g.uniform3f(L.u_core, ...f(m.core ?? m.base));
      g.uniform3f(L.u_burn, ...f(m.burn));
      g.uniform3f(L.u_layers, ...f(m.layers ?? m.base));
      g.uniform1f(L.u_ply, m.kind === "plywood" ? 1.5 : 0);
      g.uniform1f(L.u_darken, m.core && !isWoody(m) ? 0.15 : 1);
      g.uniform1f(L.u_gloss, m.gloss ?? 0);
      const sp = Math.sin(v.pitch);
      g.uniform3f(L.u_view, -sp * Math.sin(v.yaw), -sp * Math.cos(v.yaw), Math.cos(v.pitch));
      g.uniform1i(L.u_kind, c.kind === "mill" ? 0 : 1);
      g.uniform1f(L.u_cut, c.kind === "plasma" ? PLASMA_CUT * 0.99 : c.cutDose);
      g.uniform1f(L.u_plasma, c.kind === "plasma" ? 1 : 0);
      g.uniform2f(L.u_cyl, c.cyl ? c.cyl.R : 0, c.cyl?.alongY ? 1 : 0);
      g.uniform1f(L.u_cylR, c.cyl ? c.cyl.R : 0);
      if (c.cyl) {
        const st = c.cyl.stock, fs = faces(st);
        g.uniform1i(L.u_body, fs.length ? 2 : 1);
        g.uniform1f(L.u_per, perimeter(st));
        if (st.shape === "cone") g.uniform4f(L.u_rev, st.d0 / 2, st.d1 / 2, st.coneLen, perimeter(st) / (2 * Math.PI));
        else g.uniform4f(L.u_rev, c.cyl.R, c.cyl.R, 1, c.cyl.R);
        g.uniform1i(L.u_nf, fs.length);
        if (fs.length) g.uniform4fv(L.u_face, fs.flatMap(f => [f.start, f.end, f.apothem, (f.angle * Math.PI) / 180]));
      }
      // Drehachse: Teil so drehen, dass die Arbeitsstelle oben liegt; Werkzeug dann senkrecht darüber
      let tool = v.tool, spin = 0;
      const sp0 = c.spinNow;
      if (c.cyl && tool && sp0 !== null) {
        // Nicht rund: Der Winkel kommt aus dem Programm; Werkzeug vom Teil zurück auf die Maschine drehen
        const q = c.cyl.alongY ? -tool.x : tool.y, zr = tool.z + c.cyl.R, along = c.cyl.alongY ? tool.y : tool.x;
        spin = sp0;
        const cs = Math.cos(spin), sn = Math.sin(spin), my = q * cs - zr * sn, mz = q * sn + zr * cs;
        tool = { ...tool, x: c.cyl.alongY ? -my : along, y: c.cyl.alongY ? along : my, z: mz - c.cyl.R };
      } else if (c.cyl && tool) {
        const q = c.cyl.alongY ? -tool.x : tool.y, zr = tool.z + c.cyl.R;
        spin = Math.atan2(q, zr);
        const d = Math.hypot(q, zr) - c.cyl.R, along = c.cyl.alongY ? tool.y : tool.x;
        tool = { ...tool, x: c.cyl.alongY ? 0 : along, y: c.cyl.alongY ? along : 0, z: d };
      }
      g.uniform1f(L.u_spin, spin);
      g.uniform1i(L.u_side, 0);
      this.drawSurface(g, c);
      for (const s of c.cyl ? [3, 4] : [1, 2, 3, 4]) {
        g.uniform1i(L.u_side, s);
        g.drawArraysInstanced(g.TRIANGLES, 0, 6, c.cyl ? c.ny : (s <= 2 ? c.nx : c.ny) - 1);
      }

      // ---- Maschine drumherum (fester Teil) ----
      const env = v.env ?? null, head = v.tool && v.tool.kind === "mill" ? v.tool.holder.stickout + v.tool.holder.holderH : c.kind === "plasma" ? 60 : 40;
      if (env) {
        this.buildEnv(g, c, env, head);
        g.useProgram(this.meshProg);
        g.bindVertexArray(this.envVao);
        this.camera(g, this.mloc, v, c);
        g.uniform2f(this.mloc.u_zmap, 0, 1);
        if (c.cyl) {
          const ax: [number, number, number] = [0, 0, -c.cyl.R], y = c.cyl.alongY ? 1 : 0;
          this.drawEnv(g, "fixed", ax, [1, 0, y]);
          this.drawEnv(g, "chuck", ax, [Math.cos(spin), Math.sin(spin), y]);
        } else this.drawEnv(g, "bed", [0, 0, 0]);
      }

      // ---- Fräser ----
      if (tool) {
        const tk = tool.kind;
        const key = tk === "mill" ? tool.holder : tk;
        if (this.meshKey !== key || !this.meshBuf) {
          const m = tk === "mill" ? toolMesh(tool.geom, tool.holder, () => { this.meshKey = null; this.onReady?.(); }) : headMesh(tk);
          const beam = tk === "mill" ? new Float32Array(0) : beamMesh(tk);
          const all = new Float32Array(m.solid.length + m.ghost.length + beam.length);
          all.set(m.solid); all.set(m.ghost, m.solid.length); all.set(beam, m.solid.length + m.ghost.length);
          if (!this.meshBuf) this.meshBuf = g.createBuffer();
          if (!this.meshVao) this.meshVao = g.createVertexArray();
          g.bindVertexArray(this.meshVao);
          g.bindBuffer(g.ARRAY_BUFFER, this.meshBuf);
          g.bufferData(g.ARRAY_BUFFER, all, g.STATIC_DRAW);
          const st = 40;
          const at = (name: string, size: number, off: number) => {
            const l = g.getAttribLocation(this.meshProg!, name);
            g.enableVertexAttribArray(l);
            g.vertexAttribPointer(l, size, g.FLOAT, false, st, off);
          };
          at("a_p", 3, 0); at("a_n", 3, 12); at("a_c", 4, 24);
          this.meshCounts = { solid: m.solid.length / 10, ghost: m.ghost.length / 10, beam: beam.length / 10 };
          this.meshKey = key;
        }
        g.useProgram(this.meshProg);
        g.bindVertexArray(this.meshVao);
        const M = this.mloc;
        this.camera(g, M, v, c);
        g.uniform3f(M.u_at, tool.x, tool.y, tool.z);
        g.uniform3f(M.u_turn, 1, 0, 0);
        g.uniform2f(M.u_zmap, 0, 1);
        // Fräser dreht sich, solange die Simulation läuft: nur fürs Auge, gut 1 Umdrehung je Sekunde, rechts herum (M3)
        const now = performance.now();
        if (tk === "mill" && tool.spin) this.spinA = (this.spinA - Math.min(0.1, (now - this.spinAt) / 1000) * 2 * Math.PI * 1.2) % (2 * Math.PI);
        this.spinAt = now;
        g.uniform1f(M.u_spinA, tk === "mill" ? this.spinA : 0);
        g.drawArrays(g.TRIANGLES, 0, this.meshCounts.solid);
        g.uniform1f(M.u_spinA, 0);
        // durchsichtige Teile: über alles Feste, ohne in den Tiefenpuffer zu schreiben
        g.enable(g.BLEND);
        g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
        g.depthMask(false);
        // Strahl / Lichtbogen: von der Oberfläche (Abstand = Höhe der Spitze) bis zur Düse
        if (tool.on && this.meshCounts.beam) {
          const zs = -Math.max(0, tool.z), ze = tk === "laser" ? LASER_FOCUS : 0;
          if (ze - zs > 0.05) {
            g.uniform2f(M.u_zmap, zs, ze - zs);
            g.drawArrays(g.TRIANGLES, this.meshCounts.solid + this.meshCounts.ghost, this.meshCounts.beam);
            g.uniform2f(M.u_zmap, 0, 1);
          }
        }
        g.drawArrays(g.TRIANGLES, this.meshCounts.solid, this.meshCounts.ghost);
        g.depthMask(true);
        g.disable(g.BLEND);
      }
      // halb durchsichtig: Spannpratzen, Portal und Schlitten (zuletzt, ohne Tiefenpuffer zu ändern)
      if (env && !c.cyl) {
        g.useProgram(this.meshProg);
        g.bindVertexArray(this.envVao);
        this.camera(g, this.mloc, v, c);
        g.uniform2f(this.mloc.u_zmap, 0, 1);
        g.enable(g.BLEND);
        g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
        g.depthMask(false);
        this.drawEnv(g, "clamps", [0, 0, 0]);
        if (tool) { const lift = Math.max(0, tool.z); this.drawEnv(g, "carriage", [tool.x, tool.y, lift]); this.drawEnv(g, "gantry", [0, tool.y, 0]); }
        g.depthMask(true);
        g.disable(g.BLEND);
      }
      g.bindVertexArray(null);
      const err = g.getError();
      if (err !== g.NO_ERROR) { console.warn("material view: GL error", err); return null; }
      return this.canvas;
    } catch (e) {
      console.warn("material view:", e);
      return null;
    }
  }

  /** Grafikkarten-Speicher freigeben */
  dispose() {
    const g = this.gl;
    if (g) {
      if (this.tex) g.deleteTexture(this.tex);
      if (this.lookTex) g.deleteTexture(this.lookTex);
      if (this.meshBuf) g.deleteBuffer(this.meshBuf);
      if (this.meshVao) g.deleteVertexArray(this.meshVao);
      if (this.envBuf) g.deleteBuffer(this.envBuf);
      if (this.envVao) g.deleteVertexArray(this.envVao);
    }
    this.tex = null; this.texFor = null; this.lookTex = null; this.lookId = ""; this.meshBuf = null; this.meshVao = null; this.meshKey = null; this.envBuf = null; this.envVao = null; this.envKey = "";
  }
}
