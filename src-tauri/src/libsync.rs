//! WERKSTATT-SYNC: Bibliotheken über einen gemeinsamen Ordner abgleichen
//!
//! Büro-Rechner und Werkstatt-Laptop zeigen auf denselben Ordner (NAS/SMB, Dropbox, USB-Stick).
//! Darin liegt je Bibliothek eine Datei:
//!
//!   <Ordner>/cnc-craft-sync/tools.json    – Fräswerkzeuge
//!   <Ordner>/cnc-craft-sync/laser.json    – Laser-Ebenen
//!   <Ordner>/cnc-craft-sync/plasma.json   – Plasma-Schnitte
//!   <Ordner>/cnc-craft-sync/.lock         – kurz da, während ein Rechner schreibt
//!
//! Abgleich je Eintrag (über die ID): der neuere Stand (`updated`, ms) gewinnt. Gleiche Zeit, anderer
//! Inhalt: die größere Geräte-Kennung (`device`) gewinnt – so kommen beide Rechner zum selben Ergebnis.
//! Alte Einträge ohne Zeit (0) auf beiden Seiten mit anderem Inhalt: beide bleiben, der Verlierer
//! bekommt eine neue ID (`<id>_<Gerät>`), damit nichts verloren geht.
//! Gelöschte Einträge bleiben als Grabstein (`deleted: true`) stehen, damit sie nicht wiederkommen,
//! und werden nach 90 Tagen aufgeräumt. Reihenfolge der Liste (T1, T2 …): eigener Eintrag `order`,
//! der neuere gewinnt.
//!
//! Dieses Modul kennt nur Dateien und JSON (kein Tauri) – die Felder der Einträge prüft danach die
//! Oberfläche (sanitize der jeweiligen Bibliothek). Befehle in lib.rs (libsync_*).

use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const SUB_DIR: &str = "cnc-craft-sync";
pub const FORMAT: &str = "cnc-craft-sync";
pub const KINDS: [&str; 3] = ["tools", "laser", "plasma"];
/// Größer wird eine Bibliotheks-Datei nie (Schutz vor Unsinn im gemeinsamen Ordner)
pub const MAX_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 5000;
/// Grabsteine so lange behalten
pub const TOMBSTONE_MS: u64 = 90 * 24 * 3600 * 1000;
/// Sperre älter als das = übrig geblieben (Absturz, Stick abgezogen) -> wegräumen
const LOCK_STALE: Duration = Duration::from_secs(30);
const LOCK_TRIES: u32 = 40;
const LOCK_WAIT: Duration = Duration::from_millis(150);
/// Sicherungen vor dem Abgleich (im App-Datenordner)
pub const KEEP_BACKUPS: usize = 20;

/// Was beim Abgleich auf DIESEM Rechner passiert (für die Meldung in der Konsole)
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
pub struct Summary {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    /// alte Einträge mit gleicher ID und anderem Inhalt -> als Kopie behalten
    pub copies: usize,
    /// Datei im Ordner war kaputt und wurde beiseitegelegt
    pub broken: bool,
}

#[cfg(test)]
impl Summary {
    pub fn local_changed(&self) -> bool {
        self.added + self.updated + self.removed + self.copies > 0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Doc {
    pub entries: Vec<Value>,
    pub order: Value,
}

fn id_of(e: &Value) -> Option<&str> {
    e.get("id").and_then(|v| v.as_str())
}
fn updated_of(e: &Value) -> u64 {
    e.get("updated").and_then(|v| v.as_f64()).filter(|v| v.is_finite() && *v > 0.0).map(|v| v as u64).unwrap_or(0)
}
fn device_of(e: &Value) -> &str {
    e.get("device").and_then(|v| v.as_str()).unwrap_or("")
}
fn is_deleted(e: &Value) -> bool {
    e.get("deleted").and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Nur harmlose IDs (wie sanitize in der Oberfläche) – alles andere wird übersprungen
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

/// Inhalt ohne Verwaltungsfelder – zum Vergleichen
fn content(e: &Value) -> Value {
    let mut m = e.as_object().cloned().unwrap_or_default();
    m.remove("updated");
    m.remove("device");
    Value::Object(m)
}

/// Einträge aus einem JSON-Wert holen: nur Objekte mit gültiger ID, doppelte IDs -> erster zählt
fn clean_entries(v: Option<&Value>) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    if let Some(arr) = v.and_then(|v| v.as_array()) {
        for e in arr.iter().take(MAX_ENTRIES) {
            let Some(id) = id_of(e) else { continue };
            if !e.is_object() || !valid_id(id) || !seen.insert(id.to_string()) {
                continue;
            }
            out.push(e.clone());
        }
    }
    out
}

fn clean_order(v: Option<&Value>) -> Value {
    let ids: Vec<Value> = v
        .and_then(|o| o.get("ids"))
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter(|x| x.as_str().map(valid_id).unwrap_or(false)).take(MAX_ENTRIES).cloned().collect())
        .unwrap_or_default();
    let updated = v.map(updated_of).unwrap_or(0);
    let device = v.map(device_of).unwrap_or("");
    json!({ "ids": ids, "updated": updated, "device": device })
}

/// Text (Datei im Ordner oder Stand der Oberfläche) lesen. None = kaputt / falsches Format.
pub fn parse_doc(text: &str) -> Option<Doc> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let o = v.as_object()?;
    if o.get("format").and_then(|f| f.as_str()) != Some(FORMAT) {
        return None;
    }
    if !o.get("entries").map(|e| e.is_array()).unwrap_or(false) {
        return None;
    }
    Some(Doc { entries: clean_entries(o.get("entries")), order: clean_order(o.get("order")) })
}

/// Wer gewinnt? true = b ersetzt a
fn newer(a: &Value, b: &Value) -> bool {
    let (ua, ub) = (updated_of(a), updated_of(b));
    if ua != ub {
        return ub > ua;
    }
    let (da, db) = (device_of(a), device_of(b));
    if da != db {
        return db > da;
    }
    // gleiche Zeit, gleiches Gerät (sollte nie vorkommen): fest nach Inhalt, damit beide gleich entscheiden
    content(b).to_string() > content(a).to_string()
}

/// Kurzes, harmloses Kennzeichen eines Geräts für die neue ID einer Kopie
fn device_tag(d: &str) -> String {
    let t: String = d.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect();
    if t.is_empty() { "copy".into() } else { t }
}

/**
 * Abgleich: lokaler Stand + Stand im Ordner -> gemeinsamer Stand (für beide gleich).
 * `now` in ms (für das Aufräumen alter Grabsteine). Summary zählt, was sich LOKAL ändert.
 */
pub fn merge(local: &Doc, remote: &Doc, now: u64) -> (Doc, Summary) {
    let mut sum = Summary::default();
    let lmap: HashMap<&str, &Value> = local.entries.iter().filter_map(|e| id_of(e).map(|i| (i, e))).collect();
    let rmap: HashMap<&str, &Value> = remote.entries.iter().filter_map(|e| id_of(e).map(|i| (i, e))).collect();

    // alle IDs in fester Reihenfolge: erst lokal, dann neue aus dem Ordner
    let mut ids: Vec<&str> = Vec::new();
    let mut seen = BTreeSet::new();
    for e in local.entries.iter().chain(remote.entries.iter()) {
        if let Some(i) = id_of(e) {
            if seen.insert(i) {
                ids.push(i);
            }
        }
    }

    let mut out: Vec<Value> = Vec::new();
    let mut extra: Vec<Value> = Vec::new(); // Kopien bei alten Einträgen mit gleicher ID
    for id in ids {
        let l = lmap.get(id).copied();
        let r = rmap.get(id).copied();
        let pick = match (l, r) {
            (Some(l), None) => l.clone(),
            (None, Some(r)) => {
                if !is_deleted(r) {
                    sum.added += 1;
                }
                r.clone()
            }
            (Some(l), Some(r)) => {
                if content(l) == content(r) {
                    // gleicher Inhalt: nur die Verwaltungsfelder angleichen (neuere Zeit)
                    if newer(l, r) { r.clone() } else { l.clone() }
                } else if updated_of(l) == 0 && updated_of(r) == 0 && !is_deleted(l) && !is_deleted(r) {
                    // beide aus der Zeit vor dem Sync: nichts wegwerfen, Verlierer als Kopie behalten
                    let (win, lose) = if newer(l, r) { (r, l) } else { (l, r) };
                    let mut copy = lose.clone();
                    let mut cid = format!("{}_{}", id, device_tag(device_of(lose)));
                    cid.truncate(64);
                    copy["id"] = Value::String(cid);
                    copy["updated"] = json!(1);
                    extra.push(copy);
                    if std::ptr::eq(win, r) {
                        sum.updated += 1;
                    } else {
                        sum.copies += 1; // die Kopie des anderen Rechners kommt hier dazu
                    }
                    win.clone()
                } else if newer(l, r) {
                    match (is_deleted(l), is_deleted(r)) {
                        (false, true) => sum.removed += 1,
                        (true, false) => sum.added += 1,
                        (false, false) => sum.updated += 1,
                        (true, true) => {}
                    }
                    r.clone()
                } else {
                    l.clone()
                }
            }
            (None, None) => continue,
        };
        out.push(pick);
    }
    // Kopien nur, wenn die neue ID frei ist (sonst gibt es sie schon von einem früheren Abgleich)
    for c in extra {
        let cid = id_of(&c).unwrap_or("").to_string();
        if !out.iter().any(|e| id_of(e) == Some(cid.as_str())) {
            out.push(c);
        }
    }
    // alte Grabsteine aufräumen
    out.retain(|e| !(is_deleted(e) && updated_of(e) + TOMBSTONE_MS < now));
    out.truncate(MAX_ENTRIES);

    let order = merge_order(&local.order, &remote.order, &out);
    (Doc { entries: out, order }, sum)
}

/// Reihenfolge: die neuere Liste gewinnt, fehlende (lebende) Einträge kommen hinten dran
fn merge_order(l: &Value, r: &Value, entries: &[Value]) -> Value {
    let win = if newer(l, r) { r } else { l };
    let alive: Vec<&str> = entries.iter().filter(|e| !is_deleted(e)).filter_map(id_of).collect();
    let alive_set: BTreeSet<&str> = alive.iter().copied().collect();
    let mut ids: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    let lists = [win, if std::ptr::eq(win, l) { r } else { l }];
    for list in lists {
        for x in list.get("ids").and_then(|a| a.as_array()).into_iter().flatten() {
            if let Some(s) = x.as_str() {
                if alive_set.contains(s) && seen.insert(s.to_string()) {
                    ids.push(s.to_string());
                }
            }
        }
    }
    for s in alive {
        if seen.insert(s.to_string()) {
            ids.push(s.to_string());
        }
    }
    json!({ "ids": ids, "updated": updated_of(win), "device": device_of(win) })
}

fn doc_json(kind: &str, d: &Doc, device: &str, device_name: &str, now: u64) -> String {
    let v = json!({
        "format": FORMAT, "version": 1, "kind": kind, "saved": now,
        "writer": { "device": device, "name": device_name },
        "order": d.order, "entries": d.entries,
    });
    serde_json::to_string_pretty(&v).unwrap_or_default() + "\n"
}

// ---------------------------------------------------------------------
// Dateien im gemeinsamen Ordner
// ---------------------------------------------------------------------

/// Datei sicher schreiben: erst daneben als .tmp, dann umbenennen (kein halber Stand im Ordner)
fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data)?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path)
}

fn sync_dir(folder: &Path) -> io::Result<PathBuf> {
    if !folder.is_absolute() || !folder.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "folder-missing"));
    }
    let d = folder.join(SUB_DIR);
    fs::create_dir_all(&d)?;
    Ok(d)
}

/// Sperre: Datei .lock neu anlegen (schlägt fehl, wenn der andere Rechner gerade schreibt)
struct Lock(PathBuf);

impl Lock {
    fn take(dir: &Path, device: &str) -> io::Result<Lock> {
        let p = dir.join(".lock");
        for _ in 0..LOCK_TRIES {
            match fs::OpenOptions::new().write(true).create_new(true).open(&p) {
                Ok(mut f) => {
                    use std::io::Write;
                    let _ = f.write_all(device.as_bytes());
                    return Ok(Lock(p));
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    let old = fs::metadata(&p)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| SystemTime::now().duration_since(t).ok())
                        .map(|age| age > LOCK_STALE)
                        .unwrap_or(false);
                    if old {
                        let _ = fs::remove_file(&p);
                        continue;
                    }
                    std::thread::sleep(LOCK_WAIT);
                }
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(io::ErrorKind::WouldBlock, "busy"))
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Ergebnis für die Oberfläche
#[derive(serde::Serialize)]
pub struct SyncResult {
    pub entries: Vec<Value>,
    pub order: Value,
    pub summary: Summary,
    /// Gerät, das die Datei im Ordner zuletzt geschrieben hatte (Name, nur zur Anzeige)
    pub from: String,
}

fn read_remote(path: &Path) -> (Option<String>, bool) {
    match fs::metadata(path) {
        Err(_) => (None, false),
        Ok(m) if m.len() > MAX_BYTES => (None, true),
        Ok(_) => match fs::read_to_string(path) {
            Ok(s) => (Some(s), false),
            Err(_) => (None, true),
        },
    }
}

/**
 * Eine Bibliothek abgleichen: Sperre nehmen, Datei im Ordner lesen, mit `local` (Text im
 * Sync-Format) mischen, Ergebnis zurückschreiben (nur wenn anders), Sperre freigeben.
 * Eine kaputte Datei wird als <art>.broken-<ms>.json beiseitegelegt und nicht beachtet.
 */
pub fn sync_kind(folder: &Path, kind: &str, local: &str, device: &str, device_name: &str, now: u64) -> io::Result<SyncResult> {
    if !KINDS.contains(&kind) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "kind"));
    }
    let local = parse_doc(local).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "local"))?;
    let dir = sync_dir(folder)?;
    let _lock = Lock::take(&dir, device)?;
    let path = dir.join(format!("{}.json", kind));
    let (text, mut broken) = read_remote(&path);
    let mut from = String::new();
    let remote = match text.as_deref() {
        None => Doc { entries: vec![], order: clean_order(None) },
        Some(t) => match parse_doc(t) {
            Some(d) => {
                from = serde_json::from_str::<Value>(t)
                    .ok()
                    .and_then(|v| v.pointer("/writer/name").and_then(|n| n.as_str()).map(|s| s.chars().take(60).collect()))
                    .unwrap_or_default();
                d
            }
            None => {
                broken = true;
                Doc { entries: vec![], order: clean_order(None) }
            }
        },
    };
    if broken && path.exists() {
        let _ = fs::rename(&path, dir.join(format!("{}.broken-{}.json", kind, now)));
    }
    let (merged, mut summary) = merge(&local, &remote, now);
    summary.broken = broken;
    if broken || merged != remote {
        write_atomic(&path, doc_json(kind, &merged, device, device_name, now).as_bytes())?;
    }
    Ok(SyncResult { entries: merged.entries, order: merged.order, summary, from })
}

/// Sicherung vor dem Abgleich (libraryBackup-Format) in <App-Daten>/backups/library-sync-…json
pub fn write_backup(app_dir: &Path, data: &str, secs: u64) -> io::Result<PathBuf> {
    if data.len() as u64 > MAX_BYTES * 3 || data.trim().is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "backup"));
    }
    let bdir = app_dir.join(crate::store::BACKUP_DIR);
    fs::create_dir_all(&bdir)?;
    let s = secs % 86_400;
    let name = format!("library-sync-{}-{:02}{:02}{:02}.json", crate::store::date_string(secs), s / 3600, (s / 60) % 60, s % 60);
    let p = bdir.join(name);
    write_atomic(&p, data.as_bytes())?;
    // aufräumen: nur die neuesten behalten (Name enthält Datum + Uhrzeit -> Textsortierung reicht)
    let mut all: Vec<PathBuf> = fs::read_dir(&bdir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("library-sync-") && n.ends_with(".json")).unwrap_or(false))
        .collect();
    all.sort();
    all.reverse();
    for old in all.into_iter().skip(KEEP_BACKUPS) {
        let _ = fs::remove_file(old);
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(id: &str, name: &str, updated: u64, device: &str) -> Value {
        json!({ "id": id, "name": name, "updated": updated, "device": device })
    }
    fn tomb(id: &str, updated: u64, device: &str) -> Value {
        json!({ "id": id, "deleted": true, "updated": updated, "device": device })
    }
    fn doc(entries: Vec<Value>) -> Doc {
        Doc { entries, order: clean_order(None) }
    }
    fn find<'a>(d: &'a Doc, id: &str) -> Option<&'a Value> {
        d.entries.iter().find(|x| id_of(x) == Some(id))
    }
    fn name(d: &Doc, id: &str) -> String {
        find(d, id).and_then(|x| x["name"].as_str()).unwrap_or("").to_string()
    }
    const NOW: u64 = 1_800_000_000_000;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cnc-libsync-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn local_text(entries: Vec<Value>) -> String {
        json!({ "format": FORMAT, "entries": entries, "order": { "ids": [], "updated": 0 } }).to_string()
    }

    #[test]
    fn newer_wins() {
        let l = doc(vec![e("t1", "alt", 100, "a"), e("t2", "neu hier", 500, "a")]);
        let r = doc(vec![e("t1", "neu dort", 200, "b"), e("t2", "alt dort", 300, "b")]);
        let (m, s) = merge(&l, &r, NOW);
        assert_eq!(name(&m, "t1"), "neu dort");
        assert_eq!(name(&m, "t2"), "neu hier");
        assert_eq!(s.updated, 1);
        assert_eq!(s.added, 0);
        // andersherum gemischt -> gleiches Ergebnis (beide Rechner kommen zum selben Stand)
        let (m2, _) = merge(&r, &l, NOW);
        assert_eq!(name(&m2, "t1"), "neu dort");
        assert_eq!(name(&m2, "t2"), "neu hier");
    }

    #[test]
    fn added_from_other_side() {
        let l = doc(vec![e("t1", "a", 100, "a")]);
        let r = doc(vec![e("t1", "a", 100, "a"), e("t9", "neu", 50, "b")]);
        let (m, s) = merge(&l, &r, NOW);
        assert_eq!(m.entries.len(), 2);
        assert_eq!(s.added, 1);
        assert!(s.local_changed());
    }

    #[test]
    fn tombstone_beats_older_and_stays() {
        let l = doc(vec![tomb("t1", NOW - 1000 + 300, "a")]);
        let r = doc(vec![e("t1", "noch da", NOW - 1000 + 200, "b")]);
        let (m, s) = merge(&l, &r, NOW);
        assert!(is_deleted(find(&m, "t1").unwrap()));
        assert_eq!(s.removed, 0); // lokal war es schon weg
        // andere Seite: Löschung kommt an
        let (m2, s2) = merge(&r, &l, NOW);
        assert!(is_deleted(find(&m2, "t1").unwrap()));
        assert_eq!(s2.removed, 1);
        // nach der Löschung bearbeitet -> kommt zurück
        let r3 = doc(vec![e("t1", "bearbeitet", NOW - 1000 + 400, "b")]);
        let (m3, s3) = merge(&l, &r3, NOW);
        assert!(!is_deleted(find(&m3, "t1").unwrap()));
        assert_eq!(s3.added, 1);
    }

    #[test]
    fn old_tombstones_pruned() {
        let l = doc(vec![tomb("t1", NOW - TOMBSTONE_MS - 1, "a"), tomb("t2", NOW - 1000, "a")]);
        let (m, _) = merge(&l, &doc(vec![]), NOW);
        assert!(find(&m, "t1").is_none());
        assert!(find(&m, "t2").is_some());
    }

    #[test]
    fn conflict_on_both_sides_same_time() {
        // beide haben denselben Eintrag zur selben Zeit anders geändert -> größere Gerätekennung gewinnt, überall gleich
        let l = doc(vec![e("t1", "Büro", 700, "aaa")]);
        let r = doc(vec![e("t1", "Werkstatt", 700, "zzz")]);
        let (m1, _) = merge(&l, &r, NOW);
        let (m2, _) = merge(&r, &l, NOW);
        assert_eq!(name(&m1, "t1"), "Werkstatt");
        assert_eq!(name(&m2, "t1"), "Werkstatt");
        assert_eq!(m1.entries.len(), 1);
    }

    #[test]
    fn same_id_different_content_without_time_keeps_both() {
        // alte Bibliotheken (vor dem Sync): t1 heißt auf beiden Rechnern anders
        let l = doc(vec![e("t1", "3 mm Büro", 0, "aaa")]);
        let r = doc(vec![e("t1", "3 mm Werkstatt", 0, "zzz")]);
        let (m1, s1) = merge(&l, &r, NOW);
        assert_eq!(name(&m1, "t1"), "3 mm Werkstatt");
        assert_eq!(name(&m1, "t1_aaa"), "3 mm Büro");
        assert_eq!(s1.updated, 1);
        // der andere Rechner mischt danach den Stand aus dem Ordner -> nichts Neues, keine weitere Kopie
        let (m2, s2) = merge(&r, &m1, NOW);
        assert_eq!(m2.entries.len(), 2);
        assert_eq!(s2.added, 1);
        let (m3, _) = merge(&m2, &m1, NOW);
        assert_eq!(m3.entries.len(), 2);
        // gleicher Inhalt ohne Zeit -> keine Kopie
        let (m4, s4) = merge(&doc(vec![e("t2", "x", 0, "aaa")]), &doc(vec![e("t2", "x", 0, "zzz")]), NOW);
        assert_eq!(m4.entries.len(), 1);
        assert!(!s4.local_changed());
    }

    #[test]
    fn bad_entries_ignored() {
        let d = parse_doc(r#"{"format":"cnc-craft-sync","entries":[{"id":"ok"},{"id":"<script>"},{"name":"ohne id"},5,{"id":"ok","name":"doppelt"}]}"#).unwrap();
        assert_eq!(d.entries.len(), 1);
        assert!(parse_doc("{kaputt").is_none());
        assert!(parse_doc(r#"{"format":"other","entries":[]}"#).is_none());
    }

    #[test]
    fn order_newer_wins_and_new_entries_appended() {
        let mut l = doc(vec![e("a", "a", 1, "x"), e("b", "b", 1, "x"), e("c", "c", 1, "x")]);
        l.order = json!({ "ids": ["a", "b", "c"], "updated": 10, "device": "x" });
        let mut r = doc(vec![e("a", "a", 1, "x"), e("b", "b", 1, "x"), e("d", "d", 1, "y")]);
        r.order = json!({ "ids": ["b", "a", "d"], "updated": 20, "device": "y" });
        let (m, _) = merge(&l, &r, NOW);
        assert_eq!(m.order["ids"], json!(["b", "a", "d", "c"]));
    }

    #[test]
    fn sync_files_broken_file_and_lock() {
        let dir = tmpdir("files");
        // erster Rechner legt die Datei an
        let r1 = sync_kind(&dir, "tools", &local_text(vec![e("t1", "Büro", 100, "aaa")]), "aaa", "Büro", NOW).unwrap();
        assert_eq!(r1.entries.len(), 1);
        let file = dir.join(SUB_DIR).join("tools.json");
        assert!(file.exists());
        assert!(!dir.join(SUB_DIR).join(".lock").exists());
        // zweiter Rechner bekommt den Eintrag und sieht, von wem er kommt
        let r2 = sync_kind(&dir, "tools", &local_text(vec![]), "zzz", "Werkstatt", NOW).unwrap();
        assert_eq!(r2.summary.added, 1);
        assert_eq!(r2.from, "Büro");
        // kaputte Datei: wird beiseitegelegt, der lokale Stand wird neu geschrieben
        fs::write(&file, "{ kaputt").unwrap();
        let r3 = sync_kind(&dir, "tools", &local_text(vec![e("t1", "Büro", 100, "aaa")]), "aaa", "Büro", NOW + 1).unwrap();
        assert!(r3.summary.broken);
        assert_eq!(r3.entries.len(), 1);
        assert!(parse_doc(&fs::read_to_string(&file).unwrap()).is_some());
        assert!(fs::read_dir(dir.join(SUB_DIR)).unwrap().any(|x| x.unwrap().file_name().to_string_lossy().starts_with("tools.broken-")));
        // fremde Sperre (frisch) -> "busy"; alte Sperre wird weggeräumt
        let lock = dir.join(SUB_DIR).join(".lock");
        fs::write(&lock, "other").unwrap();
        let t = std::time::Instant::now();
        let busy = sync_kind(&dir, "tools", &local_text(vec![]), "aaa", "Büro", NOW);
        assert!(busy.is_err());
        assert!(t.elapsed() >= LOCK_WAIT * (LOCK_TRIES - 1));
        let _ = fs::remove_file(&lock);
        // unbekannte Art / fehlender Ordner
        assert!(sync_kind(&dir, "evil", &local_text(vec![]), "aaa", "", NOW).is_err());
        assert!(sync_kind(&dir.join("fehlt"), "tools", &local_text(vec![]), "aaa", "", NOW).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backups_rotate() {
        let dir = tmpdir("bak");
        for i in 0..(KEEP_BACKUPS as u64 + 5) {
            write_backup(&dir, "{\"x\":1}", 1_792_108_800 + i).unwrap();
        }
        let n = fs::read_dir(dir.join("backups")).unwrap().count();
        assert_eq!(n, KEEP_BACKUPS);
        let _ = fs::remove_dir_all(&dir);
    }
}
