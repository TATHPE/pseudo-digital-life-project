/**
 * 角色路由（13 §2）+ 隐私闸门（19 §0.1 W-A）
 *
 * 硬规则：凡是能看到记忆原文的角色，kind 必须是 local。
 * 违规不降级、不重试——直接抛 E_PRIVACY。
 */
export type RoleKind = "local" | "cloud";
export type Role =
  | "embed" | "route" | "extract" | "salience" | "conflict"   // 记忆类 → 必须 local
  | "night"                                                    // 自传/反思（本地，会读全文）
  | "express" | "plan";                                       // 表达/规划 → 可 cloud

export interface RoleConfig {
  kind: RoleKind;
  provider: string;      // ollama | anthropic | openai | deepseek | ...
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  /** 该角色是否会读到记忆原文。默认按角色名推断，可显式覆盖 */
  seesMemoryText?: boolean;
}

/**
 * 默认视为"能看到记忆原文"的角色。
 *
 * 注意 **embed 必须在内**：它拿到的就是记忆原文（否则算什么嵌入）。
 * 这一条最初漏了，被 transport 的隐私闸门测试当场抓住（见 README"四条被工具抓出来的问题"）。
 */
export const MEMORY_ROLES: ReadonlySet<Role> = new Set([
  "embed", "route", "extract", "salience", "conflict", "night",
]);
/** 只读"装配块 / 用户输入"、不读记忆原文的角色 */
export const EXPRESSION_ROLES: ReadonlySet<Role> = new Set(["express", "plan"]);

export class PrivacyError extends Error {
  // 注意：不能用参数属性（`constructor(public role: Role)`）——
  // Node 的类型剥离是 strip-only，不支持它。tsconfig 里开了 erasableSyntaxOnly 强制这一点。
  readonly role: Role;
  readonly detail: string;
  constructor(role: Role, detail: string) {
    super(`E_PRIVACY: role=${role} ${detail}`);
    this.name = "PrivacyError";
    this.role = role;
    this.detail = detail;
  }
}

export interface Router {
  role(r: Role): RoleConfig;
  /** 断言：这次请求里带了记忆原文，角色必须是 local */
  assertLocalOnly(r: Role, payloadHasMemoryText: boolean): void;
  /** 换模型/换 provider 只改这里，不动代码（00 §1 判据 L5） */
  override(r: Role, patch: Partial<RoleConfig>): void;
}

export function createRouter(config: Partial<Record<Role, RoleConfig>>): Router {
  const table = new Map<Role, RoleConfig>(Object.entries(config) as [Role, RoleConfig][]);

  const role = (r: Role): RoleConfig => {
    const c = table.get(r);
    if (!c) throw new Error(`E_ROLE_MISSING: ${r}（拒绝启动：缺角色即无法保证隐私边界）`);
    return c;
  };

  return {
    role,
    assertLocalOnly(r: Role, payloadHasMemoryText: boolean): void {
      if (!payloadHasMemoryText) return;
      const c = role(r);
      const sees = c.seesMemoryText ?? MEMORY_ROLES.has(r);
      if (c.kind !== "local") {
        throw new PrivacyError(r, `kind=${c.kind} 却要读记忆原文（model=${c.model}）`);
      }
      if (!sees) {
        throw new PrivacyError(r, "标记为不读记忆原文，却传来记忆原文（配置与调用不一致）");
      }
    },
    override(r: Role, patch: Partial<RoleConfig>): void {
      const cur = role(r);
      const next = { ...cur, ...patch };
      // 覆盖也不许把记忆类角色改成 cloud
      if (MEMORY_ROLES.has(r) && next.kind !== "local") {
        throw new PrivacyError(r, "记忆类角色不允许覆盖为 cloud");
      }
      table.set(r, next);
    },
  };
}

/** 校验整张表：记忆类全 local，否则拒绝启动（19 §0.1 A1） */
export function validateRouter(cfg: Partial<Record<Role, RoleConfig>>): string[] {
  const problems: string[] = [];
  for (const r of MEMORY_ROLES) {
    const c = cfg[r];
    if (!c) { problems.push(`缺角色 ${r}`); continue; }
    if (c.kind !== "local") problems.push(`${r} 应为 local，实为 ${c.kind}`);
  }
  for (const [r, c] of Object.entries(cfg) as [Role, RoleConfig][]) {
    if (!c.provider || !c.model) problems.push(`${r} 缺 provider/model`);
  }
  return problems;
}

/**
 * 只有这些“必须在启动时就拒绝”：隐私边界（记忆类必须 local）与缺角色。
 *
 * 缺 model **不在此列**（C-5 之后默认模型为空）：云端聊天不需要本地模型，
 * 不能因为“还没装本地整理模型”就把整个 router 拒了 —— 那会让首次启动一个字都说不出来。
 * 缺 model 在真的用到那个角色时报 E_MODEL（调用点报，不是启动时报）。
 */
export function validateRouterFatal(cfg: Partial<Record<Role, RoleConfig>>): string[] {
  const problems: string[] = [];
  for (const r of MEMORY_ROLES) {
    const c = cfg[r];
    if (!c) problems.push(`缺角色 ${r}`);
    else if (c.kind !== "local") problems.push(`${r} 应为 local，实为 ${c.kind}`);
  }
  return problems;
}

/**
 * 降级链（13 §5）：express 失败 → 下一个 → 本地短回复。
 * 注意：**永远不把记忆类角色降级到 cloud**，宁可降级为"只记不整理"。
 */
export function fallbackChain(cfg: Record<string, RoleConfig>, primary: Role): RoleConfig[] {
  const chain: RoleConfig[] = [cfg[primary]!].filter(Boolean);
  const fb = cfg[`${primary}:fallback`];
  if (fb) chain.push(fb);
  return chain;
}
