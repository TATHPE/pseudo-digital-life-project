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
        Self { child, port }
    }

    /// 等它活过来。
    ///
    /// 预算是 **10 秒**（20 × 500ms），不是 1.5 秒 —— 实测 Node 起 serve 要 3–4 秒，
    /// 原来 3 × 500ms 会把它误判成「起不来」，然后白白打开一次浏览器（踩过）。
    /// 但如果子进程已经退出（真崩了），就别傻等。
    pub fn wait_healthy(&mut self) -> Result<(), String> {
        for _ in 0..20 {
            if healthy(self.port) {
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
