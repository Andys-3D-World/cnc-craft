/**
 * EIGENE SYMBOLE (SVG) – sehen auf Windows, Mac und Linux gleich aus.
 * Alle Symbole: 24×24, Linienstärke über CSS (currentColor).
 */
const P: Record<string, string> = {
  // ---- Zeichenwerkzeuge ----
  select: `<path d="M5 3l13 8-6 1.5 3.5 6.5-2.5 1.3-3.5-6.5L5 18z"/>`,
  pan: `<path d="M8 12V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V5.5a1.5 1.5 0 013 0V13M8 12V9.5a1.5 1.5 0 00-3 0V14c0 4 3 7 7 7h1c3.5 0 5-2.5 5-6v-3"/>`,
  line: `<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>`,
  rect: `<rect x="4" y="6" width="16" height="12" rx="1"/>`,
  ellipse: `<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>`,
  polygon: `<path d="M12 3.5l7.5 4.3v8.4L12 20.5l-7.5-4.3V7.8z"/>`,
  arc: `<path d="M4 18a8 8 0 0116 0"/><circle cx="4" cy="18" r="1.4"/><circle cx="20" cy="18" r="1.4"/>`,
  text: `<path d="M5 6V4.5h14V6M12 4.5V19.5M9 19.5h6"/>`,
  measure: `<path d="M3.5 15.5l12-12 5 5-12 12z"/><path d="M7 12l2 2M10 9l1.5 1.5M13 6l2 2"/>`,

  // ---- Datei ----
  import: `<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>`,
  open: `<path d="M3 7.5V18a1 1 0 001 1h16a1 1 0 001-1V9a1 1 0 00-1-1h-8l-2-2.5H4a1 1 0 00-1 1z"/>`,
  save: `<path d="M5 4h11l3 3v12a1 1 0 01-1 1H6a1 1 0 01-1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>`,
  clear: `<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/>`,

  // ---- G-Code ----
  gcode: `<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M10 11.5l-2 2.5 2 2.5M15 11.5l2 2.5-2 2.5"/>`,
  gcodeSave: `<path d="M13 21H6V3h9l4 4v6"/><path d="M15 3v4h4"/><path d="M18 15v6M15.5 18.5l2.5 2.5 2.5-2.5"/>`,
  simulate: `<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5.5 3.5-5.5 3.5z"/>`,

  // ---- Bearbeiten ----
  undo: `<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>`,
  redo: `<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>`,
  copy: `<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>`,
  paste: `<rect x="5" y="5" width="14" height="16" rx="1.5"/><path d="M9 5V3.5h6V5M9 11h6M9 15h4"/>`,
  delete: `<path d="M6 6l12 12M18 6L6 18"/>`,
  duplicate: `<rect x="4" y="4" width="11" height="11" rx="1.5"/><rect x="9" y="9" width="11" height="11" rx="1.5"/>`,
  selectAll: `<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 2.5"/><rect x="8.5" y="8.5" width="7" height="7"/>`,
  group: `<rect x="3.5" y="3.5" width="17" height="17" rx="1" stroke-dasharray="3 2.5"/><rect x="7" y="7" width="5" height="5"/><circle cx="15" cy="15" r="2.7"/>`,
  ungroup: `<rect x="4" y="4" width="7" height="7"/><circle cx="16.5" cy="16.5" r="3.5"/><path d="M14 4h6v6M4 14v6h6" stroke-dasharray="2.5 2"/>`,
  splitParts: `<rect x="3" y="5" width="8" height="14" rx="1"/><circle cx="7" cy="12" r="1.8"/><rect x="13" y="5" width="8" height="14" rx="1"/><circle cx="17" cy="12" r="1.8"/>`,
  offset: `<rect x="8" y="8" width="8" height="8" rx="1"/><rect x="4" y="4" width="16" height="16" rx="4" stroke-dasharray="3 2"/>`,
  zoomFit: `<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="8.5" y="8.5" width="7" height="7"/>`,

  // ---- Transformieren ----
  mirrorH: `<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L4 17h5zM15 7l5 10h-5z"/>`,
  mirrorV: `<path d="M3 12h18" stroke-dasharray="2 2"/><path d="M7 9L17 4v5zM7 15l10 5v-5z"/>`,
  rotateLeft: `<path d="M4 5v5h5"/><path d="M4.5 10A8 8 0 1112 20"/>`,
  rotateRight: `<path d="M20 5v5h-5"/><path d="M19.5 10A8 8 0 1012 20"/>`,

  // ---- Ausrichten ----
  alignLeft: `<path d="M4 3v18"/><rect x="7" y="6" width="12" height="4"/><rect x="7" y="14" width="7" height="4"/>`,
  alignCenterH: `<path d="M12 3v18"/><rect x="5" y="6" width="14" height="4"/><rect x="8" y="14" width="8" height="4"/>`,
  alignRight: `<path d="M20 3v18"/><rect x="5" y="6" width="12" height="4"/><rect x="10" y="14" width="7" height="4"/>`,
  alignTop: `<path d="M3 4h18"/><rect x="6" y="7" width="4" height="12"/><rect x="14" y="7" width="4" height="7"/>`,
  alignCenterV: `<path d="M3 12h18"/><rect x="6" y="5" width="4" height="14"/><rect x="14" y="8" width="4" height="8"/>`,
  alignBottom: `<path d="M3 20h18"/><rect x="6" y="5" width="4" height="12"/><rect x="14" y="10" width="4" height="7"/>`,

  // ---- Sonstiges ----
  endmill: `<path d="M9 3h6v6H9z"/><path d="M9.5 9l-.5 9 3 3 3-3-.5-9"/><path d="M9.3 12.5l5.4-2M9.2 16l5.6-2.2"/>`,
  placeFree: `<rect x="3" y="3" width="18" height="18" rx="1.5" stroke-dasharray="3 2.5"/><path d="M3 12h6M12 3v6" opacity=".5"/><rect x="12.5" y="12.5" width="6" height="6"/><path d="M7 7l4.5 4.5M11.5 8.5v3h-3"/>`,
  magnet: `<path d="M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4z"/><path d="M6 7.5h4M14 7.5h4"/>`,
  grid: `<rect x="4" y="4" width="16" height="16"/><path d="M4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16"/>`,
  globe: `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>`,
  console: `<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M7 9l3 3-3 3M12 15h5"/>`
};

export function icon(name: string, size = 18): string {
  const body = P[name] || P.select;
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
