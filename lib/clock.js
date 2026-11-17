// 判定时钟：曲线命中（睡满判定时长的总命中率 = P_total）+ 拉普拉斯形状
// 设计约定 v22 L76-78（2026-11-15 作者拍板曲线命中）：做不做梦由曲线顺手判——判定时长内按拉普拉斯密度抽命中时刻，
// 命中密度的总质量 = P_total（睡满整个窗口的命中率）；角色实际睡多久决定累积到多少：
//   睡满 6h → P_total；睡到窗口中央 → 约 P_total/2；提前醒且没到命中时刻 → 本段不命中。
// 当日额度 K 由用户配置（Kmax 上限），每命中一场扣 1，扣到 0 当天不再判。

/**
 * 从曲线上抽一次命中时刻（返回相对窗口起点的小时数），null = 本段睡眠不命中。
 * 判定：先掷一次"整段命中"总质量（命中概率 = hitP），命中后再按窗口内归一化的拉普拉斯
 * 密度反采样出时刻 T。于是"角色睡到 t 时的累积命中率" = hitP × F(t)（F 为窗口内 CDF），
 * 睡满整段正好等于 hitP。
 */
export function drawHitTime(windowH, hitP, lambdaHours, lambdaRatio) {
  const wH = Math.min(24, Math.max(1, Number(windowH) || 6));
  const p = Math.min(1, Math.max(0, Number(hitP) || 0));
  if (p <= 0) return null;
  if (Math.random() >= p) return null; // 这一段整段都不命中的质量（1−hitP）
  const mu = wH / 2; // 窗口中央
  const lambda = Math.max(0.01, Number(lambdaHours) || (wH / (lambdaRatio ?? 12)));
  // 采样点反采样（600 点，6h 窗口约 36 秒粒度）
  const n = 600;
  const weights = [];
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * wH;
    const w = Math.exp(-Math.abs(t - mu) / lambda);
    weights.push(w);
    sum += w;
  }
  const u = Math.random() * sum;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (u <= acc) return (i / n) * wH;
  }
  return wH;
}

// 半幕字数与放送间隔随机取值（区间内均匀）
export function pickRange([min, max]) {
  return min + Math.random() * (max - min);
}

// —— 走神允许时段（分钟精度；支持跨零点：起点>终点视为跨夜，如 22:00—06:00）——
export function inWanderWindow(w, nowMs) {
  const arr = Array.isArray(w?.window) ? w.window : [8, 20];
  const start = Math.round(Number(arr[0] ?? 8) * 60);
  const end = Math.round(Number(arr[1] ?? 20) * 60);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const d = new Date(nowMs);
  const m = d.getHours() * 60 + d.getMinutes();
  return start < end ? (m >= start && m < end) : (m >= start || m < end);
}

// untilSleep 只放宽"终点"（到入睡前），起点不变：
// - 普通窗口（8-20）：开启后 = 8:00 之后都允许（凌晨 0-8 不算）
// - 跨零点窗口（22-6）：放宽后的终点仍是次日 6:00 前（设计约定：跨零点窗口从起点到次日终点前），与不开启相同
export function wanderTimeOk(w, nowMs) {
  const arr = Array.isArray(w?.window) ? w.window : [8, 20];
  const start = Math.round(Number(arr[0] ?? 8) * 60);
  const end = Math.round(Number(arr[1] ?? 20) * 60);
  const d = new Date(nowMs);
  const m = d.getHours() * 60 + d.getMinutes();
  if (!w?.untilSleep) return inWanderWindow(w, nowMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  return start < end ? m >= start : (m >= start || m < end);
}
