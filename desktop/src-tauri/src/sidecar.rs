// sidecar：壳唯一被允许"碰"的东西。三次纪律：
//   ① 端口被占就先探活（可能上次没杀干净）——能连上就复用，不再起第二个
//   ② 探测最多 3 次，每次间隔 500ms；仍不通就落回浏览器
//   ③ stop() 必须杀**进程树**（Windows 上 node 会派生子进程；只杀父进程会留孤儿）

use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// 端口不再是常量：`serve 0` 让 OS 分配，node 把真实端口和令牌写进 data/.desk.json。
/// 这样"知道 7700 就能用浏览器打开"这件事从根上不存在（2026-11-01）。
pub const DESK_FILE: &str = ".desk.json";

/// 从 data/.desk.json 读 (port, token)。没有/损坏都返回 None。
fn read_desk(home: &std::path::Path) -> Option<(u16, String)> {
    let text = std::fs::read_to_string(home.join(DESK_FILE)).ok()?;
    let grab = |key: &str| -> Option<String> {
        let i = text.find(&format!("\"{}\"", key))?;
        let rest = &text[i + key.len() + 2..];
        let colon = rest.find(':')?;
        let after = rest[colon + 1..].trim_start();
        if after.starts_with('"') {
            let end = after[1..].find('"')?;
            Some(after[1..1 + end].to_string())
        } else {
            let end = after.find(|c: char| !c.is_ascii_digit()).unwrap_or(after.len());
            Some(after[..end].to_string())
        }
    };
    let port: u16 = grab("port")?.parse().ok()?;
    let token = grab("token")?;
    Some((port, token))
}

/// 壳的日志：GUI 进程没有控制台，出问题只能靠这个文件。
/// 写在 `<home>/logs/shell.log`，每次启动 append 一行时间戳。
fn shell_log(home: &std::path::Path, msg: &str) {
    use std::io::Write;
    let dir = home.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("shell.log")) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
}

/// 从 exe 所在目录一路向上找项目根（看见 `src/cli/jingjing.ts` 就算到）。
/// 双击 exe 时 cwd 是 exe 目录，相对路径的 node 脚本会找不到 —— 所以必须显式指定。
fn find_project_root() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?;
    for _ in 0..8 {
        if dir.join("src").join("cli").join("jingjing.ts").exists() {
            return Some(dir.to_path_buf());
        }
        // 也认 JJ_PROJECT_ROOT 这种显式指定
        if let Ok(p) = std::env::var("JJ_PROJECT_ROOT") {
            let pb = std::path::PathBuf::from(p);
            if pb.join("src").join("cli").join("jingjing.ts").exists() { return Some(pb); }
        }
        dir = dir.parent()?;
    }
    None
}

pub struct Sidecar {
    child: Option<Child>,
    port: u16,
    home: std::path::PathBuf,
}

impl Sidecar {
    /// 启动：起 node `serve 0`（端口由 OS 分配），然后把 .desk.json 里的端口/令牌读回来。
    pub fn start(home: &std::path::Path) -> Self {
        // 上一次没退干净的，把残留的 .desk.json 删掉，免得读到旧端口
        let _ = std::fs::remove_file(home.join(DESK_FILE));
        let port = 0;

        let node = std::env::var("JJ_NODE").unwrap_or_else(|_| "node".to_string());
        let mut cmd = Command::new(&node);
        shell_log(home, &format!("start: exe={:?} cwd={:?}", std::env::current_exe().ok(), std::env::current_dir().ok()));
        if let Some(root) = find_project_root() {
            shell_log(home, &format!("project_root={:?}", root));
            cmd.current_dir(&root);
        } else {
            eprintln!("[shell] 找不到项目根（src/cli/jingjing.ts）—— 试着设 JJ_PROJECT_ROOT");
        }
        cmd.args(["--experimental-strip-types", "src/cli/jingjing.ts", "serve", "0"])
            .env("JJ_HOME", home)
            // 看门狗：壳被硬杀（任务管理器/崩溃）时，node 也要跟着退，不能变孤儿占着 7700
            .env("JJ_PARENT_PID", std::process::id().to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // 不弹黑框：Windows 上加 CREATE_NO_WINDOW
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let child = cmd.spawn().ok();
        match &child {
            Some(c) => shell_log(home, &format!("spawn ok pid={}", c.id())),
            None => shell_log(home, "spawn FAILED (node 不在 PATH？)"),
        }
        Self { child, port, home: home.to_path_buf() }
    }

    /// 等它活过来：读 data/.desk.json 拿端口，再探 /health。
    ///
    /// 预算是 **10 秒**（20 × 500ms），不是 1.5 秒 —— 实测 Node 起 serve 要 3–4 秒，
    /// 原来 3 × 500ms 会把它误判成「起不来」，然后白白打开一次浏览器（踩过）。
    /// 但如果子进程已经退出（真崩了），就别傻等。
    pub fn wait_healthy(&mut self) -> Result<(), String> {
        for _ in 0..24 {
            // node 起来后会写 data/.desk.json（端口 + 令牌）。先看文件，再探活。
            if self.port == 0 {
                if let Some((port, _)) = read_desk(self.home.as_path()) { self.port = port; }
            }
            if self.port != 0 && healthy(self.port) {
                shell_log(&self.home, &format!("healthy port={} token_len={}", self.port, self.token().len()));
                return Ok(());
            }
            if let Some(c) = self.child.as_mut() {
                if matches!(c.try_wait(), Ok(Some(_))) {
                    return Err("sidecar 进程已退出（看桌面/终端里的报错）".to_string());
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        Err("10 秒内端口都没通".to_string())
    }

    /// 端口号（main 导航窗口时要用）
    pub fn port(&self) -> u16 { self.port }

    /// 本轮的一次性令牌（main 拼 `/?k=` 用）。读不到就返回空串。
    pub fn token(&self) -> String {
        read_desk(&self.home).map(|(_, t)| t).unwrap_or_default()
    }

    /// 杀进程树。Windows 用 taskkill /T /F；其他平台 kill 子进程。
    pub fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let pid = c.id();
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            #[cfg(not(windows))]
            {
                let _ = c.kill();
            }
            let _ = c.wait();
        }
    }
}

/// 端口能连上就算活（不做 HTTP 解析：壳不该理解 `/health` 的业务含义）
pub fn healthy(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let start = Instant::now();
    match TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(300)) {
        Ok(_) => start.elapsed() < Duration::from_millis(300),
        Err(_) => false,
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}
