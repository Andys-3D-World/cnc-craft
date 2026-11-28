//! DREHACHSE – Form des Rohteils: Zwilling von `src/rotaryStock.ts` (rund, rechteckig, Vieleck, Kegel: Flächen, Umfang,
//! Eck- und Bezugsradius, Kegelradius, Fläche im Band, Querschnitt, Abstand Achse–Oberfläche).
//! Fehlende Zahlen zählen wie in JavaScript als „keine Zahl“ (NaN). Gebraucht von rotarysim.rs; Fälle in
//! `tests/fixtures/rotarysim-cases.json.gz`.

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath::{self, js_round};
use serde::{Deserialize, Deserializer, Serialize};
use std::f64::consts::PI;

fn nan_num<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
}
fn nan() -> f64 {
    f64::NAN
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RotaryStock {
    #[serde(default)]
    pub shape: String,
    #[serde(default = "nan", deserialize_with = "nan_num")]
    pub diameter: f64,
    #[serde(default = "nan", deserialize_with = "nan_num")]
    pub width: f64,
    #[serde(default = "nan", deserialize_with = "nan_num")]
    pub height: f64,
    #[serde(default = "nan", deserialize_with = "nan_num")]
    pub sides: f64,
    #[serde(default = "nan", deserialize_with = "nan_num")]
    pub flats: f64,
    #[serde(default = "nan", deserialize_with = "nan_num")]
    pub d0: f64,
    #[serde(default = "nan", deserialize_with = "nan_num")]
    pub d1: f64,
    #[serde(default = "nan", deserialize_with = "nan_num")]
    pub cone_len: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Face {
    pub k: f64,
    pub width: f64,
    pub apothem: f64,
    pub angle: f64,
    pub start: f64,
    pub end: f64,
    pub center: f64,
}

pub fn is_prism(s: &RotaryStock) -> bool {
    s.shape == "rect" || s.shape == "poly"
}

/// Flächen in Reihenfolge rundherum (rund und Kegel: keine)
pub fn faces(s: &RotaryStock) -> Vec<Face> {
    let mut list: Vec<(f64, f64)> = vec![];
    if s.shape == "rect" {
        list.extend([(s.width, s.height / 2.0), (s.height, s.width / 2.0), (s.width, s.height / 2.0), (s.height, s.width / 2.0)]);
    } else if s.shape == "poly" {
        let n = mx(3.0, mn(12.0, js_round(s.sides)));
        // NaN Seiten: Math.max(3, NaN) = NaN → die Schleife läuft nicht
        let mut k = 0.0;
        while k < n {
            list.push((s.flats * jsmath::tan(PI / n), s.flats / 2.0));
            k += 1.0;
        }
    }
    let mut at = 0.0;
    let len = list.len() as f64;
    list.iter()
        .enumerate()
        .map(|(k, &(width, apothem))| {
            let f = Face { k: k as f64, width, apothem, angle: (k as f64 * 360.0) / len, start: at, end: at + width, center: at + width / 2.0 };
            at += width;
            f
        })
        .collect()
}

/// Weg einmal rundherum (Kegel: am dicksten Ende)
pub fn perimeter(s: &RotaryStock) -> f64 {
    if s.shape == "cone" {
        return PI * mx(s.d0, s.d1);
    }
    if s.shape == "round" {
        return PI * s.diameter;
    }
    faces(s).iter().fold(0.0, |a, f| a + f.width)
}

/// Radius der Stelle, die beim Drehen am weitesten herausragt
#[allow(dead_code)] // im Fenster anderswo gebraucht (Einstellungen, Ansicht): nur vom Test verglichen
pub fn corner_radius(s: &RotaryStock) -> f64 {
    if s.shape == "rect" {
        return hypot2(s.width, s.height) / 2.0;
    }
    if s.shape == "poly" {
        return (s.flats / 2.0) / jsmath::cos(PI / mx(3.0, js_round(s.sides)));
    }
    if s.shape == "cone" {
        mx(s.d0, s.d1) / 2.0
    } else {
        s.diameter / 2.0
    }
}

/// Abstand Achse – Z 0. faces(s)[0] fehlt (Vieleck mit NaN Seiten): im Fenster ein Fehler, hier NaN
#[allow(dead_code)] // im Fenster anderswo gebraucht (Einstellungen, Ansicht): nur vom Test verglichen
pub fn ref_radius(s: &RotaryStock) -> f64 {
    if is_prism(s) {
        return faces(s).first().map_or(f64::NAN, |f| f.apothem);
    }
    if s.shape == "cone" {
        s.d0 / 2.0
    } else {
        s.diameter / 2.0
    }
}

/// Bis hierhin ist Material bis zur Achse (Math.min(...[]) = Infinity)
#[allow(dead_code)] // im Fenster anderswo gebraucht (Einstellungen, Ansicht): nur vom Test verglichen
pub fn min_radius(s: &RotaryStock) -> f64 {
    if is_prism(s) {
        return faces(s).iter().fold(f64::INFINITY, |a, f| mn(a, f.apothem));
    }
    if s.shape == "cone" {
        mn(s.d0, s.d1) / 2.0
    } else {
        s.diameter / 2.0
    }
}

/// Kegel: Radius an der Stelle entlang der Achse (außerhalb der Länge bleibt es beim Endmaß)
pub fn cone_radius(s: &RotaryStock, along: f64) -> f64 {
    let u = mx(0.0, mn(1.0, along / mx(1e-9, s.cone_len)));
    mx(0.01, (s.d0 + (s.d1 - s.d0) * u) / 2.0)
}

/// Kegel: Mitte des Bands (u), liegt bei A = 0 oben
pub fn cone_center(s: &RotaryStock) -> f64 {
    perimeter(s) / 2.0
}

/// Fläche zu einer Stelle im Band und Lage ihrer Mitte (auch außerhalb 0 … Umfang)
#[allow(dead_code)] // im Fenster anderswo gebraucht (Einstellungen, Ansicht): nur vom Test verglichen
pub fn face_at(fs: &[Face], u: f64) -> (usize, f64) {
    let p = fs[fs.len() - 1].end;
    let m = (u / p).floor();
    let w = u - m * p;
    let i = fs.iter().position(|f| w < f.end).unwrap_or(fs.len() - 1);
    (i, fs[i].center + m * p)
}

/// Querschnitt bei A = 0 (y, z um die Achse)
#[allow(dead_code)] // im Fenster anderswo gebraucht (Einstellungen, Ansicht): nur vom Test verglichen
pub fn section_at(s: &RotaryStock, along: f64, n: f64) -> Vec<[f64; 2]> {
    if is_prism(s) {
        if s.shape == "rect" {
            let (w, h) = (s.width / 2.0, s.height / 2.0);
            return vec![[-w, h], [w, h], [w, -h], [-w, -h]];
        }
        let c = mx(3.0, js_round(s.sides));
        let r = corner_radius(s);
        return circle(c, r, -0.5);
    }
    let r = if s.shape == "cone" { cone_radius(s, along) } else { s.diameter / 2.0 };
    circle(n, r, 0.0)
}
/// Array.from({ length: n }): Länge = ToLength(n) (abgeschnitten, NaN = 0)
fn circle(n: f64, r: f64, shift: f64) -> Vec<[f64; 2]> {
    let len = if n.is_nan() || n <= 0.0 { 0 } else { n.trunc().min(1e7) as usize };
    (0..len)
        .map(|k| {
            let t = ((k as f64 + shift) * 2.0 * PI) / n;
            [r * jsmath::sin(t), r * jsmath::cos(t)]
        })
        .collect()
}

/// Abstand Achse – Oberfläche in Richtung phi (von +Z nach +Y)
pub fn surface_radius(s: &RotaryStock, fs: &[Face], along: f64, phi: f64) -> f64 {
    if is_prism(s) {
        let mut best = f64::INFINITY;
        for f in fs {
            let c = jsmath::cos(phi - (f.angle * PI) / 180.0);
            if c > 1e-6 {
                best = mn(best, f.apothem / c);
            }
        }
        return best;
    }
    if s.shape == "cone" {
        cone_radius(s, along)
    } else {
        s.diameter / 2.0
    }
}
