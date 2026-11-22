/**
 * POST-PROCESSORS (data only)
 *
 * CNC Craft writes its router programs in one neutral form: millimetres, the way GRBL reads them. A post-processor
 * turns that program into a file for another controller. Each controller is one entry in POSTS below: a few values
 * and short templates. To support another controller, copy an entry and change it – postProcess.ts does the rest.
 *
 * Only the SAVED FILE goes through a post. "To machine" always sends the neutral program with the machine's own protocol.
 *
 * Placeholders in the templates:
 *   {info}   comment lines CNC Craft adds at the top (which post, which unit, warnings)
 *   {units}  G21 (millimetres) or G20 (inches)
 *   {g49}    G49 when the tool lengths come from the controller's tool table, otherwise nothing
 *   {blend}  path tolerance `blend`, in the unit of the file
 *   {t}      tool number (tool change templates)
 *   {z}      the height the tool was at before the tool change, in the unit of the file (line is left out if unknown)
 *
 * Where the values come from (public manuals, read in November 2026 – none of this has run on a real machine):
 *
 * LinuxCNC (linuxcnc.org/docs, G-code overview, G-codes, M-codes):
 *   - "%" first and last line is optional when the file has M2/M30. With it, LinuxCNC refuses a file whose end is
 *     missing ("percent line at the beginning but not at the end"), so a cut-off file does not run halfway.
 *   - preamble from "G-code Best Practices": G17 G20 G40 G49 G54 G80 G90 G94 (here with the unit of the file)
 *   - G91.1: I and J are measured from the start of the arc (the default, stated anyway)
 *   - G64 P: path blending, the path stays within P of the programmed points
 *   - G4 P is in seconds, fractions allowed
 *   - "T1 M6" changes the tool, "G43 H1" uses the length of tool 1 from the tool table; G43 does not move
 *   - M0 pauses, but nothing can be moved by hand or set to zero during the pause
 *   - a comment "(MSG, …)" is shown as a message – postProcess.ts keeps ordinary comments from starting like that
 *
 * Mach3 ("Using Mach3Mill" 1.84, chapter 10; "Mach3Mill Install & Config"):
 *   - G4 P is seconds OR milliseconds, depending on the Mach3 setting "G04 Dwell in ms" (Config > General Config).
 *     This post writes seconds: the setting has to be off (the note next to the choice says so).
 *   - M6 calls the tool change of the machine, or does nothing if Mach3 is set to "Ignore Tool Change"
 *   - G43 H~ uses the tool table, G49 switches it off; G90.1 / G91.1 set how I and J are read
 *   - an arc is an error if its two radii differ by more than 0.0002 inch / 0.002 mm (10.7.3.2) –
 *     postProcess.ts centres every arc again after rounding
 *   - M30 ends the program and rewinds; files usually end in .tap; line numbers go up to N99999
 *
 * Mach4 ("Mach4 CNC Controller Mill Programming Guide" 1.1):
 *   - G4 P without a decimal point is milliseconds, with a decimal point seconds – so the time is written "P2.0"
 *   - safe start line from the guide: G00 G90 G17 G54 G40 G49 G80
 *   - the guide ends its programs with M30 and a "%" line
 *   - "T1 M6", then "G43 H1" (no move when no axis is on the line)
 */
export interface PostDef {
  /** stored in the setting – do not change once released */
  id: string;
  /** shown in the list (a product name, not translated) */
  name: string;
  /** ending of the saved file, without the dot */
  ext: string;
  /** false: the program stays as CNC Craft writes it for GRBL (only inches are converted) */
  rewrite: boolean;
  /** lines written first */
  start: string[];
  /** lines written instead of the program end (M30); null keeps the line */
  end: string[] | null;
  /** tool change when the controller knows the tool lengths; null keeps the line as it is */
  toolTable: string[] | null;
  /** tool change as a plain pause (no tool table) */
  toolPause: string[] | null;
  /** G4 P: "s" seconds as written, "s." seconds always with a decimal point, "ms" milliseconds */
  dwell: "s" | "s." | "ms";
  /** seconds to wait after the spindle starts where the program has no wait of its own (0 = add nothing) */
  spinUp: number;
  /** 0 = no line numbers, otherwise the step (10 gives N10, N20 …) */
  lineNumbers: number;
  /** "paren" = (comment), "semicolon" = ; comment */
  comment: "paren" | "semicolon";
  /** path tolerance for {blend}, in mm */
  blend: number;
  /** tool lengths from the tool table can be chosen (T… M6 and G43 H…) */
  hasToolTable: boolean;
  /** texts shown next to the choice (keys in src/i18n/lang) */
  notes: string[];
  /** comment lines for the top of the file (keys in src/i18n/lang) */
  fileNotes: string[];
}

export const POSTS: PostDef[] = [
  {
    id: "grbl", name: "GRBL", ext: "gcode", rewrite: false,
    start: ["{info}"],
    end: null, toolTable: null, toolPause: null,
    dwell: "s", spinUp: 0, lineNumbers: 0, comment: "paren", blend: 0,
    hasToolTable: false,
    notes: [], fileNotes: []
  },
  {
    id: "linuxcnc", name: "LinuxCNC", ext: "ngc", rewrite: true,
    start: ["%", "{info}", "G17 {units} G40 {g49} G54 G80 G90 G94", "G91.1", "G64 P{blend}"],
    end: ["M2", "%"],
    toolTable: ["T{t} M6", "G43 H{t}", "G0 Z{z}"],
    toolPause: ["M0"],
    dwell: "s", spinUp: 2, lineNumbers: 0, comment: "paren", blend: 0.01,
    hasToolTable: true,
    notes: ["post.note.untested", "post.note.linuxcncPause"], fileNotes: []
  },
  {
    id: "mach3", name: "Mach3", ext: "tap", rewrite: true,
    start: ["{info}", "G17 {units} G40 {g49} G54 G80 G90 G94", "G91.1"],
    end: ["M30"],
    toolTable: ["T{t} M6", "G43 H{t}", "G0 Z{z}"],
    toolPause: ["M0"],
    dwell: "s", spinUp: 2, lineNumbers: 0, comment: "paren", blend: 0,
    hasToolTable: true,
    notes: ["post.note.untested", "post.note.mach3Dwell"], fileNotes: ["post.gc.mach3Dwell"]
  },
  {
    id: "mach4", name: "Mach4", ext: "tap", rewrite: true,
    start: ["{info}", "G0 G90 G17 G54 G40 {g49} G80", "{units} G94 G91.1"],
    end: ["M30", "%"],
    toolTable: ["T{t} M6", "G43 H{t}", "G0 Z{z}"],
    toolPause: ["M0"],
    dwell: "s.", spinUp: 2, lineNumbers: 0, comment: "paren", blend: 0,
    hasToolTable: true,
    notes: ["post.note.untested"], fileNotes: []
  }
];

export const DEFAULT_POST = "grbl";

export function postById(id: string | null | undefined): PostDef {
  return POSTS.find(p => p.id === id) ?? POSTS[0];
}
