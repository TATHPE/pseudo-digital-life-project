/**
 * 状态总览（阶段 1 数据层 + 阶段 2 开关，2026-11-15）：把「能力 / 配置体检 / 模型与接口 / 资源快照」
 * 四份**只读事实**聚合成一份结构化结果，供界面把现状显式摆出来。
 *
 * 设计约束（research/notes/ui-design-references.md §9）：
 *  - 本模块自己纯只读：不写 config.json / inbox / 数据库，不联网，不 spawn 外部进程。
 *    尤其不调用 wsl.status() —— 它会 spawnSync("wsl.exe")，本环境有命令安全黑名单。
 *    WSL 一律如实标「未探测」并给安装引导，不假装有结论。
 *  - 全部能力显式列出（含没配好的），禁用 ≠ 隐藏；状态标五态，缺什么给 installHint。
 *  - 只做当前快照：不采样、不存时间序列、不做趋势。
 *  - 开关只**描述**，写入在别处：toggleKey 给的是配置键（如 ui.beat），
 *    真正的写走路由里的 writeGuarded（src/web/routes/config.ts 的 PUT /api/ui）。
 *    restartRequired=true 的项必须把「配置开了」与「进程在跑」分成两个字段，
 *    不许用一句话糊过去 —— 那是界面最容易骗人的地方。
 *
 * 为什么单独一层：控制器只负责取数，状态判定全在这里，可以纯函数测试
 * （不启服务、不碰真实数据目录）。参考 docs/runtime/11 §5.3 的「能力自述」口径，
 * 与 src/capabilities.ts 的分工是：它报「代码里有什么」，这里报「用户现在能用哪些、缺什么」。
 */
import { lstatSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import type { AppConfig } from "./config.ts";
import type { FileConfig } from "./configfile.ts";
import type { Capabilities } from "./capabilities.ts";
import { isInstalled } from "./ollama.ts";

/* ── 类型 ───────────────────────────────────────────────────────────── */

/** 五态：已启用 / 可用但未启用 / 缺模型或素材 / 需人开闸或填 Key / 未探测或环境不支持 */
export type CapState = "enabled" | "off" | "missing" | "gated" | "unknown";

export type CapGroup = "大脑" | "感官" | "手脚" | "后台" | "数据";

export interface CapabilityRow {
  id: string;
  group: CapGroup;
  label: string;
  state: CapState;
  /** 一句话说明「现在到底怎样」，不写空话 */
  detail: string;
  /** 缺环境时给的命令文本；只展示、不自动执行 */
  installHint?: string;
  /** 阶段 2 界面开关要写的配置键（本阶段不写入） */
  toggleKey?: string;
  /** 切换后是否需要重启进程 */
  restartRequired?: boolean;
}

export interface CheckRow {
  id: string;
  label: string;
  state: CapState;
  detail: string;
  hint?: string;
  /** 设置页里对应的小节，供界面跳转 */
  target: string;
}

export interface ModelRow {
  role: string;
  purpose: string;
  side: "本地" | "云端";
  provider: string;
  model: string | null;
  /** 值来源：env / file / default，来自 configSources() */
  source: string;
  state: CapState;
  detail: string;
}

export interface ProcessSnapshot {
  rss: number;
  heapUsed: number;
  external: number;
  uptimeS: number;
  node: string;
  pid: number;
}

export interface ResourceGroup {
  key: string;
  label: string;
  bytes: number;
  files: number;
}

export interface HomeScan {
  groups: ResourceGroup[];
  totalBytes: number;
  totalFiles: number;
  /** 超过扫描上限时置 true，界面要提示「数字不完整」 */
  truncated: boolean;
  /** 因深度上限被整棵跳过的子树数（0 表示没有目录被深度截断） */
  depthLimited: number;
}

export interface OverviewInput {
  cfg: AppConfig;
  file: FileConfig;
  sources: Record<string, string>;
  caps: Capabilities;
  /** provider -> 有没有登记 key。只有布尔值，绝不携带密钥内容 */
  secrets: Record<string, boolean>;
  /** 当前进程**真的**在跑心跳（`--beat` 或配置开启后重启过；只认运行期信号） */
  beatRunning: boolean;
  /** config.json 的 ui.beat：下次启动要不要带心跳。开着但没重启 ≠ 正在跑 */
  beatConfigured: boolean;
  memory: { total: number; added7d: number };
  usage: { todayUsd: number; calls: number; inTokens: number; outTokens: number };
  proc: ProcessSnapshot;
  scan: HomeScan;
  /** Ollama 状态是否来自实时探测；false 表示用的缓存/未探测 */
  ollamaProbed: boolean;
  now?: Date;
}

export interface Overview {
  generatedAt: string;
  capabilities: CapabilityRow[];
  checks: CheckRow[];
  models: ModelRow[];
  resources: {
    process: ProcessSnapshot;
    groups: ResourceGroup[];
    totalBytes: number;
    totalFiles: number;
    truncated: boolean;
  };
  counters: {
    memories: number;
    added7d: number;
    todayUsd: number;
    calls: number;
    inTokens: number;
    outTokens: number;
  };
  /** 口径与边界说明，界面应原样展示，别让用户误以为「没列出来就是没有」 */
  notes: string[];
}

/* ── 资源：数据目录当前快照（只读、有上限、不跟随链接） ─────────────── */

const GROUPS: Array<{ key: string; label: string; match: (first: string) => boolean }> = [
  { key: "memory", label: "记忆库（db / wal / shm）", match: (f) => f.startsWith("memory.db") },
  { key: "pal", label: "形象与背景素材", match: (f) => f === "pal" },
  { key: "tts", label: "语音模型", match: (f) => f === "tts" },
  { key: "inbox", label: "原始事件（事实源）", match: (f) => f === "inbox" },
  { key: "workspace", label: "工作区 / 截图", match: (f) => f === "workspace" },
  { key: "logs", label: "日志", match: (f) => f === "logs" },
  { key: "snapshots", label: "备份与快照", match: (f) => f === "snapshots" || f === "wsl" },
  { key: "skills", label: "技能", match: (f) => f === "skills" },
];

/** 顶层第一段决定归类；纯函数，测试可直接喂路径 */
export function classifyPath(rel: string): { key: string; label: string } {
  const first = rel.split(/[\\/]/)[0] ?? "";
  const hit = GROUPS.find((g) => g.match(first));
  return hit ? { key: hit.key, label: hit.label } : { key: "other", label: "其它配置文件" };
}

export interface ScanOptions {
  /** 最多统计多少个文件，防止大目录拖慢请求 */
  maxFiles?: number;
  /** 最大递归深度 */
  maxDepth?: number;
}

/**
 * 扫描数据目录。用 lstat + Dirent 判链接，**不跟随 junction / symlink**
 * （data 目录里可能出现指向仓库的链接，跟过去会算进别人的文件，甚至循环）。
 * 只读，不创建任何目录；目录不存在就返回空快照。
 */
export function scanHome(home: string, opts: ScanOptions = {}): HomeScan {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxDepth = opts.maxDepth ?? 6;
  const acc = new Map<string, { label: string; bytes: number; files: number }>();
  let totalFiles = 0;
  let truncated = false;
  let stopped = false; // 硬上限（文件数）已到，整轮停止
  let depthLimited = 0; // 因深度上限被跳过的子树数

  // 递归时自带相对路径，不做「full.startsWith(home)」字符串前缀比较：
  // Windows 下 join() 产出反斜杠，而调用方可能传正斜杠的 home，
  // 前缀一失配就会把所有文件归到「其它」（2026-11-15 冒烟实测踩到）。
  const walk = (dir: string, depth: number, prefix: string): void => {
    if (stopped) return;
    // 深度超限只跳过这一棵子树，不能把整轮扫描停掉：
    // 否则用户目录里第一个深层分支（AppData\…）就会让 totalFiles 停在个位数。
    if (depth > maxDepth) { depthLimited += 1; return; }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; } // 目录不存在 / 没权限：如实跳过，不假装 0 就是全部
    for (const e of entries) {
      if (stopped) return;
      if (totalFiles >= maxFiles) { stopped = true; truncated = true; return; }
      const full = join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      // 链接一律跳过（含 Windows junction），既不跟随也不计入体积。
      // isDirectory() 分支再查一次 lstat：junction 在部分 Node/Windows 组合下
      // 的 Dirent.isSymbolicLink() 为 false，只靠上面那一道会跟过去。
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        try { if (lstatSync(full).isSymbolicLink()) continue; } catch { continue; }
        walk(full, depth + 1, rel);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      const g = classifyPath(rel);
      const cur = acc.get(g.key) ?? { label: g.label, bytes: 0, files: 0 };
      cur.bytes += st.size;
      cur.files += 1;
      acc.set(g.key, cur);
      totalFiles += 1;
    }
  };
  walk(home, 0, "");

  // 任一子树被深度跳过，结果同样不完整；如实标记，不把不完整当完整
  if (depthLimited > 0) truncated = true;

  const groups: ResourceGroup[] = [...acc.entries()]
    .map(([key, v]) => ({ key, label: v.label, bytes: v.bytes, files: v.files }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    groups,
    totalBytes: groups.reduce((n, g) => n + g.bytes, 0),
    totalFiles,
    truncated,
    depthLimited,
  };
}

/* ── 能力清单：全部列出，带五态与安装引导 ──────────────────────────── */

const ROLE_PURPOSE: Record<string, string> = {
  embed: "向量嵌入",
  route: "路由判断",
  extract: "事实抽取",
  salience: "显著性打分",
  conflict: "冲突比对",
  night: "夜间整理",
  express: "日常对话",
  plan: "规划 / 深度思考",
};

const VISION_LOCAL_MODEL = "qwen2.5vl:3b";

function hasFiles(scan: HomeScan, key: string): boolean {
  return (scan.groups.find((g) => g.key === key)?.files ?? 0) > 0;
}

/**
 * 能力行。所有判定只依赖入参，不发请求、不执行命令。
 * 注意：WSL 状态固定 unknown + 安装引导 —— 这是刻意的安全边界，见文件头。
 */
export function capabilityRows(i: OverviewInput): CapabilityRow[] {
  const models = i.caps.providers.ollama.models ?? [];
  const online = i.caps.providers.ollama.online === true;
  const localEmbed = i.cfg.roles["embed"]?.model ?? "bge-m3";
  const localDefault = i.file.local?.default ?? "";
  const expressProvider = i.cfg.roles["express"]?.provider ?? "";
  const hasExpressKey = Boolean(i.secrets[expressProvider]);
  const visionProvider = i.file.vision?.provider === "cloud" ? "cloud" : "ollama";
  const visionCloudOn = i.file.vision?.cloudEnabled === true;
  const hasVisionKey = Boolean(i.secrets["vision"]);
  const mcpErrors = i.caps.degraded.filter((d) => d.startsWith("mcp-unavailable"));
  const mcpTools = i.caps.classes?.tool?.filter((t) => t.source === "mcp").length ?? 0;

  const rows: CapabilityRow[] = [
    {
      id: "heartbeat", group: "后台", label: "主动开口（心跳）",
      state: i.beatRunning ? "enabled" : "off",
      detail: i.beatRunning
        ? "每 60 秒判定一次；静音 23:30–08:00，每日最多 3 次，发不发都留审计"
        : i.beatConfigured
          // 配置开了但进程没重启：这是最容易骗人的状态，必须写成「还没生效」而不是「已开启」
          ? "界面里已开启，但当前进程启动时还没带心跳 —— 重启面板后生效"
          : "功能已实现，当前未开启；打开开关后重启面板才会开始判定",
      toggleKey: "ui.beat", restartRequired: true,
    },
    {
      id: "night", group: "后台", label: "夜间自我整理",
      state: "enabled",
      detail: "闲置 20 小时或每日触发；也可手动跑 jingjing night run",
    },
    {
      id: "express", group: "大脑", label: "云端对话",
      state: hasExpressKey ? "enabled" : "gated",
      detail: hasExpressKey
        ? `${expressProvider} 已登记密钥，模型 ${i.cfg.roles["express"]?.model || "未填"}`
        : `${expressProvider || "云端"} 未登记密钥，日常对话走不通`,
      installHint: hasExpressKey ? undefined : `在设置 → 接口 · 云端 填 ${expressProvider || "对应厂商"} 的 API Key`,
    },
    {
      id: "local-chat", group: "大脑", label: "本地对话模型",
      state: !localDefault ? "off" : isInstalled(models, localDefault) ? "enabled" : "missing",
      detail: !localDefault
        ? "config.json 的 local.default 为空，4 个记忆角色没有本地模型"
        : isInstalled(models, localDefault)
          ? `已装 ${localDefault}${online ? "，Ollama 在线" : "（Ollama 状态未确认）"}`
          : `本地没装 ${localDefault}`,
      installHint: localDefault ? `ollama pull ${localDefault}` : "在设置 → 本地模型 填一个已安装的模型名",
    },
    {
      id: "embed", group: "大脑", label: "本地向量嵌入",
      state: isInstalled(models, localEmbed) ? "enabled" : "missing",
      detail: isInstalled(models, localEmbed) ? `已装 ${localEmbed}` : `本地没装 ${localEmbed}，检索会缺向量召回`,
      installHint: `ollama pull ${localEmbed}`,
    },
    {
      id: "vision", group: "感官", label: "屏幕视觉（看图答话）",
      state: visionProvider === "cloud"
        ? (visionCloudOn && hasVisionKey && i.file.vision?.model ? "enabled" : "gated")
        : (isInstalled(models, VISION_LOCAL_MODEL) ? "enabled" : "missing"),
      detail: visionProvider === "cloud"
        ? (visionCloudOn && hasVisionKey ? "云端视觉已配置（屏幕发云需人开闸）" : "云端视觉缺 baseUrl / model / key，或云闸未开")
        : (isInstalled(models, VISION_LOCAL_MODEL)
          ? `本地视觉模型 ${VISION_LOCAL_MODEL} 已装`
          : `本地没装 ${VISION_LOCAL_MODEL}；屏幕内容默认只走本地`),
      installHint: visionProvider === "cloud"
        ? "在设置 → 眼 · 视觉 填 baseUrl / model / key 并打开「屏幕可发云端」"
        : `ollama pull ${VISION_LOCAL_MODEL}`,
    },
    {
      id: "tts", group: "感官", label: "她开口说话（TTS）",
      state: (i.file.tts?.backend ?? "local") === "cloud"
        ? "gated"
        : (hasFiles(i.scan, "tts") ? "enabled" : "missing"),
      detail: (i.file.tts?.backend ?? "local") === "cloud"
        ? "云端音色免密钥但需要网络；本机离线时不可用"
        : (hasFiles(i.scan, "tts") ? "本地音色素材已在数据目录" : "本地音色模型还没下载"),
      installHint: "jingjing tts setup（本地音色模型由人下载）",
    },
    {
      id: "companion", group: "感官", label: "陪伴形象（分层 2D / Live2D）",
      state: "enabled",
      detail: `内置分层形象随包提供${hasFiles(i.scan, "pal") ? "；数据目录另有自己导入的素材" : ""}`,
    },
    {
      id: "wsl", group: "手脚", label: "Linux 小房子（WSL）",
      state: "unknown",
      detail: `代码与 wsl.exec / wsl.status 都在；本接口不执行 wsl.exe 探测（安全黑名单 / 可能超时），发行版装没装如实不判${i.file.wsl?.autonomous ? "；自主开关已开" : "；自主开关未开"}`,
      installHint: "先装 Ubuntu 发行版，再跑 jingjing wsl setup；状态用 jingjing wsl status 查",
      toggleKey: "wsl.autonomous",
    },
    {
      id: "mcp", group: "手脚", label: "外部工具（MCP）",
      state: mcpErrors.length ? "gated" : (mcpTools > 0 ? "enabled" : "off"),
      detail: mcpErrors.length
        ? `有 ${mcpErrors.length} 个 MCP 连接失败：${mcpErrors.join("、")}`
        : (mcpTools > 0 ? `已连上 ${mcpTools} 个外部工具` : "没有挂载任何 MCP server"),
      installHint: mcpErrors.length ? "检查 data/mcp.json，或调用 /api/plugins/reconnect 重连" : undefined,
    },
    {
      id: "memory", group: "数据", label: "记忆库",
      state: "enabled",
      detail: `${i.memory.total} 条活跃记忆，近 7 天新增 ${i.memory.added7d} 条`,
    },
    {
      id: "update-check", group: "数据", label: "检查更新（只读）",
      state: "enabled",
      detail: "只比对本地 release.json，不联网、不下载、不安装",
    },
  ];
  // 已就绪的行不该再挂「怎么装 / 怎么配」——那是缺环境时才该说的话，
  // 挂在已启用的行上等于把人往已经配好的地方赶（2026-11-15 截图验收抓到）。
  return rows.map((r) => (r.state === "enabled" && r.installHint ? { ...r, installHint: undefined } : r));
}

/** 配置体检：4–6 项，从能力行派生，避免两套判定逻辑漂移 */
export function checkRows(rows: CapabilityRow[]): CheckRow[] {
  const pick = (id: string) => rows.find((r) => r.id === id);
  const targets: Record<string, string> = {
    express: "接口 · 云端",
    "local-chat": "本地模型",
    embed: "本地模型",
    vision: "眼 · 视觉",
    tts: "声音",
    wsl: "WSL 小房子",
    // 心跳没有设置页落点：开关就在体检页自己这一屏，跳过去只会让人找不到东西。
    // 空串 = 不渲染「去设置」按钮（界面按 target 有无决定）。
    heartbeat: "",
  };
  const ids = ["express", "local-chat", "embed", "vision", "tts", "wsl", "heartbeat"];
  return ids.flatMap((id) => {
    const r = pick(id);
    if (!r) return [];
    return [{
      id: r.id,
      label: r.label,
      state: r.state,
      detail: r.detail,
      // 已经就绪的项不该再挂「怎么装」——那是给缺环境的项用的（2026-11-15 截图验收抓到）
      hint: r.state === "enabled" ? undefined : r.installHint,
      target: targets[id] ?? "设置",
    }];
  });
}

/** 本地 / 云端共用一张表：角色用途、值来源、当前能不能用 */
export function modelRows(i: OverviewInput): ModelRow[] {
  const models = i.caps.providers.ollama.models ?? [];
  return i.caps.providers.roles.map((r) => {
    const side: "本地" | "云端" = r.kind === "local" ? "本地" : "云端";
    const hasKey = Boolean(i.secrets[r.provider]);
    const state: CapState = side === "本地"
      ? (!r.model ? "off" : isInstalled(models, r.model) ? "enabled" : "missing")
      : (hasKey ? "enabled" : "gated");
    const detail = side === "本地"
      ? (!r.model ? "未配置模型名" : isInstalled(models, r.model) ? "已安装" : `本地没装 ${r.model}`)
      : (hasKey ? "已登记密钥" : `缺 ${r.provider} 的密钥`);
    return {
      role: r.role,
      purpose: ROLE_PURPOSE[r.role] ?? r.role,
      side,
      provider: r.provider,
      model: r.model,
      source: i.sources[r.role] ?? "default",
      state,
      detail,
    };
  });
}

/* ── 组装 ───────────────────────────────────────────────────────────── */

export function buildOverview(i: OverviewInput): Overview {
  const capabilities = capabilityRows(i);
  const notes = [
    "只读当前快照：不采样、不存历史、不访问外网、不执行外部命令；Ollama 状态沿用项目既有的本地回环 preflight 缓存。",
    "能力全部列出（含未启用与缺环境的），状态不代表代码不存在。",
    i.ollamaProbed
      ? "Ollama 模型清单来自实时探测。"
      : "Ollama 状态来自上次探测缓存或尚未探测，模型清单可能不完整；界面应提示「以实际安装为准」。",
    "WSL 未做发行版探测（本环境 wsl.exe 在命令安全黑名单）：如实标未探测，不假装可用或不可用。",
    i.scan.truncated
      ? (i.scan.depthLimited > 0
        ? `有 ${i.scan.depthLimited} 个深层子目录超出扫描深度被跳过，本次体积统计不完整。`
        : "数据目录文件数超过扫描上限，本次体积统计不完整。")
      : "数据目录已完整扫描（不含链接目标）。",
    "密钥只报「有没有登记」，不返回密钥值。",
  ];
  return {
    generatedAt: (i.now ?? new Date()).toISOString(),
    capabilities,
    checks: checkRows(capabilities),
    models: modelRows(i),
    resources: {
      process: i.proc,
      groups: i.scan.groups,
      totalBytes: i.scan.totalBytes,
      totalFiles: i.scan.totalFiles,
      truncated: i.scan.truncated,
    },
    counters: {
      memories: i.memory.total,
      added7d: i.memory.added7d,
      todayUsd: i.usage.todayUsd,
      calls: i.usage.calls,
      inTokens: i.usage.inTokens,
      outTokens: i.usage.outTokens,
    },
    notes,
  };
}

/** 供界面/测试格式化体积；纯函数，避免各页面各写一套 */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, k = 0;
  while (v >= 1024 && k < units.length - 1) { v /= 1024; k += 1; }
  return `${v >= 100 || k === 0 ? Math.round(v) : v.toFixed(1)} ${units[k]}`;
}

/** 避免 Windows 反斜杠混进展示用的相对路径 */
export function displayRel(p: string): string {
  return p.split(sep).join("/");
}
