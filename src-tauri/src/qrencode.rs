//! QR-CODE – Zwilling von `encodeQr` und `qrOutlines` in `src/editor/qrcode.ts` (eigener Encoder nach ISO/IEC 18004).
//!
//! Byte-Modus (UTF-8), Fehlerkorrektur L/M/Q/H, kleinste passende Version 1–40, alle 8 Masken probiert, die mit den
//! wenigsten Strafpunkten gewinnt. `qr_outlines` macht aus den dunklen Modulen geschlossene Umrisse (Löcher inklusive).
//! Folgt dem TypeScript Zeile für Zeile, auch in der Reihenfolge der Umrisse (Map in Einfüge-Reihenfolge).
//! Gemeinsame Fälle: `tests/fixtures/qrcode-cases.json.gz`.

use serde::Serialize;
use std::collections::HashMap;

const ECC_PER_BLOCK: [[i32; 41]; 4] = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS: [[i32; 41]; 4] = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct QrCode {
    pub version: usize,
    pub size: usize,
    pub modules: Vec<Vec<bool>>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct Pt {
    pub x: i64,
    pub y: i64,
}

/// Module (ohne Funktionsmuster) für Daten + Fehlerkorrektur
fn raw_modules(ver: i32) -> i32 {
    let mut r = (16 * ver + 128) * ver + 64;
    if ver >= 2 {
        let na = ver / 7 + 2;
        r -= (25 * na - 10) * na - 55;
        if ver >= 7 {
            r -= 36;
        }
    }
    r
}

fn data_codewords(ver: i32, e: usize) -> i32 {
    raw_modules(ver) / 8 - ECC_PER_BLOCK[e][ver as usize] * NUM_BLOCKS[e][ver as usize]
}

// ---- Reed-Solomon über GF(256), Polynom 0x11D ----
fn gf_mul(x: u32, y: u32) -> u32 {
    let mut z: u32 = 0;
    for i in (0..8).rev() {
        z = (z << 1) ^ ((z >> 7) * 0x11d);
        z ^= ((y >> i) & 1) * x;
    }
    z & 0xff
}

fn rs_divisor(degree: usize) -> Vec<u32> {
    let mut r = vec![0u32; degree];
    r[degree - 1] = 1;
    let mut root = 1;
    for _ in 0..degree {
        for j in 0..r.len() {
            r[j] = gf_mul(r[j], root);
            if j + 1 < r.len() {
                r[j] ^= r[j + 1];
            }
        }
        root = gf_mul(root, 0x02);
    }
    r
}

fn rs_remainder(data: &[u32], div: &[u32]) -> Vec<u32> {
    let mut r = vec![0u32; div.len()];
    for &b in data {
        let f = b ^ r.remove(0);
        r.push(0);
        for i in 0..div.len() {
            r[i] ^= gf_mul(div[i], f);
        }
    }
    r
}

fn align_positions(ver: i32) -> Vec<i32> {
    if ver == 1 {
        return vec![];
    }
    let n = ver / 7 + 2;
    // Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2
    let (a, b) = (ver * 4 + 4, n * 2 - 2);
    let step = if ver == 32 { 26 } else { (a + b - 1) / b * 2 };
    let mut r = vec![6];
    let mut pos = ver * 4 + 17 - 7;
    while (r.len() as i32) < n {
        r.insert(1, pos);
        pos -= step;
    }
    r
}

/// Strafpunkte nach der Norm (lange Reihen, 2×2-Blöcke, Sucher-ähnliche Muster, Hell/Dunkel-Verhältnis)
fn penalty(m: &[Vec<bool>]) -> i64 {
    let n = m.len();
    let mut p: i64 = 0;
    let mut dark: i64 = 0;
    let mut line = |get: &dyn Fn(usize) -> bool| {
        let mut run = 1;
        for i in 1..=n {
            if i < n && get(i) == get(i - 1) {
                run += 1;
            } else {
                if run >= 5 {
                    p += run - 2;
                }
                run = 1;
            }
        }
        // 1:1:3:1:1 mit 4 hellen Modulen davor oder dahinter
        let mut i = 0;
        while i + 6 < n {
            if get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6) {
                let before = i >= 4 && !get(i - 1) && !get(i - 2) && !get(i - 3) && !get(i - 4);
                let after = i + 10 < n && !get(i + 7) && !get(i + 8) && !get(i + 9) && !get(i + 10);
                if before || after {
                    p += 40;
                }
            }
            i += 1;
        }
    };
    for y in 0..n {
        line(&|i| m[y][i]);
    }
    for x in 0..n {
        line(&|i| m[i][x]);
    }
    for y in 0..n {
        for x in 0..n {
            if m[y][x] {
                dark += 1;
            }
            if x + 1 < n && y + 1 < n && m[y][x] == m[y][x + 1] && m[y][x] == m[y + 1][x] && m[y][x] == m[y + 1][x + 1] {
                p += 3;
            }
        }
    }
    let total = (n * n) as i64;
    // Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
    let d = (dark * 20 - total * 10).abs();
    p += ((d + total - 1) / total - 1) * 10;
    p
}

/// Text als QR-Code (None = zu lang für Version 40). `ecc` = "L" | "M" | "Q" | "H" (anderes zählt wie TypeScript: undefined)
pub fn encode_qr(text: &str, ecc: &str) -> Option<QrCode> {
    let bytes: Vec<u32> = text.as_bytes().iter().map(|&b| b as u32).collect();
    let (e, ecc_bits) = match ecc {
        "L" => (0, 1),
        "Q" => (2, 3),
        "H" => (3, 2),
        _ => (1, 0),
    };
    let mut ver = 1;
    while ver <= 40 {
        let cc_bits = if ver <= 9 { 8 } else { 16 };
        if 4 + cc_bits + bytes.len() as i32 * 8 <= data_codewords(ver, e) * 8 {
            break;
        }
        ver += 1;
    }
    if ver > 40 {
        return None;
    }

    // ---- Bitfolge: Modus 0100 (Byte), Länge, Daten, Ende, Füllbytes ----
    let mut bits: Vec<u32> = vec![];
    let put = |bits: &mut Vec<u32>, v: u32, n: i32| {
        for i in (0..n).rev() {
            bits.push((v >> i) & 1);
        }
    };
    put(&mut bits, 4, 4);
    put(&mut bits, bytes.len() as u32, if ver <= 9 { 8 } else { 16 });
    for &b in &bytes {
        put(&mut bits, b, 8);
    }
    let cap = (data_codewords(ver, e) * 8) as usize;
    let n = 4.min(cap as i64 - bits.len() as i64) as i32;
    put(&mut bits, 0, n);
    let n = ((8 - (bits.len() % 8)) % 8) as i32;
    put(&mut bits, 0, n);
    let mut pad = 0xec;
    while bits.len() < cap {
        put(&mut bits, pad, 8);
        pad ^= 0xec ^ 0x11;
    }
    let data: Vec<u32> = bits.chunks(8).map(|c| c.iter().fold(0, |a, &b| (a << 1) | b)).collect();

    // ---- Blöcke + Fehlerkorrektur, verschränkt ----
    let (nb, ecc_len) = (NUM_BLOCKS[e][ver as usize] as usize, ECC_PER_BLOCK[e][ver as usize] as usize);
    let raw = (raw_modules(ver) / 8) as usize;
    let (n_short, short_len) = (nb - raw % nb, raw / nb);
    let div = rs_divisor(ecc_len);
    let mut blocks: Vec<Vec<u32>> = vec![];
    let mut k = 0;
    for i in 0..nb {
        let len = short_len - ecc_len + usize::from(i >= n_short);
        let mut dat: Vec<u32> = data[k.min(data.len())..(k + len).min(data.len())].to_vec();
        k += dat.len();
        let ec = rs_remainder(&dat, &div);
        if i < n_short {
            dat.push(0);
        }
        dat.extend(ec);
        blocks.push(dat);
    }
    let mut all: Vec<u32> = vec![];
    for i in 0..blocks[0].len() {
        for (j, b) in blocks.iter().enumerate() {
            if i != short_len - ecc_len || j >= n_short {
                all.push(b[i]);
            }
        }
    }

    // ---- Matrix ----
    let size = (ver * 4 + 17) as usize;
    let mut m = vec![vec![false; size]; size];
    let mut f = vec![vec![false; size]; size];
    fn set(m: &mut [Vec<bool>], f: &mut [Vec<bool>], x: usize, y: usize, dark: bool) {
        m[y][x] = dark;
        f[y][x] = true;
    }
    for i in 0..size {
        set(&mut m, &mut f, 6, i, i % 2 == 0);
        set(&mut m, &mut f, i, 6, i % 2 == 0);
    }
    let s = size as i32;
    for (cx, cy) in [(3, 3), (s - 4, 3), (3, s - 4)] {
        for dy in -4..=4i32 {
            for dx in -4..=4i32 {
                let d = dx.abs().max(dy.abs());
                let (x, y) = (cx + dx, cy + dy);
                if x >= 0 && x < s && y >= 0 && y < s {
                    set(&mut m, &mut f, x as usize, y as usize, d != 2 && d != 4);
                }
            }
        }
    }
    let ap = align_positions(ver);
    for i in 0..ap.len() {
        for j in 0..ap.len() {
            if (i == 0 && j == 0) || (i == 0 && j == ap.len() - 1) || (i == ap.len() - 1 && j == 0) {
                continue;
            }
            for dy in -2..=2i32 {
                for dx in -2..=2i32 {
                    set(&mut m, &mut f, (ap[i] + dx) as usize, (ap[j] + dy) as usize, dx.abs().max(dy.abs()) != 1);
                }
            }
        }
    }
    let draw_format = |m: &mut [Vec<bool>], f: &mut [Vec<bool>], mask: u32| {
        let d = (ecc_bits << 3) | mask;
        let mut r = d;
        for _ in 0..10 {
            r = (r << 1) ^ ((r >> 9) * 0x537);
        }
        let b = ((d << 10) | r) ^ 0x5412;
        let bit = |i: usize| (b >> i) & 1 != 0;
        for i in 0..=5 {
            set(m, f, 8, i, bit(i));
        }
        set(m, f, 8, 7, bit(6));
        set(m, f, 8, 8, bit(7));
        set(m, f, 7, 8, bit(8));
        for i in 9..15 {
            set(m, f, 14 - i, 8, bit(i));
        }
        for i in 0..8 {
            set(m, f, size - 1 - i, 8, bit(i));
        }
        for i in 8..15 {
            set(m, f, 8, size - 15 + i, bit(i));
        }
        set(m, f, 8, size - 8, true);
    };
    draw_format(&mut m, &mut f, 0);
    if ver >= 7 {
        let mut r = ver as u32;
        for _ in 0..12 {
            r = (r << 1) ^ ((r >> 11) * 0x1f25);
        }
        let b = ((ver as u32) << 12) | r;
        for i in 0..18 {
            let bit = (b >> i) & 1 != 0;
            let (a, c) = (size - 11 + (i % 3), i / 3);
            set(&mut m, &mut f, a, c, bit);
            set(&mut m, &mut f, c, a, bit);
        }
    }

    // Daten im Zickzack von rechts unten
    let mut i = 0usize;
    let mut right = size as i32 - 1;
    while right >= 1 {
        if right == 6 {
            right = 5;
        }
        for v in 0..size {
            for j in 0..2 {
                let x = (right - j) as usize;
                let up = ((right + 1) & 2) == 0;
                let y = if up { size - 1 - v } else { v };
                if !f[y][x] && i < all.len() * 8 {
                    m[y][x] = ((all[i >> 3] >> (7 - (i & 7))) & 1) != 0;
                    i += 1;
                }
            }
        }
        right -= 2;
    }

    let apply_mask = |m: &mut [Vec<bool>], f: &[Vec<bool>], mask: u32| {
        for y in 0..size {
            for x in 0..size {
                if f[y][x] {
                    continue;
                }
                let inv = match mask {
                    0 => (x + y) % 2 == 0,
                    1 => y % 2 == 0,
                    2 => x % 3 == 0,
                    3 => (x + y) % 3 == 0,
                    4 => (x / 3 + y / 2) % 2 == 0,
                    5 => (x * y) % 2 + (x * y) % 3 == 0,
                    6 => ((x * y) % 2 + (x * y) % 3) % 2 == 0,
                    _ => ((x + y) % 2 + (x * y) % 3) % 2 == 0,
                };
                if inv {
                    m[y][x] = !m[y][x];
                }
            }
        }
    };
    let (mut best, mut best_p) = (0, i64::MAX);
    for mask in 0..8 {
        apply_mask(&mut m, &f, mask);
        draw_format(&mut m, &mut f, mask);
        let p = penalty(&m);
        if p < best_p {
            best_p = p;
            best = mask;
        }
        apply_mask(&mut m, &f, mask);
    }
    apply_mask(&mut m, &f, best);
    draw_format(&mut m, &mut f, best);
    Some(QrCode { version: ver as usize, size, modules: m })
}

/// Umrisse der dunklen Flächen in Modul-Einheiten (x nach rechts, y nach unten). Außen im Uhrzeigersinn, Löcher andersherum.
pub fn qr_outlines(m: &[Vec<bool>]) -> Vec<Vec<Pt>> {
    let n = m.len() as i64;
    let dark = |x: i64, y: i64| x >= 0 && y >= 0 && x < n && y < n && m[y as usize][x as usize];
    let key = |x: i64, y: i64| y * (n + 1) + x;
    // Kanten: Start-Ecke -> Liste der End-Ecken (Map in Einfüge-Reihenfolge)
    let mut order: Vec<i64> = vec![];
    let mut out: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut add = |x0: i64, y0: i64, x1: i64, y1: i64| {
        let k = key(x0, y0);
        out.entry(k).or_insert_with(|| {
            order.push(k);
            vec![]
        });
        out.get_mut(&k).unwrap().push(key(x1, y1));
    };
    for y in 0..n {
        for x in 0..n {
            if !m[y as usize][x as usize] {
                continue;
            }
            if !dark(x, y - 1) {
                add(x, y, x + 1, y);
            }
            if !dark(x + 1, y) {
                add(x + 1, y, x + 1, y + 1);
            }
            if !dark(x, y + 1) {
                add(x + 1, y + 1, x, y + 1);
            }
            if !dark(x - 1, y) {
                add(x, y + 1, x, y);
            }
        }
    }
    let w = n + 1;
    let mut loops: Vec<Vec<Pt>> = vec![];
    for &start in &order {
        while !out[&start].is_empty() {
            let mut pts: Vec<i64> = vec![start];
            let mut prev = start;
            let mut cur = out.get_mut(&start).unwrap().pop().unwrap();
            while cur != start {
                pts.push(cur);
                let next = &out[&cur];
                // berühren sich zwei Flächen nur an einer Ecke: rechts abbiegen -> getrennte Umrisse
                let mut pick = 0;
                if next.len() > 1 {
                    let (dx, dy) = (cur % w - prev % w, cur / w - prev / w);
                    pick = next
                        .iter()
                        .position(|&k| {
                            let (ex, ey) = (k % w - cur % w, k / w - cur / w);
                            dx * ey - dy * ex > 0
                        })
                        .unwrap_or(0);
                }
                prev = cur;
                cur = out.get_mut(&prev).unwrap().remove(pick);
            }
            // Punkte auf geraden Strecken weglassen
            let p: Vec<Pt> = pts.iter().map(|&k| Pt { x: k % w, y: k / w }).collect();
            let len = p.len();
            let simple: Vec<Pt> = (0..len)
                .filter(|&i| {
                    let (a, q, b) = (p[(i + len - 1) % len], p[i], p[(i + 1) % len]);
                    (q.x - a.x) * (b.y - q.y) - (q.y - a.y) * (b.x - q.x) != 0
                })
                .map(|i| p[i])
                .collect();
            loops.push(simple);
        }
    }
    loops
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Read;

    fn fnv(s: &str) -> u64 {
        let mut h: u32 = 0x811c9dc5;
        for b in s.bytes() {
            h = (h ^ b as u32).wrapping_mul(0x01000193);
        }
        h as u64
    }

    #[test]
    fn small_pieces() {
        assert_eq!((gf_mul(0x53, 0xca), gf_mul(2, 0x80)), (0x8f, 0x1d));
        assert_eq!(align_positions(32), vec![6, 34, 60, 86, 112, 138]);
        assert_eq!(encode_qr("HELLO WORLD", "Q").map(|q| q.version), Some(1));
    }

    #[test]
    fn same_result_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("qrcode-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let cases: Value = serde_json::from_str(&text).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 150, "only {} cases", cases.len());
        for c in cases {
            let (t, ecc, w) = (c["text"].as_str().unwrap(), c["ecc"].as_str().unwrap(), &c["want"]);
            let at = format!("{} bytes, {ecc}", t.len());
            let Some(q) = encode_qr(t, ecc) else {
                assert!(w.is_null(), "{at}: Rust found it too long");
                continue;
            };
            assert_eq!((q.version as u64, q.size as u64), (w["version"].as_u64().unwrap(), w["size"].as_u64().unwrap()), "{at}");
            let rows: Vec<String> = q.modules.iter().map(|r| r.iter().map(|&b| if b { '1' } else { '0' }).collect()).collect();
            let loops: Vec<Vec<i64>> = qr_outlines(&q.modules).iter().map(|l| l.iter().flat_map(|p| [p.x, p.y]).collect()).collect();
            if !w["rows"].is_null() {
                assert_eq!(serde_json::to_value(&rows).unwrap(), w["rows"], "{at}: modules");
                assert_eq!(serde_json::to_value(&loops).unwrap(), w["outlines"], "{at}: outlines");
            }
            assert_eq!(fnv(&rows.join("\n")), w["rowsHash"].as_u64().unwrap(), "{at}: modules");
            let lt: Vec<String> = loops.iter().map(|l| l.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",")).collect();
            assert_eq!(fnv(&lt.join(";")), w["outlinesHash"].as_u64().unwrap(), "{at}: outlines");
        }
        println!("{} QR codes the same as qrcode.ts (modules and outlines)", cases.len());
    }

    #[test]
    fn same_penalty_as_typescript() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(dir.join("qrpenalty-cases.json.gz")).unwrap()).read_to_string(&mut text).unwrap();
        let cases: Value = serde_json::from_str(&text).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 80, "only {} matrices", cases.len());
        for (k, c) in cases.iter().enumerate() {
            let m: Vec<Vec<bool>> = c["rows"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().chars().map(|ch| ch == '1').collect()).collect();
            assert_eq!(penalty(&m), c["want"].as_i64().unwrap(), "matrix {k} ({}×{})", m.len(), m.len());
        }
        println!("{} matrices with the same penalty points as qrcode.ts", cases.len());
    }
}
