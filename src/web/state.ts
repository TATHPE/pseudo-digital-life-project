/** 状态行（17 §4.1）：一句话，不是数字仪表盘 */
export function expenseLine(gapDays: number | null, stages: Array<{ stage: string; c: number }>): string {
  const active = stages.find((s) => s.stage === "active")?.c ?? 0;
  const fading = stages.find((s) => s.stage === "fading")?.c ?? 0;
  const awake = "醒着";
  if (gapDays === null) return `${awake} · 还没聊过`;
  if (gapDays < 0.02) return `${awake} · 刚刚还在说`;
  const d = Math.floor(gapDays);
  const h = Math.round((gapDays - d) * 24);
  const gap = d > 0 ? `${d} 天 ${h} 小时` : `${h} 小时`;
  const tone = active + fading > 0 ? ` · 记得 ${active + fading} 条（清晰 ${active}）` : "";
  return `${awake} · 距上次 ${gap}${tone}`;
}
