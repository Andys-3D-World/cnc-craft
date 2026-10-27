//! Frequenzumrichter (VFD) für die Frässpindel per Modbus (RTU über RS-485 oder TCP)
//!
//! Drehzahl setzen/lesen, Richtung (vorwärts/rückwärts/stopp) und Störung lesen.
//! Die Register stehen in Profilen (Daten, kein Code) – eigene Profile kann die Oberfläche
//! als JSON mitgeben.
//!
//! WICHTIG: Die Register der eingebauten Profile sind Annahmen aus verbreiteten Handbüchern.
//! Hersteller ändern sie je Baureihe/Firmware. Vor dem ersten Einschalten im Handbuch des eigenen
//! Umrichters prüfen – und dort die Parameter für „Steuerung über RS-485/Modbus“ setzen
//! (Befehlsquelle + Frequenzquelle = Kommunikation, Geräteadresse, Baudrate, Parität).

use crate::modbus::{Client, ModbusError, RtuTransport, TcpTransport};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;

/// Wie ein Drehzahl-/Frequenzwert im Register steht
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SpeedUnit {
    /// 0,01 Hz (4000 = 40,00 Hz)
    Hz100,
    /// 0,1 Hz (4000 = 400,0 Hz)
    Hz10,
    /// Umdrehungen pro Minute
    Rpm,
    /// 0,01 % der Höchstfrequenz (10000 = 100 %)
    Percent100,
}

/// Register lesen mit Funktion 03 (Halteregister) oder 04 (Eingangsregister)
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ReadFn {
    Holding,
    Input,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadReg {
    pub reg: u16,
    pub read: ReadFn,
}

/// Registerkarte eines Umrichters
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VfdProfile {
    pub id: String,
    pub name: String,
    /// Steuerwort-Register und die Werte für vorwärts / rückwärts / stopp
    pub control_reg: u16,
    pub cmd_fwd: u16,
    pub cmd_rev: u16,
    pub cmd_stop: u16,
    /// Sollfrequenz/-drehzahl schreiben
    pub speed_reg: u16,
    pub speed_unit: SpeedUnit,
    /// Ist-Frequenz/-drehzahl lesen (None = Umrichter meldet sie nicht)
    pub actual: Option<ReadReg>,
    pub actual_unit: SpeedUnit,
    /// Störungscode lesen (0 = keine Störung)
    pub fault: Option<ReadReg>,
}

/// Eingebaute Profile – Register bitte im Handbuch des eigenen Umrichters prüfen!
pub fn builtin_profiles() -> Vec<VfdProfile> {
    vec![
        // Delta-Protokoll (Delta VFD-E/VFD-M/MS300, AutomationDirect GS20/DURApulse u. a.):
        // 2000H Steuerwort (Bit 0-1: 01 Stopp, 10 Lauf; Bit 4-5: 01 vorwärts, 10 rückwärts),
        // 2001H Sollfrequenz 0,01 Hz, 2100H Störungscode, 2103H Ausgangsfrequenz 0,01 Hz
        VfdProfile {
            id: "delta".into(),
            name: "Delta-style (VFD-E/M, MS300, GS20 …)".into(),
            control_reg: 0x2000,
            cmd_fwd: 0x0012,
            cmd_rev: 0x0022,
            cmd_stop: 0x0001,
            speed_reg: 0x2001,
            speed_unit: SpeedUnit::Hz100,
            actual: Some(ReadReg { reg: 0x2103, read: ReadFn::Holding }),
            actual_unit: SpeedUnit::Hz100,
            fault: Some(ReadReg { reg: 0x2100, read: ReadFn::Holding }),
        },
        // Verbreitetes Protokoll neuerer China-Umrichter (Huanyang GT/HY-„neues Protokoll“, P2A,
        // Inovance MD-Reihe und Nachbauten): 1000H Sollwert in 0,01 % der Höchstfrequenz,
        // 1001H Ausgangsfrequenz 0,01 Hz, 2000H Steuerwort (1 vorwärts, 2 rückwärts, 6 Stopp mit Rampe),
        // 8000H Störungscode. Die alten Huanyang HY (eigenes, nicht normgerechtes Protokoll) passen NICHT.
        VfdProfile {
            id: "hy-gt".into(),
            name: "Huanyang GT / P2A, Inovance-style".into(),
            control_reg: 0x2000,
            cmd_fwd: 1,
            cmd_rev: 2,
            cmd_stop: 6,
            speed_reg: 0x1000,
            speed_unit: SpeedUnit::Percent100,
            actual: Some(ReadReg { reg: 0x1001, read: ReadFn::Holding }),
            actual_unit: SpeedUnit::Hz100,
            fault: Some(ReadReg { reg: 0x8000, read: ReadFn::Holding }),
        },
    ]
}

/// Spindel-Daten: Höchstdrehzahl bei Höchstfrequenz (z. B. 24000 U/min bei 400 Hz)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpindleRange {
    pub max_rpm: f64,
    pub max_hz: f64,
}

/// Drehzahl -> Registerwert (auf 0 … Höchstdrehzahl begrenzt)
pub fn rpm_to_raw(unit: SpeedUnit, rpm: f64, r: SpindleRange) -> u16 {
    let rpm = if rpm.is_finite() { rpm.clamp(0.0, r.max_rpm) } else { 0.0 };
    let hz = rpm / r.max_rpm * r.max_hz;
    let v = match unit {
        SpeedUnit::Hz100 => hz * 100.0,
        SpeedUnit::Hz10 => hz * 10.0,
        SpeedUnit::Rpm => rpm,
        SpeedUnit::Percent100 => rpm / r.max_rpm * 10000.0,
    };
    v.round().clamp(0.0, u16::MAX as f64) as u16
}

/// Registerwert -> Frequenz in Hz
pub fn raw_to_hz(unit: SpeedUnit, raw: u16, r: SpindleRange) -> f64 {
    let raw = raw as f64;
    match unit {
        SpeedUnit::Hz100 => raw / 100.0,
        SpeedUnit::Hz10 => raw / 10.0,
        SpeedUnit::Rpm => raw / r.max_rpm * r.max_hz,
        SpeedUnit::Percent100 => raw / 10000.0 * r.max_hz,
    }
}

pub fn raw_to_rpm(unit: SpeedUnit, raw: u16, r: SpindleRange) -> f64 {
    match unit {
        SpeedUnit::Rpm => raw as f64,
        _ => raw_to_hz(unit, raw, r) / r.max_hz * r.max_rpm,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Direction {
    Forward,
    Reverse,
    Stop,
}

impl Direction {
    pub fn parse(s: &str) -> Option<Direction> {
        match s { "fwd" => Some(Direction::Forward), "rev" => Some(Direction::Reverse), "stop" => Some(Direction::Stop), _ => None }
    }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VfdStatus {
    pub rpm: Option<f64>,
    pub hz: Option<f64>,
    /// Störungscode (0 = alles gut). Bedeutung steht im Handbuch des Umrichters
    pub fault: Option<u16>,
}

pub struct Vfd {
    client: Client,
    profile: VfdProfile,
    range: SpindleRange,
}

impl Vfd {
    pub fn new(client: Client, profile: VfdProfile, range: SpindleRange) -> Self { Vfd { client, profile, range } }

    pub async fn set_rpm(&mut self, rpm: f64) -> Result<(), ModbusError> {
        let raw = rpm_to_raw(self.profile.speed_unit, rpm, self.range);
        self.client.write_single(self.profile.speed_reg, raw).await
    }

    pub async fn set_direction(&mut self, d: Direction) -> Result<(), ModbusError> {
        let p = &self.profile;
        let v = match d { Direction::Forward => p.cmd_fwd, Direction::Reverse => p.cmd_rev, Direction::Stop => p.cmd_stop };
        self.client.write_single(p.control_reg, v).await
    }

    async fn read(&mut self, r: ReadReg) -> Result<u16, ModbusError> {
        let v = match r.read {
            ReadFn::Holding => self.client.read_holding(r.reg, 1).await?,
            ReadFn::Input => self.client.read_input(r.reg, 1).await?,
        };
        v.first().copied().ok_or_else(|| ModbusError::Frame("empty".into()))
    }

    pub async fn status(&mut self) -> Result<VfdStatus, ModbusError> {
        let mut st = VfdStatus { rpm: None, hz: None, fault: None };
        if let Some(r) = self.profile.actual {
            let raw = self.read(r).await?;
            st.hz = Some(raw_to_hz(self.profile.actual_unit, raw, self.range));
            st.rpm = Some(raw_to_rpm(self.profile.actual_unit, raw, self.range));
        }
        if let Some(r) = self.profile.fault {
            st.fault = Some(self.read(r).await?);
        }
        Ok(st)
    }
}

// ---------------------------------------------------------------------
// Tauri-Befehle – ein Umrichter, unabhängig von der Maschinen-Verbindung
// ---------------------------------------------------------------------

fn state() -> &'static Mutex<Option<Vfd>> {
    static VFD: OnceLock<Mutex<Option<Vfd>>> = OnceLock::new();
    VFD.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub async fn vfd_profiles() -> Vec<VfdProfile> { builtin_profiles() }

/// target = "tcp://host[:port]" (Modbus TCP, Standard-Port 502) oder serieller Port (RTU).
/// profile = Kennung eines eingebauten Profils; custom = eigenes Profil (hat Vorrang)
#[tauri::command]
pub async fn vfd_connect(
    target: String, baud: u32, parity: String, unit: u8, profile: String, custom: Option<VfdProfile>,
    max_rpm: f64, max_hz: f64,
) -> Result<VfdStatus, String> {
    if !(1..=247).contains(&unit) { return Err("vfd-unit".into()); }
    if !(max_rpm > 0.0 && max_hz > 0.0 && max_rpm.is_finite() && max_hz.is_finite()) { return Err("vfd-range".into()); }
    let profile = match custom {
        Some(p) => p,
        None => builtin_profiles().into_iter().find(|p| p.id == profile).ok_or("vfd-profile")?,
    };
    // alte Verbindung: Spindel vorher anhalten
    vfd_disconnect().await?;
    let t = target.trim();
    let client = if let Some(hp) = t.strip_prefix("tcp://") {
        let hp = if hp.contains(':') { hp.to_string() } else { format!("{}:502", hp) };
        Client::new(Box::new(TcpTransport::new(&hp)), unit)
    } else {
        let (name, p) = (t.to_string(), parity.clone());
        let baud = if baud > 0 { baud } else { 9600 };
        let rtu = tauri::async_runtime::spawn_blocking(move || RtuTransport::open(&name, baud, &p))
            .await
            .map_err(|e| e.to_string())??;
        Client::new(Box::new(rtu), unit)
    };
    let mut vfd = Vfd::new(client, profile, SpindleRange { max_rpm, max_hz });
    // einmal lesen: antwortet der Umrichter überhaupt?
    let st = vfd.status().await.map_err(|e| e.to_string())?;
    *state().lock().await = Some(vfd);
    Ok(st)
}

/// Trennen – vorher Stopp senden (Fehler dabei ignorieren, die Leitung kann schon weg sein)
#[tauri::command]
pub async fn vfd_disconnect() -> Result<(), String> {
    let mut g = state().lock().await;
    if let Some(v) = g.as_mut() { let _ = v.set_direction(Direction::Stop).await; }
    *g = None;
    Ok(())
}

#[tauri::command]
pub async fn vfd_set_speed(rpm: f64) -> Result<(), String> {
    let mut g = state().lock().await;
    let v = g.as_mut().ok_or("not connected")?;
    v.set_rpm(rpm).await.map_err(|e| e.to_string())
}

/// direction = "fwd", "rev" oder "stop"
#[tauri::command]
pub async fn vfd_set_direction(direction: String) -> Result<(), String> {
    let d = Direction::parse(&direction).ok_or("vfd-direction")?;
    let mut g = state().lock().await;
    let v = g.as_mut().ok_or("not connected")?;
    v.set_direction(d).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vfd_status() -> Result<VfdStatus, String> {
    let mut g = state().lock().await;
    let v = g.as_mut().ok_or("not connected")?;
    v.status().await.map_err(|e| e.to_string())
}

/// Programm wird geschlossen: Spindel anhalten (höchstens ~2 s warten)
pub fn stop_blocking() {
    tauri::async_runtime::block_on(async {
        let _ = tokio::time::timeout(Duration::from_secs(2), vfd_disconnect()).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modbus::fake::{Device, FakeTransport};
    use std::sync::{Arc, Mutex as StdMutex};

    const SPINDLE: SpindleRange = SpindleRange { max_rpm: 24000.0, max_hz: 400.0 };

    fn block<F: std::future::Future>(f: F) -> F::Output { tauri::async_runtime::block_on(f) }

    fn profile(id: &str) -> VfdProfile { builtin_profiles().into_iter().find(|p| p.id == id).unwrap() }

    #[test]
    fn rpm_conversion() {
        assert_eq!(rpm_to_raw(SpeedUnit::Hz100, 12000.0, SPINDLE), 20000); // 200,00 Hz
        assert_eq!(rpm_to_raw(SpeedUnit::Hz10, 12000.0, SPINDLE), 2000);
        assert_eq!(rpm_to_raw(SpeedUnit::Rpm, 12000.0, SPINDLE), 12000);
        assert_eq!(rpm_to_raw(SpeedUnit::Percent100, 6000.0, SPINDLE), 2500); // 25 %
        // begrenzt auf 0 … Höchstdrehzahl
        assert_eq!(rpm_to_raw(SpeedUnit::Hz100, 99999.0, SPINDLE), 40000);
        assert_eq!(rpm_to_raw(SpeedUnit::Hz100, -5.0, SPINDLE), 0);
        assert_eq!(rpm_to_raw(SpeedUnit::Hz100, f64::NAN, SPINDLE), 0);
        for u in [SpeedUnit::Hz100, SpeedUnit::Hz10, SpeedUnit::Rpm, SpeedUnit::Percent100] {
            let raw = rpm_to_raw(u, 18000.0, SPINDLE);
            assert!((raw_to_rpm(u, raw, SPINDLE) - 18000.0).abs() < 1.0, "{:?}", u);
            assert!((raw_to_hz(u, raw, SPINDLE) - 300.0).abs() < 0.1, "{:?}", u);
        }
    }

    #[test]
    fn profiles_have_unique_ids_and_roundtrip_json() {
        let ps = builtin_profiles();
        let mut ids: Vec<&str> = ps.iter().map(|p| p.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), ps.len());
        let json = serde_json::to_string(&ps).unwrap();
        assert!(json.contains("\"speedUnit\":\"hz100\""));
        let back: Vec<VfdProfile> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ps);
        for p in &ps { assert!(p.cmd_fwd != p.cmd_stop && p.cmd_rev != p.cmd_stop && p.cmd_fwd != p.cmd_rev); }
    }

    #[test]
    fn delta_register_mapping() {
        let dev = Arc::new(StdMutex::new(Device::default()));
        {
            let mut d = dev.lock().unwrap();
            d.regs.insert(0x2103, 30000); // 300,00 Hz
            d.regs.insert(0x2100, 0);
        }
        let mut v = Vfd::new(Client::new(Box::new(FakeTransport(dev.clone())), 1), profile("delta"), SPINDLE);
        block(v.set_rpm(12000.0)).unwrap();
        block(v.set_direction(Direction::Forward)).unwrap();
        block(v.set_direction(Direction::Reverse)).unwrap();
        block(v.set_direction(Direction::Stop)).unwrap();
        assert_eq!(dev.lock().unwrap().writes, vec![(0x2001, 20000), (0x2000, 0x12), (0x2000, 0x22), (0x2000, 0x01)]);
        let st = block(v.status()).unwrap();
        assert_eq!(st.hz, Some(300.0));
        assert_eq!(st.rpm, Some(18000.0));
        assert_eq!(st.fault, Some(0));
    }

    #[test]
    fn hy_gt_register_mapping() {
        let dev = Arc::new(StdMutex::new(Device::default()));
        {
            let mut d = dev.lock().unwrap();
            d.regs.insert(0x1001, 10000); // 100,00 Hz
            d.regs.insert(0x8000, 14); // Störung
        }
        let mut v = Vfd::new(Client::new(Box::new(FakeTransport(dev.clone())), 1), profile("hy-gt"), SPINDLE);
        block(v.set_rpm(24000.0)).unwrap();
        block(v.set_direction(Direction::Forward)).unwrap();
        block(v.set_direction(Direction::Stop)).unwrap();
        assert_eq!(dev.lock().unwrap().writes, vec![(0x1000, 10000), (0x2000, 1), (0x2000, 6)]);
        let st = block(v.status()).unwrap();
        assert_eq!(st.rpm, Some(6000.0));
        assert_eq!(st.fault, Some(14));
    }

    #[test]
    fn custom_profile_with_input_registers() {
        let json = r#"{"id":"my","name":"Mine","controlReg":1,"cmdFwd":1,"cmdRev":2,"cmdStop":0,
            "speedReg":2,"speedUnit":"rpm","actual":{"reg":3,"read":"input"},"actualUnit":"rpm","fault":null}"#;
        let p: VfdProfile = serde_json::from_str(json).unwrap();
        let dev = Arc::new(StdMutex::new(Device::default()));
        dev.lock().unwrap().regs.insert(3, 11950);
        let mut v = Vfd::new(Client::new(Box::new(FakeTransport(dev.clone())), 1), p, SPINDLE);
        block(v.set_rpm(12000.0)).unwrap();
        assert_eq!(dev.lock().unwrap().writes, vec![(2, 12000)]);
        let st = block(v.status()).unwrap();
        assert_eq!(st.rpm, Some(11950.0));
        assert_eq!(st.fault, None);
    }

    #[test]
    fn direction_parse() {
        assert_eq!(Direction::parse("fwd"), Some(Direction::Forward));
        assert_eq!(Direction::parse("rev"), Some(Direction::Reverse));
        assert_eq!(Direction::parse("stop"), Some(Direction::Stop));
        assert_eq!(Direction::parse("FWD"), None);
    }
}
