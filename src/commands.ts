/**
 * CLI 子命令表（B-0 用）。它必须与 `src/cli/jingjing.ts` 的 switch 分支一致 ——
 * 测试会读源文件核对，少一个/多一个都会红（否则这份表就是"装饰列"）。
 */
export const CLI_COMMANDS = [
  "migrate", "remember", "search", "verify", "outage", "serve", "config", "models", "links", "threads", "proposal", "grant", "standing", "persona", "setup",
  "capabilities", "doctor", "reembed", "auth", "usage", "test", "night", "shell", "ingest", "docs",
  "forget-doc", "export", "verify-export", "import", "smoke-tools", "templates", "redteam",
  "verb", "beat", "eval", "decay", "bench", "profile",
];

