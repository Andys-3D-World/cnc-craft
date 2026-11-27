//! AN- UND WEGFAHREN (Zwilling von src/millLead.ts): der Fräser fährt im Abfall in einem Viertelkreis oder einer
//! Schräge an die Kontur heran und wieder weg – so bleibt an der Eintauchstelle keine Marke am Teil.
//! Die Rechnung folgt dem TypeScript Schritt für Schritt; geprüft über den Fräs-G-Code (millgcode.rs).
#![allow(dead_code)]

use crate::gcodesim::{hypot2, mn, mx};
use crate::jsmath;
use crate::polyoffset::{point_in_poly, polygon_area, P};
use serde::Deserialize;

/// Einstellungen der Form (leadOptions): an / weg, Art "arc" oder "line", Länge in mm
#[derive(Deserialize, Clone, Debug)]
pub struct LeadOpts {
    #[serde(rename = "in")]
    pub lin: bool,
    pub out: bool,
    #[serde(rename = "type")]
    pub kind: String,
    pub len: f64,
}

#[derive(Clone, Debug)]
pub struct LeadMove {
    pub from: P,
    pub to: P,
    /// Punkte der Bewegung (von from bis to) – für die Prüfung und zum Rampen
    pub pts: Vec<P>,
    /// nur beim Bogen: Befehl und Mittelpunkt relativ zu from
    pub arc: Option<(&'static str, f64, f64)>,
}

#[derive(Clone, Debug)]
pub struct LeadPlan {
    pub start: P,
    pub lin: Option<LeadMove>,
    pub out: Option<LeadMove>,
}

const ARC_SAMPLES: usize = 16;

fn unit(a: P, b: P) -> Option<P> {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l = hypot2(dx, dy);
    if l > 1e-9 {
        Some([dx / l, dy / l])
    } else {
        None
    }
}

/// Eine Bewegung. entering = zur Bahn hin (endet in p), sonst von der Bahn weg (beginnt in p).
/// t = Fahrtrichtung der Bahn in p, waste_left = Abfall liegt links der Fahrtrichtung.
fn make_move(p: P, t: P, waste_left: bool, line: bool, len: f64, entering: bool) -> LeadMove {
    let pi = std::f64::consts::PI;
    let n = if waste_left { [-t[1], t[0]] } else { [t[1], -t[0]] };
    let along = if entering { -1.0 } else { 1.0 };
    if line {
        let k = len * std::f64::consts::FRAC_1_SQRT_2;
        let q = [p[0] + n[0] * k + t[0] * k * along, p[1] + n[1] * k + t[1] * k * along];
        let (a, b) = if entering { (q, p) } else { (p, q) };
        let pts = (0..=ARC_SAMPLES)
            .map(|i| {
                let f = i as f64 / ARC_SAMPLES as f64;
                [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
            })
            .collect();
        return LeadMove { from: a, to: b, pts, arc: None };
    }
    // Viertelkreis: Mittelpunkt auf der Abfall-Seite, an p genau tangential und in derselben Drehrichtung wie die Fahrt
    let c = [p[0] + n[0] * len, p[1] + n[1] * len];
    let q = [c[0] + t[0] * len * along, c[1] + t[1] * len * along];
    let (from, to) = if entering { (q, p) } else { (p, q) };
    let a0 = jsmath::atan2(from[1] - c[1], from[0] - c[0]);
    let sweep = if waste_left { pi / 2.0 } else { -pi / 2.0 };
    let mut pts: Vec<P> = (0..=ARC_SAMPLES)
        .map(|i| {
            let an = a0 + (sweep * i as f64) / ARC_SAMPLES as f64;
            [c[0] + jsmath::cos(an) * len, c[1] + jsmath::sin(an) * len]
        })
        .collect();
    pts[0] = from;
    pts[ARC_SAMPLES] = to;
    LeadMove { from, to, pts, arc: Some((if waste_left { "G3" } else { "G2" }, c[0] - from[0], c[1] - from[1])) }
}

/// Bleibt die Bewegung auf der Abfall-Seite? Punkte ganz nah an der Bahn zählen nicht (dort läuft sie ja an)
fn on_waste_side(m: &LeadMove, p: P, lp: &[P], inside: bool, len: f64) -> bool {
    let near = mx(0.02, 0.15 * len);
    for q in &m.pts {
        if hypot2(q[0] - p[0], q[1] - p[1]) < near {
            continue;
        }
        if point_in_poly(q[0], q[1], lp) != inside {
            return false;
        }
    }
    true
}

/// An- und Wegfahren an einer festen Stelle der Bahn. Versucht die gewünschte Länge, dann die halbe.
/// `free` prüft, ob andere Formen im Weg sind.
#[allow(clippy::too_many_arguments)]
pub fn lead_at_point(p: P, t_in: P, t_out: P, lp: &[P], ccw: bool, inside: bool, o: &LeadOpts, free: &dyn Fn(&[P]) -> bool) -> Option<LeadPlan> {
    let waste_left = ccw == inside;
    let line = o.kind == "line";
    for len in [o.len, o.len / 2.0] {
        let m_in = if o.lin { Some(make_move(p, t_in, waste_left, line, len, true)) } else { None };
        let m_out = if o.out { Some(make_move(p, t_out, waste_left, line, len, false)) } else { None };
        let ok = |m: &Option<LeadMove>| m.as_ref().is_none_or(|m| on_waste_side(m, p, lp, inside, len) && free(&m.pts));
        if ok(&m_in) && ok(&m_out) {
            return Some(LeadPlan { start: p, lin: m_in, out: m_out });
        }
    }
    None
}

/// Wie plan_lead, aber der Start steht fest: An-/Wegfahren genau am ersten Punkt der Bahn (Startpunkt von Hand)
pub fn plan_lead_at_start(lp: &[P], inside: bool, o: &LeadOpts, free: &dyn Fn(&[P]) -> bool) -> Option<LeadPlan> {
    let n = lp.len();
    if n < 3 {
        return None;
    }
    let t_in = unit(lp[n - 1], lp[0])?;
    let t_out = unit(lp[0], lp[1])?;
    lead_at_point(lp[0], t_in, t_out, lp, polygon_area(lp) > 0.0, inside, o, free)
}

/// Für eine geschlossene Bahn die beste Stelle suchen: zuerst die Mitte langer Geraden, dann gleichmäßig verteilte
/// Ecken. Antwort: Plan und die Bahn, die an dieser Stelle anfängt.
pub fn plan_lead(lp: &[P], inside: bool, o: &LeadOpts, free: &dyn Fn(&[P]) -> bool) -> Option<(LeadPlan, Vec<P>)> {
    let n = lp.len();
    if n < 3 {
        return None;
    }
    let ccw = polygon_area(lp) > 0.0;
    let mut edges: Vec<(usize, f64)> = (0..n).map(|i| (i, hypot2(lp[(i + 1) % n][0] - lp[i][0], lp[(i + 1) % n][1] - lp[i][1]))).filter(|e| e.1 >= 1.0).collect();
    edges.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    edges.truncate(12);
    for (i, _) in edges {
        let (a, b) = (lp[i], lp[(i + 1) % n]);
        let Some(t) = unit(a, b) else { continue };
        let mid = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
        if let Some(plan) = lead_at_point(mid, t, t, lp, ccw, inside, o, free) {
            let mut path = vec![mid];
            path.extend((1..=n).map(|k| lp[(i + k) % n]));
            return Some((plan, path));
        }
    }
    let tries = n.min(12);
    for c in 0..tries {
        let i = (c * n) / tries;
        let Some(t) = unit(lp[(i + n - 1) % n], lp[(i + 1) % n]) else { continue };
        if let Some(plan) = lead_at_point(lp[i], t, t, lp, ccw, inside, o, free) {
            let path = lp[i..].iter().chain(lp[..i].iter()).copied().collect();
            return Some((plan, path));
        }
    }
    None
}

/// Kleinster Abstand eines Punktes zu einem Linienzug
pub fn dist_to_path(p: P, path: &[P], closed: bool) -> f64 {
    let mut best = f64::INFINITY;
    let m = path.len();
    if m == 0 {
        return best;
    }
    for i in 0..(if closed { m } else { m - 1 }) {
        let (a, b) = (path[i], path[(i + 1) % m]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let f = if l2 > 1e-12 { mx(0.0, mn(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) } else { 0.0 };
        best = mn(best, hypot2(a[0] + dx * f - p[0], a[1] + dy * f - p[1]));
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(kind: &str) -> LeadOpts {
        LeadOpts { lin: true, out: true, kind: kind.into(), len: 3.0 }
    }

    #[test]
    fn quarter_circle_touches_the_path_tangentially_on_the_waste_side() {
        // Quadrat gegen den Uhrzeigersinn, Fräser außen: Abfall liegt rechts der Fahrt, also unter der unteren Kante
        let sq = vec![[0.0, 0.0], [40.0, 0.0], [40.0, 30.0], [0.0, 30.0]];
        let (plan, path) = plan_lead(&sq, false, &opts("arc"), &|_| true).unwrap();
        assert_eq!(path[0], [20.0, 0.0]); // Mitte der längsten Geraden
        let m = plan.lin.unwrap();
        assert_eq!(m.to, [20.0, 0.0]);
        assert!((m.from[0] - 17.0).abs() < 1e-9 && (m.from[1] + 3.0).abs() < 1e-9, "{:?}", m.from);
        assert_eq!(m.arc.unwrap().0, "G2");
        let out = plan.out.unwrap();
        assert!((out.to[0] - 23.0).abs() < 1e-9 && (out.to[1] + 3.0).abs() < 1e-9);
    }

    #[test]
    fn something_in_the_way_gives_no_plan() {
        let sq = vec![[0.0, 0.0], [40.0, 0.0], [40.0, 30.0], [0.0, 30.0]];
        assert!(plan_lead(&sq, false, &opts("line"), &|_| false).is_none());
        assert!((dist_to_path([5.0, 4.0], &sq, true) - 4.0).abs() < 1e-12);
    }
}
