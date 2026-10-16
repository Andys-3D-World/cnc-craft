//! USB-Zugriff auf das K40-Board (CH341 im Parallel-/EPP-Modus, 1a86:5512) über libusb (rusb).
//!
//! macOS: kein Treiber nötig.  Linux: udev-Regel für 1a86:5512 (Zugriff ohne root).
//! Windows: Das Board braucht den WinUSB-/libusb-Treiber (z. B. mit Zadig einrichten) statt
//! des chinesischen CH341PAR-Treibers – wie bei MeerK40t mit libusb.

use crate::k40::{Ch341, USB_PID, USB_VID};
use rusb::{DeviceHandle, GlobalContext};
use std::time::Duration;

const EP_OUT: u8 = 0x02;
const EP_IN: u8 = 0x82;
const TIMEOUT: Duration = Duration::from_millis(1500);

pub struct K40Usb {
    h: DeviceHandle<GlobalContext>,
    desc: String,
}

fn why(e: rusb::Error) -> String {
    match e {
        rusb::Error::Access => "k40-access".into(),
        rusb::Error::Busy => "k40-busy".into(),
        rusb::Error::NotFound | rusb::Error::NoDevice => "k40-notfound".into(),
        other => other.to_string(),
    }
}

/// Anzahl gefundener K40-Boards
pub fn count() -> usize {
    match rusb::devices() {
        Ok(list) => list.iter().filter(|d| d.device_descriptor().map(|dd| dd.vendor_id() == USB_VID && dd.product_id() == USB_PID).unwrap_or(false)).count(),
        Err(_) => 0,
    }
}

/// Board öffnen (index = welches, falls mehrere) und in den EPP-1.9-Modus schalten
pub fn open(index: usize) -> Result<K40Usb, String> {
    let list = rusb::devices().map_err(why)?;
    let dev = list
        .iter()
        .filter(|d| d.device_descriptor().map(|dd| dd.vendor_id() == USB_VID && dd.product_id() == USB_PID).unwrap_or(false))
        .nth(index)
        .ok_or_else(|| "k40-notfound".to_string())?;
    let h = dev.open().map_err(why)?;
    let _ = h.set_auto_detach_kernel_driver(true); // nur Linux, sonst egal
    let _ = h.set_active_configuration(1);
    h.claim_interface(0).map_err(why)?;
    // CH341InitParallel(EPP 1.9): Vendor-Write 0xB1, Wert 0x0102
    h.write_control(0x40, 0xB1, 0x0102, 0, &[], TIMEOUT).map_err(why)?;
    let desc = format!("K40 USB (Bus {}, Adresse {})", dev.bus_number(), dev.address());
    Ok(K40Usb { h, desc })
}

impl Ch341 for K40Usb {
    fn bulk_write(&mut self, data: &[u8]) -> Result<(), String> {
        let t = if data.len() > 1 { Duration::from_secs(60) } else { TIMEOUT };
        self.h.write_bulk(EP_OUT, data, t).map(|_| ()).map_err(why)
    }
    fn bulk_read(&mut self, n: usize) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; n];
        let k = self.h.read_bulk(EP_IN, &mut buf, TIMEOUT).map_err(why)?;
        buf.truncate(k);
        Ok(buf)
    }
    fn describe(&self) -> String { self.desc.clone() }
}

impl Drop for K40Usb {
    fn drop(&mut self) {
        let _ = self.h.release_interface(0);
    }
}
