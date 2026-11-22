/**
 * Set only while a router program is generated for a file that goes through a post-processor other than GRBL
 * (postExport.ts, withPost). Everything else – Simulation, "To machine", GRBL files – sees both switches off and
 * gets the same G-code as always.
 *
 * foreign    the file is for another controller: leave out what only CNC Craft's own sender understands
 *            (stops for re-measuring the tool)
 * toolTable  the controller knows the tool lengths: write every tool with its number, also the first one
 */
export const postCtx = { foreign: false, toolTable: false };
