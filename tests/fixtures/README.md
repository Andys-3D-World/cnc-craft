# Test fixtures

`post-drawing.gcode` and `post-drawing-table.gcode` are the neutral router program of one small test drawing, written by
`src/cam.ts` in the running app (language English, tools of a fresh install: T1 = 3 mm end mill, T2 = 6 mm end mill):

- outline 100 x 70 mm, cut out (outside) 6 mm deep with 4 holding tabs, tool T2
- pocket 28 x 20 mm, 3 mm deep, tool T1
- three drilled holes, 6 mm deep, tool T1
- a round hole (inside), radius 9 mm, 4 mm deep, tool T1 – this gives the arcs (G2/G3)
- a tool change between T1 and T2

`post-drawing.gcode` is what GRBL gets (and what every post without tool table starts from).
`post-drawing-table.gcode` is the same job generated for a controller with a tool table: the tools carry their numbers,
the first one too. `tests/postProcess.test.ts` sends both through every post-processor, in mm and in inches.

To make them again after a change to the generator: start the preview, build the drawing above and call
`generateGcode(shapes)` – once as it is, once inside `withPost()` (src/post/postExport.ts) with LinuxCNC and
"Tool table" chosen.

`nodegraph-0.4.8.cncgraph` is a node-graph template file as version 0.4.8 wrote it: every node type of that version
with the settings and connections it had then. `tests/nodeGraph.test.ts` loads it to make sure old templates keep working.

`millgcode-cases.json.gz` (gzip, because pocket G-code is long; pack it with `gzip -9 -n`) holds, for 156 small test drawings, the job for the Rust mill G-code (`src/camJob.ts`), what `src/cam.ts` gives beside the G-code (`side`: warnings as shown, threads, tool per section) and the G-code
that `src/cam.ts` gives for it. `cargo test millgcode` checks that `src-tauri/src/millgcode.rs` gives the same G-code line
by line. `cam.ts` cannot run under node, so the file is made in the preview with `millgcode-make.js` (the steps are at the
top of that file; the text is 7 MB, so let the page post it to a small local receiver instead of copying it by hand).
A tool-less job ("Standard") cannot be made in the preview, the library always keeps one tool: that case is a hand-written
test in `millgcode.rs`. Make it again whenever `cam.ts` changes something in the parts the Rust version covers – otherwise
the test compares against an old `cam.ts`.

`keepout-cases.json` / `keepout-expected.json` (keep-out zones for clamps) and `rotarywrap-cases.json.gz` /
`rotarywrap-expected.json.gz` (rotary axis; packed, because arcs become many short lines) are shared cases for a
TypeScript module and its Rust twin: `src/keepOut.ts` and `src-tauri/src/keepout.rs`, `src/rotaryWrap.ts` and
`src-tauri/src/rotarywrap.rs`. The cases are written by `keepout-make.py` and `rotarywrap-make.py` (hand-written edge
cases, real router programs taken from `millgcode-cases.json.gz`, random programs with a fixed seed). `npm test` pins
what the TypeScript gives in the `-expected` file (`UPDATE_FIXTURES=1 npm test` writes it again), `cargo test keepout`
and `cargo test rotarywrap` compare the Rust result with it line by line. The rotary `-expected` file also holds the job
the Rust side gets for each case (`wrapJob` in `src/rotaryRust.ts`).

`lasergcode-cases.json.gz` holds, for 75 small laser drawings, the job for the Rust laser G-code (`src/laserJob.ts`), the
G-code and the warnings that `src/laserCam.ts` gives for it; drawings with pictures also hold the rastered picture points
(`data`: zlib-packed, base64). `cargo test lasergcode` checks that
`src-tauri/src/lasergcode.rs` gives the same G-code line by line and the same warnings. Like the mill cases it is made in
the preview, with `lasergcode-make.js` (steps at the top of that file). Make it again whenever `laserCam.ts` or
`laserJob.ts` changes.
