//! GAMEPAD LESEN (gilrs) – für src/gamepad.ts
//!
//! Das Fenster (WKWebView auf dem Mac) meldet angeschlossene Controller über seine Gamepad-Schnittstelle oft gar nicht,
//! obwohl macOS sie kennt. Deshalb liest Rust sie selbst und gibt den Zustand im selben Aufbau wie die
//! „Standard“-Belegung der Gamepad-Schnittstelle weiter (Knopf-Nummern 0–16, Achsen 0–3, oben = -1).
//!
//! Der Lese-Faden startet erst beim ersten `gamepad_read` (Gamepad eingeschaltet oder Abschnitt offen) und läuft
//! danach ruhig weiter: Fragt niemand mehr, schaut er nur noch selten nach. Bleibt er hängen, ist der Stand
//! zu alt und `gamepad_read` meldet „kein Gamepad“ – damit stoppt eine laufende Fahrt.
use gilrs::{Axis, Button, Gilrs, MappingSource};
use serde::Serialize;
use std::sync::{Mutex, Once};
use std::time::{Duration, Instant};

const MAX_AGE: Duration = Duration::from_millis(300);
const ACTIVE_FOR: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct PadSnapshot {
    pub key: String,
    pub id: String,
    pub standard: bool,
    pub buttons: Vec<bool>,
    pub axes: Vec<f32>,
}

/// Reihenfolge = Nummer in der Standard-Belegung
const BUTTONS: [Button; 17] = [
    Button::South, Button::East, Button::West, Button::North,
    Button::LeftTrigger, Button::RightTrigger, Button::LeftTrigger2, Button::RightTrigger2,
    Button::Select, Button::Start, Button::LeftThumb, Button::RightThumb,
    Button::DPadUp, Button::DPadDown, Button::DPadLeft, Button::DPadRight, Button::Mode,
];

/// gilrs: oben = +1. Standard-Belegung: oben = -1
fn axes(lx: f32, ly: f32, rx: f32, ry: f32) -> Vec<f32> {
    vec![lx, -ly, rx, -ry]
}

/// Manche Controller melden das Steuerkreuz als Achsen statt als Knöpfe
fn merge_dpad(buttons: &mut [bool], dx: f32, dy: f32) {
    if dy > 0.5 { buttons[12] = true; }
    if dy < -0.5 { buttons[13] = true; }
    if dx < -0.5 { buttons[14] = true; }
    if dx > 0.5 { buttons[15] = true; }
}

struct Shared {
    snapshot: Option<PadSnapshot>,
    updated: Instant,
    last_read: Instant,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);
static START: Once = Once::new();

fn read_first(g: &Gilrs) -> Option<PadSnapshot> {
    let (id, p) = g.gamepads().find(|(_, p)| p.is_connected())?;
    let mut buttons: Vec<bool> = BUTTONS.iter().map(|b| p.is_pressed(*b)).collect();
    merge_dpad(&mut buttons, p.value(Axis::DPadX), p.value(Axis::DPadY));
    Some(PadSnapshot {
        key: format!("rust:{id}"),
        id: p.name().to_string(),
        standard: p.mapping_source() != MappingSource::None,
        buttons,
        axes: axes(p.value(Axis::LeftStickX), p.value(Axis::LeftStickY), p.value(Axis::RightStickX), p.value(Axis::RightStickY)),
    })
}

fn run() {
    let mut g = match Gilrs::new() {
        Ok(g) => g,
        Err(gilrs::Error::NotImplemented(g)) => g,
        Err(e) => { eprintln!("gamepad: {e}"); return; }
    };
    loop {
        while g.next_event().is_some() {} // aktualisiert den Zustand
        let snap = read_first(&g);
        let active = {
            let Ok(mut s) = SHARED.lock() else { return };
            let Some(s) = s.as_mut() else { return };
            s.snapshot = snap;
            s.updated = Instant::now();
            s.last_read.elapsed() < ACTIVE_FOR
        };
        std::thread::sleep(Duration::from_millis(if active { 10 } else { 250 }));
    }
}

/// Aktueller Zustand des ersten Gamepads (None = keins da oder Stand zu alt)
pub fn read() -> Option<PadSnapshot> {
    START.call_once(|| {
        if let Ok(mut s) = SHARED.lock() {
            let now = Instant::now();
            *s = Some(Shared { snapshot: None, updated: now, last_read: now });
        }
        let _ = std::thread::Builder::new().name("gamepad".into()).spawn(run);
    });
    let mut guard = SHARED.lock().ok()?;
    let s = guard.as_mut()?;
    s.last_read = Instant::now();
    if s.updated.elapsed() > MAX_AGE { return None; }
    s.snapshot.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn up_is_negative_like_the_standard_layout() {
        assert_eq!(axes(0.5, 1.0, -0.25, -1.0), vec![0.5, -1.0, -0.25, 1.0]);
    }

    #[test]
    fn dpad_axes_become_buttons() {
        let mut b = vec![false; 17];
        merge_dpad(&mut b, 1.0, -1.0);
        assert!(b[15] && b[13] && !b[12] && !b[14]);
        let mut c = vec![false; 17];
        merge_dpad(&mut c, 0.2, 0.2);
        assert!(c.iter().all(|x| !x));
    }

    /// Mit echtem Controller: cargo test gamepad::tests::live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live() {
        read();
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(250));
            println!("{:?}", read());
        }
    }
}
