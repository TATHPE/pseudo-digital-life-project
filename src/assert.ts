/** 越界即抛（比 `!` 安全：漏了会炸而不是 NaN 悄悄传播） */
export function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`E_INDEX: ${i} out of range (len ${arr.length})`);
  return v;
}

export function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`E_MISSING: ${what}`);
  return v;
}
