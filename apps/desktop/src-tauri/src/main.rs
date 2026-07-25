#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod devices;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

/// Count of unacknowledged critical alerts, surfaced on the tray icon.
struct AlertCounter(Arc<AtomicU32>);

#[tauri::command]
fn set_alert_count(app: tauri::AppHandle, state: tauri::State<AlertCounter>, count: u32) {
    state.0.store(count, Ordering::Relaxed);

    let title = if count == 0 {
        String::new()
    } else {
        count.to_string()
    };

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(Some(&title));
        let _ = tray.set_tooltip(Some(&if count == 0 {
            "MediCore — no active alerts".to_string()
        } else {
            format!("MediCore — {count} active alert(s)")
        }));
    }

    // A critical alert must raise and focus the window even if it is minimised.
    if count > 0 {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
            let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
        }
    }
}

#[tauri::command]
fn alert_count(state: tauri::State<AlertCounter>) -> u32 {
    state.0.load(Ordering::Relaxed)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AlertCounter(Arc::new(AtomicU32::new(0))))
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Open MediCore", true, None::<&str>)?;
            let sync = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &sync, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("MediCore")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "sync" => {
                        let _ = app.emit("medicore://sync-requested", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_alert_count,
            alert_count,
            devices::list_barcode_scanners,
            devices::list_serial_ports,
            devices::print_zpl_label,
            devices::list_card_readers,
            devices::read_card_atr,
            devices::scan_document,
            devices::local_sync_status,
        ])
        .on_window_event(|window, event| {
            // Closing hides to tray; a clinician's session should survive a stray click.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running MediCore desktop");
}
