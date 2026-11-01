//! DPAPI 解密（只做一件事：把 `data/secrets/<provider>.secret` 解成明文）。
//!
//! 为什么在壳里做：以前是 Node 起 PowerShell 调 ProtectedData。父进程是 GUI（无控制台）时
//! `windowsHide` 挡不住那一闪 —— 每读一次配置就闪一个黑框（用户实测抱怨）。
//! 现在壳把解出来的密钥放进 sidecar 的环境变量，Node 一次 PowerShell 都不用起。

#![cfg(windows)]

use std::path::Path;
use windows::Win32::Foundation::LocalFree;
use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

/// 极简 base64 解码（只为这个文件服务，不想为它加依赖）
fn b64decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// 解密一个 .secret 文件（内容是 base64 的 DPAPI 密文）
pub fn unprotect_file(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let data = b64decode(raw.trim())?;
    if data.is_empty() { return None; }
    let mut input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&mut input, None, None, None, None, 0, &mut output).ok()?;
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let text = String::from_utf8_lossy(bytes).to_string();
    unsafe {
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(output.pbData as *mut _)));
    }
    Some(text.trim().to_string())
}

/// 把 `secrets/` 下所有 provider 解出来（返回 (provider, key)）
pub fn read_all(home: &Path) -> Vec<(String, String)> {
    let dir = home.join("secrets");
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else { continue };
        let Some(provider) = name.strip_suffix(".secret") else { continue };
        if let Some(k) = unprotect_file(&p) {
            if !k.is_empty() { out.push((provider.to_string(), k)); }
        }
    }
    out
}