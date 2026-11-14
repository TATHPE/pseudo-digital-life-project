/**
 * WSL 之手（2026-11-12）：argv 渲染 / Linux 侧 timeout / 硬禁区 / 路径换算 / 自主闸门。
 * 全是纯函数 + 临时 home 的闸门判定，不依赖真 WSL（真机验收另跑 jingjing wsl setup）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderExec, innerArgv, wslHardDeny, winToWsl, wslToWin, WSL_TIMEOUT_S } from "../src/wsl.ts";
import { checkGrant } from "../src/grant.ts";
import { writeFileConfig } from "../src/configfile.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-wsl-"));

test("renderExec：argv 直传 + Linux 侧 timeout 收尸（杀客户端杀不死 Linux 进程）", () => {
  const r = renderExec(["uname", "-a"]);
  assert.deepEqual(r, ["wsl.exe", "-d", "Ubuntu", "-u", "root", "--", "timeout", "-k", "5", String(WSL_TIMEOUT_S), "uname", "-a"]);
  const custom = renderExec(["ls"], { distro: "Debian", timeoutS: 30 });
  assert.equal(custom[2], "Debian");
  assert.equal(custom[9], "30");
  // 原始命令能无损取回（闸门复核硬禁区要用）
  assert.deepEqual(innerArgv(r), ["uname", "-a"]);
  assert.deepEqual(innerArgv(custom), ["ls"]);
});

test("renderExec：空 argv / 控制字符 / 超长都拒", () => {
  assert.throws(() => renderExec([]), /E_BAD_ARGV/);
  assert.throws(() => renderExec(["echo", "a\u0000b"]), /E_BAD_ARGV/);
  assert.throws(() => renderExec(["echo", "x".repeat(2001)]), /E_BAD_ARGV/);
});

test("硬禁区：格式化/写块设备/注销 WSL/删盘根与系统目录/删审计快照 —— 都拒", () => {
  assert.ok(wslHardDeny(["mkfs.ext4", "/dev/sda1"]));
  assert.ok(wslHardDeny(["dd", "if=/dev/zero", "of=/dev/sda"]));
  assert.ok(wslHardDeny(["wsl", "--unregister", "Ubuntu"]));
  assert.ok(wslHardDeny(["rm", "-rf", "/mnt/d"]));
  assert.ok(wslHardDeny(["rm", "-rf", "/mnt/c/Windows"]));
  assert.ok(wslHardDeny(["rm", "-rf", "/mnt/d/Pseudo Digital Life Project/data"]));
  assert.ok(wslHardDeny(["rm", "-rf", "/mnt/d/x/data/wsl/snapshots"]));
  // 正常命令不拦
  assert.equal(wslHardDeny(["uname", "-a"]), null);
  assert.equal(wslHardDeny(["ls", "/root/jj"]), null);
  assert.equal(wslHardDeny(["rm", "old.log"]), null);
  assert.equal(wslHardDeny(["apt", "install", "git"]), null);
});

test("硬禁区（2026-11-14）：Linux 侧系统根、包装器、内联 shell 都拒；正常运维不误伤", () => {
  const shouldDeny: string[][] = [
    ["rm", "-rf", "/"],
    ["rm", "-rf", "/*"],
    ["rm", "-rf", "/etc"],
    ["rm", "-rf", "/etc/*"],
    ["rm", "-rf", "/home"],
    ["rm", "-rf", "/usr"],
    ["rm", "-rf", "/var"],
    ["rm", "-rf", "/root"],
    ["rm", "-rf", "/root/jj"],
    ["rm", "-rf", "/mnt"],
    ["rm", "-rf", "//"],
    ["rm", "-rf", "/./"],
    ["rm", "-rf", "~"],
    ["rm", "-rf", "$HOME"],
    ["rm", "-rf", "/", "--no-preserve-root"],
    ["sudo", "rm", "-rf", "/"],
    ["sudo", "-u", "root", "rm", "-rf", "/etc"],
    ["find", "/", "-delete"],
    ["bash", "-c", "rm -rf /"],
    ["bash", "-lc", "cd /etc && rm -rf /home"],
    ["sh", "-c", "dd if=/dev/zero of=/dev/sda"],
  ];
  for (const argv of shouldDeny) {
    assert.ok(wslHardDeny(argv), "该拒：" + JSON.stringify(argv));
  }
  const shouldAllow: string[][] = [
    ["rm", "-rf", "/root/jj/tmp/build"],
    ["rm", "-rf", "/etc/nginx/conf.d/old.conf"],
    ["rm", "-rf", "/tmp"],
    ["rm", "old.log"],
    ["bash", "-c", "cd /etc && cat os-release"],
    ["ls", "/etc"],
  ];
  for (const argv of shouldAllow) {
    assert.equal(wslHardDeny(argv), null, "不该拒：" + JSON.stringify(argv));
  }
});

test("路径换算：Windows ↔ /mnt 往返", () => {
  assert.equal(winToWsl("D:\\Pseudo Digital Life Project\\data\\workspace"), "/mnt/d/Pseudo Digital Life Project/data/workspace");
  assert.equal(wslToWin("/mnt/d/tmp/x"), "D:/tmp/x");
  assert.equal(wslToWin(winToWsl("C:\\Users\\Fez")), "C:/Users/Fez");
});

test("自主闸门：开了不逐次问（无窗口也放行），关着回到 E_NO_GRANT，硬禁区仍拒", () => {
  const home = H();
  const cwd = join(home, "workspace");
  const argv = renderExec(["uname", "-a"]);
  // 没开自主、也没窗口 → 拒
  assert.equal(checkGrant(home, { argv, cwd, verb: "wsl.exec" }).ok, false);
  // 人开自主 → 持久放行，id=wsl-auto
  writeFileConfig(home, { wsl: { autonomous: true } });
  const ok = checkGrant(home, { argv, cwd, verb: "wsl.exec" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.id, "wsl-auto");
  // 硬禁区：渲染后的 rm 盘根，闸门取内层复核 → 仍拒
  const bad = checkGrant(home, { argv: renderExec(["rm", "-rf", "/mnt/d"]), cwd, verb: "wsl.exec" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "E_WSL_DENY");
  // 自主档没有授权窗口兜底，Linux 侧的系统根必须在这里被挡住
  const root = checkGrant(home, { argv: renderExec(["rm", "-rf", "/etc"]), cwd, verb: "wsl.exec" });
  assert.equal(root.ok, false);
  if (!root.ok) assert.equal(root.code, "E_WSL_DENY");
  // 正常命令照旧放行
  assert.equal(checkGrant(home, { argv: renderExec(["ls", "/etc"]), cwd, verb: "wsl.exec" }).ok, true);
});