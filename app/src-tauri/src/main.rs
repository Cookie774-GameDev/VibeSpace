// Prevents an extra console window from spawning on Windows in release builds.
// The webview is still our visible UI; we don't need a parent terminal.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jarvis_lib::run();
}
