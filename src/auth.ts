/**
 * 凭据存储（13 §3）
 *
 * Windows → DPAPI（CurrentUser），密文落盘，只有本用户能解
 * Linux   → secret-tool（libsecret）
 * 都没有  → 0600 文件 + 启动时告警
 *
 * 绝不：写进 config、写进 SQLite、写进日志、写进 argv。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export type Provider = "deepseek" | "anthropic" | "openai";

export interface SecretStore {
  kind: "dpapi" | "libsecret" | "file";
  set(provider: Provider, key: string): void;
  get(provider: Provider): string | undefined;
  list(): Array<{ provider: string; fingerprint: string; storedBy: string }>;
  /**
   * 删掉一个 provider 的密钥（C-1）。
   *
   * 之前只有 set/get/list —— **密钥只有“写入”没有“删除”**，于是想测本地模型就没有任何精确开关：
   * 只能断网或填一个坏 key，而填坏了也拿不回来。降级链（withFallback）因此只能靠祈祷验证。
   * 返回是否真的删掉了东西（不存在时返回 false，不报错——重复删幂等）。
   */
  clear(provider: Provider): boolean;
}

const fp = (k: string) => `${k.slice(0, 5)}…${k.slice(-4)}`;

/**
 * 调 PowerShell 做 DPAPI。
 * 注意：PS 5.1 必须显式 `Add-Type -AssemblyName System.Security`，
 * 否则 [Security.Cryptography.ProtectedData] 报 TypeNotFound（踩过）。
 * 明文通过**环境变量**传入，不进 argv（避免 ps 列表泄露）。
 */
function ps(script: string, plaintext?: string): string {
  const r = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " + script,
  ], { env: { ...process.env, JJ_PT: plaintext ?? "" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.trim();
}

export function createStore(dir: string): SecretStore {
  mkdirSync(dir, { recursive: true });
  const file = (p: Provider) => `${dir}/${p}.secret`;

  if (process.platform === "win32") {
    const hasDpapi = (() => {
      try { return ps("'ok'") === "ok"; } catch { return false; }
    })();
    if (hasDpapi) {
      return {
        kind: "dpapi",
        set(p, key) {
          const b64 = ps(
            "$b=[Text.Encoding]::UTF8.GetBytes($env:JJ_PT);" +
            "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
            "[Convert]::ToBase64String($e)", key);
          writeFileSync(file(p), b64 + "\n", { mode: 0o600 });
        },
        get(p) {
          const f = file(p);
          if (!existsSync(f)) return undefined;
          const b64 = readFileSync(f, "utf8").trim();
          return ps(
            "$e=[Convert]::FromBase64String($env:JJ_PT);" +
            "$b=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser');" +
            "[Text.Encoding]::UTF8.GetString($b)", b64);
        },
        list() { return listKeys(dir, "dpapi"); },
        clear(p) {
          const f = file(p);
          if (!existsSync(f)) return false;
          unlinkSync(f);
          return true;
        },
      };
    }
  }

  if (process.platform !== "win32") {
    try {
      execFileSync("secret-tool", ["--version"], { stdio: "ignore" });
      return {
        kind: "libsecret",
        set(p, key) {
          execFileSync("secret-tool", ["store", "--label", `jingjing:${p}`, "service", "jingjing", "provider", p],
            { input: key + "\n" });
        },
        get(p) {
          try {
            return execFileSync("secret-tool", ["lookup", "service", "jingjing", "provider", p], { encoding: "utf8" }).trim() || undefined;
          } catch { return undefined; }
        },
        list() { return listKeys(dir, "libsecret"); },
        clear(p) {
          // 两份都要清：keyring 里的条目 + 指纹文件（否则 list 还会显示它）
          let had = false;
          try { execFileSync("secret-tool", ["clear", "service", "jingjing", "provider", p], { stdio: "ignore" }); had = true; } catch { /* 不在 keyring 里 */ }
          const f = file(p);
          if (existsSync(f)) { unlinkSync(f); had = true; }
          return had;
        },
      };
    } catch { /* fallthrough */ }
  }

  return {
    kind: "file",
    set(p, key) {
      const f = file(p);
      writeFileSync(f, key + "\n", { mode: 0o600 });
      try { chmodSync(f, 0o600); } catch { /* windows */ }
    },
    get(p) {
      const f = file(p);
      return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
    },
    list() { return listKeys(dir, "file"); },
    clear(p) {
      const f = file(p);
      if (!existsSync(f)) return false;
      unlinkSync(f);
      return true;
    },
  };
}

function listKeys(dir: string, by: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".secret")).map((f) => {
    const provider = f.replace(/\.secret$/, "");
    let fingerprint = by === "dpapi" ? "(dpapi 受保护)" : "????";
    try {
      if (by !== "dpapi") fingerprint = fp(readFileSync(`${dir}/${f}`, "utf8").trim());
    } catch { /* ignore */ }
    return { provider, fingerprint, storedBy: by };
  });
}

export { fp as fingerprint };
