/**
 * EMOJI → EIGENE SYMBOLE
 *
 * Bunte System-Emojis sehen auf Windows, Mac und Linux jedes Mal anders aus und passen nicht zur Oberfläche. In allen Texten bleiben sie
 * als einfache Zeichen stehen (auch in den Übersetzungen); beim Anzeigen ersetzt ui/emojiIcons.ts sie durch das passende Symbol aus icons.ts.
 * Schlichte Textzeichen (Pfeile, ✓, ✕, ▲ …) gehören zur Schrift und bleiben.
 *
 * Nur die Zuordnung und das Zerlegen, ohne Oberfläche (Tests: tests/emojiMap.test.ts).
 */
const GROUPS: Record<string, string> = {
  play: "▶", pause: "⏸", stop: "⏹", record: "⏺🔴", next: "⏭", prev: "⏮", eject: "⏏", check: "✔", xmark: "❌", warning: "⚠", forbidden: "⛔🛑", checkCircle: "✅",
  plus: "➕", arrowUp: "⬆", arrowDown: "⬇", wave: "〰", sun: "☀", moon: "🌙", coffee: "☕", recycle: "♻", gear: "⚙", bolt: "⚡", fullscreen: "⛶", cut: "✂", pan: "✋",
  pencil: "✎✏✒", sparkle: "✨🆕🎉", snow: "❄", heart: "❤💖", spiral: "🌀", globe: "🌐", thermo: "🌡", leaf: "🌿", sliders: "🎛", camera: "🎥📷📸", palette: "🎨", clap: "🎬",
  target: "🎯", dice: "🎲", mountain: "🏔🪨", home: "🏠", factory: "🏭", bug: "🐞", eye: "👁", bulb: "💡", drop: "💧", wind: "💨", cost: "💶", save: "💾", open: "📁📂",
  file: "📄📜📰🧾", clipboard: "📋", pin: "📍", scale: "📏", setSquare: "📐", books: "📚", antenna: "📡", export: "📤", import: "📥", boxgen: "📦", wifi: "📶", shuffle: "🔀",
  refresh: "🔁🔄", plug: "🔌", search: "🔍🔎", lock: "🔒", unlock: "🔓", bell: "🔔", link: "🔗", radio: "🔘", text: "🔤", flame: "🔥", laser: "🔦", wrench: "🔧", screw: "🔩",
  rect: "🔲", diamond: "🔷", triangleDown: "🔻", hole: "🕳", monitor: "🖥", printer: "🖨", image: "🖼", cabinet: "🗄", clear: "🗑", map: "🗺", smile: "🙂", rocket: "🚀",
  siren: "🚨", door: "🚪", endmill: "🛠", robot: "🤖", foot: "🦶", view3d: "🧊", puzzle: "🧩", flask: "🧪", compass: "🧭", calc: "🧮", brick: "🧱", wood: "🪵", star: "⭐", info: "ℹ",
};

export const EMOJI_ICONS: Record<string, string> = {};
for (const [name, list] of Object.entries(GROUPS)) for (const ch of list) EMOJI_ICONS[ch] = name;

/** Symbole, die ihre Bedeutung über die Farbe mittragen; alle anderen nehmen die Textfarbe an */
export const ICON_COLORS: Record<string, string> = { heart: "#e8445a", warning: "#f5a524", forbidden: "#e5484d", xmark: "#e5484d", siren: "#e5484d", checkCircle: "#3ccf4e", flame: "#f76707" };

// Emoji-Zeichen samt dem unsichtbaren „bunt anzeigen“-Zusatz (U+FE0F); Doppelzeichen wie 〰️ gehören zusammen
const RE = new RegExp(`(${Object.keys(EMOJI_ICONS).join("|")})️?`, "gu");

export type Piece = { text: string } | { icon: string };

/** Text in Textstücke und Symbole zerlegen. null = nichts zu ersetzen (der häufigste Fall, muss schnell sein) */
export function splitEmoji(s: string): Piece[] | null {
  RE.lastIndex = 0;
  if (!RE.test(s)) return null;
  RE.lastIndex = 0;
  const out: Piece[] = [];
  let at = 0;
  for (const m of s.matchAll(RE)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    out.push({ icon: EMOJI_ICONS[m[1]] });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** Für Stellen ohne Symbole (Auswahllisten, Platzhalter): Emoji und den Abstand dahinter einfach weglassen */
export function stripEmoji(s: string): string {
  const p = splitEmoji(s);
  if (!p) return s;
  return p.map(q => ("text" in q ? q.text : "\u0000")).join("").replace(/\u0000\s*/g, "").replace(/\s+\u0000/g, "").trim();
}
