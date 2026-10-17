//! NETZWERK-SUCHE (IP-Finder wie in OpenBuilds CONTROL)
//!
//! Sucht im eigenen Netz nach Maschinen, die GRBL über Netzwerk sprechen:
//! FluidNC, grblHAL, Grbl_ESP32, MKS DLC32 (Original-Firmware), xTool F1 …
//!
//! ESP32-Boards sind im WLAN oft „verschlafen“ (Stromsparmodus: erste Antwort braucht bis zu
//! 1–2 s) und nehmen meist nur EINE Telnet-Verbindung gleichzeitig an. Darum in drei Runden:
//!
//!   1. Bekannte Adressen gründlich (langes Zeitlimit): zuletzt benutzte/gefundene Adressen
//!      (kommen aus der Oberfläche), Geräte aus der ARP-Tabelle des Rechners, Namen wie
//!      fluidnc.local / grblesp.local, 192.168.4.1 (Access-Point der ESP32-Boards), xTool F1
//!   2. Ganzes /24-Netz schnell abklopfen (Ports 23 und 8080)
//!   3. Danach steht jedes Gerät, das auf Runde 2 reagiert hat, in der ARP-Tabelle – auch wenn
//!      es für TCP zu langsam war. Diese Geräte noch einmal mit langem Zeitlimit probieren.
//!
//! Pro Adresse/Port wird nur EINE Verbindung geöffnet: darin Begrüßung lesen, „?“ senden
//! (GRBL-Statusabfrage, bewegt nichts) und die Antwort einordnen. Webserver werden aussortiert.
//! Dieses Modul kennt kein Tauri (lässt sich mit rustc allein testen); Befehl `net_scan` in lib.rs.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Ports, auf denen GRBL-Netzwerk-Firmwares lauschen (8780 nur xTool F1)
pub const PORTS: [u16; 2] = [23, 8080];
const XTOOL: Ipv4Addr = Ipv4Addr::new(172, 25, 3, 1);
const ESP_AP: Ipv4Addr = Ipv4Addr::new(192, 168, 4, 1);
/// Übliche mDNS-Namen der Firmwares
const MDNS_NAMES: [&str; 5] = ["fluidnc.local", "grblesp.local", "grblhal.local", "esp3d.local", "mks.local"];

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
    /// Name im Netzwerk (Hostname aus [ESP800]), z. B. "laser-garage" – leer wenn unbekannt
    pub host: String,
}

/// Ergebnis eines Verbindungsversuchs
#[derive(Debug, Clone, Copy, PartialEq)]
enum Knock {
    Found,
    Refused,  // Gerät da, Port zu
    Timeout,  // keine Antwort (aus, zu langsam oder gar kein Gerät)
}

/// Eigene IPv4-Adresse im lokalen Netz (die, über die das Internet erreicht würde)
pub fn local_ipv4() -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    // connect bei UDP schickt nichts, legt nur die Route/Quelladresse fest
    s.connect("8.8.8.8:80").or_else(|_| s.connect("192.168.1.1:80")).ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

/// Ganzes /24-Netz der eigenen Adresse (ohne sich selbst)
pub fn subnet(own: Option<Ipv4Addr>) -> Vec<Ipv4Addr> {
    let mut v = Vec::new();
    if let Some(ip) = own {
        let o = ip.octets();
        for last in 1..=254u8 {
            let c = Ipv4Addr::new(o[0], o[1], o[2], last);
            if c != ip {
                v.push(c);
            }
        }
    }
    v
}

/// Alle IPv4-Adressen aus einem Text (ARP-Ausgabe), ohne Broadcast/Multicast/0.0.0.0
pub fn ips_in_text(text: &str) -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.to_lowercase();
        // unvollständige Einträge (Gerät antwortet nicht) überspringen
        if l.contains("incomplete") || l.contains("00:00:00:00:00:00") || l.contains("ff-ff-ff-ff-ff-ff") || l.contains("ff:ff:ff:ff:ff:ff") {
            continue;
        }
        for tok in line.split(|c: char| !(c.is_ascii_digit() || c == '.')) {
            if let Ok(ip) = tok.parse::<Ipv4Addr>() {
                let o = ip.octets();
                if ip.is_unspecified() || ip.is_broadcast() || ip.is_multicast() || ip.is_loopback() || o[3] == 255 || o[3] == 0 {
                    continue;
                }
                if !out.contains(&ip) {
                    out.push(ip);
                }
            }
        }
    }
    out
}

/// Geräte, die der Rechner gerade im Netz kennt (ARP-Tabelle)
pub fn arp_hosts() -> Vec<Ipv4Addr> {
    let mut text = String::new();
    if let Ok(s) = std::fs::read_to_string("/proc/net/arp") {
        // Linux: Spalte "Flags" 0x0 = unvollständig
        for line in s.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 4 && cols[2] != "0x0" {
                text.push_str(cols[0]);
                text.push('\n');
            }
        }
    }
    if text.is_empty() {
        let mut cmd = std::process::Command::new("arp");
        cmd.arg("-a");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW – kein Konsolenfenster aufblitzen lassen
        }
        if let Ok(out) = cmd.output() {
            text = String::from_utf8_lossy(&out.stdout).to_string();
        }
    }
    ips_in_text(&text)
}

/// Namen wie fluidnc.local auflösen (parallel, höchstens `limit` warten)
fn resolve_names(names: &[&str], limit: Duration) -> Vec<Ipv4Addr> {
    let (tx, rx) = mpsc::channel();
    for n in names {
        let tx = tx.clone();
        let host = format!("{}:23", n);
        thread::spawn(move || {
            if let Ok(it) = host.to_socket_addrs() {
                for a in it {
                    if let IpAddr::V4(v4) = a.ip() {
                        let _ = tx.send(v4);
                    }
                }
            }
        });
    }
    drop(tx);
    let mut v = Vec::new();
    let end = Instant::now() + limit;
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(ip) => if !v.contains(&ip) { v.push(ip) },
            Err(_) => break,
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
    let mut fw = String::new();
    if let Some(i) = t.find("FluidNC") {
        fw = t[i..].split(|c: char| c == ']' || c == '(' || c == '\r' || c == '\n').next().unwrap_or("").trim().to_string();
    } else if let Some(i) = t.find("GrblHAL").or_else(|| t.find("grblHAL")) {
        fw = t[i..].split(|c: char| c == '[' || c == '\r' || c == '\n').next().unwrap_or("").trim().to_string();
    } else if let Some(i) = t.find("Grbl") {
        fw = t[i..].split(|c: char| c == '[' || c == '\r' || c == '\n').next().unwrap_or("").trim().to_string();
    }
    let grbl_like = !fw.is_empty()
        || ["<Idle", "<Alarm", "<Run", "<Hold", "<Jog", "<Home", "<Door", "<Check", "<Sleep", "MPos:", "WPos:"].iter().any(|k| t.contains(k))
        || lower.contains("[msg:")
        || t.lines().any(|l| l.trim() == "ok");
    if grbl_like {
        Some(("grbl".to_string(), fw))
    } else {
        Some(("open".to_string(), String::new()))
    }
}

/// In einer offenen Verbindung nachsehen: Begrüßung lesen, "?" senden, Antwort lesen
fn probe_stream(mut s: TcpStream, read_time: Duration) -> Option<(String, String)> {
    let _ = s.set_nodelay(true);
    let _ = s.set_read_timeout(Some(Duration::from_millis(60)));
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 512];
    let mut read_until = |s: &mut TcpStream, until: Instant, buf: &mut Vec<u8>| {
        while Instant::now() < until && buf.len() < 2048 {
            match s.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => {}
            }
        }
    };
    read_until(&mut s, Instant::now() + read_time / 3, &mut buf);
    let _ = s.write_all(b"?");
    let mut end = Instant::now() + read_time;
    read_until(&mut s, end, &mut buf);
    // verschlafenes Board: noch einmal fragen
    if buf.is_empty() {
        let _ = s.write_all(b"?\n");
        end = Instant::now() + read_time;
        read_until(&mut s, end, &mut buf);
    }
    let _ = s.shutdown(std::net::Shutdown::Both);
    if buf.is_empty() {
        return Some(("open".to_string(), String::new()));
    }
    classify(&buf)
}

/// Eine Adresse/Port: EINE Verbindung, darin gleich nachsehen
fn knock(addr: SocketAddr, connect_timeout: Duration, read_time: Duration) -> (Knock, Option<(String, String)>) {
    match TcpStream::connect_timeout(&addr, connect_timeout) {
        Ok(s) => match probe_stream(s, read_time) {
            Some(r) => (Knock::Found, Some(r)),
            None => (Knock::Refused, None), // Webserver o. Ä. – kein GRBL
        },
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => (Knock::Refused, None),
        Err(_) => (Knock::Timeout, None),
    }
}

/// Liste parallel abklopfen. Gibt Funde und Adressen zurück, die gar nicht geantwortet haben.
fn run_round(targets: Vec<SocketAddr>, connect_timeout: Duration, read_time: Duration, threads: usize) -> (Vec<Found>, Vec<SocketAddr>) {
    let queue = Arc::new(Mutex::new(targets));
    let found: Arc<Mutex<Vec<Found>>> = Arc::new(Mutex::new(Vec::new()));
    let silent: Arc<Mutex<Vec<SocketAddr>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for _ in 0..threads.max(1) {
        let (q, f, si) = (Arc::clone(&queue), Arc::clone(&found), Arc::clone(&silent));
        handles.push(thread::spawn(move || loop {
            let next = q.lock().ok().and_then(|mut v| v.pop());
            let Some(addr) = next else { break };
            match knock(addr, connect_timeout, read_time) {
                (Knock::Found, Some((kind, firmware))) => {
                    if let Ok(mut v) = f.lock() {
                        v.push(Found { ip: addr.ip().to_string(), port: addr.port(), kind, firmware, name: String::new(), host: String::new() });
                    }
                }
                (Knock::Timeout, _) => {
                    if let Ok(mut v) = si.lock() {
                        v.push(addr);
                    }
                }
                _ => {}
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
    let f = found.lock().map(|v| v.clone()).unwrap_or_default();
    let s = silent.lock().map(|v| v.clone()).unwrap_or_default();
    (f, s)
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

/// "192.168.1.5", "192.168.1.5:8080", "http://…" -> Adressen zum Prüfen (ohne Port: 23 und 8080)
pub fn parse_hint(h: &str) -> Vec<SocketAddr> {
    let s = h.trim().trim_start_matches("tcp://").trim_start_matches("http://").split('/').next().unwrap_or("").to_string();
    if s.is_empty() {
        return Vec::new();
    }
    if let Ok(a) = s.parse::<SocketAddr>() {
        return vec![a];
    }
    if let Ok(ip) = s.parse::<Ipv4Addr>() {
        return PORTS.iter().map(|p| SocketAddr::new(IpAddr::V4(ip), *p)).collect();
    }
    Vec::new()
}

/// Ergebnisse zusammenführen (gleiche Adresse+Port nur einmal, GRBL-Antwort gewinnt), sortieren
fn merge(mut v: Vec<Found>) -> Vec<Found> {
    v.sort_by(|a, b| (a.kind != "grbl").cmp(&(b.kind != "grbl")));
    let mut seen = HashSet::new();
    v.retain(|f| seen.insert(format!("{}:{}", f.ip, f.port)));
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

fn add_titles(v: &mut [Found]) {
    let mut cache: Vec<(String, String, String)> = Vec::new();
    for f in v.iter_mut() {
        if let Some((_, n, h)) = cache.iter().find(|(ip, _, _)| ip == &f.ip) {
            f.name = n.clone();
            f.host = h.clone();
            continue;
        }
        let name = f.ip.parse::<Ipv4Addr>().map(|ip| web_title(ip, Duration::from_millis(900))).unwrap_or_default();
        // Hostname über die Weboberfläche ([ESP800] – Grbl_ESP32, MKS DLC32, FluidNC, ESP3D)
        let host = if name.is_empty() && f.kind != "grbl" {
            String::new()
        } else {
            crate::camfetch::web_command(&f.ip, "[ESP800]", Duration::from_millis(900))
                .map(|r| hostname_of(&r))
                .unwrap_or_default()
        };
        cache.push((f.ip.clone(), name.clone(), host.clone()));
        f.name = name;
        f.host = host;
    }
}

/// "FW version:1.0.4 # FW target:grbl-embedded # hostname:laser-garage # axis:3" -> "laser-garage"
pub fn hostname_of(text: &str) -> String {
    let lower = text.to_lowercase();
    let Some(i) = lower.find("hostname:") else { return String::new() };
    text[i + 9..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .take(40)
        .collect()
}

/// Ganze Suche. `hints` = zuletzt benutzte/gefundene Adressen aus der Oberfläche.
pub fn scan_network(hints: &[String]) -> (Option<Ipv4Addr>, Vec<Found>) {
    let own = local_ipv4();
    let mut all: Vec<Found> = Vec::new();
    let mut done: HashSet<SocketAddr> = HashSet::new();
    let slow = Duration::from_millis(1800);

    // ---- Runde 1: bekannte Adressen gründlich ----
    let mut first: Vec<SocketAddr> = Vec::new();
    let push = |a: SocketAddr, list: &mut Vec<SocketAddr>| { if !list.contains(&a) { list.push(a); } };
    for h in hints {
        for a in parse_hint(h) { push(a, &mut first); }
    }
    let mut known: Vec<Ipv4Addr> = arp_hosts();
    known.extend(resolve_names(&MDNS_NAMES, Duration::from_millis(1500)));
    known.push(ESP_AP);
    for ip in known {
        if Some(ip) == own { continue; }
        // nur eigenes Netz, 192.168.4.x (ESP-Access-Point) und xTool – keine fremden Netze aus der ARP-Tabelle
        let same = own.map(|o| o.octets()[..3] == ip.octets()[..3]).unwrap_or(false);
        if !(same || ip == ESP_AP) { continue; }
        for p in PORTS { push(SocketAddr::new(IpAddr::V4(ip), p), &mut first); }
    }
    push(SocketAddr::new(IpAddr::V4(XTOOL), 8780), &mut first);
    done.extend(first.iter().copied());
    let (f1, _) = run_round(first, slow, Duration::from_millis(900), 48);
    all.extend(f1);

    // ---- Runde 2: ganzes Netz schnell ----
    let mut sweep: Vec<SocketAddr> = Vec::new();
    for ip in subnet(own) {
        for p in PORTS {
            let a = SocketAddr::new(IpAddr::V4(ip), p);
            if !done.contains(&a) { sweep.push(a); }
        }
    }
    done.extend(sweep.iter().copied());
    let (f2, silent) = run_round(sweep, Duration::from_millis(450), Duration::from_millis(700), 64);
    all.extend(f2);

    // ---- Runde 3: jetzt bekannte, aber zu langsame Geräte noch einmal gründlich ----
    let alive: HashSet<Ipv4Addr> = arp_hosts().into_iter().collect();
    let again: Vec<SocketAddr> = silent
        .into_iter()
        .filter(|a| matches!(a.ip(), IpAddr::V4(v4) if alive.contains(&v4)))
        .collect();
    if !again.is_empty() {
        let (f3, _) = run_round(again, slow, Duration::from_millis(900), 48);
        all.extend(f3);
    }

    let mut v = merge(all);
    add_titles(&mut v);
    (own, v)
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
    fn subnet_and_hints() {
        let c = subnet(Some(Ipv4Addr::new(192, 168, 178, 20)));
        assert_eq!(c.len(), 253);
        assert!(!c.contains(&Ipv4Addr::new(192, 168, 178, 20)));
        assert!(subnet(None).is_empty());
        assert_eq!(parse_hint("192.168.1.5:8080"), vec!["192.168.1.5:8080".parse().unwrap()]);
        assert_eq!(parse_hint("tcp://192.168.1.5").len(), 2);
        assert_eq!(parse_hint("http://192.168.1.5:81/stream"), vec!["192.168.1.5:81".parse().unwrap()]);
        assert!(parse_hint("quatsch").is_empty());
    }

    #[test]
    fn arp_text() {
        // macOS
        let mac = "? (192.168.178.1) at 3c:a6:2f:aa:bb:cc on en0 ifscope [ethernet]\n? (192.168.178.45) at 24:6f:28:11:22:33 on en0 ifscope [ethernet]\n? (192.168.178.77) at (incomplete) on en0 ifscope [ethernet]\n? (192.168.178.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]\n? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]";
        assert_eq!(ips_in_text(mac), vec![Ipv4Addr::new(192, 168, 178, 1), Ipv4Addr::new(192, 168, 178, 45)]);
        // Windows
        let win = "\r\nSchnittstelle: 192.168.178.20 --- 0x5\r\n  Internetadresse      Physische Adresse     Typ\r\n  192.168.178.1         3c-a6-2f-aa-bb-cc     dynamisch\r\n  192.168.178.45        24-6f-28-11-22-33     dynamisch\r\n  192.168.178.255       ff-ff-ff-ff-ff-ff     statisch\r\n";
        let v = ips_in_text(win);
        assert!(v.contains(&Ipv4Addr::new(192, 168, 178, 45)));
        assert!(!v.contains(&Ipv4Addr::new(192, 168, 178, 255)));
    }

    fn fake_grbl(single_client: bool, delay_ms: u64) -> SocketAddr {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let a = l.local_addr().unwrap();
        thread::spawn(move || {
            let busy = Arc::new(Mutex::new(false));
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let busy = Arc::clone(&busy);
                // wie ESP32-Telnet: nur ein Client – weitere werden sofort wieder geschlossen
                if single_client {
                    let mut b = busy.lock().unwrap();
                    if *b { drop(s); continue; }
                    *b = true;
                }
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(delay_ms));
                    let _ = s.write_all(b"\r\nGrbl 1.1f ['$' for help]\r\n");
                    let mut b = [0u8; 16];
                    let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
                    if let Ok(n) = s.read(&mut b) {
                        if n > 0 && b[0] == b'?' {
                            let _ = s.write_all(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n");
                        }
                    }
                    thread::sleep(Duration::from_millis(1500));
                    *busy.lock().unwrap() = false;
                });
            }
        });
        a
    }

    /// GRBL nur EIN Client, langsame Antwort; Webserver und geschlossener Port
    #[test]
    fn rounds() {
        let grbl = fake_grbl(true, 300);
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
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let (f, silent) = run_round(vec![grbl, waddr, closed], Duration::from_millis(400), Duration::from_millis(600), 4);
        assert_eq!(f.len(), 1, "{:?}", f);
        assert_eq!(f[0].kind, "grbl");
        assert_eq!(f[0].firmware, "Grbl 1.1f");
        assert!(silent.is_empty(), "geschlossener Port zählt als 'abgelehnt', nicht als 'still'");
    }

    #[test]
    fn hostname_from_esp800() {
        assert_eq!(hostname_of("FW version:1.0.4 # FW target:grbl-embedded # FW HW:Direct SD # hostname:laser-garage # axis:3"), "laser-garage");
        assert_eq!(hostname_of("FW version:3.9.1 # hostname: fluidnc # webcommunication"), "fluidnc");
        assert_eq!(hostname_of("Error: no such command"), "");
    }

    #[test]
    fn merge_dedupe() {
        let a = Found { ip: "10.0.0.5".into(), port: 23, kind: "open".into(), firmware: "".into(), name: "".into(), host: "".into() };
        let b = Found { kind: "grbl".into(), firmware: "Grbl 1.1h".into(), ..a.clone() };
        let c = Found { ip: "10.0.0.2".into(), port: 8080, kind: "open".into(), firmware: "".into(), name: "".into(), host: "".into() };
        let m = merge(vec![a, c, b]);
        assert_eq!(m.len(), 2);
        assert_eq!((m[0].ip.as_str(), m[0].kind.as_str()), ("10.0.0.5", "grbl"));
    }
}
