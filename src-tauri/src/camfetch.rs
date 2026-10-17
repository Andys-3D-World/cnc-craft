//! IP-KAMERA: EIN BILD HOLEN (für die Kamera-Überlagerung auf der Arbeitsfläche)
//!
//! Netzwerk-Kameras (ESP32-CAM, OctoPrint/mjpg-streamer, Handy-Apps wie „IP Webcam“ …) liefern
//! entweder ein Einzelbild (…/capture, …/snapshot.jpg) oder einen MJPEG-Strom (…/stream, ?action=stream).
//! Im Fenster der Oberfläche lässt sich der Strom direkt anzeigen; zum Entzerren auf der
//! Arbeitsfläche braucht die Oberfläche aber die Bilddaten selbst – die dürfte sie von einer fremden
//! Adresse nicht lesen (CORS). Darum holt Rust ein Bild und gibt die JPEG-Bytes zurück.
//!
//! Nur http:// (Kameras im eigenen Netz). Bei MJPEG wird das erste vollständige Bild genommen.
//! Ohne Tauri – lässt sich mit rustc allein testen; Befehl `camera_snapshot` in lib.rs.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

pub const MAX_BYTES: usize = 8 * 1024 * 1024;

/// "http://host[:port]/pfad" zerlegen -> (host, port, pfad)
pub fn parse_url(url: &str) -> Result<(String, u16, String), String> {
    let u = url.trim();
    let rest = if let Some(r) = u.strip_prefix("http://") {
        r
    } else if u.starts_with("https://") {
        return Err("https-not-supported".into());
    } else if u.contains("://") {
        return Err("bad-url".into());
    } else {
        u
    };
    // Zugangsdaten (user:pass@) werden nicht unterstützt – sauber ablehnen statt falsch verbinden
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    if hostport.contains('@') {
        return Err("auth-not-supported".into());
    }
    if hostport.is_empty() {
        return Err("bad-url".into());
    }
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "bad-url".to_string())?),
        None => (hostport.to_string(), 80),
    };
    Ok((host, port, path))
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// Erstes vollständiges JPEG (FF D8 … FF D9) in den Daten
pub fn first_jpeg(data: &[u8]) -> Option<&[u8]> {
    let s = find(data, &[0xFF, 0xD8, 0xFF], 0)?;
    let e = find(data, &[0xFF, 0xD9], s + 2)?;
    Some(&data[s..e + 2])
}

/// Ein Bild von der Kamera holen (JPEG-Bytes)
pub fn fetch_frame(url: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    let (host, port, path) = parse_url(url)?;
    let addr = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or_else(|| "bad-url".to_string())?;
    let mut s = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(200)));
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: CNC-Craft\r\nAccept: image/jpeg, multipart/x-mixed-replace, */*\r\nConnection: close\r\n\r\n",
        path, host
    );
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

    let deadline = Instant::now() + timeout;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16384];
    let mut header_end: Option<usize> = None;
    loop {
        if Instant::now() > deadline {
            break;
        }
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(e.to_string()),
        }
        if buf.len() > MAX_BYTES {
            break;
        }
        if header_end.is_none() {
            if let Some(i) = find(&buf, b"\r\n\r\n", 0) {
                header_end = Some(i + 4);
                let head = String::from_utf8_lossy(&buf[..i]).to_string();
                let status = head.lines().next().unwrap_or("");
                let code: u16 = status.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
                if code == 401 {
                    return Err("auth-not-supported".into());
                }
                if !(200..300).contains(&code) {
                    return Err(format!("http-{}", code));
                }
            }
        }
        // Sobald ein vollständiges JPEG da ist: fertig (bei MJPEG läuft der Strom sonst endlos)
        if let Some(h) = header_end {
            if first_jpeg(&buf[h..]).is_some() {
                break;
            }
        }
    }
    let h = header_end.ok_or_else(|| "no-answer".to_string())?;
    first_jpeg(&buf[h..]).map(|j| j.to_vec()).ok_or_else(|| "no-jpeg".to_string())
}

// ---------------------------------------------------------------------
// Befehl über die Weboberfläche eines ESP32-Boards schicken
// ---------------------------------------------------------------------

/// Text für eine URL kodieren (alles außer A–Z a–z 0–9 - _ . ~ wird %HH, UTF-8-Bytes einzeln)
pub fn url_encode(s: &str) -> String {
    let mut o = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{:02X}", b));
        }
    }
    o
}

/// Einfache GET-Anfrage, gibt (Status, Text) zurück. Nur http, Antwort höchstens 256 KB.
pub fn http_get(url: &str, timeout: Duration) -> Result<(u16, String), String> {
    let (host, port, path) = parse_url(url)?;
    let addr = (host.as_str(), port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or_else(|| "bad-url".to_string())?;
    let mut s = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(200)));
    let req = format!("GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: CNC-Craft\r\nConnection: close\r\n\r\n", path, host);
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    while Instant::now() < deadline && buf.len() < 256 * 1024 {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                // Antwort vollständig? (Content-Length erreicht)
                if let Some(h) = find(&buf, b"\r\n\r\n", 0) {
                    let head = String::from_utf8_lossy(&buf[..h]).to_lowercase();
                    if let Some(len) = head.lines().find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok())) {
                        if buf.len() >= h + 4 + len { break; }
                    }
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let h = find(&buf, b"\r\n\r\n", 0).ok_or_else(|| "no-answer".to_string())?;
    let head = String::from_utf8_lossy(&buf[..h]).to_string();
    let code: u16 = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).and_then(|c| c.parse().ok()).unwrap_or(0);
    Ok((code, String::from_utf8_lossy(&buf[h + 4..]).to_string()))
}

/// GRBL-Befehl über die Weboberfläche (Grbl_ESP32 / FluidNC / ESP3D: /command?plain=…) schicken.
/// Dort laufen die Zeichen nicht durch den seriellen Zeichenfilter – ! ? ~ und Umlaute kommen an.
pub fn web_command(host: &str, command: &str, timeout: Duration) -> Result<String, String> {
    let url = format!("http://{}/command?plain={}", host.trim().trim_start_matches("http://").trim_end_matches('/'), url_encode(command));
    let (code, body) = http_get(&url, timeout)?;
    if code == 401 { return Err("auth-not-supported".into()); }
    if !(200..300).contains(&code) { return Err(format!("http-{}", code)); }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn urls() {
        assert_eq!(parse_url("http://192.168.1.50/capture").unwrap(), ("192.168.1.50".into(), 80, "/capture".into()));
        assert_eq!(parse_url("192.168.1.50:81/stream").unwrap(), ("192.168.1.50".into(), 81, "/stream".into()));
        assert_eq!(parse_url("http://cam.local:8080").unwrap(), ("cam.local".into(), 8080, "/".into()));
        assert_eq!(parse_url("https://x/y").unwrap_err(), "https-not-supported");
        assert_eq!(parse_url("http://a:b@x/y").unwrap_err(), "auth-not-supported");
        assert!(parse_url("rtsp://x/y").is_err());
    }

    #[test]
    fn jpeg_markers() {
        let d = [0u8, 1, 0xFF, 0xD8, 0xFF, 0xE0, 5, 6, 0xFF, 0xD9, 9, 0xFF, 0xD8, 0xFF];
        assert_eq!(first_jpeg(&d).unwrap(), &[0xFF, 0xD8, 0xFF, 0xE0, 5, 6, 0xFF, 0xD9]);
        assert!(first_jpeg(&[0xFF, 0xD8, 0xFF, 1, 2]).is_none());
    }

    #[test]
    fn web_cmd() {
        assert_eq!(url_encode("$Sta/Password=a!b ?ä"), "%24Sta%2FPassword%3Da%21b%20%3F%C3%A4");
        let got = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let g2 = got.clone();
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let a = l.local_addr().unwrap();
        thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let mut b = [0u8; 2048];
                let n = s.read(&mut b).unwrap_or(0);
                *g2.lock().unwrap() = String::from_utf8_lossy(&b[..n]).lines().next().unwrap_or("").to_string();
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            }
        });
        let r = web_command(&a.to_string(), "$Sta/Password=Ab!c~?(x);ü", Duration::from_secs(2)).unwrap();
        assert_eq!(r, "ok");
        assert_eq!(*got.lock().unwrap(), "GET /command?plain=%24Sta%2FPassword%3DAb%21c%7E%3F%28x%29%3B%C3%BC HTTP/1.1");
    }

    fn fake_jpeg(tag: u8) -> Vec<u8> {
        vec![0xFF, 0xD8, 0xFF, 0xE0, tag, tag, tag, 0xFF, 0xD9]
    }

    fn serve(reply: impl Fn(&mut TcpStream) + Send + 'static) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let a = l.local_addr().unwrap();
        thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let mut b = [0u8; 1024];
                let _ = s.read(&mut b);
                reply(&mut s);
            }
        });
        format!("http://{}", a)
    }

    #[test]
    fn single_and_mjpeg() {
        let single = serve(|s| {
            let j = fake_jpeg(1);
            let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n", j.len()).as_bytes());
            let _ = s.write_all(&j);
        });
        assert_eq!(fetch_frame(&format!("{}/capture", single), Duration::from_secs(2)).unwrap(), fake_jpeg(1));

        // MJPEG: endloser Strom – darf nicht hängen bleiben
        let mjpeg = serve(|s| {
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n");
            for i in 0..50u8 {
                let j = fake_jpeg(10 + i);
                let _ = s.write_all(format!("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n", j.len()).as_bytes());
                let _ = s.write_all(&j);
                let _ = s.write_all(b"\r\n");
                thread::sleep(Duration::from_millis(30));
            }
        });
        let t0 = Instant::now();
        assert_eq!(fetch_frame(&format!("{}/stream", mjpeg), Duration::from_secs(3)).unwrap(), fake_jpeg(10));
        assert!(t0.elapsed() < Duration::from_millis(800));

        let notfound = serve(|s| { let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n"); });
        assert_eq!(fetch_frame(&format!("{}/x", notfound), Duration::from_secs(2)).unwrap_err(), "http-404");
        let html = serve(|s| { let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html></html>"); });
        assert_eq!(fetch_frame(&html, Duration::from_millis(600)).unwrap_err(), "no-jpeg");
    }
}
