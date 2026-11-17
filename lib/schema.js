// Config schema（设计约定 v22 十二节字段全量表落代码；schemastery）
// 数值字段带范围校验（防 0 值造成空转/刷爆调用；范围与面板下拉一致）。
// 注意：schemastery 的 z.natural() = 非负整数；概率/时长用 z.number().min().max()。
import z from '@deepseek-ai/schemastery';

const ratio = () => z.number().min(0).max(1); // 0-1 概率

export const Config = z.object({
  scope: z.array(z.string().role('text')).default([]).description('作用域会话 id 列表（空则不生效）'),
  dreamEnabled: z.boolean().default(false).description('做梦开关'),
  wanderEnabled: z.boolean().default(false).description('走神开关'),
  wander: z.object({
    window: z.tuple([z.number().min(0).max(24), z.number().min(0).max(24)]).default([8, 20]).description('允许时段（两个时间点，面板下拉整点/半点；如 8—20，跨零点写 22—6）'),
    untilSleep: z.boolean().default(true).description('放宽至入睡前'),
    aloneMin: z.number().min(1).default(15).description('独处触发时长（分钟，≥1）'),
    p: ratio().default(0.3).description('触发概率（0-1）'),
    factor: z.number().min(1).default(2).description('过度在意翻倍因子（≥1）'),
    threshold: z.natural().min(1).default(10).description('过度在意阈值（次，非负整数）'),
    max: z.number().min(1).default(50).description('单条走神上限（约字数；生成是自由发挥，实际可能略多或略少）'),
    dupThreshold: z.number().min(0.1).max(1).default(0.95).description('走神复读判定阈值（0.1-1；与今天已写走神的相似度 ≥ 此值算重复、会重试或放弃；越高越宽松）'),
  }).description('走神'),
  cycle: z.object({
    residueP: ratio().default(0.3).description('残留带入走神概率（0-1）'),
  }).description('循环'),
  judge: z.object({
    confirmH: z.number().min(0).max(5).default(1).description('入睡确认（静默满 N 小时才算睡着，判定时长从这一刻起算；可配置 0-5 小时，档位 0-1 每 0.1、1-3 每 0.5、3-5 每 1，默认 1）'),
    windowH: z.number().min(1).max(24).default(6).description('最长判定时长（整数小时 1-24，面板下拉；确认入睡后最多判定多久）'),
    intervalMin: z.number().min(0.1).default(30).description('旧字段（新机制不使用，保留兼容）'),
    dreamsPerDay: z.natural().default(1).description('Kmax：当日允许的梦数上限（非负整数）'),
    kMin: z.natural().default(0).description('已废弃（新机制无作用，仅兼容旧配置，下个版本删除）'),
    hitP: ratio().default(0.5).description('睡满整个判定时长的命中率（曲线总质量，0-1）'),
    lambdaRatio: z.number().min(1).default(12).description('λ=窗口/比例（曲线形状）'),
    lambdaHours: z.union([z.number().min(0.01), z.const(null)]).default(null).description('λ 独立覆盖（null=按比例）'),
  }).description('判定'),
  play: z.object({
    halfChars: z.tuple([z.number().min(1), z.number().min(1)]).default([100, 200]).description('半幕字数区间'),
    intervalMin: z.tuple([z.number().min(0.01), z.number().min(0.01)]).default([10, 30]).description('放送间隔区间（分钟，>0）'),
    actsPerRelease: z.number().min(0.5).default(0.5).description('每次放送幕数'),
    releaseMinutes: z.union([z.number().min(0.01), z.const('interval')]).default('interval').description('已废弃（放字时长由放送间隔决定，此字段无作用，下个版本删除）'),
    maxDurationMin: z.number().min(1).default(90).description('梦时长上限（分钟，≥1；默认 90）'),
  }).description('演出'),
  interrupt: z.object({
    sensitivity: z.union([z.const('weak'), z.const('mid'), z.const('strong')]).default('mid').description('敏感度'),
    count: z.natural().min(0).max(5).default(2).description('已废弃（累计满 2 次即断是固定机制，不提供配置；仅兼容旧配置，下个版本删除）'),
    weakPool: z.array(z.string().role('text')).default(['（呼噜噜......）']).description('弱档迷糊语小池'),
    midPool: z.array(z.string().role('text')).default(['（唔...）']).description('中档迷糊语小池'),
    fullName: z.string().role('text').default('').description('完整唤醒称呼（默认空）'),
    missP: ratio().default(0.05).description('没听见概率'),
    startleP: ratio().default(0.02).description('惊跳概率'),
  }).description('中断'),
  actJump: z.object({
    sceneP: ratio().default(0.25).description('场景跳基础概率（默认 15%）'),
    timeP: ratio().default(0.25).description('时间跳基础概率（默认 15%）'),
    linkage: ratio().default(0.75).description('跳跃关联程度（0=完全断开、1=紧密衔接；只写进生成提示词，不参与概率判定）'),
    chainP: ratio().default(0.65).description('已废弃（原跳后联动概率；现由 linkage 关联程度取代，仅兼容旧配置，下个版本删除）'),
  }).description('幕拍'),
  llm: z.object({
    provider: z.string().role('text').default('deepseek-account').description('直连生成用 provider（开源可换）'),
    model: z.string().role('text').default('deepseek-flash').description('直连生成用 model（开源可换）'),
  }).description('直连生成通道（走神/场景/半幕/判断共用）'),
  retry: z.natural().default(2).description('生成/判断失败重试次数'),
  copy: z.object({
    degrade: z.union([z.const('daily'), z.const('restart')]).default('daily').description('降档驱动'),
    visibility: z.array(z.number().min(0).max(100)).default([80, 40, 20, 0, 0]).description('逐日可见比例（第1格管今天/昨天、第2格管前天…；0=删除；默认 80/40/20/0/0）'),
    keepDays: z.natural().min(1).default(3).description('已废弃（保留期由 copy.visibility 唯一决定，本字段不参与计算；下个版本删除）'),
  }).description('副本'),
  frame: z.object({
    interruptMin: z.number().min(1).default(30).description('中断画面留存（分钟）'),
    naturalMin: z.number().min(1).default(120).description('自然梦画面留存（分钟）'),
  }).description('画面'),
  residue: z.object({
    form: z.union([z.const('words'), z.const('blur')]).default('blur').description('梦醒记忆形态（二选一）：words=词句残留（三词一句）/ blur=打码梦文本（全文按可见比例逐日变糊、到期删）'),
    hours: z.number().min(0).default(24).description('残留保留（小时，0-48，每 2 一档；0=不留；仅词句形态用）'),
    tiers: z.tuple([z.number().min(1), z.number().min(1), z.number().min(1), z.number().min(1)]).default([50, 100, 200, 300]).description('档位边界（仅词句形态用）'),
    visibility: z.array(z.number().min(0).max(100)).default([50, 30, 10, 0, 0]).description('打码梦文本形态：她能看到的比例序列（当天第1格、隔天第2格、再隔天第3格…；0=删除；默认 50/30/10/0/0，独立于副本）'),
  }).description('残留'),
  mood: z.object({
    hours: z.number().min(0).default(2).description('心情影响时长（小时，0-12，每 1 一档；0=醒后不留心情）'),
    scale: z.tuple([z.number(), z.number(), z.number()]).default([70, 80, 60]).description('示意刻度'),
  }).description('心情'),
  freq: z.object({
    stopwords: z.array(z.string().role('text')).default([]).description('停用词增删（合并内置表）'),
    names: z.array(z.string().role('text')).default([]).description('称呼表'),
    pronouns: z.array(z.string().role('text')).default(['我', '你', '他', '她', '它']).description('代词表（默认 我/你/他/她/它）'),
  }).description('词频'),
  bridge: z.object({
    dir: z.string().role('text').default('').description('桥接安装目录（读 state/console-token 与 social-v2.json）'),
    port: z.natural().min(1).max(65535).default(3100).description('桥接控制台端口'),
    keys: z.dict(z.string().role('text'), z.string().role('text')).default({}).description('会话 id ↔ 桥接 key 映射（private:QQ号 / group:群号）'),
  }).description('桥接适配'),
  signal: z.object({
    pollIntervalSec: z.tuple([z.number().min(1), z.number().min(1)]).default([2, 5]).description('轮询间隔区间（秒，1-10）'),
  }).description('信号'),
  dataDir: z.string().role('text').default('').description('数据目录（空=默认）'),
}).description('走神与做梦配置');


