//! WINKELFUNKTIONEN FÜR DIE RECHEN-ZWILLINGE
//!
//! Die Grundrechenarten und die Wurzel liefern überall dieselben Zahlen. Sinus, Kosinus und ihre Verwandten nicht:
//! die Funktionen des Betriebssystems weichen von denen im Fenster ab (auf diesem Mac gegen node: je nach Funktion bei
//! 3 bis 40 von 100 Werten um eine letzte Stelle), und sie sind auf Mac, Windows und Linux nicht dieselben.
//! Darum hier `libm` (reines Rust): auf jedem Rechner dieselben Zahlen, und gegen node nur noch bei etwa 1 von 100
//! Werten eine letzte Stelle daneben. Ganz gleich wie im Fenster geht nicht – node rechnet selbst nicht auf jedem
//! Prozessor gleich. Zwillinge, die Winkel brauchen, werden deshalb mit einer kleinen Toleranz verglichen.
//! Der Test unten prüft gegen Werte aus node (tests/fixtures/jsmath.json, geschrieben von tests/jsMath.test.ts).
#![allow(dead_code)]

pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}
pub fn tan(x: f64) -> f64 {
    libm::tan(x)
}
pub fn acos(x: f64) -> f64 {
    libm::acos(x)
}
pub fn asin(x: f64) -> f64 {
    libm::asin(x)
}
pub fn atan(x: f64) -> f64 {
    libm::atan(x)
}
pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}
/// Potenz: hier nimmt node (und das Fenster) die Funktion des Betriebssystems – also wir auch. Gemessen: damit
/// 0 von 1500 Werten anders, mit libm 126. Auf einem anderen Betriebssystem kann die letzte Stelle abweichen,
/// dort aber im Fenster genauso.
pub fn pow(x: f64, y: f64) -> f64 {
    x.powf(y)
}

/// Math.round: halbe Werte nach oben
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// Zahl als Text wie in JavaScript (`String(v)`, `${v}`): ganze Zahlen ohne Komma, sonst die kürzeste Schreibweise
pub fn js_num(v: f64) -> String {
    if v == 0.0 {
        return "0".into();
    }
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    // sehr klein oder sehr groß: JavaScript schreibt mit Exponent (1e-7, 1.5e+21)
    if v.abs() < 1e-6 || v.abs() >= 1e21 {
        let e = format!("{v:e}");
        return if e.contains("e-") { e } else { e.replace('e', "e+") };
    }
    format!("{v}")
}

/// Zahl mit `digits` Nachkommastellen wie `toFixed` in JavaScript. Unterschied zu Rust: liegt die Zahl genau auf
/// der Hälfte (z. B. 0,125 bei zwei Stellen), rundet JavaScript vom Nullpunkt weg, Rust zur geraden Ziffer.
pub fn to_fixed(v: f64, digits: usize) -> String {
    // schneller Weg (G-Code schreibt Millionen Zahlen): v · 10^digits gerundet als Ziffern. Nur, wo das Ergebnis eindeutig
    // ist – nicht nahe an einer Hälfte (dort entscheidet die genaue Dezimalzahl) und nicht bei sehr großen Zahlen. Sonst
    // der genaue Weg. Dass beide dasselbe schreiben, prüft `fast_to_fixed_is_the_exact_one` mit Millionen Werten.
    if digits <= 6 {
        let scale = [1.0, 10.0, 100.0, 1000.0, 1e4, 1e5, 1e6][digits];
        let s = v.abs() * scale;
        if s < 1e9 {
            let f = s.floor();
            let frac = s - f;
            if (frac - 0.5).abs() >= 1e-4 {
                let k = (if frac > 0.5 { f + 1.0 } else { f }) as u64;
                let mut out = String::with_capacity(digits + 12);
                if v < 0.0 {
                    out.push('-');
                }
                let p = [1u64, 10, 100, 1000, 10_000, 100_000, 1_000_000][digits];
                out.push_str(&(k / p).to_string());
                if digits > 0 {
                    out.push('.');
                    let r = (k % p).to_string();
                    for _ in r.len()..digits {
                        out.push('0');
                    }
                    out.push_str(&r);
                }
                return out;
            }
        }
    }
    to_fixed_exact(v, digits)
}

/// Der genaue, langsame Weg von `to_fixed` (über die lange Dezimalschreibweise)
pub fn to_fixed_exact(v: f64, digits: usize) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let a = v.abs();
    let plain = format!("{a:.digits$}");
    // genaue Dezimalschreibweise: steht nach den gewünschten Stellen genau „5000…“, ist es eine Hälfte
    let long = format!("{:.*}", digits + 60, a);
    let tail = &long[long.len() - 60..];
    let text = if tail.starts_with('5') && tail[1..].bytes().all(|b| b == b'0') {
        // abschneiden und die letzte Ziffer um eins erhöhen (mit Übertrag)
        let mut d: Vec<u8> = long[..long.len() - 60].trim_end_matches('.').bytes().collect();
        let mut i = d.len();
        loop {
            if i == 0 {
                d.insert(0, b'1');
                break;
            }
            i -= 1;
            if d[i] == b'.' {
                continue;
            }
            if d[i] == b'9' {
                d[i] = b'0';
            } else {
                d[i] += 1;
                break;
            }
        }
        String::from_utf8(d).unwrap_or(plain)
    } else {
        plain
    };
    if v < 0.0 {
        format!("-{text}")
    } else {
        text
    }
}

#[cfg(test)]
mod tests {

    /// Der schnelle Weg von to_fixed schreibt genau dasselbe wie der genaue: Zufallswerte aller Größen und Vorzeichen,
    /// jede halbe letzte Stelle in einem Bereich mit winzigen Abweichungen, kleine negative Zahlen („-0.000“), Ränder
    #[test]
    fn fast_to_fixed_is_the_exact_one() {
        let mut seed = 0x2545F4914F6CDD1Du64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut count = 0usize;
        let mut check = |v: f64, d: usize| {
            assert_eq!(to_fixed(v, d), to_fixed_exact(v, d), "{v:?} with {d} digits");
            count += 1;
        };
        for _ in 0..600_000 {
            let r = next();
            let v = ((r >> 11) as f64 / (1u64 << 53) as f64 - 0.5) * [1e-3, 1.0, 10.0, 700.0, 2500.0, 1e6, 1e9][(r % 7) as usize];
            check(v, (r >> 3) as usize % 7);
        }
        for d in 0..=6usize {
            let step = 10f64.powi(-(d as i32)) / 2.0;
            for k in -3000i64..=3000 {
                let v = k as f64 * step;
                for e in [0.0, 1e-13, -1e-13, 1e-9, -1e-9, 3e-6, -3e-6] {
                    check(v + e, d);
                    check((v + e) * 37.0 + 123.0, d);
                }
            }
        }
        for v in [0.0, -0.0, -0.0004, -0.00049, 0.0005, -0.0005, 1.005, 2.675, 0.125, -0.125, 999999.9995, 1e8 + 0.25, 4.35, 1.45, 8.345, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 5e-324, -5e-324] {
            for d in 0..=6 {
                check(v, d);
            }
        }
        assert!(count > 1_000_000);
    }

    use super::{to_fixed, to_fixed_exact};
    use serde_json::Value;

    fn bits(v: &Value) -> f64 {
        f64::from_bits(u64::from_str_radix(v.as_str().unwrap(), 16).unwrap())
    }

    /// Antwort: Abweichungen je Funktion (Anzahl), einmal mit libm, einmal mit den Funktionen des Betriebssystems
    fn differences() -> Vec<(String, usize, usize, usize)> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/jsmath.json");
        let all: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut out = vec![];
        for (name, rows) in all.as_object().unwrap() {
            let (mut lib, mut sys) = (0, 0);
            let rows = rows.as_array().unwrap();
            for r in rows {
                let (a, b, want) = (bits(&r[0]), bits(&r[1]), bits(&r[2]));
                let (l, s) = match name.as_str() {
                    "sin" => (super::sin(a), a.sin()),
                    "cos" => (super::cos(a), a.cos()),
                    "tan" => (super::tan(a), a.tan()),
                    "acos" => (super::acos(a), a.acos()),
                    "asin" => (super::asin(a), a.asin()),
                    "atan" => (super::atan(a), a.atan()),
                    "atan2" => (super::atan2(a, b), a.atan2(b)),
                    "pow" => (super::pow(a, b), libm::pow(a, b)),
                    other => panic!("unknown function {other}"),
                };
                // nie mehr als eine letzte Stelle (die Bitmuster benachbarter Zahlen unterscheiden sich um 1)
                let steps = |v: f64| (v.to_bits() as i128 - want.to_bits() as i128).abs();
                assert!(steps(l) <= 1 || (l == 0.0 && want == 0.0), "{name}({a}, {b}): {l} is not next to {want}");
                lib += (l.to_bits() != want.to_bits()) as usize;
                sys += (s.to_bits() != want.to_bits()) as usize;
            }
            out.push((name.clone(), rows.len(), lib, sys));
        }
        out
    }

    #[test]
    fn numbers_as_text_like_javascript() {
        use super::{js_num, to_fixed};
        assert_eq!((js_num(840.0), js_num(1.5), js_num(-0.0), js_num(0.1 + 0.2)), ("840".into(), "1.5".into(), "0".into(), "0.30000000000000004".into()));
        // mit Exponent wie String(v) in JavaScript (node: 1e-7 1.5e-7 -2.5e-9 1e+21 1.234e+22 -1e+300 5e-324 0.000001 123456789012345680000)
        let got: Vec<String> = [1e-7, 1.5e-7, -2.5e-9, 1e21, 1.234e22, -1e300, 5e-324, 0.000001, 123456789012345680000.0].iter().map(|v| js_num(*v)).collect();
        assert_eq!(got, ["1e-7", "1.5e-7", "-2.5e-9", "1e+21", "1.234e+22", "-1e+300", "5e-324", "0.000001", "123456789012345680000"]);
        assert_eq!(to_fixed(0.0625, 3), "0.063"); // genau die Hälfte: weg von null
        assert_eq!(to_fixed(-0.0625, 3), "-0.063");
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(9.995, 2), "9.99"); // 9,995 liegt als Zahl knapp darunter
        assert_eq!(to_fixed(0.9995, 3), "1.000"); // …und 0,9995 knapp darüber
        assert_eq!(to_fixed(5.0, 2), "5.00");
        assert_eq!(to_fixed(-1.5, 3), "-1.500");
        assert_eq!(to_fixed(-0.0001, 3), "-0.000");
        assert_eq!(to_fixed(-0.0, 3), "0.000");
        assert_eq!(to_fixed(4.0, 1), "4.0");
    }

    #[test]
    fn at_most_one_last_digit_from_node() {
        let d = differences();
        assert!(d.len() >= 8);
        for (name, n, lib, sys) in &d {
            println!("{name}: {n} values, jsmath differs in {lib}, the other candidate (system function; for pow: libm) in {sys}");
            // gemessen am 26.11.2026 (Mac, M-Prozessor): libm bei etwa 1 von 100 Werten, Betriebssystem bei bis zu 40 von 100
            assert!(*lib * 20 <= *n, "{name}: libm differs from node in more than 5 of 100 values");
        }
    }
}
