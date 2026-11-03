#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Linux: WebKitGTK's DMA-BUF renderer shows a black window or garbled text on many
    // graphics drivers (NVIDIA, some Wayland setups). Turn it off before GTK starts,
    // unless the user set the variable themselves.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    cnc_craft_lib::run();
}
