// PDF import: TypeScript (src/importers/pdfParse.ts) and Rust (src-tauri/src/importpdf.rs) must find the same content
// streams and read the same paths. This test builds small PDFs and pins what the TypeScript reads in
// fixtures/importpdf-cases.json (file as hex); `cargo test importpdf` compares the Rust result (numbers to 1e-9).
// After a wanted change:  UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test importpdf
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { pdfParse } from "../src/importers/pdfParse.ts";

const file = new URL("./fixtures/importpdf-cases.json", import.meta.url);
const latin = (s: string) => Buffer.from(s, "latin1");
type Stream = { dict?: string; data: string | Buffer; nl?: string };
const pdf = (streams: Stream[], head = "%PDF-1.4\n") => {
  const parts: Buffer[] = [latin(head)];
  streams.forEach((s, k) => {
    const data = typeof s.data === "string" ? latin(s.data) : s.data;
    parts.push(latin(`${k + 1} 0 obj\n<< /Length ${data.length} ${s.dict ?? ""} >>\nstream${s.nl ?? "\n"}`), data, latin("\nendstream\nendobj\n"));
  });
  parts.push(latin("trailer\n<< >>\n%%EOF\n"));
  return Buffer.concat(parts);
};
const fl = (s: string) => deflateSync(latin(s));
const a85 = (b: Buffer) => {
  let out = "<~";
  for (let i = 0; i < b.length; i += 4) {
    const g = [0, 1, 2, 3].map(k => b[i + k] ?? 0), n = Math.min(4, b.length - i);
    let v = ((g[0] << 24) >>> 0) + (g[1] << 16) + (g[2] << 8) + g[3];
    if (v === 0 && n === 4) { out += "z"; continue; }
    const c: string[] = [];
    for (let k = 0; k < 5; k++) { c.unshift(String.fromCharCode(33 + (v % 85))); v = Math.floor(v / 85); }
    out += c.slice(0, n + 1).join("");
  }
  return out + "~>";
};
const hex = (b: Buffer) => [...b].map(x => x.toString(16).padStart(2, "0")).join(" ") + ">";

const cases: { name: string; pdf: Buffer }[] = [];
const add = (name: string, b: Buffer) => cases.push({ name, pdf: b });
const SQ = "0 0 m 100 0 l 100 100 l 0 100 l h S\n";
add("square", pdf([{ data: SQ }]));
add("rectangle and fill", pdf([{ data: "10 10 50 30 re f\n20 20 m 40 40 l S" }]));
add("curves c v y", pdf([{ data: "0 0 m 0 50 50 100 100 100 c 150 100 200 50 v 200 0 250 0 y S\n" }]));
add("closing paint s b b*", pdf([{ data: "0 0 m 10 0 l 10 10 l s 20 0 m 30 0 l 30 10 l b 40 0 m 50 0 l 50 10 l b*\n" }]));
add("all paint ops", pdf([{ data: "0 0 m 1 1 l S 0 0 m 2 2 l f 0 0 m 3 3 l F 0 0 m 4 4 l f* 0 0 m 5 5 l B 0 0 m 6 6 l B* \n" }]));
add("clip path is dropped", pdf([{ data: "0 0 100 100 re W n 5 5 m 50 50 l S\n" }]));
add("cm, q and Q", pdf([{ data: "q 2 0 0 2 10 10 cm 0 0 m 10 0 l S Q 0 0 m 10 0 l S q 0.7071 0.7071 -0.7071 0.7071 0 0 cm 0 0 10 10 re S Q Q Q 1 1 m 2 2 l S\n" }]));
add("line without move and h restarts", pdf([{ data: "50 50 l 60 60 l S 0 0 m 10 0 l 10 10 l h 20 20 l S\n" }]));
add("re after open path", pdf([{ data: "0 0 m 5 5 l 10 10 20 20 re 30 30 l S\n" }]));
add("degenerate rectangle", pdf([{ data: "5 5 0 0 re S\n" }, { data: "1 1 m 2 2 l S 7 7 0 0 re S\n" }]));
add("closed path with repeated end point", pdf([{ data: "0 0 m 10 0 l 10 10 l 0 0 l h S\n" }]));
add("text blocks are skipped", pdf([{ data: "BT /F1 12 Tf 10 10 Td (Hello (nested) \\) text) Tj 0 0 m ET " + SQ + "BT ET\n" }]));
add("strings, names, hex and dicts", pdf([{ data: "/GS1 gs (a\\(b) Tj <414243> Tj << /A << /B 1 >> >> BDC 0 0 m [1 2] 0 d 5 5 l S EMC\n" }]));
add("inline image", pdf([{ data: "q BI /W 2 /H 2 ID \x00\xff m l S EI Q " + SQ }]));
add("comments", pdf([{ data: "% 0 0 m 99 99 l S\n0 0 m % ignore\r10 10 l S %end" }]));
add("odd numbers", pdf([{ data: "+1 -2 m .5 1. l -.25 +3.0 l 1e2 0 l 3 S 0 0 m 1.2.3 5 l S\n" }]));
add("missing operands", pdf([{ data: "0 0 m 5 l S 1 1 m l S 3 m 4 4 l S cm 0 0 m 1 1 l S\n" }]));
add("operators run together", pdf([{ data: "0 0 m 10 10 l/Name 5 5 l S\n" }]));
add("whitespace kinds", pdf([{ data: "0\t0\fm\x0010 10\rl\nS" }]));
add("flate", pdf([{ dict: "/Filter /FlateDecode", data: fl(SQ) }]));
add("flate short name in array", pdf([{ dict: "/Filter [/Fl]", data: fl("1 1 m 9 9 l S\n") }]));
add("ascii85 then flate", pdf([{ dict: "/Filter [/ASCII85Decode /FlateDecode]", data: latin(a85(fl(SQ))) }]));
add("ascii85 plain with z", pdf([{ dict: "/Filter /A85", data: latin(a85(Buffer.concat([latin("0 0 m "), Buffer.alloc(4), latin(" 7 7 l S\n")]))) }]));
add("ascii hex", pdf([{ dict: "/Filter /ASCIIHexDecode", data: latin(hex(latin(SQ))) }, { dict: "/Filter /AHx", data: latin("30 20 30 20 6d 20 35 20 35 20 6c 20 53 0>") }]));
add("unknown filter is counted", pdf([{ dict: "/Filter /DCTDecode", data: SQ }, { dict: "/Filter [/LZWDecode /FlateDecode]", data: fl(SQ) }, { data: "2 2 m 3 3 l S" }]));
add("broken flate", pdf([{ dict: "/Filter /FlateDecode", data: fl(SQ).subarray(0, 10) }, { dict: "/Filter /FlateDecode", data: Buffer.concat([fl(SQ), latin("junk")]) }, { dict: "/Filter /FlateDecode", data: latin("not deflate") }, { data: SQ }]));
add("skipped dictionaries", pdf([
  { dict: "/Subtype /Image", data: SQ }, { dict: "/Length1 100", data: SQ }, { dict: "/Length10 5", data: "4 4 m 5 5 l S" }, { dict: "/Type/XObject", data: SQ },
  { dict: "/Type /ObjStm", data: SQ }, { dict: "/FunctionType 4", data: SQ }, { dict: "/ShadingType 2", data: SQ }, { dict: "/N 3", data: SQ }, { dict: "/N 2", data: "6 6 m 7 7 l S" }, { dict: "/N 12", data: "8 8 m 9 9 l S" },
  { dict: "/Type /Page", data: "1 2 m 3 4 l S" }]));
add("streams that are not drawings", pdf([{ data: "BT (no path) Tj ET" }, { data: "0 0 m 10 10 l" }, { data: "10 10 20 20 re\nn" }, { data: "x re y S" }, { data: "0 0 m 1 1 l S*" }]));
add("CRLF after stream and trailing line ends", pdf([{ data: SQ + "\r\n\r\n", nl: "\r\n" }]));
add("stream keyword without line end", Buffer.concat([latin("%PDF-1.3\n1 0 obj << >> stream 0 0 m 1 1 l S endstream\n2 0 obj << >>\nstream\r"), latin("\n5 5 m 6 6 l S\nendstream\n")]));
add("stream keyword with a lone CR", Buffer.concat([latin("%PDF-1.3\n1 0 obj << >>\nstream\r0 0 m 9 9 l S\nendstream\n2 0 obj << >>\nstream\n1 1 m 2 2 l S\nendstream\n")]));
add("object keyword right before stream", latin("%PDF-1.4\n1 0 obj << /Subtype /Image >>\n2 0 obj stream\n0 0 m 9 9 l S\nendstream\n"));
add("flate followed by CR", pdf([{ dict: "/Filter /FlateDecode", data: Buffer.concat([fl(SQ), latin("\r")]) }]));
add("N without space and a broken first filter", pdf([{ dict: "/N1 x", data: "3 3 m 4 4 l S" }, { dict: "/Filter% /Filter /AHx", data: latin(hex(latin(SQ))) }]));
add("ascii85 with z and a stray v", pdf([{ dict: "/Filter /A85", data: latin(a85(Buffer.concat([Buffer.alloc(4), latin("0 0 m 9 9 l S\n")]))) }, { dict: "/Filter /A85", data: latin(a85(latin(SQ)).replace("~>", "v~>").slice(0, 5) + "v" + a85(latin(SQ)).slice(5)) }]));
add("nested strings, dicts and names between operands", pdf([{ data: "(a(b)l) Tj << /A << /B 1 >> 7 l >> BDC 0 0 m 5 5 l S 1 2 /X 3 m 9 9 l S\n" }]));
add("text ends only at ET", pdf([{ data: "BT (x) Tj 1 1 m 5 5 l S ET BT /F1 1 Tf ET 0 0 m 5 5 l S\n" }]));
add("q and Q nested", pdf([{ data: "q 2 0 0 2 0 0 cm q 3 0 0 3 0 0 cm Q Q 0 0 m 1 1 l S\n" }]));
add("open path ending at its start", pdf([{ data: "0 0 m 10 0 l 10 10 l 0 0 l S\n" }]));
add("no endstream", Buffer.concat([pdf([{ data: SQ }]), latin("3 0 obj << >>\nstream\n0 0 m 9 9 l S\n")]));
add("several pages", pdf([{ data: SQ }, { data: "q 0.5 0 0 0.5 0 0 cm " + SQ + "Q" }, { data: "200 200 10 10 re B" }]));
// these froze the reader before (a lone delimiter outside a string: the position never moved)
add("stray delimiters", pdf([{ data: "0 0 m 10 10 l ) S 1 1 m > 2 2 l } { S\n3 3 m\x0b4 4 l\xa0S\n" }]));
add("stray bracket before the first operator", pdf([{ data: ")0 0 m 5 5 l S" }]));
add("bytes above 127", pdf([{ data: "0 0 m 10 10 l S\n(\x80\xa9\xff) Tj\n" }]));
add("postscript", latin("%!PS-Adobe-3.0\n0 0 moveto\n"));
add("not a pdf", latin("hello"));
add("pdf without streams", latin("%PDF-1.7\n1 0 obj << >> endobj\n"));

test("PDF import: pinned result for Rust (importpdf-cases.json)", async () => {
  const built = [];
  for (const c of cases) {
    const want = await pdfParse(new Uint8Array(c.pdf));
    // a missing operand gives "no number" (NaN): JSON writes null, and so does Rust
    built.push({ name: c.name, pdf: c.pdf.toString("hex"), want });
  }
  const text = JSON.stringify(built) + "\n";
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, text);
  assert.equal(readFileSync(file, "utf8"), text, "fixture differs – run UPDATE_FIXTURES=1 npm test after a wanted change");
});
