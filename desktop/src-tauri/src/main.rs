// 壳的全部逻辑（H-6）。**一行业务逻辑都不许在这里** —— 见 desktop/README.md。
//
// 四件事：拉起 sidecar · 健康探测（起不来就**只弹报错**）· 托盘四项 · 退出时杀掉进程树。
//
// 2026-11-01 用户定：① 只有桌面端，不做浏览器入口；② 崩了只弹报错；
// ③ 「接 API 让 agent 修程序」那条路**不做**。所以这里没有回落浏览器，也没有自修。
//
// 基座来自 dieharders/example-tauri-v2-python-server-sidecar（Apache-2.0），
// 改动：Python → Node；窗口直接指内置面板（/，服务端会自己分流到首启引导）。

// 双击时不要弹控制台窗口：release 用 windows 子系统（GUI），debug 保留控制台方便看日志。
// 缺这一行时，release exe 是 console 程序 —— 双击就开一个黑框（用户看到的就是"又起了个 PowerShell"）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dpapi;
mod sidecar;

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

use sidecar::Sidecar;

/// 起不来时的错误页：把窗口内容换掉，而不是开浏览器。
/// 不用 dialog 插件（为一个错误框加一个依赖不值得）。
/// 壳的日志：GUI 没有控制台，出问题只能靠这个文件
fn shell_note(home: &std::path::Path, msg: &str) {
    use std::io::Write;
    let dir = home.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("shell.log")) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
}


/// 安装包里自带的运行环境（resources/app 与 resources/node）。
/// 开发态（仓库里跑）没有这两样，就退回「向上找项目根 + 系统 node」。
fn bundled_app_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let res = app.path().resource_dir().ok()?;
    let p = res.join("app");
    if p.join("src").join("cli").join("jingjing.ts").exists() { Some(p) } else { None }
}

fn bundled_node(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let res = app.path().resource_dir().ok()?;
    let p = res.join("node").join(if cfg!(windows) { "node.exe" } else { "node" });
    if p.exists() { Some(p) } else { None }
}
/// 项目根的判据：从 exe 向上找 `src/cli/jingjing.ts`。
/// 找不到（真安装之后）就返回 None —— 那时用 app_data_dir。
fn project_root_hint() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?;
    for _ in 0..8 {
        if dir.join("src").join("cli").join("jingjing.ts").exists() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
    None
}

fn show_boot_error(app: &tauri::AppHandle, err: &str, home: &std::path::Path) {
    let log = home.join("logs").join("serve.log");
    let text = format!(
        "Pseudo Digital Life Project 没能启动\n\n{}\n\n日志：{}\n\n可以试的：\n  1. 确认 node 在 PATH 上（node --version）\n  2. 手动跑一次看报错：node src/cli/jingjing.ts serve 7700\n  3. 数据目录：{}",
        err, log.display(), home.display()
    );
    let js = format!(
        "document.body.style.cssText='background:#0b0e0b;color:#e9f0f2;font:13px ui-monospace,Consolas,monospace;padding:36px;white-space:pre-wrap;line-height:1.7';document.body.textContent=\"{}\"",
        js_escape(&text)
    );
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&js);
    }
}

/// 把要注入 JS 字符串的文本转义（不做 HTML，只用 textContent）
fn js_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "")
}

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
            // 安装包自带运行环境时，先把它指给 sidecar（node 与项目根都从 resources 来）
            let bundled = bundled_app_dir(app.handle());
            if let Some(root) = &bundled {
                std::env::set_var("JJ_PROJECT_ROOT", root);
                if let Some(n) = bundled_node(app.handle()) { std::env::set_var("JJ_NODE", n); }
            }
            let home = std::env::var("JJ_HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| {
                // 安装态：永远用 AppData 下的独立目录（干净安装 → 会走新手引导）
                if bundled.is_some() {
                    return app.path().app_data_dir().map(|d| d.join("data")).unwrap_or_else(|_| std::env::current_dir().unwrap());
                }
                // 开发/测试期：项目根下的 data/（就是你聊过的那份）
                if let Some(root) = project_root_hint() {
                    let d = root.join("data");
                    if d.exists() { return d; }
                }
                // 安装之后：系统给的应用数据目录
                app.path().app_data_dir().map(|d| d.join("data")).unwrap_or_else(|_| std::env::current_dir().unwrap())
            });
            // 1) 拉起 sidecar：开发时 `node src/cli/jingjing.ts serve 7700`
            // 先把密钥解出来（DPAPI 在壳里做，Node 不用起 PowerShell → 不会再闪黑框）
            let secrets = dpapi::read_all(&home);
            if !secrets.is_empty() {
                shell_note(&home, &format!("解密了 {} 个 provider 的 key", secrets.len()));
            }
            let mut sc = Sidecar::start(&home, &secrets);
            // 2) 健康探测：不通就重启，三次失败 → 落回浏览器（记忆不丢，只是回到网页）
            match sc.wait_healthy() {
                Ok(()) => {
                    // 窗口加载时 sidecar 还没起来，会停在占位页；这里主动导航一次
                    if let Some(w) = app.get_webview_window("main") {
                        // 带令牌进来：服务端种 cookie 后一直有效；没令牌的页面请求一律 403
                        // （这就是"只有桌面端"的机制 —— 知道端口也打不开）
                        let token = sc.token();
                        let url = format!("http://127.0.0.1:{}/?k={}", sc.port(), token);
                        let _ = w.navigate(url.parse().unwrap());
                    }
                }
                Err(e) => {
                    // 只弹报错：不做浏览器回落，也不做接 API 自修。
                    // 说清两件事就够了 —— 哪一步失败、日志在哪。
                    eprintln!("[shell] sidecar 起不来：{e}");
                    show_boot_error(app.handle(), &e, &home);
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
