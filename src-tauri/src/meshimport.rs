//! 3MF- UND OBJ-IMPORT – Zwilling von `parse3mf` (src/importers/meshImport.ts mit dem Schnell-Leser meshScan.ts) und
//! `parseObjBytes` (src/importers/objParse.ts).
//!
//! 3MF: ZIP lesen, Deflate entpacken, die großen <vertices>/<triangles>-Listen direkt aus den Bytes lesen (wie
//! extractMeshLists), den kleinen XML-Rest (Objekte, Bauteile, Bau-Liste, Einheit) mit einem einfachen XML-Leser.
//! Im Fenster liest diesen Rest der DOMParser des Browsers; für gültige Dateien liefert der Leser hier dieselben
//! Elemente und Attribute. Kaputte Dateien lehnt schon das Fenster ab, dann wird nichts verglichen.
//! OBJ: Eckpunkte und Flächen aus den Bytes, Vielecke aufgefächert, negative Nummern von hinten.
//! Ergebnis für den Vergleich: Anzahl Dreiecke, Größe und eine Prüfsumme (FNV-1a über die f32-Bits aller Eckpunkte,
//! meshSummary() in stlMesh.ts). Gemeinsame Fälle: `tests/fixtures/meshimport-cases.json.gz`.

use crate::gcodesim::{js_space, to_int32};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct Head {
    pub kind: String,
}
#[derive(Serialize, Debug, PartialEq)]
pub struct Summary {
    pub triangles: usize,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub hash: u32,
}

pub fn split_body(body: &[u8]) -> Result<(Head, &[u8]), String> {
    let n = u32::from_le_bytes(body.get(..4).ok_or("short body")?.try_into().map_err(|_| "short body")?) as usize;
    let head: Head = serde_json::from_slice(body.get(4..4 + n).ok_or("short body")?).map_err(|e| e.to_string())?;
    Ok((head, &body[4 + n..]))
}

pub fn run(head: &Head, data: &[u8]) -> Result<Summary, String> {
    let pos = match head.kind.as_str() {
        "3mf" => parse_3mf(data)?,
        "obj" => parse_obj(data)?,
        k => return Err(format!("unknown kind {k}")),
    };
    Ok(summary(&pos))
}

/// Größe wie finishMesh() in stlMesh.ts, Prüfsumme wie meshSummary()
pub fn summary(p: &[f32]) -> Summary {
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    let mut i = 0;
    while i + 2 < p.len() {
        for k in 0..3 {
            let v = p[i + k] as f64;
            if v < lo[k] && v > f64::NEG_INFINITY {
                lo[k] = v;
            }
            if v > hi[k] && v < f64::INFINITY {
                hi[k] = v;
            }
        }
        i += 3;
    }
    let mut h: u32 = 2166136261;
    for v in p {
        h ^= v.to_bits();
        h = h.wrapping_mul(16777619);
    }
    Summary { triangles: p.len() / 9, min: lo, max: hi, hash: h }
}

// =====================================================================
// Zahlen aus Bytes (numAt in meshScan.ts) – liest wie dort auch das Byte an `end`
// =====================================================================

/// 10^k: Math.pow(10, k) in V8 gibt für ganze k genau den gerundeten Wert von „1ek“ (geprüft für -400…400)
fn pow10(k: f64) -> f64 {
    format!("1e{k}").parse().unwrap_or(if k > 0.0 { f64::INFINITY } else { 0.0 })
}
fn pow10_table() -> [f64; 41] {
    let mut t = [0.0; 41];
    for (i, v) in t.iter_mut().enumerate() {
        *v = pow10(i as f64 - 20.0);
    }
    t
}

pub fn num_at(b: &[u8], mut i: usize, end: usize, pow10: &[f64; 41]) -> f64 {
    let at = |i: usize| b.get(i).copied();
    let (mut neg, mut m, mut e, mut digits, mut any) = (false, 0.0f64, 0i64, 0, false);
    while i < end && b[i] <= 32 {
        i += 1;
    }
    if at(i) == Some(45) {
        neg = true;
        i += 1;
    } else if at(i) == Some(43) {
        i += 1;
    }
    while i < end {
        let c = b[i] as i32 - 48;
        if !(0..=9).contains(&c) {
            break;
        }
        any = true;
        if digits < 15 {
            m = m * 10.0 + c as f64;
            if m != 0.0 {
                digits += 1;
            }
        } else {
            e += 1;
        }
        i += 1;
    }
    if at(i) == Some(46) {
        i += 1;
        while i < end {
            let c = b[i] as i32 - 48;
            if !(0..=9).contains(&c) {
                break;
            }
            any = true;
            if digits < 15 {
                m = m * 10.0 + c as f64;
                e -= 1;
                if m != 0.0 {
                    digits += 1;
                }
            }
            i += 1;
        }
    }
    if !any {
        return f64::NAN;
    }
    if at(i) == Some(101) || at(i) == Some(69) {
        i += 1;
        let (mut eneg, mut ex) = (false, 0.0f64);
        if at(i) == Some(45) {
            eneg = true;
            i += 1;
        } else if at(i) == Some(43) {
            i += 1;
        }
        while i < end {
            let c = b[i] as i32 - 48;
            if !(0..=9).contains(&c) {
                break;
            }
            ex = ex * 10.0 + c as f64;
            i += 1;
        }
        // e ist in JavaScript eine Zahl: bei riesigen Exponenten bleibt es eine (Unendlich/0 bei pow)
        let ef = e as f64 + if eneg { -ex } else { ex };
        let v = big_exp(m, ef, pow10);
        return if neg { -v } else { v };
    }
    let v = big_exp(m, e as f64, pow10);
    if neg {
        -v
    } else {
        v
    }
}
fn big_exp(m: f64, e: f64, tab: &[f64; 41]) -> f64 {
    if (-20.0..=20.0).contains(&e) {
        if e < 0.0 {
            m / tab[(20.0 - e) as usize]
        } else {
            m * tab[(20.0 + e) as usize]
        }
    } else {
        m * pow10(e)
    }
}

// =====================================================================
// 3MF: Schnell-Leser für <vertices>/<triangles> (extractMeshLists)
// =====================================================================

struct Lists {
    xml: String,
    verts: Vec<Vec<f64>>,
    tris: Vec<Vec<u32>>,
}

fn bytes_at(b: &[u8], i: usize, s: &[u8]) -> bool {
    b.get(i..i + s.len()) == Some(s)
}

enum Scan {
    V(Vec<f64>),
    T(Vec<u32>),
}

fn scan_elements(b: &[u8], from: usize, tri: bool, pow10: &[f64; 41]) -> (Scan, Option<usize>) {
    let tag: &[u8] = if tri { b"triangle" } else { b"vertex" };
    let n_all = b.len();
    let (mut vs, mut ts): (Vec<f64>, Vec<u32>) = (vec![], vec![]);
    let mut i = from;
    let mut end = None;
    let at = |i: usize| b.get(i).copied();
    while i < n_all {
        while i < n_all && b[i] != b'<' {
            i += 1;
        }
        if i >= n_all {
            break;
        }
        let lt = i;
        i += 1;
        let closing = at(i) == Some(b'/');
        if closing {
            i += 1;
        }
        let mut s = i;
        while i < n_all && b[i] > 32 && b[i] != b'>' && b[i] != b'/' {
            if b[i] == b':' {
                s = i + 1;
            }
            i += 1;
        }
        let is_tag = i - s == tag.len() && bytes_at(b, s, tag);
        if closing && !is_tag {
            end = Some(lt);
            break;
        }
        if closing || !is_tag {
            while i < n_all && b[i] != b'>' {
                i += 1;
            }
            i += 1;
            continue;
        }
        let mut vals = [0.0f64; 3];
        while i < n_all && b[i] != b'>' {
            while i < n_all && b[i] <= 32 {
                i += 1;
            }
            let a_s = i;
            while i < n_all && b[i] > 32 && b[i] != b'=' && b[i] != b'>' && b[i] != b'/' {
                i += 1;
            }
            let alen = i - a_s;
            while i < n_all && b[i] <= 32 {
                i += 1;
            }
            if at(i) != Some(b'=') {
                if at(i) == Some(b'/') {
                    i += 1;
                }
                continue;
            }
            i += 1;
            while i < n_all && b[i] <= 32 {
                i += 1;
            }
            let q = at(i);
            if q != Some(b'"') && q != Some(b'\'') {
                continue;
            }
            i += 1;
            let v_s = i;
            while i < n_all && Some(b[i]) != q {
                i += 1;
            }
            let v_e = i;
            i += 1;
            let mut k: i32 = -1;
            if !tri {
                if alen == 1 {
                    k = b[a_s] as i32 - 120;
                    if k > 2 {
                        k = -1;
                    }
                }
            } else if alen == 2 && b[a_s] == 118 {
                k = b[a_s + 1] as i32 - 49;
                if k > 2 {
                    k = -1;
                }
            }
            if k >= 0 {
                let v = num_at(b, v_s, v_e, pow10);
                vals[k as usize] = if v.is_finite() { v } else { 0.0 };
            }
        }
        i += 1;
        if tri {
            // in ein Uint32Array: ToUint32
            ts.extend(vals.iter().map(|&v| to_int32(v) as u32));
        } else {
            vs.extend_from_slice(&vals);
        }
    }
    (if tri { Scan::T(ts) } else { Scan::V(vs) }, end)
}

fn extract_mesh_lists(b: &[u8], pow10: &[f64; 41]) -> Lists {
    let (mut verts, mut tris) = (vec![], vec![]);
    let mut keep: Vec<&[u8]> = vec![];
    let (mut last, mut i) = (0usize, 0usize);
    let n = b.len();
    let index_of = |c: u8, from: usize| b.get(from..).and_then(|r| r.iter().position(|&x| x == c)).map(|p| p + from);
    while i < n {
        let Some(lt) = index_of(b'<', i) else { break };
        let (mut s, mut j) = (lt + 1, lt + 1);
        while j < n && b[j] > 32 && b[j] != b'>' && b[j] != b'/' {
            if b[j] == b':' {
                s = j + 1;
            }
            j += 1;
        }
        let is_v = j - s == 8 && bytes_at(b, s, b"vertices");
        let is_t = !is_v && j - s == 9 && bytes_at(b, s, b"triangles");
        if !is_v && !is_t {
            i = lt + 1;
            continue;
        }
        let Some(start_end) = index_of(b'>', j) else { break };
        if start_end >= 1 && b[start_end - 1] == b'/' {
            if is_v {
                verts.push(vec![]);
            } else {
                tris.push(vec![]);
            }
            i = start_end + 1;
            continue;
        }
        let (data, close) = scan_elements(b, start_end + 1, is_t, pow10);
        let Some(close_at) = close else { break };
        match data {
            Scan::V(v) => verts.push(v),
            Scan::T(t) => tris.push(t),
        }
        keep.push(&b[last..start_end + 1]);
        last = close_at;
        i = close_at + 1;
    }
    keep.push(&b[last.min(n)..]);
    let xml = keep.iter().map(|p| String::from_utf8_lossy(p)).collect::<String>();
    Lists { xml, verts, tris }
}

// =====================================================================
// Kleiner XML-Leser für den Rest (Elemente, Attribute, Namensräume)
// =====================================================================

struct Attr {
    qname: String,
    local: String,
    ns: Option<String>,
    value: String,
}
struct El {
    local: String,
    attrs: Vec<Attr>,
    /// Ende der Nachkommen (Index hinter dem letzten)
    end: usize,
}
struct Doc {
    els: Vec<El>,
}
impl Doc {
    fn by_local(&self, from: usize, to: usize, name: &str) -> Vec<usize> {
        (from..to).filter(|&i| self.els[i].local == name).collect()
    }
    fn attr<'a>(&'a self, e: usize, qname: &str) -> Option<&'a str> {
        self.els[e].attrs.iter().find(|a| a.qname == qname).map(|a| a.value.as_str())
    }
    fn attr_ns<'a>(&'a self, e: usize, ns: &str, local: &str) -> Option<&'a str> {
        self.els[e].attrs.iter().find(|a| a.ns.as_deref() == Some(ns) && a.local == local).map(|a| a.value.as_str())
    }
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find('&') {
        out += &rest[..p];
        let r = &rest[p..];
        let Some(semi) = r.find(';') else {
            out += r;
            return out;
        };
        let ent = &r[1..semi];
        let ch = match ent {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if ent.starts_with("#x") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
            _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => out.push(c),
            None => out += &r[..=semi],
        }
        rest = &r[semi + 1..];
    }
    out + rest
}

fn parse_xml(x: &str) -> Result<Doc, String> {
    let b = x.as_bytes();
    let n = b.len();
    let mut els: Vec<El> = vec![];
    // offene Elemente: (Index, Name, Namensräume dieses Elements)
    let mut stack: Vec<(usize, String, Vec<(String, String)>)> = vec![];
    let mut i = 0;
    let find = |from: usize, pat: &str| x.get(from..).and_then(|r| r.find(pat)).map(|p| p + from);
    let lookup = |stack: &Vec<(usize, String, Vec<(String, String)>)>, own: &Vec<(String, String)>, prefix: &str| -> Option<String> {
        if prefix == "xml" {
            return Some("http://www.w3.org/XML/1998/namespace".into());
        }
        own.iter().rev().chain(stack.iter().rev().flat_map(|s| s.2.iter().rev())).find(|(p, _)| p == prefix).map(|(_, u)| u.clone())
    };
    while i < n {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        if x[i..].starts_with("<!--") {
            i = find(i + 4, "-->").ok_or("comment")? + 3;
            continue;
        }
        if x[i..].starts_with("<![CDATA[") {
            i = find(i + 9, "]]>").ok_or("cdata")? + 3;
            continue;
        }
        if x[i..].starts_with("<?") {
            i = find(i + 2, "?>").ok_or("pi")? + 2;
            continue;
        }
        if x[i..].starts_with("<!") {
            // DOCTYPE (mit möglicher interner Liste in [...])
            let mut depth = 0;
            let mut j = i + 2;
            while j < n && !(b[j] == b'>' && depth == 0) {
                if b[j] == b'[' {
                    depth += 1;
                } else if b[j] == b']' {
                    depth -= 1;
                }
                j += 1;
            }
            i = j + 1;
            continue;
        }
        if x[i..].starts_with("</") {
            let e = find(i, ">").ok_or("end tag")?;
            let name = x[i + 2..e].trim_matches(|c: char| c.is_ascii_whitespace());
            let (idx, open, _) = stack.pop().ok_or("end tag without start")?;
            if open != name {
                return Err(format!("</{name}> closes <{open}>"));
            }
            els[idx].end = els.len();
            i = e + 1;
            continue;
        }
        // Start-Tag
        let mut j = i + 1;
        while j < n && !b[j].is_ascii_whitespace() && b[j] != b'>' && b[j] != b'/' {
            j += 1;
        }
        let qname = x[i + 1..j].to_string();
        let mut raw_attrs: Vec<(String, String)> = vec![];
        let self_close;
        loop {
            while j < n && b[j].is_ascii_whitespace() {
                j += 1;
            }
            if j >= n {
                return Err("open tag".into());
            }
            if b[j] == b'>' {
                self_close = false;
                j += 1;
                break;
            }
            if b[j] == b'/' && b.get(j + 1) == Some(&b'>') {
                self_close = true;
                j += 2;
                break;
            }
            let a0 = j;
            while j < n && !b[j].is_ascii_whitespace() && b[j] != b'=' && b[j] != b'>' && b[j] != b'/' {
                j += 1;
            }
            let an = x[a0..j].to_string();
            while j < n && b[j].is_ascii_whitespace() {
                j += 1;
            }
            if b.get(j) != Some(&b'=') {
                return Err("attribute without value".into());
            }
            j += 1;
            while j < n && b[j].is_ascii_whitespace() {
                j += 1;
            }
            let q = *b.get(j).ok_or("attribute")?;
            if q != b'"' && q != b'\'' {
                return Err("attribute quote".into());
            }
            let v0 = j + 1;
            let v1 = b[v0..].iter().position(|&c| c == q).ok_or("attribute end")? + v0;
            // Zeilenenden und Tabulatoren im Wert werden zu Leerzeichen (XML-Regel), dann die Zeichen-Verweise
            let norm = x[v0..v1].replace("\r\n", " ").replace(['\r', '\n', '\t'], " ");
            raw_attrs.push((an, decode_entities(&norm)));
            j = v1 + 1;
        }
        let mut own_ns: Vec<(String, String)> = vec![];
        for (an, v) in &raw_attrs {
            if an == "xmlns" {
                own_ns.push((String::new(), v.clone()));
            } else if let Some(p) = an.strip_prefix("xmlns:") {
                own_ns.push((p.to_string(), v.clone()));
            }
        }
        let local = qname.rsplit(':').next().unwrap_or(&qname).to_string();
        let attrs = raw_attrs
            .into_iter()
            .map(|(an, value)| {
                let (prefix, local) = match an.split_once(':') {
                    Some((p, l)) => (p.to_string(), l.to_string()),
                    None => (String::new(), an.clone()),
                };
                let ns = if prefix.is_empty() || prefix == "xmlns" { None } else { lookup(&stack, &own_ns, &prefix) };
                Attr { qname: an, local, ns, value }
            })
            .collect();
        let idx = els.len();
        els.push(El { local, attrs, end: idx + 1 });
        if !self_close {
            stack.push((idx, qname, own_ns));
        }
        i = j;
    }
    if !stack.is_empty() {
        return Err("unclosed element".into());
    }
    Ok(Doc { els })
}

// =====================================================================
// 3MF: Modell-Dateien
// =====================================================================

type M = [f64; 12];
const IDENT: M = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0];
const NS_PROD: &str = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";

/// `Number(token)` in JavaScript für ein Stück ohne Leerraum
fn js_number_token(t: &str) -> f64 {
    if t.is_empty() {
        return 0.0;
    }
    let lower = t.to_ascii_lowercase();
    for (p, r) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(d) = lower.strip_prefix(p) {
            return if !d.is_empty() && d.chars().all(|c| c.is_digit(r)) { u128::from_str_radix(d, r).map_or(f64::INFINITY, |v| v as f64) } else { f64::NAN };
        }
    }
    let (neg, s) = match t.as_bytes()[0] {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    let sign = if neg { -1.0 } else { 1.0 };
    if s == "Infinity" {
        return sign * f64::INFINITY;
    }
    let b = s.as_bytes();
    let mut i = 0;
    let int0 = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int = &s[int0..i];
    let mut frac = "";
    if i < b.len() && b[i] == b'.' {
        let f0 = i + 1;
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac = &s[f0..i];
    }
    if int.is_empty() && frac.is_empty() {
        return f64::NAN;
    }
    let mut exp = String::from("0");
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let e0 = i + 1;
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let d0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if d0 == i {
            return f64::NAN;
        }
        exp = s[e0..i].to_string();
    }
    if i != b.len() {
        return f64::NAN;
    }
    let txt = format!("{}.{}e{}", if int.is_empty() { "0" } else { int }, if frac.is_empty() { "0" } else { frac }, exp);
    sign * txt.parse::<f64>().unwrap_or(f64::NAN)
}

fn parse_matrix(s: Option<&str>) -> M {
    let Some(s) = s.filter(|s| !s.is_empty()) else { return IDENT };
    let t = s.trim_matches(js_space);
    let v: Vec<f64> = t.split(js_space).filter(|p| !p.is_empty()).map(js_number_token).collect();
    // split(/\s+/) eines leeren Textes gibt [""] -> eine 0
    let v = if t.is_empty() { vec![0.0] } else { v };
    if v.len() == 12 && v.iter().all(|x| x.is_finite()) {
        v.try_into().unwrap()
    } else {
        IDENT
    }
}

/// erst a, dann b (Punkt als Zeilenvektor, p' = p · M)
fn compose(a: &M, b: &M) -> M {
    let mut r = [0.0; 12];
    for i in 0..3 {
        for j in 0..3 {
            r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
        }
    }
    for j in 0..3 {
        r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
    }
    r
}

struct Comp {
    id: String,
    path: Option<String>,
    m: M,
}
struct Obj3 {
    verts: Option<Vec<f64>>,
    tris: Option<Vec<u32>>,
    comps: Vec<Comp>,
}
struct Model {
    unit: f64,
    /// Reihenfolge wie Map in JavaScript: erstes Auftreten, Wert vom letzten
    objects: Vec<(String, Obj3)>,
    build: Vec<Comp>,
}

fn parse_model_xml(lists: Lists) -> Result<Model, String> {
    let doc = parse_xml(&lists.xml).map_err(|e| format!("3mf xml: {e}"))?;
    let all = doc.els.len();
    let v_index: HashMap<usize, usize> = doc.by_local(0, all, "vertices").into_iter().enumerate().map(|(k, e)| (e, k)).collect();
    let t_index: HashMap<usize, usize> = doc.by_local(0, all, "triangles").into_iter().enumerate().map(|(k, e)| (e, k)).collect();
    let unit = match doc.by_local(0, all, "model").first() {
        Some(&m) => doc.attr(m, "unit").filter(|u| !u.is_empty()).unwrap_or("millimeter").to_lowercase(),
        None => "millimeter".into(),
    };
    let unit = match unit.as_str() {
        "micron" => 0.001,
        "millimeter" => 1.0,
        "centimeter" => 10.0,
        "inch" => 25.4,
        "foot" => 304.8,
        "meter" => 1000.0,
        _ => 1.0,
    };
    let path_of = |e: usize| -> Option<String> {
        let p = doc.attr_ns(e, NS_PROD, "path").filter(|p| !p.is_empty()).or_else(|| doc.attr(e, "p:path"));
        p.map(|s| s.to_string())
    };
    let mut objects: Vec<(String, Obj3)> = vec![];
    for o in doc.by_local(0, all, "object") {
        let id = doc.attr(o, "id").unwrap_or("").to_string();
        let mut obj = Obj3 { verts: None, tris: None, comps: vec![] };
        let end = doc.els[o].end;
        if let Some(&mesh) = doc.by_local(o + 1, end, "mesh").first() {
            let me = doc.els[mesh].end;
            let ve = doc.by_local(mesh + 1, me, "vertices").first().copied();
            let te = doc.by_local(mesh + 1, me, "triangles").first().copied();
            obj.verts = Some(ve.and_then(|e| v_index.get(&e)).and_then(|&k| lists.verts.get(k)).cloned().unwrap_or_default());
            obj.tris = Some(te.and_then(|e| t_index.get(&e)).and_then(|&k| lists.tris.get(k)).cloned().unwrap_or_default());
        }
        for c in doc.by_local(o + 1, end, "component") {
            obj.comps.push(Comp { id: doc.attr(c, "objectid").unwrap_or("").to_string(), path: path_of(c), m: parse_matrix(doc.attr(c, "transform")) });
        }
        match objects.iter_mut().find(|(k, _)| *k == id) {
            Some(slot) => slot.1 = obj,
            None => objects.push((id, obj)),
        }
    }
    let build = doc.by_local(0, all, "item").into_iter().map(|it| Comp { id: doc.attr(it, "objectid").unwrap_or("").to_string(), path: path_of(it), m: parse_matrix(doc.attr(it, "transform")) }).collect();
    Ok(Model { unit, objects, build })
}

// =====================================================================
// ZIP
// =====================================================================

struct Entry {
    name: String,
    method: u16,
    comp_size: usize,
    offset: usize,
}
fn u16_at(z: &[u8], i: usize) -> Result<u16, String> {
    z.get(i..i + 2).map(|s| u16::from_le_bytes([s[0], s[1]])).ok_or_else(|| "zip: out of range".into())
}
fn u32_at(z: &[u8], i: usize) -> Result<u32, String> {
    z.get(i..i + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| "zip: out of range".into())
}

fn read_zip_directory(z: &[u8]) -> Result<Vec<Entry>, String> {
    let mut eocd = None;
    if z.len() >= 22 {
        let lo = z.len().saturating_sub(65557);
        for i in (lo..=z.len() - 22).rev() {
            if u32_at(z, i)? == 0x06054b50 {
                eocd = Some(i);
                break;
            }
        }
    }
    let eocd = eocd.ok_or("zip: no directory")?;
    let count = u16_at(z, eocd + 10)? as usize;
    let mut p = u32_at(z, eocd + 16)? as usize;
    let mut list = vec![];
    let mut n = 0;
    while n < count && p + 46 <= z.len() {
        if u32_at(z, p)? != 0x02014b50 {
            break;
        }
        let method = u16_at(z, p + 10)?;
        let comp_size = u32_at(z, p + 20)? as usize;
        let (name_len, extra_len, comm_len) = (u16_at(z, p + 28)? as usize, u16_at(z, p + 30)? as usize, u16_at(z, p + 32)? as usize);
        let offset = u32_at(z, p + 42)? as usize;
        let name = String::from_utf8_lossy(&z[(p + 46).min(z.len())..(p + 46 + name_len).min(z.len())]).into_owned();
        list.push(Entry { name, method, comp_size, offset });
        p += 46 + name_len + extra_len + comm_len;
        n += 1;
    }
    Ok(list)
}

/// Roh-Deflate wie inflateRaw() im Fenster: bis zum letzten Block, Reste danach zählen nicht
fn inflate_raw(data: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::{Decompress, FlushDecompress, Status};
    let mut d = Decompress::new(false);
    let mut out: Vec<u8> = Vec::with_capacity(data.len() * 4 + 1024);
    loop {
        if out.len() == out.capacity() {
            out.reserve(out.len().max(1 << 16));
        }
        let before = (d.total_in(), d.total_out());
        let st = d.decompress_vec(&data[d.total_in() as usize..], &mut out, FlushDecompress::None).map_err(|e| format!("inflate: {e}"))?;
        if st == Status::StreamEnd {
            return Ok(out);
        }
        if (d.total_in(), d.total_out()) == before && out.len() < out.capacity() {
            return Err("inflate: unexpected end".into());
        }
    }
}

fn read_zip_entry(z: &[u8], e: &Entry) -> Result<Vec<u8>, String> {
    if u32_at(z, e.offset)? != 0x04034b50 {
        return Err("zip: bad entry".into());
    }
    let start = e.offset + 30 + u16_at(z, e.offset + 26)? as usize + u16_at(z, e.offset + 28)? as usize;
    let data = &z[start.min(z.len())..(start + e.comp_size).min(z.len())];
    match e.method {
        0 => Ok(data.to_vec()),
        8 => inflate_raw(data),
        m => Err(format!("zip: method {m}")),
    }
}

fn norm_name(n: &str) -> String {
    n.trim_start_matches('/').to_lowercase()
}

/// `/<Relationship[^>]*Type="[^"]*3dmodel"[^>]*>/i`, darin `/Target="([^"]+)"/i`
fn rels_target(rels: &str) -> Option<String> {
    let low = rels.to_ascii_lowercase();
    let mut from = 0;
    while let Some(p) = low[from..].find("<relationship").map(|p| p + from) {
        let tag_end = low[p..].find('>').map(|e| e + p);
        let Some(te) = tag_end else { return None };
        let tag = &low[p..te];
        let hit = tag.match_indices("type=\"").any(|(k, _)| {
            let v0 = k + 6;
            tag[v0..].find('"').is_some_and(|q| tag[v0..v0 + q].ends_with("3dmodel"))
        });
        if hit {
            let orig = &rels[p..te];
            let lo = &low[p..te];
            let mut f = 0;
            while let Some(k) = lo[f..].find("target=\"").map(|k| k + f) {
                let v0 = k + 8;
                if let Some(q) = orig[v0..].find('"') {
                    if q > 0 {
                        return Some(orig[v0..v0 + q].to_string());
                    }
                }
                f = k + 1;
            }
            return None;
        }
        from = p + 1;
    }
    None
}

pub fn parse_3mf(bytes: &[u8]) -> Result<Vec<f32>, String> {
    let pow10 = pow10_table();
    let entries = read_zip_directory(bytes)?;
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for (k, e) in entries.iter().enumerate() {
        by_name.insert(norm_name(&e.name), k);
    }
    let raw = |name: &str| -> Result<Vec<u8>, String> {
        let k = by_name.get(&norm_name(name)).ok_or_else(|| format!("3mf: missing part {name}"))?;
        read_zip_entry(bytes, &entries[*k])
    };
    let mut root = String::new();
    if let Ok(r) = raw("_rels/.rels") {
        if let Some(t) = rels_target(&String::from_utf8_lossy(&r)) {
            root = t;
        }
    }
    let is_model = |n: &str| n.to_ascii_lowercase().ends_with(".model");
    if root.is_empty() || !by_name.contains_key(&norm_name(&root)) {
        root = entries.iter().find(|e| is_model(&e.name)).map(|e| e.name.clone()).unwrap_or_default();
    }
    if root.is_empty() {
        return Err("3mf: no model".into());
    }
    let mut files: HashMap<String, Model> = HashMap::new();
    for e in entries.iter().filter(|e| is_model(&e.name)) {
        let data = read_zip_entry(bytes, e)?;
        files.insert(norm_name(&e.name), parse_model_xml(extract_mesh_lists(&data, &pow10))?);
    }
    let mut load = |path: &str, files: &mut HashMap<String, Model>| -> Result<(), String> {
        let k = norm_name(path);
        if !files.contains_key(&k) {
            let m = parse_model_xml(extract_mesh_lists(&raw(path)?, &pow10))?;
            files.insert(k, m);
        }
        Ok(())
    };
    load(&root, &mut files)?;
    let scale = files[&norm_name(&root)].unit;
    // Teile sammeln (Bauteile rekursiv)
    struct Part {
        file: String,
        obj: usize,
        m: M,
    }
    let mut parts: Vec<Part> = vec![];
    let mut guard = 0usize;
    #[allow(clippy::too_many_arguments)]
    fn collect(path: &str, id: &str, m: M, depth: u32, files: &mut HashMap<String, Model>, guard: &mut usize, parts: &mut Vec<Part>, load: &mut dyn FnMut(&str, &mut HashMap<String, Model>) -> Result<(), String>) -> Result<(), String> {
        if depth > 32 {
            return Ok(());
        }
        *guard += 1;
        if *guard > 200000 {
            return Ok(());
        }
        load(path, files)?;
        let key = norm_name(path);
        let Some(oi) = files[&key].objects.iter().position(|(k, _)| k == id) else { return Ok(()) };
        let o = &files[&key].objects[oi].1;
        if o.verts.is_some() && o.tris.as_ref().is_some_and(|t| !t.is_empty()) {
            parts.push(Part { file: key.clone(), obj: oi, m });
        }
        let comps: Vec<(String, Option<String>, M)> = o.comps.iter().map(|c| (c.id.clone(), c.path.clone(), c.m)).collect();
        for (cid, cpath, cm) in comps {
            let p = cpath.filter(|p| !p.is_empty()).unwrap_or_else(|| path.to_string());
            collect(&p, &cid, compose(&cm, &m), depth + 1, files, guard, parts, load)?;
        }
        Ok(())
    }
    let main_key = norm_name(&root);
    let build: Vec<(String, Option<String>, M)> = files[&main_key].build.iter().map(|c| (c.id.clone(), c.path.clone(), c.m)).collect();
    if !build.is_empty() {
        for (id, path, m) in build {
            let p = path.filter(|p| !p.is_empty()).unwrap_or_else(|| root.clone());
            collect(&p, &id, m, 0, &mut files, &mut guard, &mut parts, &mut load)?;
        }
    } else {
        let ids: Vec<String> = files[&main_key].objects.iter().filter(|(_, o)| o.verts.is_some()).map(|(k, _)| k.clone()).collect();
        for id in ids {
            collect(&root, &id, IDENT, 0, &mut files, &mut guard, &mut parts, &mut load)?;
        }
    }
    let mut out: Vec<f32> = Vec::new();
    for p in &parts {
        let o = &files[&p.file].objects[p.obj].1;
        let (v, tr, m) = (o.verts.as_ref().unwrap(), o.tris.as_ref().unwrap(), &p.m);
        let mut i = 0;
        while i + 2 < tr.len() {
            let (ka, kb, kc) = (tr[i] as usize * 3, tr[i + 1] as usize * 3, tr[i + 2] as usize * 3);
            i += 3;
            if ka + 2 >= v.len() || kb + 2 >= v.len() || kc + 2 >= v.len() {
                continue; // ungültige Eckpunkt-Nummer: Dreieck weglassen
            }
            for k in [ka, kb, kc] {
                let (x, y, z) = (v[k], v[k + 1], v[k + 2]);
                out.push(((x * m[0] + y * m[3] + z * m[6] + m[9]) * scale) as f32);
                out.push(((x * m[1] + y * m[4] + z * m[7] + m[10]) * scale) as f32);
                out.push(((x * m[2] + y * m[5] + z * m[8] + m[11]) * scale) as f32);
            }
        }
    }
    if out.is_empty() {
        return Err("noTriangles".into());
    }
    Ok(out)
}

// =====================================================================
// OBJ (objParse.ts)
// =====================================================================

const OBJ_MAX_TRIANGLES: usize = 5_000_000;
const OBJ_MAX_VERTICES: usize = 20_000_000;
const OBJ_MAX_BYTES: usize = 1024 * 1024 * 1024;
const MAX_COORD: f64 = 1e9;

fn is_space(c: u8) -> bool {
    c == 32 || c == 9 || c == 13
}

pub fn parse_obj(b: &[u8]) -> Result<Vec<f32>, String> {
    let pow10 = pow10_table();
    if b.len() > OBJ_MAX_BYTES {
        return Err("tooBigFile".into());
    }
    let mut verts: Vec<f64> = Vec::new();
    let mut cap = 3 * 4096;
    let mut tris: Vec<u32> = Vec::new();
    let (mut line, mut max_ref, mut max_ref_line) = (0usize, -1.0f64, 0usize);
    let n = b.len();
    let mut face: Vec<f64> = Vec::new();
    let mut i = 0;
    let err = |code: &str, line: usize| format!("{code} line {line}");
    while i < n {
        line += 1;
        let (mut start, mut end) = (i, i);
        // Zeilenende; "\" am Ende verbindet mit der nächsten Zeile
        loop {
            while end < n && b[end] != 10 {
                end += 1;
            }
            let mut e = end;
            while e > start && is_space(b[e - 1]) {
                e -= 1;
            }
            if end < n && e > start && b[e - 1] == 92 {
                end += 1;
                line += 1;
                continue;
            }
            break;
        }
        i = end + 1;
        while start < end && is_space(b[start]) {
            start += 1;
        }
        if start >= end {
            continue;
        }
        let c0 = b[start];
        let c1 = if start + 1 < end { b[start + 1] } else { 32 };
        if !(is_space(c1) || c1 == 92) {
            continue;
        }
        if c0 == b'v' {
            // wie im Fenster: geprüft wird nur, wenn das Feld (Start 3·4096, dann doppelt) wachsen muss
            if verts.len() + 3 > cap {
                if verts.len() / 3 >= OBJ_MAX_VERTICES {
                    return Err(err("tooMany", line));
                }
                cap *= 2;
            }
            let mut p = start + 1;
            for _ in 0..3 {
                while p < end && (is_space(b[p]) || b[p] == 92 || b[p] == 10) {
                    p += 1;
                }
                let t0 = p;
                while p < end && !is_space(b[p]) && b[p] != 92 && b[p] != 10 {
                    p += 1;
                }
                let v = if t0 < p { num_at(b, t0, p, &pow10) } else { f64::NAN };
                if !v.is_finite() || v.abs() > MAX_COORD {
                    return Err(err("badNumber", line));
                }
                verts.push(v);
            }
        } else if c0 == b'f' {
            face.clear();
            let mut p = start + 1;
            while p < end {
                while p < end && (is_space(b[p]) || b[p] == 92 || b[p] == 10) {
                    p += 1;
                }
                if p >= end {
                    break;
                }
                let (mut neg, mut v, mut digits) = (false, 0.0f64, 0);
                if b[p] == 45 {
                    neg = true;
                    p += 1;
                } else if b[p] == 43 {
                    p += 1;
                }
                while p < end && b[p].is_ascii_digit() {
                    v = v * 10.0 + (b[p] - 48) as f64;
                    digits += 1;
                    p += 1;
                }
                if digits == 0 || v == 0.0 || v > 4294967295.0 {
                    return Err(err("badIndex", line));
                }
                if p < end && !is_space(b[p]) && b[p] != 47 && b[p] != 92 && b[p] != 10 {
                    return Err(err("badIndex", line));
                }
                while p < end && !is_space(b[p]) && b[p] != 92 && b[p] != 10 {
                    p += 1;
                }
                let nv3 = (verts.len() / 3) as f64;
                let idx = if neg { nv3 - v } else { v - 1.0 };
                if idx < 0.0 {
                    return Err(err("badIndex", line));
                }
                if idx > max_ref {
                    max_ref = idx;
                    max_ref_line = line;
                }
                face.push(idx);
            }
            if face.len() < 3 {
                continue;
            }
            for k in 1..face.len() - 1 {
                let (a, q, r) = (face[0], face[k], face[k + 1]);
                if a == q || q == r || a == r {
                    continue;
                }
                if tris.len() / 3 >= OBJ_MAX_TRIANGLES {
                    return Err(err("tooMany", line));
                }
                // in ein Uint32Array: ToUint32
                tris.extend([a, q, r].iter().map(|&x| to_int32(x) as u32));
            }
        }
    }
    let vertices = verts.len() / 3;
    if vertices == 0 {
        return Err(err("noVertices", 0));
    }
    if tris.is_empty() {
        return Err(err("noFaces", 0));
    }
    if max_ref >= vertices as f64 {
        return Err(err("badIndex", max_ref_line));
    }
    let mut positions = Vec::with_capacity(tris.len() * 3);
    for &t in &tris {
        let q = t as usize * 3;
        positions.extend([verts[q] as f32, verts[q + 1] as f32, verts[q + 2] as f32]);
    }
    Ok(positions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

    #[test]
    fn numbers_and_obj() {
        let t = pow10_table();
        let n = |s: &str| num_at(s.as_bytes(), 0, s.len(), &t);
        // nur 15 Stellen zählen (wie numAt im Fenster)
        assert_eq!((n("1.5"), n("-2e3"), n(" +.25"), n("12345678901234567890")), (1.5, -2000.0, 0.25, 12345678901234500000.0));
        assert!(n("x").is_nan() && n("-").is_nan());
        let p = parse_obj(b"v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nf 1 2 3 4\n").unwrap();
        assert_eq!(p.len(), 18);
        assert_eq!(js_number_token("0x10"), 16.0);
        assert!(js_number_token("1e").is_nan() && js_number_token("-0x1").is_nan());
    }

    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("meshimport-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let cases: Value = serde_json::from_str(&text).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 30, "only {} cases", cases.len());
        let (mut ok, mut errors) = (0, 0);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let hex = c["file"].as_str().unwrap().as_bytes();
            let data: Vec<u8> = hex.chunks(2).map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap()).collect();
            let head = Head { kind: c["kind"].as_str().unwrap().to_string() };
            let want = &c["want"];
            match run(&head, &data) {
                Ok(s) => {
                    assert!(want["error"].is_null(), "{name}: Rust read it, the TypeScript failed ({})", want["error"]);
                    let got = serde_json::to_value(&s).unwrap();
                    for k in ["triangles", "hash"] {
                        assert_eq!(got[k], want[k], "{name}: {k}");
                    }
                    for k in ["min", "max"] {
                        for i in 0..3 {
                            let (g, w) = (&got[k][i], &want[k][i]);
                            assert!(g == w || g.as_f64() == w.as_f64(), "{name}: {k}[{i}] {g} vs {w}");
                        }
                    }
                    ok += 1;
                }
                Err(e) => {
                    let w = want["error"].as_str().unwrap_or_else(|| panic!("{name}: Rust failed ({e}), the TypeScript read it"));
                    // OBJ: dieselbe Fehler-Art; 3MF: nur dass beide ablehnen
                    if head.kind == "obj" {
                        assert!(e.starts_with(w), "{name}: {e} vs {w}");
                    }
                    errors += 1;
                }
            }
        }
        println!("{ok} models the same as the TypeScript, {errors} refused by both");
    }
}
