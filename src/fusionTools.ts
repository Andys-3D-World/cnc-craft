/**
 * WERKZEUG-BIBLIOTHEKEN AUS FUSION 360 EINLESEN (.tools / .json)
 *
 * Viele Werkzeug-Händler bieten ihre Fräser als Fusion-360-Bibliothek zum Herunterladen an.
 * Das Format ist offen lesbar: „.tools“ ist eine ZIP-Datei mit einer „tools.json“, „.json“ ist dieselbe Liste
 * ohne ZIP. Darin: { "data": [ { "type": "flat end mill", "unit": "millimeters", "description": …,
 *   "geometry": { DC, SFDM, LCF, OAL, NOF, RE, TA, SIG, TP, NT, "shoulder-length", "thread-profile-angle" … },
 *   "shaft": { "segments": [ { "lower-diameter" … } ] }, "start-values": { "presets": [ { name, n, v_f … } ] } } ] }
 * Übernommen werden Art, Maße, Schneiden, Steigung und die Schnittwerte – die zum eingestellten Material passen,
 * sonst die ersten; alle Vorlagen landen zusätzlich in der Notiz. Halter, Taster, Gewindebohrer & Co. werden
 * übersprungen. Alle Werte prüft danach toolLibrary.sanitize wie bei jedem Import.
 * (Fusion 360 ist eine Marke von Autodesk; CNC Craft liest nur das Dateiformat.)
 */
import type { ToolType } from "./toolGraphics";

/** Fusion-Werkzeugart -> unsere Art (fehlt = wird übersprungen) */
const TYPE_MAP: Record<string, ToolType> = {
  "flat end mill": "endmill",
  "ball end mill": "ball",
  "bull nose end mill": "bullnose",
  "chamfer mill": "chamfer",
  "face mill": "facemill",
  "drill": "drill",
  "spot drill": "drill",
  "counter sink": "countersink",
  "thread mill": "threadmill",
};

/** Material-Stichwörter in Vorlagen-Namen -> unsere Materialien (toolLibrary MATERIALS) */
const MAT_WORDS: [RegExp, string[]][] = [
  [/alu/i, ["alu"]],
  [/messing|brass|bronze|kupfer|copper/i, ["brass"]],
  [/stahl|steel|eisen|iron/i, ["steel"]],
  [/kunststoff|plast|acryl|pmma|polymer/i, ["acrylic", "softplastic"]],
  [/mdf/i, ["mdf"]],
  [/sperrholz|plywood/i, ["plywood"]],
  [/hartholz|hardwood/i, ["hardwood"]],
  [/holz|wood/i, ["softwood", "hardwood", "plywood"]],
  [/platine|pcb|fr-?4/i, ["pcb"]],
];

export interface FusionImport {
  tools: any[];      // Rohdaten im Format von MillingTool (noch nicht geprüft)
  skipped: number;   // Einträge, die keine passende Werkzeugart haben (Halter, Taster …)
}

/** Sieht der Inhalt nach einer Fusion-Bibliothek aus? */
export function isFusionLibrary(data: any): boolean {
  return !!data && typeof data === "object" && Array.isArray(data.data)
    && data.data.some((x: any) => x && typeof x === "object" && typeof x.type === "string" && x.geometry);
}

const num = (v: any): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Fusion-Liste -> Werkzeuge. material = eingestelltes Material (für die passenden Schnittwerte) */
export function fusionToTools(data: any, material = "softwood"): FusionImport {
  const out: any[] = [];
  let skipped = 0;
  for (const x of Array.isArray(data?.data) ? data.data : []) {
    const type = TYPE_MAP[String(x?.type || "").toLowerCase()];
    const g = x?.geometry;
    if (!type || !g || typeof g !== "object" || !(num(g.DC)! > 0)) { skipped++; continue; }
    const k = String(x.unit || "").toLowerCase().startsWith("inch") ? 25.4 : 1; // Längen in mm
    const mm = (v: any) => (num(v) !== undefined ? Math.round(num(v)! * k * 10000) / 10000 : undefined);
    const t: any = {
      id: "f-" + String(x.guid || x["product-id"] || out.length + 1),
      name: String(x.description || "").trim() || `${x.type} Ø${mm(g.DC)}`,
      type,
      diameter: mm(g.DC),
      shankDia: mm(g.SFDM),
      fluteLen: mm(g.LCF),
      length: mm(g.OAL),
      flutes: num(g.NOF),
      toolMat: String(x.BMC || "").toLowerCase() === "hss" ? "hss" : "carbide",
    };
    if (type === "bullnose") t.cornerR = mm(g.RE);
    if (type === "chamfer") {
      // TA = Winkel zur Achse (halber Spitzenwinkel)
      if (num(g.TA) !== undefined) t.angle = num(g.TA)! * 2;
      t.tipDia = mm(g["tip-diameter"]) ?? 0;
    }
    if (type === "drill" || type === "countersink") t.angle = num(g.SIG);
    if (type === "threadmill") {
      t.pitch = mm(g.TP);
      t.angle = num(g["thread-profile-angle"]) ?? 60;
      t.threadSingle = num(g.NT) === 1;
      // Einzahn: Schneidenlänge = Schulterlänge (wie tief der Hals reicht); Hals-Ø = erster Schaft-Abschnitt
      if (t.threadSingle) {
        t.fluteLen = mm(g["shoulder-length"]) ?? t.fluteLen;
        const neck = mm(x.shaft?.segments?.[0]?.["lower-diameter"]);
        if (neck && neck < t.diameter) t.neckDia = neck;
      }
    }
    // Schnittwerte: Vorlage zum eingestellten Material, sonst die erste
    const presets: any[] = Array.isArray(x["start-values"]?.presets) ? x["start-values"].presets : [];
    const fits = (p: any) => MAT_WORDS.some(([re, mats]) => re.test(String(p?.name || "")) && mats.includes(material));
    const p = presets.find(fits) || presets[0];
    if (p) {
      if (num(p.n)) t.rpm = Math.round(num(p.n)!);
      if (num(p.v_f)) t.feedrate = Math.round(num(p.v_f)! * k);
      if (num(p.v_f_plunge)) t.plungeFeed = Math.round(num(p.v_f_plunge)! * k);
      if (p["use-stepdown"] && num(p.stepdown)) t.stepZ = num(p.stepdown)! * k;
    }
    const notes = [
      x["product-id"] ? String(x["product-id"]) : "",
      x["product-link"] ? String(x["product-link"]) : "",
      ...presets.filter(q => num(q?.n) && num(q?.v_f)).map(q => `${String(q.name || "").slice(0, 40)}: S${Math.round(q.n)} F${Math.round(q.v_f * k)}`),
    ].filter(Boolean);
    t.notes = ("Fusion 360: " + notes.join(" · ")).slice(0, 500);
    // fehlende Werte nicht als undefined übergeben (sanitize nimmt dann die Standardwerte der Art)
    for (const key of Object.keys(t)) if (t[key] === undefined) delete t[key];
    out.push(t);
  }
  return { tools: out, skipped };
}

/**
 * Erste .json-Datei aus einer ZIP-Datei (.tools) als Text. Liest das Inhaltsverzeichnis am Dateiende,
 * entpackt mit dem eingebauten DecompressionStream („deflate-raw“). Wirft Error("lib-invalid").
 */
export async function unzipJson(bytes: Uint8Array): Promise<string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true), u32 = (o: number) => dv.getUint32(o, true);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("lib-invalid");
  let p = u32(eocd + 16);
  const count = u16(eocd + 10);
  for (let e = 0; e < count && p + 46 <= bytes.length; e++) {
    if (u32(p) !== 0x02014b50) break;
    const method = u16(p + 10), size = u32(p + 20), nameLen = u16(p + 28), extraLen = u16(p + 30), commLen = u16(p + 32);
    const local = u32(p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commLen;
    if (!/\.json$/i.test(name) || u32(local) !== 0x04034b50) continue;
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) return new TextDecoder().decode(raw);
    if (method !== 8 || typeof DecompressionStream === "undefined") throw new Error("lib-invalid");
    const stream = new Blob([raw.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return await new Response(stream).text();
  }
  throw new Error("lib-invalid");
}
