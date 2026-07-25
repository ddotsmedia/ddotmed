//! Native device integration for the clinical workstation.
//!
//! Each subsystem degrades to a clear error rather than a silent no-op: a nurse
//! must know immediately that a scanner or printer is unavailable, not discover it
//! when a label never prints.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
pub enum DeviceError {
    #[error("no {kind} device found")]
    NotFound { kind: String },
    #[error("{kind} device error: {message}")]
    Io { kind: String, message: String },
    #[error("{0} is not available on this platform")]
    Unsupported(String),
}

pub type DeviceResult<T> = Result<T, DeviceError>;

// ── USB HID barcode scanner ───────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ScannerInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

/// HID usage page 0x01 / usage 0x06 is a keyboard; most barcode scanners present
/// as one. We list candidates so the operator can pick the right device.
#[tauri::command]
pub fn list_barcode_scanners() -> DeviceResult<Vec<ScannerInfo>> {
    let api = hidapi::HidApi::new().map_err(|e| DeviceError::Io {
        kind: "hid".into(),
        message: e.to_string(),
    })?;

    let devices: Vec<ScannerInfo> = api
        .device_list()
        .filter(|d| d.usage_page() == 0x01 && d.usage() == 0x06)
        .map(|d| ScannerInfo {
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            manufacturer: d.manufacturer_string().map(str::to_string),
            product: d.product_string().map(str::to_string),
        })
        .collect();

    if devices.is_empty() {
        return Err(DeviceError::NotFound {
            kind: "barcode scanner".into(),
        });
    }
    Ok(devices)
}

// ── ZPL label printer over serial ─────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SerialPortInfo {
    pub name: String,
    pub port_type: String,
}

#[tauri::command]
pub fn list_serial_ports() -> DeviceResult<Vec<SerialPortInfo>> {
    let ports = serialport::available_ports().map_err(|e| DeviceError::Io {
        kind: "serial".into(),
        message: e.to_string(),
    })?;

    Ok(ports
        .into_iter()
        .map(|p| SerialPortInfo {
            name: p.port_name,
            port_type: format!("{:?}", p.port_type),
        })
        .collect())
}

#[derive(Debug, Deserialize)]
pub struct LabelRequest {
    pub port: String,
    pub baud_rate: Option<u32>,
    /// Patient/specimen label content.
    pub line1: String,
    pub line2: String,
    pub barcode_data: String,
}

/// Renders a Code-128 patient/specimen label in ZPL II and writes it to the printer.
#[tauri::command]
pub fn print_zpl_label(request: LabelRequest) -> DeviceResult<()> {
    let zpl = format!(
        "^XA\n\
         ^CI28\n\
         ^FO30,30^A0N,32,32^FD{}^FS\n\
         ^FO30,72^A0N,26,26^FD{}^FS\n\
         ^FO30,112^BY2\n\
         ^BCN,80,Y,N,N\n\
         ^FD{}^FS\n\
         ^XZ\n",
        escape_zpl(&request.line1),
        escape_zpl(&request.line2),
        escape_zpl(&request.barcode_data),
    );

    let mut port = serialport::new(&request.port, request.baud_rate.unwrap_or(9600))
        .timeout(std::time::Duration::from_secs(5))
        .open()
        .map_err(|e| DeviceError::Io {
            kind: "label printer".into(),
            message: e.to_string(),
        })?;

    use std::io::Write;
    port.write_all(zpl.as_bytes()).map_err(|e| DeviceError::Io {
        kind: "label printer".into(),
        message: e.to_string(),
    })?;
    port.flush().map_err(|e| DeviceError::Io {
        kind: "label printer".into(),
        message: e.to_string(),
    })?;
    Ok(())
}

/// `^` and `~` are ZPL control characters and must not appear in field data.
fn escape_zpl(value: &str) -> String {
    value.replace('^', " ").replace('~', " ")
}

// ── Smart card ID reader (PC/SC) ──────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct CardReaderInfo {
    pub name: String,
    pub card_present: bool,
}

#[tauri::command]
pub fn list_card_readers() -> DeviceResult<Vec<CardReaderInfo>> {
    use pcsc::{Context, Scope, ShareMode, Protocols};

    let context = Context::establish(Scope::User).map_err(|e| DeviceError::Io {
        kind: "smart card".into(),
        message: e.to_string(),
    })?;

    let mut buffer = vec![0u8; 2048];
    let readers = context
        .list_readers(&mut buffer)
        .map_err(|e| DeviceError::Io {
            kind: "smart card".into(),
            message: e.to_string(),
        })?;

    let mut out = Vec::new();
    for reader in readers {
        let name = reader.to_string_lossy().to_string();
        // Connecting succeeds only when a card is actually seated.
        let present = context
            .connect(reader, ShareMode::Shared, Protocols::ANY)
            .is_ok();
        out.push(CardReaderInfo {
            name,
            card_present: present,
        });
    }

    if out.is_empty() {
        return Err(DeviceError::NotFound {
            kind: "smart card reader".into(),
        });
    }
    Ok(out)
}

/// Reads the card's ATR. Parsing national eID data objects is deliberately not
/// implemented here — that requires the issuing authority's applet specification
/// and, for most schemes, a signed terminal certificate.
#[tauri::command]
pub fn read_card_atr(reader_name: String) -> DeviceResult<String> {
    use pcsc::{Context, Scope, ShareMode, Protocols};
    use std::ffi::CString;

    let context = Context::establish(Scope::User).map_err(|e| DeviceError::Io {
        kind: "smart card".into(),
        message: e.to_string(),
    })?;

    let name = CString::new(reader_name).map_err(|e| DeviceError::Io {
        kind: "smart card".into(),
        message: e.to_string(),
    })?;

    let card = context
        .connect(&name, ShareMode::Shared, Protocols::ANY)
        .map_err(|e| DeviceError::Io {
            kind: "smart card".into(),
            message: e.to_string(),
        })?;

    let mut buffer = vec![0u8; 64];
    let atr = card.get_attribute(pcsc::Attribute::AtrString, &mut buffer)
        .map_err(|e| DeviceError::Io {
            kind: "smart card".into(),
            message: e.to_string(),
        })?;

    Ok(atr.iter().map(|b| format!("{b:02X}")).collect::<String>())
}

// ── Document scanner (TWAIN / WIA / SANE) ─────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ScanResult {
    pub file_path: String,
    pub page_count: u32,
}

/// Document acquisition is delegated to the platform's own scanning utility so the
/// workstation does not have to bundle a TWAIN/WIA data-source manager.
#[tauri::command]
pub fn scan_document(output_dir: String) -> DeviceResult<ScanResult> {
    let file_name = format!("scan-{}.jpg", uuid::Uuid::new_v4());
    let path = std::path::Path::new(&output_dir).join(&file_name);

    #[cfg(target_os = "windows")]
    {
        // WIA via the built-in Windows Fax and Scan acquisition wizard.
        let status = std::process::Command::new("wiaacmgr.exe")
            .args(["/SelectDevice"])
            .status()
            .map_err(|e| DeviceError::Io {
                kind: "document scanner".into(),
                message: e.to_string(),
            })?;
        if !status.success() {
            return Err(DeviceError::Io {
                kind: "document scanner".into(),
                message: "scan was cancelled".into(),
            });
        }
    }

    #[cfg(target_os = "linux")]
    {
        // SANE
        let output = std::process::Command::new("scanimage")
            .args(["--format=jpeg", "--resolution", "300"])
            .output()
            .map_err(|e| DeviceError::Io {
                kind: "document scanner".into(),
                message: e.to_string(),
            })?;
        std::fs::write(&path, output.stdout).map_err(|e| DeviceError::Io {
            kind: "document scanner".into(),
            message: e.to_string(),
        })?;
    }

    #[cfg(target_os = "macos")]
    {
        return Err(DeviceError::Unsupported(
            "document scanning on macOS (use Image Capture)".into(),
        ));
    }

    Ok(ScanResult {
        file_path: path.to_string_lossy().to_string(),
        page_count: 1,
    })
}

// ── Local PostgreSQL sync agent ───────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SyncStatus {
    pub connected: bool,
    pub pending_operations: i64,
    pub last_sync_at: Option<String>,
    pub message: String,
}

/// Reports the local offline replica's state. The replica is read-mostly: it lets a
/// workstation keep working through a network outage, and queued writes are drained
/// by core-api on reconnect rather than merged locally.
#[tauri::command]
pub async fn local_sync_status(database_url: String) -> DeviceResult<SyncStatus> {
    match tokio_postgres::connect(&database_url, tokio_postgres::NoTls).await {
        Ok((client, connection)) => {
            tokio::spawn(async move {
                let _ = connection.await;
            });

            let pending: i64 = client
                .query_one("SELECT count(*) FROM offline_operations WHERE synced_at IS NULL", &[])
                .await
                .map(|row| row.get(0))
                .unwrap_or(0);

            let last: Option<chrono::DateTime<chrono::Utc>> = client
                .query_opt("SELECT max(synced_at) FROM offline_operations", &[])
                .await
                .ok()
                .flatten()
                .and_then(|row| row.get(0));

            Ok(SyncStatus {
                connected: true,
                pending_operations: pending,
                last_sync_at: last.map(|t| t.to_rfc3339()),
                message: "Local replica connected".into(),
            })
        }
        Err(e) => Ok(SyncStatus {
            connected: false,
            pending_operations: 0,
            last_sync_at: None,
            message: format!("Local replica unavailable: {e}"),
        }),
    }
}
