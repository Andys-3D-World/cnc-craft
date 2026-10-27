//! Gemeinsame Schnittstelle aller Maschinen-Steuerungen (GRBL, Marlin, Ruida, K40 …)
//!
//! lib.rs hält die Verbindungen als `Conn` und ruft alles über `MachineController` auf.
//! Neue Steuerung einbauen:
//!   1. eigenes Modul mit einem Typ, der `MachineController` umsetzt (Ereignisse über `Emit`
//!      wie machine.rs: machine-status, machine-line, machine-job-progress …)
//!   2. in lib.rs eine Variante in `Conn` + im `each!`-Makro ergänzen und einen `…_connect`-Befehl anlegen
//!   3. `Conn::stop_for_close` um den sicheren Halt vor dem Trennen erweitern (nie weglassen!)
//!
//! Zusatzgeräte, die keine eigene Maschine sind (z. B. Frequenzumrichter per Modbus, vfd.rs),
//! laufen getrennt davon und brauchen diese Schnittstelle nicht.

use crate::k40::K40;
use crate::machine::Machine;
use crate::marlin::Marlin;
use crate::ruida::Ruida;

pub trait MachineController {
    /// Verbindung steht noch
    fn is_alive(&self) -> bool;
    /// Verbindung beenden (ohne vorher anzuhalten – das macht lib.rs über stop_for_close)
    fn shutdown(&self);
    /// Eine Zeile (G-Code / Befehl) senden; gibt eine laufende Nummer zurück
    fn send_line(&self, line: &str) -> Result<u64, String>;
    /// Echtzeit-Byte (GRBL: ? ! ~ 0x18 …); andere Steuerungen übersetzen es selbst
    fn realtime(&self, byte: u8) -> Result<(), String>;
    fn start_job(&self, lines: Vec<String>) -> Result<usize, String>;
    fn pause_job(&self) -> Result<(), String>;
    fn resume_job(&self) -> Result<(), String>;
    fn stop_job(&self) -> Result<(), String>;
    /// Laufenden Job live ändern – nur wo Zeilen einzeln gesendet werden (GRBL)
    fn patch_job(&self, _from: usize, _delete: usize, _insert: Vec<String>, _expect_total: usize) -> Result<usize, String> {
        Err("unsupported".into())
    }
}

/// Die Steuerungen haben die Methoden schon selbst – hier nur weiterreichen
macro_rules! delegate {
    ($t:ty) => {
        fn is_alive(&self) -> bool { <$t>::is_alive(self) }
        fn shutdown(&self) { <$t>::shutdown(self) }
        fn send_line(&self, line: &str) -> Result<u64, String> { <$t>::send_line(self, line) }
        fn realtime(&self, byte: u8) -> Result<(), String> { <$t>::realtime(self, byte) }
        fn start_job(&self, lines: Vec<String>) -> Result<usize, String> { <$t>::start_job(self, lines) }
        fn pause_job(&self) -> Result<(), String> { <$t>::pause_job(self) }
        fn resume_job(&self) -> Result<(), String> { <$t>::resume_job(self) }
        fn stop_job(&self) -> Result<(), String> { <$t>::stop_job(self) }
    };
}

impl MachineController for Machine {
    delegate!(Machine);
    fn patch_job(&self, from: usize, delete: usize, insert: Vec<String>, expect_total: usize) -> Result<usize, String> {
        Machine::patch_job(self, from, delete, insert, expect_total)
    }
}
impl MachineController for Marlin { delegate!(Marlin); }
impl MachineController for Ruida { delegate!(Ruida); }
impl MachineController for K40 { delegate!(K40); }
