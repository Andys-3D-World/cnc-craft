//! Modbus TCP und Modbus RTU (seriell, RS-485) – async, mit Zeitlimit und Wiederholen
//!
//! Eigene kleine Umsetzung statt tokio-modbus: Wir brauchen nur vier Funktionen (03, 04, 06, 16),
//! tokio-modbus würde tokio-serial, tokio-util, bytes, futures … mitbringen. So kommt nur der
//! tokio mit dazu, den Tauri ohnehin schon enthält.
//!
//! Aufbau:
//!   Request/Response   – PDU (Funktionscode + Daten) bauen und prüfen
//!   rtu_* / tcp_*      – Rahmen drumherum: RTU = Adresse + PDU + CRC16, TCP = MBAP-Kopf + PDU
//!   Transport          – schickt eine PDU und liefert die Antwort-PDU (TCP, RTU, im Test: Attrappe)
//!   Client             – Zeitlimit + Wiederholen bei Zeitüberschreitung/CRC-Fehler, nicht bei Ausnahmen

use std::future::Future;
use std::io::{Read, Write};
use std::pin::Pin;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, Clone, PartialEq)]
pub enum ModbusError {
    /// Keine (vollständige) Antwort im Zeitlimit
    Timeout,
    Io(String),
    /// RTU: Prüfsumme falsch (Störung auf der Leitung)
    Crc,
    /// Antwort passt nicht zur Anfrage (falsche Länge, Adresse, Funktion …)
    Frame(String),
    /// Gerät lehnt ab (01 = Funktion unbekannt, 02 = Register unbekannt, 03 = Wert ungültig …)
    Exception(u8),
}

impl std::fmt::Display for ModbusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModbusError::Timeout => write!(f, "modbus-timeout"),
            ModbusError::Io(e) => write!(f, "modbus-io: {}", e),
            ModbusError::Crc => write!(f, "modbus-crc"),
            ModbusError::Frame(e) => write!(f, "modbus-frame: {}", e),
            ModbusError::Exception(c) => write!(f, "modbus-exception: {}", c),
        }
    }
}

impl From<std::io::Error> for ModbusError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => ModbusError::Timeout,
            _ => ModbusError::Io(e.to_string()),
        }
    }
}

/// Modbus-CRC16 (Polynom 0xA001, Start 0xFFFF). Im Rahmen: erst das niedrige Byte
pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= b as u16;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xA001 } else { crc >> 1 };
        }
    }
    crc
}

// ---------------------------------------------------------------------
// PDU: Funktionscode + Daten
// ---------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    /// 03 – Halteregister lesen
    ReadHolding { addr: u16, count: u16 },
    /// 04 – Eingangsregister lesen
    ReadInput { addr: u16, count: u16 },
    /// 06 – ein Register schreiben
    WriteSingle { addr: u16, value: u16 },
    /// 16 (0x10) – mehrere Register schreiben
    WriteMultiple { addr: u16, values: Vec<u16> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Response {
    Registers(Vec<u16>),
    Written,
}

impl Request {
    pub fn function(&self) -> u8 {
        match self {
            Request::ReadHolding { .. } => 0x03,
            Request::ReadInput { .. } => 0x04,
            Request::WriteSingle { .. } => 0x06,
            Request::WriteMultiple { .. } => 0x10,
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, ModbusError> {
        let mut p = vec![self.function()];
        match self {
            Request::ReadHolding { addr, count } | Request::ReadInput { addr, count } => {
                if *count == 0 || *count > 125 { return Err(ModbusError::Frame("count".into())); }
                p.extend_from_slice(&addr.to_be_bytes());
                p.extend_from_slice(&count.to_be_bytes());
            }
            Request::WriteSingle { addr, value } => {
                p.extend_from_slice(&addr.to_be_bytes());
                p.extend_from_slice(&value.to_be_bytes());
            }
            Request::WriteMultiple { addr, values } => {
                if values.is_empty() || values.len() > 123 { return Err(ModbusError::Frame("count".into())); }
                p.extend_from_slice(&addr.to_be_bytes());
                p.extend_from_slice(&(values.len() as u16).to_be_bytes());
                p.push((values.len() * 2) as u8);
                for v in values { p.extend_from_slice(&v.to_be_bytes()); }
            }
        }
        Ok(p)
    }

    /// Antwort-PDU prüfen und auswerten
    pub fn decode(&self, pdu: &[u8]) -> Result<Response, ModbusError> {
        let fc = *pdu.first().ok_or_else(|| ModbusError::Frame("empty".into()))?;
        if fc == self.function() | 0x80 {
            return Err(ModbusError::Exception(pdu.get(1).copied().unwrap_or(0)));
        }
        if fc != self.function() { return Err(ModbusError::Frame(format!("function {:02X}", fc))); }
        let be = |i: usize| u16::from_be_bytes([pdu[i], pdu[i + 1]]);
        match self {
            Request::ReadHolding { count, .. } | Request::ReadInput { count, .. } => {
                let n = *pdu.get(1).ok_or_else(|| ModbusError::Frame("short".into()))? as usize;
                if n != *count as usize * 2 || pdu.len() != 2 + n { return Err(ModbusError::Frame("length".into())); }
                Ok(Response::Registers((0..*count as usize).map(|i| be(2 + i * 2)).collect()))
            }
            Request::WriteSingle { addr, value } => {
                // Gerät wiederholt Adresse und Wert
                if pdu.len() != 5 || be(1) != *addr || be(3) != *value { return Err(ModbusError::Frame("echo".into())); }
                Ok(Response::Written)
            }
            Request::WriteMultiple { addr, values } => {
                if pdu.len() != 5 || be(1) != *addr || be(3) as usize != values.len() { return Err(ModbusError::Frame("echo".into())); }
                Ok(Response::Written)
            }
        }
    }
}

// ---------------------------------------------------------------------
// RTU-Rahmen: Geräteadresse + PDU + CRC16 (niedriges Byte zuerst)
// ---------------------------------------------------------------------

pub fn rtu_frame(unit: u8, pdu: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(pdu.len() + 3);
    f.push(unit);
    f.extend_from_slice(pdu);
    f.extend_from_slice(&crc16(&f).to_le_bytes());
    f
}

/// Wie lang wird die Antwort? None = noch zu wenig Bytes, um es zu wissen.
/// RTU hat kein Längenfeld – die Länge ergibt sich aus Funktionscode bzw. Byte-Zähler
pub fn rtu_expected_len(buf: &[u8]) -> Result<Option<usize>, ModbusError> {
    if buf.len() < 2 { return Ok(None); }
    let fc = buf[1];
    if fc & 0x80 != 0 { return Ok(Some(5)); } // Adresse, Funktion|0x80, Ausnahme-Code, CRC
    match fc {
        0x03 | 0x04 => Ok(buf.get(2).map(|n| 5 + *n as usize)),
        0x06 | 0x10 => Ok(Some(8)),
        _ => Err(ModbusError::Frame(format!("function {:02X}", fc))),
    }
}

/// RTU-Antwort prüfen (CRC, Adresse) und die PDU herausholen
pub fn rtu_parse(unit: u8, frame: &[u8]) -> Result<Vec<u8>, ModbusError> {
    if frame.len() < 4 { return Err(ModbusError::Frame("short".into())); }
    let (body, crc) = frame.split_at(frame.len() - 2);
    if crc16(body).to_le_bytes() != [crc[0], crc[1]] { return Err(ModbusError::Crc); }
    if body[0] != unit { return Err(ModbusError::Frame(format!("unit {}", body[0]))); }
    Ok(body[1..].to_vec())
}

// ---------------------------------------------------------------------
// TCP-Rahmen (MBAP): Transaktion, Protokoll 0, Länge, Geräteadresse + PDU
// ---------------------------------------------------------------------

pub fn tcp_frame(tid: u16, unit: u8, pdu: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(pdu.len() + 7);
    f.extend_from_slice(&tid.to_be_bytes());
    f.extend_from_slice(&[0, 0]);
    f.extend_from_slice(&((pdu.len() + 1) as u16).to_be_bytes());
    f.push(unit);
    f.extend_from_slice(pdu);
    f
}

pub fn tcp_parse(tid: u16, unit: u8, adu: &[u8]) -> Result<Vec<u8>, ModbusError> {
    if adu.len() < 8 { return Err(ModbusError::Frame("short".into())); }
    let be = |i: usize| u16::from_be_bytes([adu[i], adu[i + 1]]);
    if be(0) != tid { return Err(ModbusError::Frame("transaction".into())); }
    if be(2) != 0 { return Err(ModbusError::Frame("protocol".into())); }
    if be(4) as usize != adu.len() - 6 { return Err(ModbusError::Frame("length".into())); }
    if adu[6] != unit { return Err(ModbusError::Frame(format!("unit {}", adu[6]))); }
    Ok(adu[7..].to_vec())
}

// ---------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait Transport: Send {
    /// Anfrage-PDU an das Gerät `unit` schicken, Antwort-PDU zurück (ohne Rahmen)
    fn exchange<'a>(&'a mut self, unit: u8, pdu: &'a [u8], timeout: Duration) -> BoxFut<'a, Result<Vec<u8>, ModbusError>>;
}

/// Modbus TCP (Port meist 502). Verbindet beim ersten Aufruf und nach jedem Fehler neu
pub struct TcpTransport {
    addr: String,
    stream: Option<TcpStream>,
    tid: u16,
}

impl TcpTransport {
    pub fn new(addr: &str) -> Self { TcpTransport { addr: addr.to_string(), stream: None, tid: 0 } }

    async fn exchange_inner(&mut self, unit: u8, pdu: &[u8]) -> Result<Vec<u8>, ModbusError> {
        if self.stream.is_none() {
            let s = TcpStream::connect(&self.addr).await?;
            let _ = s.set_nodelay(true);
            self.stream = Some(s);
        }
        self.tid = self.tid.wrapping_add(1);
        let tid = self.tid;
        let s = self.stream.as_mut().ok_or(ModbusError::Timeout)?;
        s.write_all(&tcp_frame(tid, unit, pdu)).await?;
        let mut adu = vec![0u8; 7];
        s.read_exact(&mut adu).await?;
        let len = u16::from_be_bytes([adu[4], adu[5]]) as usize;
        if !(2..=254).contains(&len) { return Err(ModbusError::Frame("length".into())); }
        adu.resize(6 + len, 0);
        s.read_exact(&mut adu[7..]).await?;
        tcp_parse(tid, unit, &adu)
    }
}

impl Transport for TcpTransport {
    fn exchange<'a>(&'a mut self, unit: u8, pdu: &'a [u8], timeout: Duration) -> BoxFut<'a, Result<Vec<u8>, ModbusError>> {
        Box::pin(async move {
            let r = match tokio::time::timeout(timeout, self.exchange_inner(unit, pdu)).await {
                Ok(r) => r,
                Err(_) => Err(ModbusError::Timeout),
            };
            // nach einem Fehler kann noch eine alte Antwort unterwegs sein: neu verbinden
            if r.is_err() { self.stream = None; }
            r
        })
    }
}

/// Serielle Leitung für RTU (echter Port oder Attrappe im Test). Lesen darf mit TimedOut zurückkommen
pub trait SerialLink: Read + Write + Send + 'static {
    /// Alte Bytes im Empfangspuffer wegwerfen (Reste einer gestörten Antwort)
    fn clear_input(&mut self) {}
}

impl SerialLink for Box<dyn serialport::SerialPort> {
    fn clear_input(&mut self) { let _ = self.clear(serialport::ClearBuffer::Input); }
}

/// Modbus RTU. Der serielle Port arbeitet blockierend – jede Anfrage läuft deshalb in spawn_blocking
pub struct RtuTransport {
    port: Option<Box<dyn SerialLink>>,
    /// Pause zwischen zwei Rahmen (3,5 Zeichen, mindestens 1,75 ms)
    gap: Duration,
}

impl RtuTransport {
    pub fn new(port: Box<dyn SerialLink>, baud: u32) -> Self {
        let us = (38_500_000u64 / baud.max(1) as u64).max(1750); // 3,5 Zeichen à 11 Bit
        RtuTransport { port: Some(port), gap: Duration::from_micros(us) }
    }

    /// Echten seriellen Port öffnen (8 Datenbits, 1 Stoppbit). parity: "N", "E" oder "O"
    pub fn open(name: &str, baud: u32, parity: &str) -> Result<Self, String> {
        let parity = match parity { "E" => serialport::Parity::Even, "O" => serialport::Parity::Odd, _ => serialport::Parity::None };
        let port = serialport::new(name, baud)
            .parity(parity)
            .timeout(Duration::from_millis(20))
            .open()
            .map_err(|e| e.to_string())?;
        Ok(RtuTransport::new(Box::new(port), baud))
    }
}

/// Eine RTU-Anfrage blockierend: senden, Antwort bis zur erwarteten Länge lesen, prüfen
fn rtu_blocking(port: &mut dyn SerialLink, unit: u8, pdu: &[u8], timeout: Duration, gap: Duration) -> Result<Vec<u8>, ModbusError> {
    port.clear_input();
    std::thread::sleep(gap);
    port.write_all(&rtu_frame(unit, pdu))?;
    port.flush()?;
    let deadline = Instant::now() + timeout;
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 64];
    loop {
        if let Some(n) = rtu_expected_len(&buf)? {
            if n > 256 { return Err(ModbusError::Frame("length".into())); }
            if buf.len() >= n { return rtu_parse(unit, &buf[..n]); }
        }
        if Instant::now() >= deadline { return Err(ModbusError::Timeout); }
        match port.read(&mut tmp) {
            Ok(0) => std::thread::sleep(Duration::from_millis(1)),
            Ok(k) => buf.extend_from_slice(&tmp[..k]),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {}
            Err(e) => return Err(e.into()),
        }
    }
}

impl Transport for RtuTransport {
    fn exchange<'a>(&'a mut self, unit: u8, pdu: &'a [u8], timeout: Duration) -> BoxFut<'a, Result<Vec<u8>, ModbusError>> {
        Box::pin(async move {
            let mut port = self.port.take().ok_or_else(|| ModbusError::Io("port busy".into()))?;
            let pdu = pdu.to_vec();
            let gap = self.gap;
            let (port, r) = tokio::task::spawn_blocking(move || {
                let r = rtu_blocking(&mut *port, unit, &pdu, timeout, gap);
                (port, r)
            })
            .await
            .map_err(|e| ModbusError::Io(e.to_string()))?;
            self.port = Some(port);
            r
        })
    }
}

// ---------------------------------------------------------------------
// Client: Zeitlimit + Wiederholen
// ---------------------------------------------------------------------

pub struct Client {
    transport: Box<dyn Transport>,
    pub unit: u8,
    pub timeout: Duration,
    /// Zusätzliche Versuche nach Zeitüberschreitung / Störung (Ausnahmen des Geräts nicht)
    pub retries: u32,
}

impl Client {
    pub fn new(transport: Box<dyn Transport>, unit: u8) -> Self {
        Client { transport, unit, timeout: Duration::from_millis(500), retries: 2 }
    }

    pub async fn call(&mut self, req: &Request) -> Result<Response, ModbusError> {
        let pdu = req.encode()?;
        let mut last = ModbusError::Timeout;
        for _ in 0..=self.retries {
            match self.transport.exchange(self.unit, &pdu, self.timeout).await.and_then(|r| req.decode(&r)) {
                Ok(r) => return Ok(r),
                // Gerät hat geantwortet und abgelehnt: Wiederholen bringt nichts
                Err(e @ ModbusError::Exception(_)) => return Err(e),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    pub async fn read_holding(&mut self, addr: u16, count: u16) -> Result<Vec<u16>, ModbusError> {
        match self.call(&Request::ReadHolding { addr, count }).await? {
            Response::Registers(v) => Ok(v),
            Response::Written => Err(ModbusError::Frame("unexpected".into())),
        }
    }

    pub async fn read_input(&mut self, addr: u16, count: u16) -> Result<Vec<u16>, ModbusError> {
        match self.call(&Request::ReadInput { addr, count }).await? {
            Response::Registers(v) => Ok(v),
            Response::Written => Err(ModbusError::Frame("unexpected".into())),
        }
    }

    pub async fn write_single(&mut self, addr: u16, value: u16) -> Result<(), ModbusError> {
        self.call(&Request::WriteSingle { addr, value }).await.map(|_| ())
    }

    #[allow(dead_code)]
    pub async fn write_multiple(&mut self, addr: u16, values: Vec<u16>) -> Result<(), ModbusError> {
        self.call(&Request::WriteMultiple { addr, values }).await.map(|_| ())
    }
}

// ---------------------------------------------------------------------
// Test-Gerät: beantwortet PDUs aus einer Registerliste (auch für vfd.rs-Tests)
// ---------------------------------------------------------------------

#[cfg(test)]
pub mod fake {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    pub struct Device {
        pub regs: HashMap<u16, u16>,
        /// So viele Anfragen gehen zuerst „verloren“ (Zeitüberschreitung)
        pub drop_next: u32,
        pub writes: Vec<(u16, u16)>,
    }

    impl Device {
        /// Anfrage-PDU beantworten wie ein echtes Gerät (unbekanntes Register = Ausnahme 02)
        pub fn answer(&mut self, pdu: &[u8]) -> Vec<u8> {
            let be = |i: usize| u16::from_be_bytes([pdu[i], pdu[i + 1]]);
            let fc = pdu[0];
            match fc {
                0x03 | 0x04 => {
                    let (addr, n) = (be(1), be(3));
                    let mut out = vec![fc, (n * 2) as u8];
                    for a in addr..addr + n {
                        match self.regs.get(&a) { Some(v) => out.extend_from_slice(&v.to_be_bytes()), None => return vec![fc | 0x80, 2] }
                    }
                    out
                }
                0x06 => {
                    self.regs.insert(be(1), be(3));
                    self.writes.push((be(1), be(3)));
                    pdu.to_vec()
                }
                0x10 => {
                    let (addr, n) = (be(1), be(3));
                    for i in 0..n { let v = be(6 + i as usize * 2); self.regs.insert(addr + i, v); self.writes.push((addr + i, v)); }
                    pdu[..5].to_vec()
                }
                _ => vec![fc | 0x80, 1],
            }
        }
    }

    /// Transport direkt auf das Test-Gerät (ohne Rahmen)
    pub struct FakeTransport(pub Arc<Mutex<Device>>);

    impl Transport for FakeTransport {
        fn exchange<'a>(&'a mut self, _unit: u8, pdu: &'a [u8], _timeout: Duration) -> BoxFut<'a, Result<Vec<u8>, ModbusError>> {
            Box::pin(async move {
                let mut d = self.0.lock().unwrap();
                if d.drop_next > 0 { d.drop_next -= 1; return Err(ModbusError::Timeout); }
                Ok(d.answer(pdu))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{Device, FakeTransport};
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    fn block<F: Future>(f: F) -> F::Output { tauri::async_runtime::block_on(f) }

    #[test]
    fn crc16_known_values() {
        // Standard-Prüfwert für CRC-16/MODBUS
        assert_eq!(crc16(b"123456789"), 0x4B37);
        // 01 03 00 00 00 01 -> CRC 84 0A (niedriges Byte zuerst)
        assert_eq!(crc16(&[0x01, 0x03, 0x00, 0x00, 0x00, 0x01]).to_le_bytes(), [0x84, 0x0A]);
        assert_eq!(crc16(&[]), 0xFFFF);
    }

    #[test]
    fn encode_requests() {
        assert_eq!(Request::ReadHolding { addr: 0x2103, count: 2 }.encode().unwrap(), vec![0x03, 0x21, 0x03, 0x00, 0x02]);
        assert_eq!(Request::ReadInput { addr: 1, count: 1 }.encode().unwrap(), vec![0x04, 0x00, 0x01, 0x00, 0x01]);
        assert_eq!(Request::WriteSingle { addr: 0x2000, value: 0x12 }.encode().unwrap(), vec![0x06, 0x20, 0x00, 0x00, 0x12]);
        assert_eq!(
            Request::WriteMultiple { addr: 0x10, values: vec![1, 0xABCD] }.encode().unwrap(),
            vec![0x10, 0x00, 0x10, 0x00, 0x02, 0x04, 0x00, 0x01, 0xAB, 0xCD]
        );
        assert!(Request::ReadHolding { addr: 0, count: 0 }.encode().is_err());
        assert!(Request::ReadHolding { addr: 0, count: 126 }.encode().is_err());
        assert!(Request::WriteMultiple { addr: 0, values: vec![] }.encode().is_err());
    }

    #[test]
    fn decode_responses() {
        let r = Request::ReadHolding { addr: 0, count: 2 };
        assert_eq!(r.decode(&[0x03, 0x04, 0x01, 0x02, 0xFF, 0xFE]).unwrap(), Response::Registers(vec![0x0102, 0xFFFE]));
        assert_eq!(r.decode(&[0x83, 0x02]).unwrap_err(), ModbusError::Exception(2));
        assert!(matches!(r.decode(&[0x03, 0x02, 0x00, 0x01]), Err(ModbusError::Frame(_)))); // zu wenige Register
        assert!(matches!(r.decode(&[0x04, 0x04, 0, 0, 0, 0]), Err(ModbusError::Frame(_)))); // falsche Funktion
        let w = Request::WriteSingle { addr: 0x2000, value: 1 };
        assert_eq!(w.decode(&[0x06, 0x20, 0x00, 0x00, 0x01]).unwrap(), Response::Written);
        assert!(w.decode(&[0x06, 0x20, 0x00, 0x00, 0x02]).is_err()); // Echo stimmt nicht
        let m = Request::WriteMultiple { addr: 5, values: vec![1, 2, 3] };
        assert_eq!(m.decode(&[0x10, 0x00, 0x05, 0x00, 0x03]).unwrap(), Response::Written);
    }

    #[test]
    fn rtu_frame_roundtrip() {
        let f = rtu_frame(1, &[0x03, 0x00, 0x00, 0x00, 0x01]);
        assert_eq!(f, vec![0x01, 0x03, 0x00, 0x00, 0x00, 0x01, 0x84, 0x0A]);
        assert_eq!(rtu_parse(1, &f).unwrap(), vec![0x03, 0x00, 0x00, 0x00, 0x01]);
        let mut bad = f.clone();
        bad[3] ^= 0x01;
        assert_eq!(rtu_parse(1, &bad).unwrap_err(), ModbusError::Crc);
        assert!(matches!(rtu_parse(2, &f), Err(ModbusError::Frame(_)))); // anderes Gerät
    }

    #[test]
    fn rtu_expected_lengths() {
        assert_eq!(rtu_expected_len(&[1]).unwrap(), None);
        assert_eq!(rtu_expected_len(&[1, 0x03]).unwrap(), None);
        assert_eq!(rtu_expected_len(&[1, 0x03, 4]).unwrap(), Some(9));
        assert_eq!(rtu_expected_len(&[1, 0x06]).unwrap(), Some(8));
        assert_eq!(rtu_expected_len(&[1, 0x10]).unwrap(), Some(8));
        assert_eq!(rtu_expected_len(&[1, 0x83]).unwrap(), Some(5));
        assert!(rtu_expected_len(&[1, 0x2B]).is_err());
    }

    #[test]
    fn tcp_frame_roundtrip() {
        let f = tcp_frame(0x1234, 7, &[0x03, 0x00, 0x01, 0x00, 0x01]);
        assert_eq!(f, vec![0x12, 0x34, 0, 0, 0, 6, 7, 0x03, 0x00, 0x01, 0x00, 0x01]);
        assert_eq!(tcp_parse(0x1234, 7, &f).unwrap(), vec![0x03, 0x00, 0x01, 0x00, 0x01]);
        assert!(tcp_parse(0x1235, 7, &f).is_err()); // alte Antwort
        assert!(tcp_parse(0x1234, 8, &f).is_err());
        let mut bad = f.clone();
        bad[5] = 9;
        assert!(tcp_parse(0x1234, 7, &bad).is_err());
    }

    #[test]
    fn client_retries_after_timeout() {
        let dev = Arc::new(Mutex::new(Device::default()));
        dev.lock().unwrap().regs.insert(0x2103, 4000);
        dev.lock().unwrap().drop_next = 2;
        let mut c = Client::new(Box::new(FakeTransport(dev.clone())), 1);
        assert_eq!(block(c.read_holding(0x2103, 1)).unwrap(), vec![4000]);
        // mehr Ausfälle als Versuche: Zeitüberschreitung
        dev.lock().unwrap().drop_next = 3;
        assert_eq!(block(c.read_holding(0x2103, 1)).unwrap_err(), ModbusError::Timeout);
    }

    #[test]
    fn client_does_not_retry_exceptions() {
        let dev = Arc::new(Mutex::new(Device::default()));
        let mut c = Client::new(Box::new(FakeTransport(dev.clone())), 1);
        assert_eq!(block(c.read_holding(0x9999, 1)).unwrap_err(), ModbusError::Exception(2));
    }

    /// Serielle Attrappe: antwortet als RTU-Gerät, liefert die Antwort in kleinen Stücken
    struct FakeSerial { dev: Device, unit: u8, rx: VecDeque<u8>, corrupt: bool }

    impl Write for FakeSerial {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            let pdu = rtu_parse(self.unit, data).expect("valid request frame");
            let mut out = rtu_frame(self.unit, &self.dev.answer(&pdu));
            if self.corrupt { out[2] ^= 0xFF; self.corrupt = false; }
            self.rx.extend(out);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }

    impl Read for FakeSerial {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.rx.is_empty() { return Err(std::io::ErrorKind::TimedOut.into()); }
            let n = buf.len().min(3).min(self.rx.len());
            for b in buf.iter_mut().take(n) { *b = self.rx.pop_front().unwrap(); }
            Ok(n)
        }
    }

    impl SerialLink for FakeSerial {
        fn clear_input(&mut self) { self.rx.clear(); }
    }

    #[test]
    fn rtu_transport_over_fake_serial() {
        let mut dev = Device::default();
        dev.regs.insert(0x2103, 12345);
        dev.regs.insert(0x2104, 7);
        let port = FakeSerial { dev, unit: 3, rx: VecDeque::new(), corrupt: true };
        let mut c = Client::new(Box::new(RtuTransport::new(Box::new(port), 115_200)), 3);
        c.timeout = Duration::from_millis(100);
        // erste Antwort gestört (CRC) -> zweiter Versuch klappt
        assert_eq!(block(c.read_holding(0x2103, 2)).unwrap(), vec![12345, 7]);
        block(c.write_single(0x2000, 0x12)).unwrap();
        assert_eq!(block(c.read_holding(0x2000, 1)).unwrap(), vec![0x12]);
        assert_eq!(block(c.read_holding(0x0001, 1)).unwrap_err(), ModbusError::Exception(2));
    }

    #[test]
    fn tcp_transport_against_local_server() {
        block(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap().to_string();
            tokio::spawn(async move {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut dev = Device::default();
                dev.regs.insert(0x1001, 20000);
                loop {
                    let mut head = [0u8; 7];
                    if s.read_exact(&mut head).await.is_err() { break; }
                    let len = u16::from_be_bytes([head[4], head[5]]) as usize;
                    let mut pdu = vec![0u8; len - 1];
                    s.read_exact(&mut pdu).await.unwrap();
                    let tid = u16::from_be_bytes([head[0], head[1]]);
                    s.write_all(&tcp_frame(tid, head[6], &dev.answer(&pdu))).await.unwrap();
                }
            });
            let mut c = Client::new(Box::new(TcpTransport::new(&addr)), 1);
            assert_eq!(c.read_holding(0x1001, 1).await.unwrap(), vec![20000]);
            c.write_single(0x2000, 1).await.unwrap();
            assert_eq!(c.read_holding(0x2000, 1).await.unwrap(), vec![1]);
        });
    }

    #[test]
    fn tcp_transport_times_out() {
        block(async {
            // Server nimmt an, antwortet aber nie
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap().to_string();
            tokio::spawn(async move {
                let mut keep = Vec::new();
                while let Ok((s, _)) = listener.accept().await { keep.push(s); }
            });
            let mut c = Client::new(Box::new(TcpTransport::new(&addr)), 1);
            c.timeout = Duration::from_millis(50);
            c.retries = 1;
            assert_eq!(c.read_holding(0, 1).await.unwrap_err(), ModbusError::Timeout);
        });
    }
}
