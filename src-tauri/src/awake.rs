//! RECHNER WACH HALTEN, SOLANGE EIN JOB LÄUFT
//!
//! Geht der Rechner mitten im Job in den Ruhezustand, reißt die Verbindung ab – die Maschine bleibt mitten im
//! Werkstück stehen (wie ein Video-Programm, das den Ruhezustand verhindert). Der Bildschirm darf trotzdem ausgehen.
//!   macOS:   `caffeinate -i -m -w <pid>` (eingebaut; endet von selbst, wenn CNC Craft beendet wird)
//!   Windows: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) auf einem eigenen Faden
//!   Linux:   `systemd-inhibit --what=sleep:idle …` (fehlt es, geht es eben ohne)
//! Ein-/Ausschalten über den Befehl `keep_awake` (die Oberfläche schaltet bei Job-Start/-Ende).

use std::sync::Mutex;

#[cfg(not(windows))]
static CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);
#[cfg(windows)]
static STOP: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

#[cfg(target_os = "macos")]
fn spawn() -> Option<std::process::Child> {
    let pid = std::process::id().to_string();
    std::process::Command::new("/usr/bin/caffeinate").args(["-i", "-m", "-w", &pid]).spawn().ok()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn() -> Option<std::process::Child> {
    // läuft, bis CNC Craft endet oder abgeschaltet wird
    let pid = std::process::id().to_string();
    let wait = format!("while kill -0 {pid} 2>/dev/null; do sleep 5; done");
    std::process::Command::new("systemd-inhibit")
        .args(["--what=sleep:idle", "--who=CNC Craft", "--why=Job running", "--mode=block", "sh", "-c", &wait])
        .spawn()
        .ok()
}

/// true = wach halten, false = Ruhezustand wieder erlauben. Ergebnis: ob es geklappt hat
#[cfg(not(windows))]
pub fn set(on: bool) -> bool {
    let mut c = CHILD.lock().unwrap_or_else(|e| e.into_inner());
    if on {
        if let Some(ch) = c.as_mut() {
            if matches!(ch.try_wait(), Ok(None)) {
                return true;
            }
        }
        *c = spawn();
        c.is_some()
    } else {
        if let Some(mut ch) = c.take() {
            let _ = ch.kill();
            let _ = ch.wait();
        }
        true
    }
}

#[cfg(windows)]
pub fn set(on: bool) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    let mut s = STOP.lock().unwrap_or_else(|e| e.into_inner());
    if on {
        if s.is_some() {
            return true;
        }
        // Der Zustand gilt je Faden – deshalb ein eigener, der bis zum Abschalten wartet
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            let _ = rx.recv();
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        });
        *s = Some(tx);
        true
    } else {
        if let Some(tx) = s.take() {
            let _ = tx.send(());
        }
        true
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn on_off_twice() {
        // darf mehrfach hintereinander gerufen werden, ohne mehrere Prozesse zu starten
        super::set(true);
        super::set(true);
        assert!(super::set(false));
        assert!(super::set(false));
    }
}
