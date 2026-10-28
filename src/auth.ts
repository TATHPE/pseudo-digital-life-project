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
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

export type Provider = "deepseek" | "anthropic" | "openai";

export interface SecretStore {
  kind: "dpapi" | "libsecret" | "file";
  set(provider: Provider, key: string): void;
  get(provider: Provider): string | undefined;
  list(): Array<{ provider: string; fingerprint: string; storedBy: string }>;
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
