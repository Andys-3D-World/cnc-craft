//! SERIELLE PORTS: auflisten (mit Chip-Erkennung) und für die Maschine öffnen.

use crate::flash::FlashPort;
use crate::machine::{Emit, Machine};
use crate::marlin::Marlin;
use serialport::{ClearBuffer, SerialPort, SerialPortType};
use std::io::{Read, Write};
use std::time::Duration;

/// Ein gefundener Port
pub struct PortEntry {
    pub name: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub chip: String,         // "CH340", "CP210x", "ESP32-S3 USB" … ("" = unbekannt)
    pub product: String,
    pub manufacturer: String,
}

/// USB-Kennung -> Chip-Name (die üblichen Chips auf CNC-/Laser-Boards)
pub fn chip_name(vid: u16, pid: u16) -> &'static str {
    match (vid, pid) {
        (0x1a86, 0x7523) => "CH340",
        (0x1a86, 0x5523) => "CH341",
        (0x1a86, 0x55d4) => "CH9102",
        (0x1a86, 0x55d3) => "CH343",
        (0x1a86, _) => "WCH",
        (0x10c4, _) => "CP210x",
        (0x0403, _) => "FTDI",
        (0x2341, _) | (0x2a03, _) => "Arduino",
        (0x303a, 0x1001) => "ESP32-S3/C3 USB",
        (0x303a, _) => "ESP32 USB",
        (0x0483, _) => "STM32 USB",
        (0x16c0, _) => "Teensy",
        (0x2e8a, _) => "RP2040",
        _ => "",
    }
}

pub fn list_ports() -> Vec<PortEntry> {
    let ports = match serialport::available_ports() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<PortEntry> = Vec::new();
    for p in ports {
        // macOS: nur /dev/cu.* benutzen – /dev/tty.* blockiert beim Öffnen
        if cfg!(target_os = "macos") && p.port_name.starts_with("/dev/tty.") { continue; }
        let lname = p.port_name.to_lowercase();
        if lname.contains("bluetooth") || lname.contains("debug-console") { continue; }
        let mut e = PortEntry { name: p.port_name.clone(), vid: None, pid: None, chip: String::new(), product: String::new(), manufacturer: String::new() };
        if let SerialPortType::UsbPort(u) = &p.port_type {
            e.vid = Some(u.vid);
            e.pid = Some(u.pid);
            e.chip = chip_name(u.vid, u.pid).to_string();
            e.product = u.product.clone().unwrap_or_default();
            e.manufacturer = u.manufacturer.clone().unwrap_or_default();
        }
        out.push(e);
    }
    // USB-Geräte zuerst
    out.sort_by_key(|e| (e.vid.is_none(), e.name.clone()));
    out
}

struct PortReader(Box<dyn SerialPort>);
impl Read for PortReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> { self.0.read(buf) }
}
struct PortWriter(Box<dyn SerialPort>);
impl Write for PortWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> { self.0.write(buf) }
    fn flush(&mut self) -> std::io::Result<()> { self.0.flush() }
}

/// Port öffnen und die Maschinen-Threads starten
pub fn open_machine(name: &str, baud: u32, emit: Emit) -> Result<Machine, String> {
    let mut port = serialport::new(name, baud)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| e.to_string())?;
    // DTR/RTS aus: ESP32-Boards (DLC32 usw.) laufen sonst evtl. im Reset/Bootloader fest.
    // Arduino-Boards starten dabei einmal neu und melden sich dann mit "Grbl ..."
    let _ = port.write_data_terminal_ready(false);
    let _ = port.write_request_to_send(false);
    let reader = port.try_clone().map_err(|e| e.to_string())?;
    Ok(Machine::start(Box::new(PortReader(reader)), Box::new(PortWriter(port)), emit))
}

/// TCP-Lesen: Verbindung zu = Fehler (sonst würde der Lese-Thread ewig warten)
struct TcpReader(std::net::TcpStream);
impl Read for TcpReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self.0.read(buf) {
            Ok(0) => Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "connection closed")),
            other => other,
        }
    }
}

/// GRBL über Netzwerk (Telnet/TCP): FluidNC, grblHAL, Grbl_ESP32 per WLAN (Port 23),
/// MKS DLC32 mit Original-Firmware (Port 8080), xTool F1 per USB-Netzwerk (172.25.3.1:8780).
/// addr = "host:port"; ohne Port wird erst 23, dann 8080 versucht.
pub fn open_machine_tcp(addr: &str, emit: Emit) -> Result<Machine, String> {
    use std::net::{TcpStream, ToSocketAddrs};
    let a = addr.trim();
    let has_port = a.rsplit_once(':').map(|(_, p)| p.parse::<u16>().is_ok()).unwrap_or(false);
    let tries: Vec<(String, Duration)> = if has_port {
        vec![(a.to_string(), Duration::from_secs(4))]
    } else {
        vec![(format!("{}:23", a), Duration::from_millis(2500)), (format!("{}:8080", a), Duration::from_millis(2500))]
    };
    let mut last_err = String::from("bad address");
    let mut stream: Option<TcpStream> = None;
    for (target, timeout) in tries {
        let sock = match target.to_socket_addrs().map_err(|e| e.to_string()).and_then(|mut it| it.next().ok_or_else(|| "bad address".to_string())) {
            Ok(s) => s,
            Err(e) => { last_err = e; continue; }
        };
        match TcpStream::connect_timeout(&sock, timeout) {
            Ok(s) => { stream = Some(s); break; }
            Err(e) => last_err = format!("{}: {}", target, e),
        }
    }
    let stream = stream.ok_or(last_err)?;
    let _ = stream.set_nodelay(true);
    stream.set_read_timeout(Some(Duration::from_millis(50))).map_err(|e| e.to_string())?;
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    Ok(Machine::start(Box::new(TcpReader(reader)), Box::new(stream), emit))
}

/// Port öffnen für eine Marlin-Maschine (Creality, Anycubic, MPCNC …)
pub fn open_marlin(name: &str, baud: u32, laser: bool, emit: Emit) -> Result<Marlin, String> {
    let mut port = serialport::new(name, baud)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| e.to_string())?;
    let _ = port.write_data_terminal_ready(false);
    let _ = port.write_request_to_send(false);
    let reader = port.try_clone().map_err(|e| e.to_string())?;
    Ok(Marlin::start(Box::new(PortReader(reader)), Box::new(PortWriter(port)), laser, emit))
}

// ---------------------------------------------------------------------
// Port zum Flashen (DTR/RTS für den Reset in den Bootloader, Baudrate umschaltbar)
// ---------------------------------------------------------------------

pub struct FlashSerial(Box<dyn SerialPort>);

impl Read for FlashSerial {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> { self.0.read(buf) }
}
impl Write for FlashSerial {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> { self.0.write(buf) }
    fn flush(&mut self) -> std::io::Result<()> { self.0.flush() }
}
impl FlashPort for FlashSerial {
    fn set_dtr(&mut self, on: bool) { let _ = self.0.write_data_terminal_ready(on); }
    fn set_rts(&mut self, on: bool) { let _ = self.0.write_request_to_send(on); }
    fn set_baud(&mut self, baud: u32) -> Result<(), String> { self.0.set_baud_rate(baud).map_err(|e| e.to_string()) }
    fn clear_input(&mut self) { let _ = self.0.clear(ClearBuffer::Input); }
}

/// Port zum Flashen öffnen. Wartet kurz, falls die Maschinen-Verbindung ihn gerade freigibt.
pub fn open_flash_port(name: &str) -> Result<FlashSerial, String> {
    let mut last = String::new();
    for _ in 0..15 {
        match serialport::new(name, 115_200).timeout(Duration::from_millis(20)).open() {
            Ok(p) => return Ok(FlashSerial(p)),
            Err(e) => { last = e.to_string(); std::thread::sleep(Duration::from_millis(200)); }
        }
    }
    Err(last)
}

// ---------------------------------------------------------------------
// Ruida über USB (FTDI, 8N1, Hardware-Handshake, keine Prüfsumme/ACK)
// ---------------------------------------------------------------------

pub struct RuidaSerial(Box<dyn SerialPort>, String);

impl crate::ruida::Link for RuidaSerial {
    fn send(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.0.write_all(data)?;
        self.0.flush()
    }
    fn recv(&mut self, want: usize, timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
        let deadline = std::time::Instant::now() + timeout;
        let mut out = Vec::with_capacity(want);
        let mut buf = [0u8; 64];
        while out.len() < want && std::time::Instant::now() < deadline {
            let n = want - out.len();
            match self.0.read(&mut buf[..n.min(64)]) {
                Ok(0) => {}
                Ok(k) => out.extend_from_slice(&buf[..k]),
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(e),
            }
        }
        Ok(if out.len() == want { Some(out) } else { None })
    }
    fn is_udp(&self) -> bool { false }
    fn purge(&mut self) { let _ = self.0.clear(ClearBuffer::All); }
    fn describe(&self) -> String { self.1.clone() }
}

/// USB-Port einer Ruida-Steuerung öffnen
pub fn open_ruida(name: &str) -> Result<RuidaSerial, String> {
    let mut port = serialport::new(name, 115_200)
        .timeout(Duration::from_millis(50))
        .flow_control(serialport::FlowControl::Hardware)
        .open()
        .map_err(|e| e.to_string())?;
    let _ = port.write_data_terminal_ready(true);
    let _ = port.write_request_to_send(true);
    Ok(RuidaSerial(port, name.to_string()))
}
