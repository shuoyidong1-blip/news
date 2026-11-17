#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Emitter;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = app.emit_to("main", "hotkey", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            // 他アプリと競合して登録できなくても起動は続ける
            let _ = app.global_shortcut().register("ctrl+alt+t");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TaskWidget");
}
