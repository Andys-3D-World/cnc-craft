//! NETZWERK-SUCHE (IP-Finder wie in OpenBuilds CONTROL)
//!
//! Sucht im eigenen Netz nach Maschinen, die GRBL über Netzwerk sprechen:
//! FluidNC, grblHAL, Grbl_ESP32, MKS DLC32 (Original-Firmware), xTool F1 …
//!
//! Ablauf:
//!   1. Eigene IP ermitteln (ohne Zusatz-Bibliothek: UDP-Socket „verbinden“, es wird nichts gesendet)
//!   2. Alle 254 Adressen des eigenen /24-Netzes + feste Kandidaten (192.168.4.1 = Access-Point
//!      der ESP32-Boards, 172.25.3.1 = xTool F1 per USB-Netzwerk) auf den Ports 23, 8080, 8780
//!      mit kurzem Zeitlimit anklopfen (viele Threads gleichzeitig, dauert wenige Sekunden)
//!   3. Offene Ports genauer ansehen: Begrüßung lesen, „?“ (GRBL-Statusabfrage) senden, Antwort
//!      einordnen (Grbl-Version, FluidNC, Statusbericht <Idle|…>). Webserver (HTTP) werden aussortiert.
//!   4. Für gefundene Geräte den Seitentitel der Weboberfläche (Port 80) als Namen holen
//!
//! Nur Lesen/Statusabfrage – es werden keine Befehle gesendet, die etwas bewegen.
//! Dieses Modul kennt kein Tauri (lässt sich mit rustc allein testen); Befehl `net_scan` in lib.rs.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Ports, auf denen GRBL-Netzwerk-Firmwares lauschen
pub const PORTS: [u16; 3] = [23, 8080, 8780];

#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub ip: String,
    pub port: u16,
    /// "grbl" = Antwort sieht nach GRBL aus, "open" = Port offen, Antwort unklar
    pub kind: String,
    /// erkannte Firmware, z. B. "Grbl 1.1h", "FluidNC v3.9.1", leer wenn unbekannt
    pub firmware: String,
    /// Name aus der Weboberfläche (Seitentitel), leer wenn keiner
    pub name: String,
}

/// Eigene IPv4-Adresse im lokalen Netz (die, über die das Internet erreicht würde)
pub fn local_ipv4() -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    // connect bei UDP schickt nichts, legt nur die Route/Quelladresse fest
    s.connect("192.0.2.1:9").or_else(|_| s.connect("8.8.8.8:80")).ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

/// Kandidaten: ganzes /24-Netz der eigenen Adresse (ohne sich selbst) + feste Adressen
pub fn candidates(own: Option<Ipv4Addr>) -> Vec<Ipv4Addr> {
    let mut v: Vec<Ipv4Addr> = Vec::new();
    if let Some(ip) = own {
        let o = ip.octets();
        for last in 1..=254u8 {
            let c = Ipv4Addr::new(o[0], o[1], o[2], last);
            if c != ip {
                v.push(c);
            }
        }
    }
    for fixed in [Ipv4Addr::new(192, 168, 4, 1), Ipv4Addr::new(172, 25, 3, 1)] {
        if !v.contains(&fixed) && Some(fixed) != own {
            v.push(fixed);
        }
    }
    v
}

/// Antwort eines offenen Ports einordnen. None = kein GRBL-Gerät (z. B. Webserver)
pub fn classify(reply: &[u8]) -> Option<(String, String)> {
    let text = String::from_utf8_lossy(reply);
    let t = text.trim();
    if t.starts_with("HTTP/") || t.contains("<html") || t.contains("<HTML") {
        return None;
    }
    let lower = t.to_lowercase();
    // Firmware-Name aus der Begrüßung ("Grbl 1.1h ['$' for help]", "Grbl 3.0 [FluidNC v3.9.1 …]")
    let mut fw = String::new();
    if let Some(i) = t.find("FluidNC") {
        fw = t[i..].split(|c: char| c == ']' || c == '(' || c == '\r' || c == '\n').next().unwrap_or("").trim().to_string();
    } else if let Some(i) = t.find("GrblHAL").or_else(|| t.find("grblHAL")) {
        fw = t[i..].split(|c: char| c == '[' || c == '\r' || c == '\n').next().unwrap_or("").trim().to_string();
    } else if let Some(i) = t.find("Grbl") {
        fw = t[i..].split(|c: char| c == '[' || c == '\r' || c == '\n').next().unwrap_or("").trim().to_string();
    }
    let grbl_like = !fw.is_empty()
        || t.contains("<Idle")
        || t.contains("<Alarm")
        || t.contains("<Run")
        || t.contains("<Hold")
        || t.contains("<Jog")
        || t.contains("<Home")
        || t.contains("<Door")
        || t.contains("<Check")
        || t.contains("MPos:")
        || t.contains("WPos:")
        || lower.contains("[msg:")
        || t.lines().any(|l| l.trim() == "ok");
    if grbl_like {
        Some(("grbl".to_string(), fw))
    } else {
        Some(("open".to_string(), String::new()))
    }
}

/// Offenen Port genauer ansehen: Begrüßung lesen, dann "?" senden und Antwort lesen
pub fn probe(addr: SocketAddr, connect_timeout: Duration, read_time: Duration) -> Option<(String, String)> {
    let mut s = TcpStream::connect_timeout(&addr, connect_timeout).ok()?;
    let _ = s.set_nodelay(true);
    let _ = s.set_read_timeout(Some(Duration::from_millis(80)));
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 512];
    let read_some = |s: &mut TcpStream, buf: &mut Vec<u8>, chunk: &mut [u8], until: Instant| {
        while Instant::now() < until && buf.len() < 2048 {
            match s.read(chunk) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => {}
            }
        }
    };
    // manche schicken sofort eine Begrüßung
    read_some(&mut s, &mut buf, &mut chunk, Instant::now() + read_time / 2);
    // GRBL-Statusabfrage (Echtzeit-Befehl, ändert nichts an der Maschine)
    let _ = s.write_all(b"?");
    read_some(&mut s, &mut buf, &mut chunk, Instant::now() + read_time);
    if buf.is_empty() {
        // offen, aber stumm – könnte trotzdem passen (z. B. Telnet ohne Echo)
        return Some(("open".to_string(), String::new()));
    }
    classify(&buf)
}

/// Titel der Weboberfläche (Port 80) – z. B. "FluidNC", "MKS DLC32", "ESP3D"
pub fn web_title(ip: Ipv4Addr, timeout: Duration) -> String {
    let addr = SocketAddr::new(IpAddr::V4(ip), 80);
    let Ok(mut s) = TcpStream::connect_timeout(&addr, timeout) else { return String::new() };
    let _ = s.set_read_timeout(Some(Duration::from_millis(150)));
    let req = format!("GET / HTTP/1.0\r\nHost: {}\r\nConnection: close\r\n\r\n", ip);
    if s.write_all(req.as_bytes()).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    let until = Instant::now() + timeout;
    while Instant::now() < until && buf.len() < 16384 {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => {}
        }
        if String::from_utf8_lossy(&buf).to_lowercase().contains("</title>") {
            break;
        }
    }
    title_of(&String::from_utf8_lossy(&buf))
}

pub fn title_of(html: &str) -> String {
    let lower = html.to_lowercase();
    let Some(a) = lower.find("<title") else { return String::new() };
    let Some(b) = lower[a..].find('>') else { return String::new() };
    let start = a + b + 1;
    let Some(e) = lower[start..].find("</title>") else { return String::new() };
    let t: String = html[start..start + e].split_whitespace().collect::<Vec<_>>().join(" ");
    t.chars().take(60).collect()
}

/// Liste von Adressen/Ports parallel abklopfen. Gibt alle offenen Ports zurück, die nicht als
/// Webserver erkannt wurden. Geräte mit GRBL-Antwort zuerst.
pub fn scan_targets(targets: Vec<SocketAddr>, connect_timeout: Duration, read_time: Duration, threads: usize, with_titles: bool) -> Vec<Found> {
    let queue = Arc::new(Mutex::new(targets));
    let found: Arc<Mutex<Vec<Found>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for _ in 0..threads.max(1) {
        let q = Arc::clone(&queue);
        let f = Arc::clone(&found);
        handles.push(thread::spawn(move || loop {
            let next = q.lock().ok().and_then(|mut v| v.pop());
            let Some(addr) = next else { break };
            // erst nur anklopfen (schnell), dann genauer ansehen
            if TcpStream::connect_timeout(&addr, connect_timeout).is_err() {
                continue;
            }
            if let Some((kind, firmware)) = probe(addr, connect_timeout * 2, read_time) {
                if let Ok(mut v) = f.lock() {
                    v.push(Found { ip: addr.ip().to_string(), port: addr.port(), kind, firmware, name: String::new() });
                }
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
    let mut v = found.lock().map(|v| v.clone()).unwrap_or_default();
    if with_titles {
        let mut seen: Vec<String> = Vec::new();
        for f in v.iter_mut() {
            if let Some(i) = seen.iter().position(|s| s.starts_with(&format!("{}|", f.ip))) {
                f.name = seen[i].split_once('|').map(|x| x.1.to_string()).unwrap_or_default();
                continue;
            }
            let name = f.ip.parse::<Ipv4Addr>().map(|ip| web_title(ip, Duration::from_millis(700))).unwrap_or_default();
            seen.push(format!("{}|{}", f.ip, name));
            f.name = name;
        }
    }
    // GRBL-Geräte zuerst, dann nach Adresse
    v.sort_by(|a, b| {
        (a.kind != "grbl")
            .cmp(&(b.kind != "grbl"))
            .then_with(|| {
                let pa = a.ip.parse::<Ipv4Addr>().map(u32::from).unwrap_or(0);
                let pb = b.ip.parse::<Ipv4Addr>().map(u32::from).unwrap_or(0);
                pa.cmp(&pb)
            })
            .then(a.port.cmp(&b.port))
    });
    v
}

/// Ganze Suche: eigenes Netz + feste Kandidaten auf allen Ports
pub fn scan_network() -> (Option<Ipv4Addr>, Vec<Found>) {
    let own = local_ipv4();
    let mut targets = Vec::new();
    for ip in candidates(own) {
        for p in PORTS {
            // xTool-Port nur bei der xTool-Adresse, sonst unnötig viele Versuche
            if p == 8780 && ip != Ipv4Addr::new(172, 25, 3, 1) {
                continue;
            }
            targets.push(SocketAddr::new(IpAddr::V4(ip), p));
        }
    }
    let found = scan_targets(targets, Duration::from_millis(350), Duration::from_millis(700), 96, true);
    (own, found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn classify_replies() {
        assert_eq!(classify(b"\r\nGrbl 1.1h ['$' for help]\r\n"), Some(("grbl".into(), "Grbl 1.1h".into())));
        let (k, fw) = classify(b"Grbl 3.0 [FluidNC v3.9.1 (wifi) '$' for help]\r\n").unwrap();
        assert_eq!((k.as_str(), fw.as_str()), ("grbl", "FluidNC v3.9.1"));
        assert_eq!(classify(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n").unwrap().0, "grbl");
        assert_eq!(classify(b"ok\r\n").unwrap().0, "grbl");
        assert_eq!(classify(b"HTTP/1.1 400 Bad Request\r\n\r\n"), None);
        assert_eq!(classify(b"SSH-2.0-OpenSSH").unwrap().0, "open");
    }

    #[test]
    fn titles() {
        assert_eq!(title_of("<html><head><TITLE>  MKS  DLC32\n</TITLE>"), "MKS DLC32");
        assert_eq!(title_of("<title lang=x>FluidNC</title>"), "FluidNC");
        assert_eq!(title_of("no title"), "");
    }

    #[test]
    fn candidates_net() {
        let c = candidates(Some(Ipv4Addr::new(192, 168, 178, 20)));
        assert_eq!(c.len(), 253 + 2);
        assert!(!c.contains(&Ipv4Addr::new(192, 168, 178, 20)));
        assert!(c.contains(&Ipv4Addr::new(192, 168, 178, 1)));
        assert!(c.contains(&Ipv4Addr::new(192, 168, 4, 1)));
        let c = candidates(Some(Ipv4Addr::new(192, 168, 4, 2)));
        assert_eq!(c.iter().filter(|x| **x == Ipv4Addr::new(192, 168, 4, 1)).count(), 1);
        assert_eq!(candidates(None).len(), 2);
    }

    /// Falsches GRBL-Gerät, falscher Webserver und geschlossener Port auf 127.0.0.1
    #[test]
    fn scan_fakes() {
        let grbl = TcpListener::bind("127.0.0.1:0").unwrap();
        let gaddr = grbl.local_addr().unwrap();
        thread::spawn(move || {
            for s in grbl.incoming() {
                let Ok(mut s) = s else { continue };
                thread::spawn(move || {
                    let _ = s.write_all(b"\r\nGrbl 1.1f ['$' for help]\r\n");
                    let mut b = [0u8; 16];
                    let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
                    if let Ok(n) = s.read(&mut b) {
                        if n > 0 && b[0] == b'?' {
                            let _ = s.write_all(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n");
                        }
                    }
                    thread::sleep(Duration::from_millis(300));
                });
            }
        });
        let web = TcpListener::bind("127.0.0.1:0").unwrap();
        let waddr = web.local_addr().unwrap();
        thread::spawn(move || {
            for s in web.incoming() {
                let Ok(mut s) = s else { continue };
                let mut b = [0u8; 64];
                let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
                let _ = s.read(&mut b);
                let _ = s.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
            }
        });
        // geschlossener Port: Listener sofort wieder schließen
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let t0 = Instant::now();
        let v = scan_targets(vec![gaddr, waddr, closed], Duration::from_millis(300), Duration::from_millis(400), 4, false);
        assert_eq!(v.len(), 1, "{:?}", v);
        assert_eq!(v[0].port, gaddr.port());
        assert_eq!(v[0].kind, "grbl");
        assert_eq!(v[0].firmware, "Grbl 1.1f");
        assert!(t0.elapsed() < Duration::from_secs(3));
    }
}
