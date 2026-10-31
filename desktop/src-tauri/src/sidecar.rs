// sidecar：壳唯一被允许"碰"的东西。三次纪律：
//   ① 端口被占就先探活（可能上次没杀干净）——能连上就复用，不再起第二个
//   ② 探测最多 3 次，每次间隔 500ms；仍不通就落回浏览器
//   ③ stop() 必须杀**进程树**（Windows 上 node 会派生子进程；只杀父进程会留孤儿）

use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const PORT: u16 = 7700;

pub struct Sidecar {
    child: Option<Child>,
    port: u16,
}

impl Sidecar {
    /// 启动：先看端口通不通；不通才起 node。
    pub fn start(home: &std::path::Path) -> Self {
        let port = PORT;
        if healthy(port) {
            // 上次没杀干净 / 用户自己开着 `jingjing serve`：复用，别起第二个
            eprintln!("[shell] {port} 已经在服务，复用它");
            return Self { child: None, port };
        }

        let node = std::env::var("JJ_NODE").unwrap_or_else(|_| "node".to_string());
        let mut cmd = Command::new(&node);
        cmd.args(["--experimental-strip-types", "src/cli/jingjing.ts", "serve", &port.to_string()])
            .env("JJ_HOME", home.join("data"))
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // 不弹黑框：Windows 上加 CREATE_NO_WINDOW
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let child = cmd.spawn().ok();
        Self { child, port }
    }

    /// 等它活过来：最多 3 次 × 500ms。
    pub fn wait_healthy(&mut self) -> Result<(), String> {
        for i in 0..3 {
            if healthy(self.port) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(500));
            let _ = i;
        }
        Err(format!("{} 次探测都没通", 3))
    }

    /// 三次失败之后：打开系统浏览器。**记忆不丢**，只是回到网页。
    pub fn fallback_to_browser(&self) {
        let url = format!("http://127.0.0.1:{}/", self.port);
        #[cfg(windows)]
        {
            let _ = Command::new("cmd").args(["/C", "start", "", &url]).spawn();
        }
        #[cfg(target_os = "macos")]
        {
            let _ = Command::new("open").arg(&url).spawn();
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let _ = Command::new("xdg-open").arg(&url).spawn();
        }
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
