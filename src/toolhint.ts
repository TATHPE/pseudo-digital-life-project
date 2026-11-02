/**
 * 工具调用 → 一句人话（2026-11-03）。
 *
 * 学自 Coopanion 的 `core/pet-status.ts`：它把每个工具调用翻译成气泡上的一句话
 * （"读 config.json" / "搜索「记忆」" / "双击"），而且有三条硬规矩：
 *
 *  1. **只说得出的事**：参数不完整时不说（"不说出这次调用最终没做的事"）
 *  2. **细��截断**：文件名、pattern 这类细节截到 20 字（CJK）/ 40 字（其他）
 *  3. **敏感参数永不上屏**：打出来的文字、笔记、窗口标题、坐标一律不显示
 *
 * 我们之前把 argv / params 的**原文**直接塞进右栏和历史（`{"q":"记忆","k":3}`），
 * 既看不懂，又可能把路径、正文、密钥带出来。
 */

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** 只要文件名，不要整条路径（路径本身就可能是隐私） */
function leaf(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  const s = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return s || undefined;
}

/** 细节截断：CJK 20 字，其他 40 字 */
export function shorten(s: string, max?: number): string {
  const n = max ?? (CJK.test(s) ? 20 : 40);
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n).join("") + "…" : s;
}

/** 全角引号包一层（中文里比 "…" 好读） */
const q = (s: string) => "「" + s + "」";

function asObj(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === "object") return args as Record<string, unknown>;
  if (typeof args !== "string") return {};
  try { return JSON.parse(args) as Record<string, unknown>; } catch { return {}; }
}

/** 哪些键的值一个字都不许显示（打字内容、笔记、密钥…） */
const SECRET_KEYS = /pass(word)?|secret|token|key|apikey|credential|text|content|body|payload|clipboard|title/i;

/**
 * 把一次工具调用说成人话。**参数缺失就说得含糊些，不猜**。
 * 返回一行，直接可以贴到右栏。
 */
export function toolHuman(name: string, args: unknown): string {
  const o = asObj(args);
  const file = leaf(o.path) ?? leaf(o.from) ?? leaf(o.file);
  const cwd = leaf(o.dir) ?? leaf(o.cwd);

  switch (name) {
    case "fs.read": return "读 " + (file ?? "一个文件");
    case "fs.list": return "列目录" + (cwd ? " " + cwd : "");
    case "fs.write": return "写 " + (file ?? "一个文件");
    case "fs.mkdir": return "建目录" + (cwd ? " " + cwd : "");
    case "fs.trash": return "把 " + (file ?? "一个文件") + " 移到废纸篓";
    case "fs.restore": return "从废纸篓恢复 " + (file ?? "一个文件");
    case "fs.stat": return "看 " + (file ?? "一个文件") + " 的信息";
    case "fs.search": return "在文件里搜" + (typeof o.q === "string" ? " " + q(shorten(o.q)) : "");
    case "doc.search": return "在文档里搜" + (typeof o.q === "string" ? " " + q(shorten(o.q)) : "");
    case "doc.list": return "列文档";
    case "memory.search": return "在记忆里搜" + (typeof o.q === "string" ? " " + q(shorten(o.q)) : "");
    case "memory.remember": {
      const kind = typeof o.kind === "string" ? o.kind : "";
      return "记一条" + (kind ? "（" + kind + "）" : "") + "记忆";
    }
    case "proposal.create": return "提一个想法等你看";
    case "msg.notify": return "给你发通知";
    case "git.status": return "看 git 状态";
    case "git.diff": return "看 git 改动";
    case "git.log": return "看 git 历史";
    case "skill.list": return "列技能";
    case "skill.read": return "读技能 " + (typeof o.id === "string" ? shorten(o.id) : "一份");
    case "project.list": return "列项目目录";
    case "project.read": return "读项目里的 " + (file ?? (typeof o.path === "string" ? shorten(o.path) : "一个文件"));
    case "project.search": return "在项目里搜" + (typeof o.q === "string" ? " " + q(shorten(o.q)) : "");
    case "shell.run": return "跑模板 " + (typeof o.template === "string" ? shorten(o.template) : "");
    case "shell.exec": {
      // 只报第一个词（程序名）：整条 argv 可能带路径、正文、密钥
      const argv = Array.isArray(o.argv) ? o.argv.map(String) : [];
      return "跑命令 " + (argv[0] ? shorten(leaf(argv[0]) ?? argv[0]) : "");
    }
    case "script.run": return "跑脚本 " + (file ?? "");
    case "shell.templates": return "列可用的命令模板";
    case "time.now": return "看时间";
    default: {
      // 未知工具：只报名字与**参数键**，不报值
      const keys = Object.keys(o).filter((k) => !SECRET_KEYS.test(k)).slice(0, 3);
      return (name || "调用工具") + (keys.length ? "（" + keys.join("/") + "）" : "");
    }
  }
}

/**
 * 工具**结果**的人话摘要：只保留第一行、去掉控制字符、截断。
 * 结果里可能是文件正文，所以同样要克制。
 */
export function toolResultHuman(result: string, max = 160): string {
  // 先取第一行，再清控制字符（反过来会把换行也变成空格，第一行就没了）
  const first = String(result ?? "").split(String.fromCharCode(10))[0] ?? "";
  return shorten(first.replace(CONTROL, " ").trim(), max);
}
