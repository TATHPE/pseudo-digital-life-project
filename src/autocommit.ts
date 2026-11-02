/**
 * 她写文件 → 自动 git commit（2026-11-03）。
 *
 * 学自 Coopanion 的 `core/persona.ts`：每个写文件工具的 handler 包一层，
 * 成功后 `git.commitAllAsync(\`Coo ${verb} ${path}\`, AUTHOR_COO)`
 * —— 它 README 的原话是「电脑上有 Git 时，Coo 改过的文字都留有历史版本」。
 *
 * 我们之前只有 `exec_audit`（记了"她写过 xxx"），**没有可以回滚的那一版**：
 * 审计告诉你发生过，但拿不回原文。
 *
 * 三条边界：
 *  1. **只在 git 仓库里做**（项目根是仓库才 commit；home 里的 data/ 多半不是）
 *  2. **绝不 amend / 绝不改别人的提交**：每次一个独立 commit，作者写成她
 *  3. **失败只记一声**，不阻断写入 —— 让人因为 git 没配好而写不了文件是本末倒置
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const run = (cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 8000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || stderr || "").trim() });
    });
  });

/** 这个目录是不是 git 工作区（有 .git 就算，不跑 git 命令省时间） */
export function isGitRepo(dir: string): boolean {
  try { return existsSync(join(dir, ".git")); } catch { return false; }
}

/**
 * 把一次写入提交掉。返回短 hash（能验证"真的留了一版"），没有就 null。
 * **不抛错**：写文件成功但它没提交，不该让调用方失败。
 */
export async function autoCommit(
  repo: string,
  relPath: string,
  action: string,
  who = "Coo",
): Promise<{ hash: string | null; why?: string }> {
  if (!isGitRepo(repo)) return { hash: null, why: "not_a_repo" };
  // 只 add 这一个路径：不要把工作区里别人的改动一起卷进来
  const add = await run(repo, ["add", "--", relPath]);
  if (!add.ok) return { hash: null, why: "add_failed" };
  const msg = who + " " + action + " " + relPath;
  const ci = await run(repo, [
    "-c", "user.name=" + who,
    "-c", "user.email=" + who.toLowerCase() + "@local",
    "commit", "-m", msg, "--", relPath,
  ]);
  if (!ci.ok) {
    // 没有改动可提交（内容一样）不算错
    if (/nothing to commit|no changes added/i.test(ci.out)) return { hash: null, why: "no_change" };
    return { hash: null, why: "commit_failed" };
  }
  const rev = await run(repo, ["rev-parse", "--short", "HEAD"]);
  return { hash: rev.ok ? rev.out.slice(0, 12) : null };
}
