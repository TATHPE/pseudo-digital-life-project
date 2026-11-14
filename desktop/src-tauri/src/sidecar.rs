// sidecar：壳唯一被允许"碰"的东西。三条纪律：
//   ① 端口交给 OS 分配（serve 0），从 data/.desk.json 读回真实端口与一次性令牌
//   ② 探测**持续**进行，只区分「慢」和「子进程真退了」；不设一次性预算、不回落浏览器
//      （2026-11-14：开机冷加载曾因 12 秒预算到点被误判，还把刚要监听的 node 杀掉）
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
    pub fn start(home: &std::path::Path, secrets: &[(String, String)]) -> Self {
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
        // 日志落盘（2026-11-14）：以前 stdout/stderr 全丢进 null()，
        // 而 show_boot_error 让去看 data/logs/serve.log —— 那个文件从来不存在，排障全靠猜。
        // 每次启动把上一份留作 serve.prev.log，避免日志无限增长。
        let log_dir = home.join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
        let log_path = log_dir.join("serve.log");
        if log_path.exists() { let _ = std::fs::rename(&log_path, log_dir.join("serve.prev.log")); }
        let open_log = || std::fs::OpenOptions::new().create(true).append(true)
            .open(&log_path).map(Stdio::from).unwrap_or_else(|_| Stdio::null());
        let out = open_log();
        let err = open_log();
        cmd.args(["--experimental-strip-types", "src/cli/jingjing.ts", "serve", "0"])
            .env("JJ_HOME", home)
            // 看门狗：壳被硬杀（任务管理器/崩溃）时，node 也要跟着退，不能变孤儿占着 7700
            .env("JJ_PARENT_PID", std::process::id().to_string())
            // 密钥从壳传进来（DPAPI 已在 Rust 侧解开）—— Node 侧优先读这些环境变量
            .envs(secrets.iter().map(|(p, k)| (format!("JJ_SECRET_{}", p.to_uppercase()), k.clone())))
            .stdout(out).stderr(err);
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

    /// 单次探测：读到 .desk.json 且端口能连上就返回 (port, token)。
    /// 壳的后台线程每 500ms 调一次，**不再有「一次预算用完就判死」**——
    /// 开机冷加载（Defender 扫 node.exe / venv 里的 Python 进程）可能十几秒，
    /// 以前 24×500ms 一到就报「起不来」，还把刚要监听的 node 一起杀掉。
    pub fn try_ready(&mut self) -> Option<(u16, String)> {
        if let Some((port, token)) = read_desk(&self.home) {
            if !token.is_empty() && healthy(port) {
                self.port = port;
                return Some((port, token));
            }
        }
        None
    }

    /// 子进程是否已经退出：用来区分「只是慢」和「真崩了」。
    pub fn exited(&mut self) -> bool {
        self.child.as_mut().and_then(|c| c.try_wait().ok().flatten()).is_some()
    }

    /// 杀进程树。Windows 用 taskkill /T /F；其他平台 kill 子进程。
    pub fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let pid = c.id();
            #[cfg(windows)]
            {
                // 先礼：调一次 /api/shutdown，让它把 data/.desk.json 清掉再退。
                // 原来直接 /T /F，node 的 exit 钩子来不及跑 —— 令牌文件就留在磁盘上（2026-11-05）。
                // 端口/令牌现从 .desk.json 取：启动很慢或超时后才就绪时 self.port 可能没赋值。
                let (port, token) = read_desk(&self.home).unwrap_or((self.port, String::new()));
                let _ = settle_shutdown(&port, &token);
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

/// 叫它自己退：POST /api/shutdown，最多等 1.5 秒。失败就返回 false，调用方还有强杀兜底。
#[cfg(windows)]
fn settle_shutdown(port: &u16, token: &str) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let addr = format!("127.0.0.1:{}", port);
    let mut s = match TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(400)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1200)));
    let req = format!("POST /api/shutdown?k={} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-jj: 1\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", token);
    if s.write_all(req.as_bytes()).is_err() { return false; }
    let mut buf = [0u8; 64];
    let _ = s.read(&mut buf);
    std::thread::sleep(Duration::from_millis(600));
    true
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
