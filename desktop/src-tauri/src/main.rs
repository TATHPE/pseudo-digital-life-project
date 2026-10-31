// 壳的全部逻辑（H-6）。**一行业务逻辑都不许在这里** —— 见 desktop/README.md。
//
// 四件事：拉起 sidecar · 健康探测（三次失败→打开浏览器）· 托盘四项 · 退出时杀掉进程树。
//
// 基座来自 dieharders/example-tauri-v2-python-server-sidecar（Apache-2.0），
// 改动：Python → Node；窗口直接指内置面板；加托盘与浏览器回落。

mod sidecar;

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

use sidecar::Sidecar;

/// 全局只持有一个 sidecar 句柄：退出/托盘都要能杀掉它。
struct AppState {
    sidecar: Mutex<Option<Sidecar>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二次双击：聚焦已有窗口，不再起一个 sidecar
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { sidecar: Mutex::new(None) })
        .setup(|app| {
            // 数据目录：JJ_HOME 优先（开发/自测用现有库），否则用 AppData 下的独立目录
            let home = std::env::var("JJ_HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| {
                app.path().app_data_dir().map(|d| d.join("data")).unwrap_or_else(|_| std::env::current_dir().unwrap())
            });
            // 1) 拉起 sidecar：开发时 `node src/cli/jingjing.ts serve 7700`
            let mut sc = Sidecar::start(&home);
            // 2) 健康探测：不通就重启，三次失败 → 落回浏览器（记忆不丢，只是回到网页）
            match sc.wait_healthy() {
                Ok(()) => {
                    // 窗口加载时 sidecar 还没起来，会停在占位页；这里主动导航一次
                    if let Some(w) = app.get_webview_window("main") {
                        let url = format!("http://127.0.0.1:{}/desk", sc.port());
                        let _ = w.navigate(url.parse().unwrap());
                    }
                }
                Err(e) => {
                    eprintln!("[shell] sidecar 起不来：{e}；回落到浏览器");
                    sc.fallback_to_browser();
                }
            }
            *app.state::<AppState>().sidecar.lock().unwrap() = Some(sc);

            // 3) 托盘四项
            let toggle = MenuItem::with_id(app, "toggle", "暂停 / 继续心跳", true, None::<&str>)?;
            let open_dir = MenuItem::with_id(app, "open_dir", "打开数据目录", true, None::<&str>)?;
            let export = MenuItem::with_id(app, "export", "导出备份", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &open_dir, &export, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "toggle" => {
                        // 只调 CLI，不碰数据库（壳不该理解记忆）
                        let _ = std::process::Command::new(node_bin())
                            .args(["src/cli/jingjing.ts", "beat", "--toggle"])
                            .spawn();
                    }
                    "open_dir" => {
                        if let Ok(h) = app.path().app_data_dir() {
                            let _ = tauri_plugin_opener::open_path(h, None::<&str>);
                        }
                    }
                    "export" => {
                        let _ = std::process::Command::new(node_bin())
                            .args(["src/cli/jingjing.ts", "export"])
                            .spawn();
                    }
                    "quit" => {
                        // 退出前先杀 sidecar：否则 Node 会活着，下次启动端口占用
                        if let Some(sc) = app.state::<AppState>().sidecar.lock().unwrap().as_mut() {
                            sc.stop();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, ev| {
            if let WindowEvent::CloseRequested { .. } = ev {
                // 关窗 = 真的退出（含杀 sidecar）。不允许"窗口关了但进程还在偷偷跑"。
                if let Some(sc) = window.app_handle().state::<AppState>().sidecar.lock().unwrap().as_mut() {
                    sc.stop();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 开发期用 PATH 上的 node；打包后换成随包分发的二进制（见 sidecar.rs 的注释）
pub fn node_bin() -> String {
    std::env::var("JJ_NODE").unwrap_or_else(|_| "node".to_string())
}

fn main() {
    run();
}
