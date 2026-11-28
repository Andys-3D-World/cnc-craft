//! PDF/AI-IMPORT – Zwilling von `pdfParse` in `src/importers/pdfParse.ts`.
//!
//! Sucht die Seiteninhalte (Streams, auch FlateDecode/ASCII85/ASCIIHex) und führt deren Zeichenbefehle aus: Linien,
//! Bézierkurven, Rechtecke, Transformationen (cm, q/Q). Text, Bilder und Schnittmasken werden übersprungen.
//! Folgt dem TypeScript Zeile für Zeile auf den Bytes (der Text im Fenster ist windows-1252: ein Zeichen je Byte;
//! nur 0xA0 zählt dort zusätzlich als Leerraum). Kurven: der Test vergleicht Zahlen auf 1e-9 genau.
//! Entpacken: wie DecompressionStream in Node ein Fehler bei abgeschnittenen Daten, falscher Prüfsumme und Resten danach.
//! Gemeinsame Fälle: `tests/fixtures/importpdf-cases.json` (festgehalten von `tests/importPdfRust.test.ts`).

use crate::gcodesim::hypot2;
use crate::importdxf::parse_float;
use crate::importplt::{Pt, CURVE_TOL};
use crate::importsvg::flatten_cubic;
use serde::Serialize;

const PT_TO_MM: f64 = 25.4 / 72.0;
const INFLATE_MAX: usize = 64 * 1024 * 1024;
type Mat = [f64; 6];

#[derive(Serialize, Clone, Debug)]
pub struct Path {
    pub pts: Vec<Pt>,
    pub closed: bool,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    pub kind: &'static str,
    pub paths: Vec<Path>,
    pub contents: usize,
    pub text_blocks: usize,
    pub skipped_filters: usize,
}

/// `\s` im Fenster für ein Byte (windows-1252)
fn ws(b: u8) -> bool {
    matches!(b, 9..=13 | 32 | 0xA0)
}
fn word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}
fn find(h: &[u8], n: &[u8], from: usize) -> Option<usize> {
    (from..=h.len().checked_sub(n.len())?).find(|&i| h[i..].starts_with(n))
}
fn mat_mul(m: &Mat, n: &Mat) -> Mat {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}
fn mat_apply(m: &Mat, x: f64, y: f64) -> Pt {
    Pt { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

/// Muster, die einen Stream ausschließen (Bilder, Schriften, Objekt-Streams …) – die Regel aus pdfParse.ts
fn skip_dict(d: &[u8]) -> bool {
    let at = |i: usize, s: &[u8]| d[i..].starts_with(s);
    let spaces = |mut j: usize| {
        while j < d.len() && ws(d[j]) {
            j += 1;
        }
        j
    };
    (0..d.len()).any(|i| {
        if at(i, b"/Subtype") {
            let j = spaces(i + 8);
            if d.get(j) == Some(&b'/') {
                return true;
            }
        }
        if at(i, b"/Length") && matches!(d.get(i + 7), Some(b'1'..=b'3')) && !d.get(i + 8).is_some_and(|&b| word(b)) {
            return true;
        }
        if at(i, b"/Type") {
            let j = spaces(i + 5);
            if d.get(j) == Some(&b'/') && [&b"XRef"[..], b"ObjStm", b"Metadata", b"XObject", b"EmbeddedFile"].iter().any(|n| d[j + 1..].starts_with(n)) {
                return true;
            }
        }
        if at(i, b"/FunctionType") || at(i, b"/ShadingType") || at(i, b"/PatternType") {
            return true;
        }
        if at(i, b"/N") {
            let j = spaces(i + 2);
            if j > i + 2 && matches!(d.get(j), Some(b'1' | b'3' | b'4')) && !d.get(j + 1).is_some_and(|&b| word(b)) {
                return true;
            }
        }
        false
    })
}

/// Filter-Namen: erstes `/Filter\s*(\[[^\]]*\]|\/\w+)`, darin alle `/\w+`
fn filters(d: &[u8]) -> Vec<String> {
    for i in 0..d.len() {
        if !d[i..].starts_with(b"/Filter") {
            continue;
        }
        let mut j = i + 7;
        while j < d.len() && ws(d[j]) {
            j += 1;
        }
        let group: Option<&[u8]> = match d.get(j) {
            Some(b'[') => d[j + 1..].iter().position(|&b| b == b']').map(|k| &d[j..j + 2 + k]),
            Some(b'/') if d.get(j + 1).is_some_and(|&b| word(b)) => {
                let mut k = j + 1;
                while k < d.len() && word(d[k]) {
                    k += 1;
                }
                Some(&d[j..k])
            }
            _ => None,
        };
        let Some(g) = group else { continue };
        let mut out = Vec::new();
        let mut k = 0;
        while k < g.len() {
            if g[k] == b'/' && g.get(k + 1).is_some_and(|&b| word(b)) {
                let mut e = k + 1;
                while e < g.len() && word(g[e]) {
                    e += 1;
                }
                out.push(String::from_utf8_lossy(&g[k..e]).into_owned());
                k = e;
            } else {
                k += 1;
            }
        }
        return out;
    }
    vec![]
}

fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    use flate2::{Decompress, FlushDecompress, Status};
    let mut z = Decompress::new(true);
    let mut out: Vec<u8> = Vec::with_capacity(data.len() * 4 + 64);
    loop {
        if out.len() == out.capacity() {
            if out.len() > INFLATE_MAX {
                return None; // Obergrenze wie inflateLimited
            }
            out.reserve(out.len().max(64 * 1024));
        }
        let before = (z.total_in(), z.total_out());
        let st = z.decompress_vec(&data[z.total_in() as usize..], &mut out, FlushDecompress::None).ok()?;
        if st == Status::StreamEnd {
            // Reste nach dem Ende: DecompressionStream meldet „Trailing junk“
            return (z.total_in() as usize == data.len() && out.len() <= INFLATE_MAX).then_some(out);
        }
        if (z.total_in(), z.total_out()) == before && out.len() < out.capacity() {
            return None; // abgeschnitten
        }
    }
}

fn ascii85(src: &[u8]) -> Vec<u8> {
    let s = src.strip_prefix(b"<~").unwrap_or(src);
    let mut out = Vec::new();
    let mut group: Vec<f64> = Vec::new();
    let word4 = |v: f64| {
        let u = v.rem_euclid(4294967296.0) as u64 as u32;
        u.to_be_bytes()
    };
    for &c in s {
        if c == b'~' {
            break;
        }
        if c == b'z' && group.is_empty() {
            out.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        if !(33..=117).contains(&c) {
            continue;
        }
        group.push(f64::from(c - 33));
        if group.len() == 5 {
            out.extend_from_slice(&word4(group.iter().fold(0.0, |v, g| v * 85.0 + g)));
            group.clear();
        }
    }
    if !group.is_empty() {
        let n = group.len();
        group.resize(5, 84.0);
        out.extend_from_slice(&word4(group.iter().fold(0.0, |v, g| v * 85.0 + g))[..n - 1]);
    }
    out
}

fn ascii_hex(src: &[u8]) -> Vec<u8> {
    let s: Vec<u8> = src.iter().copied().filter(|b| b.is_ascii_hexdigit()).collect();
    let hex = |b: u8| (b as char).to_digit(16).unwrap_or(0) as u8;
    s.chunks(2).map(|p| hex(p[0]) * 16 + p.get(1).map_or(0, |&b| hex(b))).collect()
}

/// `/(^|\s)(re|m)\s/` und `/(^|\s)[SsfFBb]\*?(\s|$)/`: hat der Stream Zeichenbefehle?
fn looks_like_drawing(t: &[u8]) -> bool {
    let start = |i: usize| i == 0 || ws(t[i - 1]);
    let path = (0..t.len()).any(|i| start(i) && (t[i..].starts_with(b"re") && t.get(i + 2).is_some_and(|&b| ws(b)) || t[i] == b'm' && t.get(i + 1).is_some_and(|&b| ws(b))));
    let paint = (0..t.len()).any(|i| {
        if !start(i) || !b"SsfFBb".contains(&t[i]) {
            return false;
        }
        let end = |j: usize| j == t.len() || ws(t[j]);
        end(i + 1) || (t.get(i + 1) == Some(&b'*') && end(i + 2))
    });
    path && paint
}

pub fn parse_pdf(bytes: &[u8]) -> Parsed {
    let mut res = Parsed { kind: "pdf", paths: vec![], contents: 0, text_blocks: 0, skipped_filters: 0 };
    if !bytes.starts_with(b"%PDF") {
        res.kind = if bytes.starts_with(b"%!PS") { "postscript" } else { "notpdf" };
        return res;
    }
    let mut contents: Vec<Vec<u8>> = Vec::new();
    let mut last = 0;
    while let Some(m) = find(bytes, b"stream", last) {
        // stream\r?\n
        let nl = if bytes.get(m + 6) == Some(&b'\n') {
            1
        } else if bytes.get(m + 6) == Some(&b'\r') && bytes.get(m + 7) == Some(&b'\n') {
            2
        } else {
            last = m + 1;
            continue;
        };
        let start = m + 6 + nl;
        let Some(end) = find(bytes, b"endstream", start) else { break };
        let dict_start = (0..=m).rev().find(|&q| bytes[q..].starts_with(b"obj"));
        let dict = dict_start.map_or(&b""[..], |q| &bytes[q..m]);
        last = end + 9;
        if skip_dict(dict) {
            continue;
        }
        let mut data: Vec<u8> = bytes[start..end].to_vec();
        while matches!(data.last(), Some(10 | 13)) {
            data.pop();
        }
        let mut ok = true;
        for f in filters(dict) {
            match f.as_str() {
                "/FlateDecode" | "/Fl" => match inflate(&data) {
                    Some(d) => data = d,
                    None => ok = false,
                },
                "/ASCII85Decode" | "/A85" => data = ascii85(&data),
                "/ASCIIHexDecode" | "/AHx" => data = ascii_hex(&data),
                _ => ok = false,
            }
        }
        if !ok {
            res.skipped_filters += 1;
            continue;
        }
        if looks_like_drawing(&data) {
            contents.push(data);
        }
    }
    let mut paths = Vec::new();
    for c in &contents {
        res.text_blocks += run_content(c, &mut paths);
    }
    res.paths = paths;
    res.contents = contents.len();
    res
}

#[derive(Clone, Copy)]
enum Op {
    Num(f64),
    Other,
}

/// Zeichenbefehle ausführen; gibt die Anzahl übersprungener Textblöcke zurück
#[allow(unused_assignments)] // start_sub! setzt cx/cy wie startSub() im TypeScript, auch wo sie gleich danach neu gesetzt werden
fn run_content(src: &[u8], out: &mut Vec<Path>) -> usize {
    let mut stack: Vec<Mat> = Vec::new();
    let mut ctm: Mat = [PT_TO_MM, 0.0, 0.0, PT_TO_MM, 0.0, 0.0];
    let mut ops: Vec<Op> = Vec::new();
    let mut subpaths: Vec<Path> = Vec::new();
    let mut cur: Option<Vec<Pt>> = None;
    let (mut cx, mut cy, mut sx, mut sy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut in_text = false;
    let mut text_blocks = 0;
    let delim = |b: u8| ws(b) || b"/[]()<>{}%".contains(&b);
    let len = src.len();
    let mut i = 0;
    while i < len {
        let ch = src[i];
        if matches!(ch, b' ' | b'\n' | b'\r' | b'\t' | 0x0C | 0) {
            i += 1;
            continue;
        }
        if ch == b'%' {
            while i < len && src[i] != b'\n' && src[i] != b'\r' {
                i += 1;
            }
            continue;
        }
        if ch == b'(' {
            let mut depth = 1;
            i += 1;
            while i < len && depth > 0 {
                if src[i] == b'\\' {
                    i += 2;
                } else {
                    if src[i] == b'(' {
                        depth += 1;
                    } else if src[i] == b')' {
                        depth -= 1;
                    }
                    i += 1;
                }
            }
            ops.push(Op::Other);
            continue;
        }
        if ch == b'<' {
            if src.get(i + 1) == Some(&b'<') {
                let mut depth = 1;
                i += 2;
                while i < len && depth > 0 {
                    if src[i..].starts_with(b"<<") {
                        depth += 1;
                        i += 2;
                    } else if src[i..].starts_with(b">>") {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            } else {
                i = find(src, b">", i).map_or(len, |e| e + 1);
            }
            ops.push(Op::Other);
            continue;
        }
        if ch == b'[' || ch == b']' {
            i += 1;
            continue;
        }
        let mut j = i + usize::from(ch == b'/');
        while j < len && !delim(src[j]) {
            j += 1;
        }
        if ch == b'/' {
            ops.push(Op::Other);
            i = j;
            continue;
        }
        if j == i {
            // ein einzelnes Trennzeichen wie ")" oder 0xA0: überspringen (wie pdfParse.ts)
            i += 1;
            continue;
        }
        let tok = &src[i..j];
        i = j;
        if is_number(tok) {
            ops.push(Op::Num(parse_float(std::str::from_utf8(tok).unwrap_or(""))));
            continue;
        }
        if in_text {
            if tok == b"ET" {
                in_text = false;
            }
            ops.clear();
            continue;
        }
        let n = |k: usize| match ops.len().checked_sub(k).map(|p| ops[p]) {
            Some(Op::Num(v)) => v,
            _ => f64::NAN,
        };
        let t = |m: &Mat, x: f64, y: f64| mat_apply(m, x, y);
        macro_rules! start_sub {
            ($x:expr, $y:expr) => {{
                let (x, y) = ($x, $y);
                if let Some(c) = cur.take().filter(|c| c.len() >= 2) {
                    subpaths.push(Path { pts: c, closed: false });
                }
                cur = Some(vec![t(&ctm, x, y)]);
                cx = x;
                sx = x;
                cy = y;
                sy = y;
            }};
        }
        match tok {
            b"q" => stack.push(ctm),
            b"Q" => ctm = stack.pop().unwrap_or(ctm),
            b"cm" => ctm = mat_mul(&ctm, &[n(6), n(5), n(4), n(3), n(2), n(1)]),
            b"m" => start_sub!(n(2), n(1)),
            b"l" => {
                if cur.is_none() {
                    start_sub!(cx, cy);
                }
                cx = n(2);
                cy = n(1);
                let p = t(&ctm, cx, cy);
                cur.as_mut().unwrap().push(p);
            }
            b"c" | b"v" | b"y" => {
                if cur.is_none() {
                    start_sub!(cx, cy);
                }
                let (p1, p2, p3) = match tok {
                    b"c" => (Pt { x: n(6), y: n(5) }, Pt { x: n(4), y: n(3) }, Pt { x: n(2), y: n(1) }),
                    b"v" => (Pt { x: cx, y: cy }, Pt { x: n(4), y: n(3) }, Pt { x: n(2), y: n(1) }),
                    _ => (Pt { x: n(4), y: n(3) }, Pt { x: n(2), y: n(1) }, Pt { x: n(2), y: n(1) }),
                };
                let (a, b, c, d) = (t(&ctm, cx, cy), t(&ctm, p1.x, p1.y), t(&ctm, p2.x, p2.y), t(&ctm, p3.x, p3.y));
                cur.as_mut().unwrap().extend(flatten_cubic(a, b, c, d, CURVE_TOL));
                cx = p3.x;
                cy = p3.y;
            }
            b"h" => {
                if let Some(c) = cur.take().filter(|c| c.len() >= 2) {
                    subpaths.push(Path { pts: c, closed: true });
                }
                cx = sx;
                cy = sy;
            }
            b"re" => {
                if let Some(c) = cur.take().filter(|c| c.len() >= 2) {
                    subpaths.push(Path { pts: c, closed: false });
                }
                let (x, y, w, h) = (n(4), n(3), n(2), n(1));
                subpaths.push(Path { pts: vec![t(&ctm, x, y), t(&ctm, x + w, y), t(&ctm, x + w, y + h), t(&ctm, x, y + h)], closed: true });
                cx = x;
                sx = x;
                cy = y;
                sy = y;
            }
            b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*" | b"n" => {
                if matches!(tok, b"s" | b"b" | b"b*") {
                    if let Some(c) = cur.take_if(|c| c.len() >= 2) {
                        subpaths.push(Path { pts: c, closed: true });
                    }
                }
                if let Some(c) = cur.take().filter(|c| c.len() >= 2) {
                    subpaths.push(Path { pts: c, closed: false });
                }
                // n = Schnittmaske -> nicht übernehmen
                if tok != b"n" {
                    out.append(&mut subpaths);
                }
                subpaths.clear();
            }
            b"BT" => {
                in_text = true;
                text_blocks += 1;
            }
            b"BI" => i = find(src, b"EI", i).map_or(len, |e| e + 2), // eingebettetes Bild
            _ => {}
        }
        ops.clear();
    }
    // Geschlossene Pfade: doppelten Endpunkt entfernen (über alle bisher gefundenen, wie im TypeScript)
    for p in out.iter_mut() {
        if p.closed && p.pts.len() > 2 {
            let (a, b) = (p.pts[0], p.pts[p.pts.len() - 1]);
            if hypot2(a.x - b.x, a.y - b.y) < 1e-6 {
                p.pts.pop();
            }
        }
    }
    text_blocks
}

/// `/^[-+]?(\d+\.?\d*|\.\d+)$/`
fn is_number(t: &[u8]) -> bool {
    let s = usize::from(matches!(t.first(), Some(b'-' | b'+')));
    let r = &t[s..];
    let digits = r.iter().take_while(|b| b.is_ascii_digit()).count();
    if digits > 0 {
        let rest = &r[digits..];
        rest.is_empty() || (rest[0] == b'.' && rest[1..].iter().all(|b| b.is_ascii_digit()))
    } else {
        r.len() > 1 && r[0] == b'.' && r[1..].iter().all(|b| b.is_ascii_digit())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn small_pieces() {
        assert_eq!(ascii85(b"<~87cURD]i,\"Ebo80~>"), b"Hello World!");
        assert_eq!(ascii_hex(b"48 65 6c6C6\n"), b"Hell`");
        assert!(is_number(b"-1.") && is_number(b".5") && !is_number(b".") && !is_number(b"1e5") && !is_number(b"+"));
        assert_eq!(filters(b"obj << /Length 5 /Filter [ /A85 /FlateDecode ] >>"), ["/A85", "/FlateDecode"]);
    }

    #[test]
    fn same_result_as_typescript() {
        fn same(a: &Value, b: &Value, at: &str) {
            match (a, b) {
                (Value::Number(x), Value::Number(y)) => {
                    let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
                    assert!(x == y || (x - y).abs() <= 1e-9, "{at}: {x} vs {y}");
                }
                (Value::Array(x), Value::Array(y)) => {
                    assert_eq!(x.len(), y.len(), "{at}: entries");
                    for (k, (p, q)) in x.iter().zip(y).enumerate() {
                        same(p, q, &format!("{at}[{k}]"));
                    }
                }
                (Value::Object(x), Value::Object(y)) => {
                    assert_eq!(x.len(), y.len(), "{at}: keys");
                    for (k, v) in x {
                        same(v, y.get(k).unwrap_or(&Value::Null), &format!("{at}.{k}"));
                    }
                }
                _ => assert_eq!(a, b, "{at}"),
            }
        }
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let cases: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("importpdf-cases.json")).unwrap()).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 25, "only {} cases", cases.len());
        for c in cases {
            let hex = c["pdf"].as_str().unwrap().as_bytes();
            let bytes: Vec<u8> = hex.chunks(2).map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap()).collect();
            same(&c["want"], &serde_json::to_value(parse_pdf(&bytes)).unwrap(), c["name"].as_str().unwrap());
        }
        println!("{} PDF cases the same as pdfParse.ts", cases.len());
    }
}
