// 走神与做梦插件 · 配置默认值 + 合并/钳制纯函数（测试可直接 import）
import { normalizeVisibility } from './copy.js';
// 这里是程序面默认值；宿主 schema（带校验/面板描述）见 lib/schema.js。

export const DEFAULTS = {
  // 开关（出厂全关）
  dreamEnabled: false,
  wanderEnabled: false,
  // 作用域会话 id 列表（空=不生效）
  scope: [],
  // 走神
  wander: {
    window: [8, 20], // 允许时段（默认 8-20，可放宽至入睡前）
    untilSleep: true, // 放宽至入睡前（作者定：默认开）
    aloneMin: 15, // 独处触发时长（分钟）
    p: 0.3, // 触发概率
    factor: 2, // 过度在意翻倍
    threshold: 10, // 过度在意阈值（次）
    max: 50, // 单条走神上限（约字数；生成是自由发挥）
  dupThreshold: 0.95, // 复读判定阈值（作者定：默认 0.95） // 复读判定阈值（0-1；相似度 ≥ 此值算重复，越高越宽松）
  },
  // 循环
  cycle: { residueP: 0.3 }, // 残留带入走神概率
  // 判定
  judge: {
    confirmH: 1, // 入睡确认（小时；作者定：默认 1）
    windowH: 6, // 最长判定时长（整数小时 1-24）
    intervalMin: 30, // 旧字段（新机制不使用，保留兼容）
    dreamsPerDay: 1, // Kmax：当日允许的梦数上限
    kMin: 0, // Kmin：当日允许的最少场数（仅声明）
    hitP: 0.5, // 睡满整个判定时长的命中率（曲线总质量）
    lambdaRatio: 12, // 曲线形状：λ=窗口/12
    lambdaHours: null, // 独立覆盖（null=按比例）
  },
  // 演出
  play: {
    halfChars: [100, 200],
    intervalMin: [10, 30],
    actsPerRelease: 0.5,
    releaseMinutes: 'interval', // 已废弃（放字时长由 intervalMin 决定；仅保留配置兼容，下个版本删除）
    maxDurationMin: 90, // 单场梦时长上限（作者定：默认 90 分钟）
  },
  // 中断（设计约定十节：敏感度三档 + 累计计数 + 代发 + 5%/3% 抖动）
  interrupt: {
    sensitivity: 'mid',
    count: 2, // 已废弃（设计约定十节固定满 2 次即断；仅兼容旧配置，下个版本删除）
    weakPool: ['（呼噜噜......）'],
    midPool: ['（唔...）'],
    fullName: '',
    missP: 0.05,
    startleP: 0.02,
  },
  actJump: { sceneP: 0.25, timeP: 0.25, linkage: 0.75, chainP: 0.65 }, // chainP 已废弃（与 schema 默认对齐，面板不显示）
  // 直连生成通道（走神/场景/半幕/判断共用；开源用户可换自己的 provider/model）
  llm: { provider: 'deepseek-account', model: 'deepseek-flash' },
  retry: 2,
  copy: { degrade: 'daily', visibility: [80, 40, 20, 0, 0], keepDays: 3 }, // keepDays 已废弃（保留期由 visibility 唯一决定）
  frame: { interruptMin: 30, naturalMin: 120 },
  residue: { form: 'blur', hours: 24, tiers: [50, 100, 200, 300], visibility: [50, 30, 10, 0, 0] }, // form 默认 blur（作者定：打码梦文本）
  mood: { hours: 2, scale: [70, 80, 60] },
  freq: {
    stopwords: [], // 内置虚词表 + 可增删
    names: [], // 称呼表（默认空）
    pronouns: ['我', '你', '他', '她', '它'], // 设计约定十二节默认五词
  },
  // 桥接适配（设计约定十二节：scope 会话 id ↔ 桥接 key 映射表；signal 通道必需）
  bridge: {
    dir: '', // 桥接安装目录（含 state/console-token 与 state/social-v2.json）
    port: 3100, // 桥接控制台端口
    keys: {}, // { '<DSH 会话 id>': 'group:群号' | 'private:QQ号' }
  },
  signal: {
    pollIntervalSec: [2, 5], // 轮询间隔（秒，设计约定十二节）
  },
  // 数据目录（默认 <DSH_HOME>/dream-wander-data；可配 dataDir / 环境变量 DREAM_WANDER_DATA）
  dataDir: '',
};

// 内置虚词停用表（口语场景常用虚词 + 英文思考碎片虚词；配置可增删）
export const BUILTIN_STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '就', '都', '也', '还', '又', '再',
  '把', '被', '让', '给', '对', '从', '向', '往', '到', '去', '来', '着', '过',
  '得', '地', '啊', '吧', '呢', '吗', '哦', '嗯', '呀', '嘛', '哈', '啦',
  '一个', '这个', '那个', '什么', '怎么', '为什么', '这样', '那样', '这么', '那么',
  '不', '没', '很', '太', '最', '更', '挺',
  '但', '而', '且', '因为', '所以', '如果', '虽然', '然后', '可是', '只是',
  '今天', '昨天', '明天', '现在', '刚才', '已经', '正在', '马上',
  '这', '那', '一', '上', '下', '里', '外', '中', '前', '后', '些', '儿', '有点', '突然',
  // 英文思考（reasoning）里的虚词与功能词：她的思考常是英文，滤掉这些防英文碎片进词池/入梦（审查 D14）
  'the', 'and', 'but', 'for', 'with', 'that', 'this', 'these', 'those', 'from', 'into',
  'was', 'were', 'are', 'is', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'shall',
  'not', 'no', 'nor', 'so', 'if', 'or', 'as', 'than', 'then', 'too', 'very', 'just', 'only',
  'also', 'more', 'most', 'some', 'any', 'all', 'each', 'every', 'other', 'same', 'such',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'here', 'there', 'now', 'again', 'once', 'about', 'above', 'below', 'between',
  'during', 'before', 'after', 'against', 'through', 'under', 'over', 'out', 'off', 'up', 'down',
  'it', 'its', 'he', 'she', 'they', 'them', 'their', 'we', 'our', 'us', 'you', 'your', 'my', 'me',
  'i', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'is', 'as',
  // 注意：人称/代词（我/你/他/她/它…）不在此表——设计约定六节：代词计数但不进高频档，
  // 过滤在 freq 的 topHigh/drawWords 分档层做，不在计数层。
]);


// —— 配置合并与钳制（纯函数；index.js 与测试共用）——

export function mergeConfig(raw, defaults = DEFAULTS) {
  const cfg = structuredClone(defaults);
  for (const k of Object.keys(raw ?? {})) {
    if (Array.isArray(raw[k])) { cfg[k] = raw[k]; continue; } // 数组整体覆盖（空数组也要能覆盖非空默认）
    if (typeof cfg[k] === 'object' && cfg[k] && typeof raw[k] === 'object') {
      Object.assign(cfg[k], raw[k]);
    } else if (raw[k] !== undefined) {
      cfg[k] = raw[k];
    }
  }
  return cfg;
}

// 概率类字段：只钳制到 0-1；不取整（默认值里有 0.05/0.02）
export const PROB_PATHS = [
  ['wander', 'p'], ['wander', 'dupThreshold'], ['cycle', 'residueP'], ['interrupt', 'missP'], ['interrupt', 'startleP'],
  ['actJump', 'sceneP'], ['actJump', 'timeP'], ['actJump', 'linkage'], ['judge', 'hitP'],
];

export function roundProbs(cfg) {
  for (const [g, k] of PROB_PATHS) {
    const v = cfg?.[g]?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) cfg[g][k] = Math.min(1, Math.max(0, v));
  }
  return cfg;
}

// 次数/时长类字段：整数与值域；confirmH 按分段档位吸附；copy.visibility 归一化
export function clampCounts(cfg) {
  const fix = (obj, k, min) => {
    const v = obj?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) obj[k] = Math.max(min, Math.round(v));
  };
  fix(cfg.judge, 'dreamsPerDay', 0);
  fix(cfg.judge, 'kMin', 0);
  fix(cfg.interrupt, 'count', 1);
  fix(cfg.wander, 'threshold', 1);
  fix(cfg.wander, 'factor', 1);
  fix(cfg.copy, 'keepDays', 1);
  fix(cfg, 'retry', 0);
  // 入睡确认：分段档位（0-1 每 0.1、1-3 每 0.5、3-5 每 1；默认 1）
  {
    const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 2.5, 3, 4, 5];
    const v = Number(cfg.judge?.confirmH);
    if (Number.isFinite(v)) {
      let best = steps[0];
      let bd = Infinity;
      for (const st of steps) { const d = Math.abs(st - v); if (d < bd) { bd = d; best = st; } }
      cfg.judge.confirmH = best;
    }
  }
  // 最长判定时长：整数小时 1-24
  {
    const v = Number(cfg.judge?.windowH);
    if (Number.isFinite(v)) cfg.judge.windowH = Math.min(24, Math.max(1, Math.round(v)));
  }
  // λ 比例：整数、至少 1
  {
    const v = Number(cfg.judge?.lambdaRatio);
    if (Number.isFinite(v)) cfg.judge.lambdaRatio = Math.max(1, Math.round(v));
  }
  // 副本可见比例：归一化（保留期由序列唯一决定）
  if (cfg.copy) cfg.copy.visibility = normalizeVisibility(cfg.copy.visibility);
  // 残留档位边界：4 个整数、单调递增
  if (Array.isArray(cfg.residue?.tiers)) {
    const arr = cfg.residue.tiers.slice(0, 4).map((v) => Math.max(1, Math.round(Number(v) || 0))); // 与 schema min(1) 一致
    while (arr.length < 4) arr.push(arr.length ? arr[arr.length - 1] : 0);
    for (let i = 1; i < arr.length; i++) if (arr[i] < arr[i - 1]) arr[i] = arr[i - 1];
    cfg.residue.tiers = arr;
  }
  // 轮询间隔：2 项整数秒 1-10、min ≤ max
  if (Array.isArray(cfg.signal?.pollIntervalSec)) {
    const arr = cfg.signal.pollIntervalSec.slice(0, 2).map((v) => Math.min(10, Math.max(1, Math.round(Number(v) || 1))));
    while (arr.length < 2) arr.push(arr[0] ?? 2);
    if (arr[1] < arr[0]) arr[1] = arr[0];
    cfg.signal.pollIntervalSec = arr;
  }
  return cfg;
}
