/**
 * KAMERA (wie die Kamera-Funktion in LightBurn)
 *
 * Knopf 📷 oben rechts öffnet ein frei verschiebbares Kamera-Fenster:
 *   - Quelle: USB-Webcam (Liste aller Kameras) oder IP-Kamera (ESP32-CAM, mjpg-streamer,
 *     Handy-App „IP Webcam“ …) über eine http-Adresse
 *   - 📸 Foto speichern, ⏺ Video aufnehmen (nur USB-Kamera), ↻ 180° drehen, ⇆ spiegeln
 *   - ▦ Auf Arbeitsfläche: Kamerabild entzerrt UNTER der Zeichnung – so legt man Teile genau
 *     aufs Material/Reststück. Live oder als Standbild, Deckkraft einstellbar
 *   - 🎯 Ausrichten: Assistent (cameraAlign.ts) – Linse entzerren, dann 4 Punkte anklicken
 *     (Laser brennt dafür 4 Kreuze, oder eigene Punkte wie die Bettecken)
 *
 * Fenster-Lage, Quelle und Ausrichtung werden gemerkt (localStorage → auch in der
 * Einstellungs-Datei, siehe settingsStore.ts).
 * macOS/Windows fragen beim ersten Mal nach der Kamera-Erlaubnis. Linux: falls die Webcam im
 * Programm nicht geht, eine IP-Kamera nehmen (z. B. Handy-App).
 */
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n/i18n";
import { Mat3 } from "./cameraMath";
import { Warper } from "./cameraWarp";
import { cameraUnderlay } from "./cameraOverlay";
import { openAlignWizard } from "./cameraAlign";

export interface CamCalib {
  k1: number;
  /** angeklickte Punkte (unverzerrt, normiert) und ihre Bett-Koordinaten in mm */
  pts: { nx: number; ny: number; x: number; y: number }[];
  H: Mat3;               // Bett-mm -> unverzerrt normiert
  srcW: number;          // Bildgröße bei der Ausrichtung (Seitenverhältnis muss passen)
  srcH: number;
  date: string;
}

interface CamSettings {
  source: "device" | "ip" | "";
  deviceId: string;
  url: string;
  rot180: boolean;
  mirror: boolean;
  overlay: boolean;
  opacity: number;
  live: boolean;
  k1: number;
  calib: CamCalib | null;
  win: { x: number; y: number; w: number; h: number } | null;
}

const KEY = "cnc_craft_camera";
export const cam: CamSettings = {
  source: "", deviceId: "", url: "", rot180: false, mirror: false,
  overlay: false, opacity: 0.85, live: true, k1: 0, calib: null, win: null
};

function load() {
  try { Object.assign(cam, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch { /* Standard */ }
}
export function saveCam() {
  try { localStorage.setItem(KEY, JSON.stringify(cam)); } catch { /* egal */ }
}

let log: (s: string) => void = () => {};
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;      // versteckt – Quelle für Überlagerung/Fotos
let win: HTMLElement | null = null;
let recorder: MediaRecorder | null = null;
let recChunks: Blob[] = [];
let recStart = 0;
let recTimer: ReturnType<typeof setInterval> | null = null;
let overlayTimer: ReturnType<typeof setTimeout> | null = null;
let ipRefresh: ReturnType<typeof setInterval> | null = null;
const warper = new Warper();

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

/** Einzelbild-Adresse (…/capture, snapshot.jpg) statt Videostrom? Dann muss die Anzeige erneuert werden */
function isStreamUrl(u: string): boolean {
  return /stream|mjpe?g|video|action=stream|:81\b/i.test(u);
}
function normUrl(u: string): string {
  const s = u.trim();
  if (!s) return "";
  return /^[a-z]+:\/\//i.test(s) ? s : "http://" + s;
}

// ---------------------------------------------------------------------
// Quellen
// ---------------------------------------------------------------------

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === "videoinput");
  } catch { return []; }
}

function stopStream() {
  stopRecording(false);
  stream?.getTracks().forEach(tr => tr.stop());
  stream = null;
  if (video) video.srcObject = null;
}

async function startDevice(deviceId: string): Promise<void> {
  stopStream();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
  const want: MediaTrackConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  if (deviceId) want.deviceId = { exact: deviceId };
  stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false });
  if (!video) {
    video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.autoplay = true;
    video.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
    document.body.appendChild(video);
  }
  video.srcObject = stream;
  try { await video.play(); } catch { /* startet von selbst */ }
  const tr = stream.getVideoTracks()[0];
  if (tr) cam.deviceId = tr.getSettings().deviceId || deviceId;
}

/** Fehlertext für den Nutzer */
function camError(e: unknown): string {
  const n = (e as any)?.name || (e as any)?.message || String(e);
  if (n === "NotAllowedError" || n === "SecurityError") return t("cam.err.denied");
  if (n === "NotFoundError" || n === "OverconstrainedError") return t("cam.err.notFound");
  if (n === "NotReadableError") return t("cam.err.busy");
  if (n === "unsupported") return t("cam.err.unsupported");
  const k = "cam.err." + n;
  return t(k) !== k ? t(k) : t("cam.err.other", { e: n });
}

export interface Frame { src: TexImageSource; w: number; h: number }

/** Aktuelles Bild der Quelle (für Überlagerung). null = noch keins da */
async function currentFrame(): Promise<Frame | null> {
  if (cam.source === "device") {
    if (!video || !stream || video.readyState < 2 || !video.videoWidth) return null;
    return { src: video, w: video.videoWidth, h: video.videoHeight };
  }
  if (cam.source === "ip" && cam.url) {
    try {
      const buf = await invoke<ArrayBuffer>("camera_snapshot", { url: normUrl(cam.url) });
      const bmp = await createImageBitmap(new Blob([buf as ArrayBuffer], { type: "image/jpeg" }));
      return { src: bmp, w: bmp.width, h: bmp.height };
    } catch (e) {
      setStatus(t("cam.err.ip", { e: ipErr(e) }), true);
      return null;
    }
  }
  return null;
}

function ipErr(e: unknown): string {
  const m = String(e);
  const k = "cam.ipErr." + m;
  return t(k) !== k ? t(k) : m;
}

/** Standbild (eigene Kopie, ändert sich nicht mehr) – für Ausrichten und Fotos */
export async function grabStill(): Promise<Frame | null> {
  const f = await currentFrame();
  if (!f) return null;
  if (f.src instanceof HTMLVideoElement) {
    const c = document.createElement("canvas");
    c.width = f.w; c.height = f.h;
    c.getContext("2d")!.drawImage(f.src, 0, 0);
    return { src: c, w: f.w, h: f.h };
  }
  return f;
}

// ---------------------------------------------------------------------
// Überlagerung auf der Arbeitsfläche
// ---------------------------------------------------------------------

function bedSize(): { w: number; h: number } {
  const w = parseFloat(($("bed-w") as HTMLInputElement | null)?.value || "") || 300;
  const h = parseFloat(($("bed-h") as HTMLInputElement | null)?.value || "") || 300;
  return { w, h };
}

/** Ein Bild entzerrt auf das Bett rechnen und anzeigen */
async function renderOverlay(frame?: Frame | null): Promise<boolean> {
  const c = cam.calib;
  if (!c) return false;
  const f = frame || await currentFrame();
  if (!f) return false;
  // anderes Bildformat als beim Ausrichten (andere Kamera/Auflösung) -> passt nicht mehr
  if (Math.abs(f.w / f.h - c.srcW / c.srcH) > 0.02) { setStatus(t("cam.formatChanged"), true); return false; }
  const bed = bedSize();
  const long = 1400;
  const outW = bed.w >= bed.h ? long : Math.max(64, Math.round(long * bed.w / bed.h));
  const outH = bed.w >= bed.h ? Math.max(64, Math.round(long * bed.h / bed.w)) : long;
  const ok = warper.render(f.src, f.w, f.h, { mode: "bed", k1: c.k1, rot180: cam.rot180, mirror: cam.mirror, H: c.H, bedW: bed.w, bedH: bed.h, outW, outH });
  if (!ok) return false;
  cameraUnderlay.image = warper.canvas;
  window.dispatchEvent(new Event("cnc-redraw"));
  return true;
}

function stopOverlayLoop() {
  if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
}

function startOverlayLoop() {
  stopOverlayLoop();
  if (!cam.overlay || !cam.calib) return;
  const tick = async () => {
    overlayTimer = null;
    if (!cam.overlay) return;
    await renderOverlay();
    if (cam.overlay && cam.live) overlayTimer = setTimeout(tick, cam.source === "ip" ? 900 : 120);
  };
  void tick();
}

export function setOverlay(on: boolean) {
  if (on && !cam.calib) { log(t("cam.needAlign")); openAlign(); return; }
  cam.overlay = on;
  cameraUnderlay.on = on;
  cameraUnderlay.opacity = cam.opacity;
  saveCam();
  if (on) startOverlayLoop(); else { stopOverlayLoop(); window.dispatchEvent(new Event("cnc-redraw")); }
  syncWindow();
}

// ---------------------------------------------------------------------
// Foto & Video
// ---------------------------------------------------------------------

function stamp() {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function saveBytes(bytes: Uint8Array, name: string, ext: string, title: string) {
  const p = await save({ title, defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (!p) return;
  await writeFile(String(p), bytes);
  log(t("cam.saved", { p: String(p) }));
}

async function takePhoto() {
  try {
    if (cam.source === "ip") {
      const buf = await invoke<ArrayBuffer>("camera_snapshot", { url: normUrl(cam.url) });
      await saveBytes(new Uint8Array(buf as ArrayBuffer), `cnc-craft-foto-${stamp()}.jpg`, "jpg", t("cam.photo"));
      return;
    }
    if (!video || !video.videoWidth) { setStatus(t("cam.noImage"), true); return; }
    const c = document.createElement("canvas");
    c.width = video.videoWidth; c.height = video.videoHeight;
    const g = c.getContext("2d")!;
    // wie angezeigt: 180° = Spiegeln in X und Y, dazu ggf. noch in X spiegeln
    g.translate(c.width / 2, c.height / 2);
    g.scale((cam.rot180 ? -1 : 1) * (cam.mirror ? -1 : 1), cam.rot180 ? -1 : 1);
    g.drawImage(video, -c.width / 2, -c.height / 2);
    const blob: Blob = await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("png")), "image/png"));
    await saveBytes(new Uint8Array(await blob.arrayBuffer()), `cnc-craft-foto-${stamp()}.png`, "png", t("cam.photo"));
  } catch (e) {
    log(`${t("log.error")} ${e}`);
  }
}

function recMime(): string {
  const list = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  try { return list.find(m => (window as any).MediaRecorder?.isTypeSupported?.(m)) || ""; } catch { return ""; }
}

function startRecording() {
  if (!stream || recorder) return;
  const mime = recMime();
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e) {
    log(t("cam.recFailed", { e: String(e) }));
    recorder = null;
    return;
  }
  recChunks = [];
  recorder.ondataavailable = ev => { if (ev.data && ev.data.size) recChunks.push(ev.data); };
  recorder.start(1000);
  recStart = Date.now();
  recTimer = setInterval(syncRec, 500);
  log(t("cam.recStarted"));
  syncWindow();
}

/** Aufnahme beenden; keep = Datei speichern */
function stopRecording(keep = true) {
  const r = recorder;
  if (!r) return;
  recorder = null;
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  const type = r.mimeType || "video/webm";
  r.onstop = async () => {
    if (!keep || !recChunks.length) return;
    const blob = new Blob(recChunks, { type });
    recChunks = [];
    const ext = type.includes("mp4") ? "mp4" : "webm";
    try { await saveBytes(new Uint8Array(await blob.arrayBuffer()), `cnc-craft-video-${stamp()}.${ext}`, ext, t("cam.video")); }
    catch (e) { log(`${t("log.error")} ${e}`); }
  };
  try { r.stop(); } catch { /* schon gestoppt */ }
  syncWindow();
}

function syncRec() {
  const el = $("cam-rec");
  if (!el) return;
  if (!recorder) { el.style.display = "none"; return; }
  const s = Math.floor((Date.now() - recStart) / 1000);
  el.style.display = "";
  el.textContent = `● REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------
// Fenster
// ---------------------------------------------------------------------

function setStatus(text: string, warn = false) {
  const el = $("cam-status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("warn", warn);
}

function calibText(): string {
  const c = cam.calib;
  if (!c) return t("cam.notAligned");
  return t("cam.aligned", { d: new Date(c.date).toLocaleDateString() });
}

async function fillSources() {
  const sel = $<HTMLSelectElement>("cam-src");
  if (!sel) return;
  const cams = await listCameras();
  const opts = [`<option value="">${esc(t("cam.choose"))}</option>`];
  cams.forEach((d, i) => opts.push(`<option value="dev:${esc(d.deviceId)}">🎥 ${esc(d.label || t("cam.cameraN", { n: i + 1 }))}</option>`));
  opts.push(`<option value="ip">🌐 ${esc(t("cam.ipCam"))}</option>`);
  sel.innerHTML = opts.join("");
  sel.value = cam.source === "ip" ? "ip" : cam.source === "device" ? `dev:${cam.deviceId}` : "";
  if (cam.source === "device" && sel.value === "" && cams.length) sel.value = `dev:${cams[0].deviceId}`;
}

/** Anzeige im Fenster passend zur Quelle */
function showView() {
  const box = $("cam-view");
  if (!box) return;
  if (ipRefresh) { clearInterval(ipRefresh); ipRefresh = null; }
  box.querySelectorAll("video, img").forEach(e => e.remove());
  const empty = $("cam-empty")!;
  const tf = `${cam.rot180 ? "rotate(180deg) " : ""}${cam.mirror ? "scaleX(-1)" : ""}`.trim();
  if (cam.source === "device" && stream) {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.autoplay = true;
    v.srcObject = stream;
    v.style.transform = tf;
    box.prepend(v);
    void v.play().catch(() => {});
    empty.style.display = "none";
  } else if (cam.source === "ip" && cam.url) {
    const img = document.createElement("img");
    const url = normUrl(cam.url);
    img.style.transform = tf;
    img.alt = "";
    img.onerror = () => { empty.style.display = ""; empty.textContent = t("cam.ipNoView"); };
    img.onload = () => { empty.style.display = "none"; };
    img.src = url;
    if (!isStreamUrl(url)) {
      // Einzelbild-Adresse: regelmäßig neu laden
      ipRefresh = setInterval(() => { img.src = url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now(); }, 700);
    }
    box.prepend(img);
  } else {
    empty.style.display = "";
    empty.textContent = t("cam.pickSource");
  }
}

async function selectSource(val: string) {
  stopOverlayLoop();
  const urlRow = $("cam-url-row");
  if (val === "ip") {
    stopStream();
    cam.source = "ip";
    if (urlRow) urlRow.style.display = "";
    saveCam();
    showView();
    setStatus(cam.url ? calibText() : t("cam.ipHint"));
  } else if (val.startsWith("dev:")) {
    if (urlRow) urlRow.style.display = "none";
    cam.source = "device";
    setStatus(t("cam.starting"));
    try {
      await startDevice(val.slice(4));
      saveCam();
      showView();
      setStatus(calibText());
      // nach der Erlaubnis kennt der Browser die Namen der Kameras
      void fillSources();
    } catch (e) {
      stopStream();
      showView();
      setStatus(camError(e), true);
    }
  } else {
    stopStream();
    cam.source = "";
    if (urlRow) urlRow.style.display = "none";
    saveCam();
    showView();
    setStatus(t("cam.pickSource"));
  }
  if (cam.overlay) startOverlayLoop();
  syncWindow();
}

/** Knöpfe/Anzeigen an den Zustand anpassen */
function syncWindow() {
  if (!win) return;
  const on = (id: string, v: boolean) => $(id)?.classList.toggle("active", v);
  on("cam-rot", cam.rot180); on("cam-mir", cam.mirror); on("cam-ovl", cam.overlay);
  const rec = $<HTMLButtonElement>("cam-recbtn");
  if (rec) {
    rec.disabled = cam.source !== "device" || !stream;
    rec.classList.toggle("rec-on", !!recorder);
    rec.innerHTML = recorder ? `⏹ ${esc(t("cam.recStop"))}` : `⏺ ${esc(t("cam.rec"))}`;
  }
  const photo = $<HTMLButtonElement>("cam-photo");
  if (photo) photo.disabled = !(cam.source === "device" ? !!stream : cam.source === "ip" && !!cam.url);
  const row = $("cam-ovl-row");
  if (row) row.style.display = cam.overlay ? "" : "none";
  const live = $<HTMLButtonElement>("cam-live");
  if (live) live.innerHTML = cam.live ? `◉ ${esc(t("cam.live"))}` : `❄ ${esc(t("cam.still"))}`;
  const refresh = $<HTMLButtonElement>("cam-refresh");
  if (refresh) refresh.style.display = cam.live ? "none" : "";
  const op = $<HTMLInputElement>("cam-opacity");
  if (op && document.activeElement !== op) op.value = String(Math.round(cam.opacity * 100));
  $("camera-btn")?.classList.toggle("active", !!win && win.style.display !== "none");
  syncRec();
}

function placeWindow() {
  if (!win) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(Math.max(cam.win?.w || 420, 300), vw - 20);
  const h = Math.min(Math.max(cam.win?.h || 380, 240), vh - 20);
  const x = Math.min(Math.max(cam.win?.x ?? vw - w - 380, 10), vw - w - 10);
  const y = Math.min(Math.max(cam.win?.y ?? 70, 50), vh - h - 10);
  Object.assign(win.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
}

function buildWindow() {
  win = document.createElement("div");
  win.id = "cam-win";
  win.className = "cam-win";
  win.innerHTML = `
    <div class="cam-head" id="cam-head">
      <span class="cam-title">📷 ${esc(t("cam.title"))}</span>
      <select id="cam-src" data-tip="${esc(t("cam.srcTip"))}"></select>
      <button class="cam-x" id="cam-close" data-tip="${esc(t("upd.close"))}">✕</button>
    </div>
    <div class="cam-url-row" id="cam-url-row" style="display:none;">
      <input id="cam-url" type="text" placeholder="http://192.168.1.50:81/stream" data-tip="${esc(t("cam.urlTip"))}">
      <button id="cam-url-ok" class="btn-secondary">OK</button>
    </div>
    <div class="cam-view" id="cam-view">
      <div class="cam-empty" id="cam-empty"></div>
      <div class="cam-rec" id="cam-rec" style="display:none;"></div>
    </div>
    <div class="cam-bar">
      <button id="cam-photo" class="btn-secondary" data-tip="${esc(t("cam.photoTip"))}">📸 ${esc(t("cam.photo"))}</button>
      <button id="cam-recbtn" class="btn-secondary" data-tip="${esc(t("cam.recTip"))}"></button>
      <button id="cam-rot" class="btn-secondary cam-tg" data-tip="${esc(t("cam.rotTip"))}">↻ 180°</button>
      <button id="cam-mir" class="btn-secondary cam-tg" data-tip="${esc(t("cam.mirTip"))}">⇆</button>
      <span class="cam-sp"></span>
      <button id="cam-ovl" class="btn-secondary cam-tg" data-tip="${esc(t("cam.ovlTip"))}">▦ ${esc(t("cam.ovl"))}</button>
      <button id="cam-align" class="btn-secondary" data-tip="${esc(t("cam.alignTip"))}">🎯 ${esc(t("cam.align"))}</button>
    </div>
    <div class="cam-bar cam-ovl-row" id="cam-ovl-row" style="display:none;">
      <span class="cam-lbl">${esc(t("cam.opacity"))}</span>
      <input id="cam-opacity" type="range" min="10" max="100" step="5">
      <button id="cam-live" class="btn-secondary" data-tip="${esc(t("cam.liveTip"))}"></button>
      <button id="cam-refresh" class="btn-secondary" data-tip="${esc(t("cam.refreshTip"))}">⟳</button>
    </div>
    <div class="cam-status" id="cam-status"></div>`;
  document.body.appendChild(win);
  placeWindow();

  // verschieben am Kopf
  const head = $("cam-head")!;
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("select, button, input")) return;
    e.preventDefault();
    const r = win!.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x = Math.min(Math.max(ev.clientX - dx, 0), window.innerWidth - 80);
      const y = Math.min(Math.max(ev.clientY - dy, 40), window.innerHeight - 40);
      win!.style.left = x + "px"; win!.style.top = y + "px";
    };
    const up = () => {
      head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up);
      rememberWin();
    };
    head.addEventListener("pointermove", move); head.addEventListener("pointerup", up);
  });
  // Größe (CSS resize) merken
  new ResizeObserver(() => rememberWin()).observe(win);
  // Tasten im Fenster nicht an die Zeichenfläche weitergeben
  win.addEventListener("keydown", e => e.stopPropagation());

  $("cam-close")!.onclick = () => closeWindow();
  $<HTMLSelectElement>("cam-src")!.addEventListener("change", (e) => selectSource((e.target as HTMLSelectElement).value));
  const url = $<HTMLInputElement>("cam-url")!;
  url.value = cam.url;
  const applyUrl = () => { cam.url = url.value.trim(); saveCam(); showView(); setStatus(cam.url ? calibText() : t("cam.ipHint")); syncWindow(); if (cam.overlay) startOverlayLoop(); };
  $("cam-url-ok")!.onclick = applyUrl;
  url.addEventListener("keydown", e => { if (e.key === "Enter") applyUrl(); });
  $("cam-photo")!.onclick = () => takePhoto();
  $("cam-recbtn")!.onclick = () => (recorder ? stopRecording(true) : startRecording());
  $("cam-rot")!.onclick = () => { cam.rot180 = !cam.rot180; saveCam(); showView(); syncWindow(); if (cam.overlay) void renderOverlay(); };
  $("cam-mir")!.onclick = () => { cam.mirror = !cam.mirror; saveCam(); showView(); syncWindow(); if (cam.overlay) void renderOverlay(); };
  $("cam-ovl")!.onclick = () => setOverlay(!cam.overlay);
  $("cam-align")!.onclick = () => openAlign();
  const op = $<HTMLInputElement>("cam-opacity")!;
  op.addEventListener("input", () => { cam.opacity = parseInt(op.value, 10) / 100; cameraUnderlay.opacity = cam.opacity; saveCam(); window.dispatchEvent(new Event("cnc-redraw")); });
  $("cam-live")!.onclick = () => { cam.live = !cam.live; saveCam(); syncWindow(); if (cam.live) startOverlayLoop(); else stopOverlayLoop(); };
  $("cam-refresh")!.onclick = () => { void renderOverlay(); };
}

let saveWinTimer: ReturnType<typeof setTimeout> | null = null;
function rememberWin() {
  if (!win || win.style.display === "none") return;
  if (saveWinTimer) clearTimeout(saveWinTimer);
  saveWinTimer = setTimeout(() => {
    const r = win!.getBoundingClientRect();
    cam.win = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    saveCam();
  }, 300);
}

export async function openWindow() {
  if (!win) buildWindow();
  win!.style.display = "";
  placeWindow();
  await fillSources();
  const sel = $<HTMLSelectElement>("cam-src")!;
  if (cam.source === "ip") { $("cam-url-row")!.style.display = ""; showView(); setStatus(cam.url ? calibText() : t("cam.ipHint")); }
  else if (cam.source === "device" && !stream && sel.value) await selectSource(sel.value);
  else { showView(); setStatus(stream ? calibText() : t("cam.pickSource")); }
  syncWindow();
}

/** Fenster zu. Läuft die Überlagerung, bleibt die Kamera an (Bild auf der Arbeitsfläche). */
export function closeWindow() {
  if (!win) return;
  if (recorder) stopRecording(true);
  win.style.display = "none";
  if (ipRefresh) { clearInterval(ipRefresh); ipRefresh = null; }
  win.querySelectorAll("video, img").forEach(e => e.remove());
  if (!cam.overlay) stopStream();
  syncWindow();
}

function openAlign() {
  openAlignWizard({
    grab: grabStill,
    hasSource: () => cam.source === "device" ? !!stream : cam.source === "ip" && !!cam.url,
    k1: cam.calib?.k1 ?? cam.k1,
    rot180: cam.rot180,
    mirror: cam.mirror,
    bed: bedSize(),
    calib: cam.calib,
    log,
    onSave: (c) => {
      cam.calib = c;
      cam.k1 = c.k1;
      saveCam();
      setStatus(calibText());
      setOverlay(true);
    }
  });
}

/** Für Tests/Assistent: Fenster-Text neu aufbauen (Sprache gewechselt) */
function rebuild() {
  if (!win) return;
  const open = win.style.display !== "none";
  win.remove();
  win = null;
  if (open) void openWindow();
}

export function initCamera(logFn: (s: string) => void) {
  log = logFn;
  load();
  cameraUnderlay.opacity = cam.opacity;
  $("camera-btn")?.addEventListener("click", () => {
    if (win && win.style.display !== "none") closeWindow(); else void openWindow();
  });
  window.addEventListener("cnc-language-changed", rebuild);
  window.addEventListener("resize", () => { if (win && win.style.display !== "none") placeWindow(); });
  // Bettgröße geändert -> Überlagerung neu rechnen
  ["bed-w", "bed-h"].forEach(id => $(id)?.addEventListener("change", () => { if (cam.overlay) void renderOverlay(); }));
  // Überlagerung war beim letzten Mal an: Kamera wieder starten (USB braucht die Erlaubnis – still versuchen)
  if (cam.overlay && cam.calib) {
    cameraUnderlay.on = true;
    if (cam.source === "device") {
      startDevice(cam.deviceId).then(() => startOverlayLoop()).catch(() => { cameraUnderlay.on = false; cam.overlay = false; saveCam(); });
    } else if (cam.source === "ip") startOverlayLoop();
  }
}
