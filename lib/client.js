/**
 * dream-wander —— 浏览器半侧（手写 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 在设置页注册一个「走神与做梦」一级入口（slot: settings.section，与「人格」平级），
 * 页面里展示插件的全部可配置项：开关、作用域、走神、判定、演出、中断、幕拍、副本、
 * 画面、残留、心情、词频、桥接、信号等。保存走宿主 configEditor（热应用，无需重启）。
 *
 * 与宿主端只走同源 HTTP（/api/dream-wander/config），不碰 RPC。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dream-wander',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useEffect = React.useEffect
    var useState = React.useState

    var API = '/api/dream-wander/config'
    var VIEW_API = '/api/dream-wander/view'
    // 客户端构建标记：刷新页面后据此确认加载的是最新 bundle（不是浏览器缓存的旧版）
    var BUILD_TAG = '2026-11-17 15:30'

    // ---- 同源 API ---------------------------------------------------------

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var msg = (data && data.error) ? data.error : ('HTTP ' + res.status)
          var err = new Error(msg)
          err.status = res.status
          throw err
        }
        return data
      })
    }
    function apiGet() {
      return fetch(API, { cache: 'no-store' }).then(readJson)
    }
    function apiPost(body) {
      return fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    // ---- 字段说明（中文 label / hint；缺省回显字段名） ---------------------

    var LABELS = {
      dreamEnabled: ['做梦开关', '开启后角色睡着时按曲线判定这场梦做不做（睡满判定时长的命中率 = hitP）'],
      wanderEnabled: ['走神开关', '开启后独处时可能产生走神联想'],
      scope: ['作用域会话',
        '插件生效的会话（可多选）。点下方「会话列表」里的会话加入即可，不用手抄 id；' +
        '桥接会话会自动带上「桥接」标记。留空 = 插件不生效。'],
      retry: ['失败重试次数', '生成/判断调用失败后的重试次数'],
      dataDir: ['数据目录', '空 = 默认 <DSH_HOME>/dream-wander-data（DSH_HOME 默认 ~/.dsh）；填 ./data 可让数据跟着插件目录走'],
      'wander.window': ['走神允许时段', '两个时间点（下拉，整点/半点），如 08:00 — 20:00（含起点、不含终点）；跨零点可写 22:00 — 06:00'],
      'wander.untilSleep': ['放宽至入睡前', '开启后熬夜独处也允许走神，入睡即停'],
      'wander.aloneMin': ['独处触发时长', '连续无人理角色的分钟数'],
      'wander.p': ['走神触发概率', '0-1，单次触发判定'],
      'wander.factor': ['过度在意翻倍因子', '过度在意时概率 × 该因子'],
      'wander.threshold': ['过度在意阈值', '最高频词出现次数超过该值算过度在意'],
      'wander.max': ['单条走神上限', '约字数（生成是自由发挥，实际可能略多或略少）'],
      'wander.dupThreshold': ['走神复读阈值', '和今天已写走神的相似度 ≥ 这个值就算重复（会重试或放弃）；0.1-1，越高越宽松，默认 0.95'],
      'cycle.residueP': ['残留带入走神概率', '0-1，走神时带入最近一场梦残留的概率'],
      'judge.confirmH': ['入睡确认', '静默满 N 小时才算睡着（0-1 小时 0.1 一档、1-3 小时 0.5 一档、3-5 小时 1 一档），判定时长从这一刻起算；0=一有巡检就确认入睡，不建议'],
      'judge.windowH': ['最长判定时长', '确认入睡后最多判定多久（小时）；这段时间内抽命中时刻，时长走完仍未命中则本段不判'],
      'judge.dreamsPerDay': ['当日梦数上限 Kmax', '一天最多允许做几场梦（额度，做一场扣 1）'],
      'judge.hitP': ['睡满时长命中率', '睡满整个判定时长时做一场梦的概率（0-1，默认 0.5）；如果只睡到一半就醒，概率大约是它的一半；醒得越早概率越低'],
      'judge.lambdaRatio': ['拉普拉斯 λ 比例', 'λ = 判定时长 ÷ 该值（曲线形状，默认 12）；数值越大，命中时刻越集中在中间'],
      'judge.lambdaHours': ['λ 独立覆盖', '数字（小时）则优先于比例；null = 用比例'],
      'play.halfChars': ['半幕字数区间', 'min 与 max（各 50-300，每 50 一档；默认 100、200），半幕字数在这两个值之间'],
      'play.intervalMin': ['放送间隔区间', '每个半幕用多少分钟滴放完（min/max，5-60 分钟，每 5 一档）；间隔越长，一个字一个字放得越慢'],
      'play.actsPerRelease': ['每次放送幕数', '0.5 = 半幕一次；≥1 = 攒整幕一次（0.5-5，每 0.5 一档）'],
      'play.maxDurationMin': ['单场梦时长上限', '一场梦最多演出多少分钟（10-180，每 10 一档；默认 90 分钟；到点强制收场，按自然结束结算）'],
      'interrupt.sensitivity': ['敏感度', '弱档：所有信号（拍/@/点名/私聊/群聊）共用计数，第 1 次只代发一句哼唧（拍/@/点名变形混进梦里），累计第 2 次断\n中档（默认）：拍/@/群聊共用计数，第 1 次哼唧、第 2 次断；点名第 1 次就断、私聊立即断\n强档：拍/@/点名/私聊第 1 次就断，群聊普通消息不计数'],
      'interrupt.weakPool': ['弱档迷糊语池', '逗号或顿号分隔（中英文逗号都行）；第 1 次未断时代发'],
      'interrupt.midPool': ['中档迷糊语池', '逗号或顿号分隔（中英文逗号都行）；第 1 次未断时代发'],
      'interrupt.fullName': ['完整唤醒称呼', '点名/@ 判定用；空 = 仅按引用角色的消息判定。上群聊建议填（如「小助手」），否则 @ 角色被识别成普通群消息'],
      'interrupt.missP': ['没听见概率', '这次动静角色没察觉（不计数、不哼唧、不变形；只对进入计数的信号生效）'],
      'interrupt.startleP': ['惊跳概率', '被这一下直接惊醒、梦立即断（按外部中断结算；只对进入计数的信号生效）'],
      'actJump.sceneP': ['场景跳跃基础概率', '每幕开头独立判定；可选 0 / 0.25 / 0.50 / 0.75 / 1.00（默认 0.25）'],
      'actJump.timeP': ['时间跳跃基础概率', '每幕开头独立判定；可选 0 / 0.25 / 0.50 / 0.75 / 1.00（默认 0.25）'],
      'actJump.linkage': ['跳跃关联程度', '跳跃时前后故事的关联松紧：0=完全断开、1=紧密衔接（只影响生成内容，不影响跳不跳的概率）；可选 0 / 0.25 / 0.50 / 0.75 / 1.00'],
      'copy.degrade': ['副本降档驱动', 'daily = 每天一降；restart = 每次重启一降'],
      'copy.visibility': ['副本可见比例', '按副本日期距今几格（以零点为界）：0-1 天用第 1 格、2 天用第 2 格、3 天用第 3 格、4 天用第 4 格、5 天用第 5 格，再早删除；副本日期=梦开始那天。每格是那天还能看见多少（100%=全看得见、10%=只剩一成），选「无」=那天删除。默认 80/40/20/无/无（前三天依次变模糊、第四天删）。改大不会复活已删副本、也不会恢复已打码的字。'],
      'copy.keepDays': ['副本保留天数（已废弃）', '保留期由「副本可见比例」的序列唯一决定，这一项不参与计算；下个版本删除'],
      'frame.interruptMin': ['中断画面留存', '中断梦的最后画面留多少分钟（10-180，每 10 一档）；期间按三等分阶梯打码：前 1/3 完整、中间 1/3 遮一半、最后 1/3 再遮一半，到点清空'],
      'frame.naturalMin': ['自然梦画面留存', '自然结束的梦最后画面留多少分钟（10-180，每 10 一档）'],
      'residue.form': ['梦醒记忆形态', '二选一：词句残留（角色只记得最多三词一句）/ 打码梦文本（整段梦按可见比例盖方块，逐日变糊、到期删）'],
      'residue.hours': ['残留保留时长', '仅词句形态：残留保留多少小时（0-48，每 2 一档；0=不留残留）；自梦醒起算'],
      'residue.tiers': ['残留档位边界', '仅词句形态：按梦的字数决定留多少残留——不到第 1 个边界=1 词；第 1-2 之间=1 句；第 2-3 之间=1 词 1 句；第 3-4 之间=2 词 1 句；超过第 4 个=3 词 1 句。默认 50/100/200/300 字；后面的边界不会低于前一个'],
      'residue.visibility': ['角色能记住的可见比例', '打码梦文本形态专用（独立于副本）：当天用第 1 格、隔天用第 2 格、再隔天用第 3 格…（与副本"0-1 天同格"不同）；每格是那天梦的正文还能看见多少（100%=全看得见、10%=只剩一成），选「无」=那天删除。默认 50/30/10/无/无（今天一半被方块盖住，第二天剩三成，第三天剩一成，第四天忘光）'],
      'mood.hours': ['心情影响时长', '心情影响多少小时（0-12，每 1 一档；0=醒后不留心情）；画面过期则心情随之散'],
      // mood.scale（心情示意刻度）：无用字段，面板不显示（见 DEAD_PATHS）
      'freq.stopwords': ['停用词', '逗号或顿号分隔（中英文逗号都行）；并入内置表'],
      'freq.names': ['称呼表', '逗号或顿号分隔（中英文逗号都行）；计频但不进高频档'],
      'freq.pronouns': ['代词表', '逗号或顿号分隔（中英文逗号都行）；计频但不进高频档'],
      'bridge.dir': ['桥接安装目录', '填 qq-bridge 的安装目录（里面要有 state/social-v2.json）；没装桥接可留空'],
      'bridge.port': ['桥接端口', '桥接控制台的端口，默认 3100（范围 1-65535）'],
      'bridge.keys': ['会话↔桥接 key 映射', '每行一条：左边 DSH 会话 id = 右边桥接 key（私聊写 private:QQ号、群聊写 group:群号）。可先点上面的「一键填入」自动读取；不在映射里的会话，角色睡着时收不到消息'],
      'signal.pollIntervalSec': ['轮询间隔', '插件去桥接拿消息的间隔（两个秒数，1-10，每 1 一档）'],
      'llm.provider': ['直连生成 provider', '走神/梦生成用的 provider（默认 deepseek-account，开源可换）'],
      'llm.model': ['直连生成 model', '走神/梦生成用的 model（默认 deepseek-flash，开源可换）'],
    }

    var GROUP_TITLES = {
      wanderEnabled: '开关',
      dreamEnabled: '开关',
      scope: '基础',
      retry: '基础',
      dataDir: '基础',
      llm: '基础',
      wander: '走神',
      cycle: '走神',
      judge: '判定',
      play: '演出',
      interrupt: '中断',
      actJump: '幕拍',
      copy: '副本',
      frame: '画面',
      residue: '残留',
      mood: '心情',
      freq: '词频',
      bridge: '桥接',
      signal: '信号',
    }
    var GROUP_ORDER = ['基础', '开关', '走神', '判定', '演出', '中断', '幕拍', '副本', '画面', '残留', '心情', '词频', '桥接', '信号']
    // 分组说明（新手看得懂的一句话）；没有的组不显示
    var GROUP_HINTS = {
      残留: '残留 = 一场梦结束后角色手里剩下的词和句子（最多三词一句）。角色只记得这些、不知道梦的全文；这里调"留多少、留多久"。',
      画面: '画面 = 梦的最后画面在角色脑子里的短暂印象（用于心情与残留取词）；这里调它留多久、怎么变模糊。',
      副本: '副本 = 写进「梦境副本」文件夹给使用者查阅的梦境存档，按天逐步打码、过期删除。',
      幕拍: '幕拍 = 梦境把「幕」切成段时要不要发生场景/时间跳跃，以及跳跃跟上一幕有多相关。',
      判定: '判定 = 角色睡着后这场梦做不做、最多判多久。',
      演出: '演出 = 一场梦怎么一段段慢慢放出来（字数、节奏、总时长上限）。',
      中断: '中断 = 梦被外面的动静打断的规则（什么信号算、几档敏感度）。',
      走神: '走神 = 角色独处时短路式联想；这里调允许时段、触发概率、长短。',
      桥接: '桥接 = qq-bridge 程序。插件靠它看到消息、发被动回应，并判断角色什么时候睡着/醒来。装好后一般只配一次。',
      信号: '信号 = 角色睡着时插件从桥接拿消息的频率。调大反应慢、调小请求多，一般不用改。',
      心情: '心情 = 梦醒后短暂的情绪（只是模糊感受，不做数值计算）。',
    }

    // ---- 样式（只引用宿主主题 token） -------------------------------------

    var CSS = [
      '.dw-section{padding:4px 0 40px}',
      '.dw-head{margin:0 0 6px;font-size:16px;font-weight:600}',
      '.dw-sub{margin:0 0 18px;font-size:12px;opacity:.6;line-height:1.6}',
      '.dw-group{margin:0 0 22px}',
      '.dw-group-title{font-size:13px;font-weight:600;margin:0 0 8px;opacity:.9}',
      '.dw-adv{margin:6px 0 0;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:8px;padding:8px 12px}',
      '.dw-adv>summary{cursor:pointer;font-size:13px;opacity:.85;outline:none}',
      '.dw-adv[open]>summary{margin:0 0 10px}',
      '.dw-row{display:flex;align-items:flex-start;gap:12px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}',
      '.dw-inline{display:flex;align-items:center;gap:8px}',
      '.dw-time{text-align:center}',
      // 下拉框宽度按内容自适应（次数下拉只有两位数、时段下拉显示 08:00），避免撑满整行
      '.dw-input.dw-select{width:auto;min-width:44px}',
      // 次数/时长下拉：固定 64px（三位数宽度）；时段下拉仍走 auto（显示 08:00 不截断）
      '.dw-input.dw-int{width:64px}',
      // 数字或特殊值混用的文本输入框（λ 独立覆盖）：窄框 64px
      '.dw-input.dw-narrow{width:64px}',
      '.dw-select{appearance:auto;cursor:pointer;padding:4px 6px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit)}',
      '.dw-select>option{background:var(--dsw-alias-bg-layer-2,#1e1e1e);color:var(--dsw-alias-label-primary,inherit)}',
      '.dw-num-wrap{display:flex;flex-direction:column;gap:4px}',
      '.dw-input-invalid{border-color:var(--dsw-alias-state-error-primary,#e5484d)!important;color:var(--dsw-alias-state-error-primary,#e5484d)!important}',
      '.dw-err{font-size:11px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dw-warn{margin:0 0 14px;padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.5;border:1px solid var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dw-sep{opacity:.5}',
      '.dw-row:last-child{border-bottom:none}',
      '.dw-label{width:190px;flex:0 0 190px;font-size:13px;padding-top:2px}',
      '.dw-hint{font-size:11px;opacity:.55;margin-top:2px;line-height:1.5;white-space:pre-line}',
      '.dw-view-actions{margin:4px 0 8px;display:flex;align-items:center}',
      '.dw-view-block{margin:8px 0}',
      '.dw-view-title{font-size:12px;opacity:.8;margin-bottom:3px}',
      '.dw-view-pre{margin:0;padding:8px 10px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:6px}',
      '.dw-control{flex:1;min-width:0;display:flex;align-items:center;gap:8px}',
      '.dw-input{width:100%;box-sizing:border-box;padding:5px 8px;font-size:13px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit);outline:none}',
      '.dw-input:focus{border-color:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.dw-input-num{width:96px}',
      '.dw-area{min-height:56px;resize:vertical;font-family:inherit}',
      '.dw-switch{position:relative;width:40px;height:22px;border-radius:11px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.28));border:none;cursor:pointer;transition:background .15s;flex:0 0 40px;padding:0}',
      '.dw-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.dw-switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-base,#fff);transition:left .15s}',
      '.dw-switch[aria-checked="true"]::after{left:20px;background:var(--dsw-alias-bg-base,#111)}',
      '.dw-actions{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;padding:14px 0 6px;background:linear-gradient(to top,var(--dsw-alias-bg-base,#111) 60%,transparent)}',
      '.dw-btn{padding:6px 18px;font-size:13px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit);cursor:pointer}',
      '.dw-btn-primary{background:var(--dsw-alias-brand-primary,#4a7dff);border-color:transparent;color:var(--dsw-alias-bg-base,#111)}',
      '.dw-btn:disabled{opacity:.5;cursor:default}',
      '.dw-status{font-size:12px;opacity:.75;color:var(--dsw-alias-label-secondary,inherit)}',
      '.dw-status-err{color:var(--dsw-alias-state-error-primary,#e0533d)}',
      '.dw-empty{padding:20px 0;font-size:13px;opacity:.6}',
      '.dw-mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;word-break:break-all}',
      '.dw-chips{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 8px}',
      '.dw-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));font-size:11px;max-width:100%}',
      '.dw-chip-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dw-chip-bridge{border-color:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.dw-chip-tag{font-size:10px;opacity:.8;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.1))}',
      '.dw-chip-x{border:none;background:none;color:inherit;opacity:.6;cursor:pointer;font-size:13px;line-height:1;padding:0 2px}',
      '.dw-chip-x:hover{opacity:1}',
      '.dw-picker{margin-top:6px}',
      '.dw-picker-summary{cursor:pointer;font-size:12px;opacity:.75;padding:2px 0}',
      '.dw-picker-list{margin-top:4px;max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:6px}',
      '.dw-picker-item{display:flex;align-items:center;gap:8px;padding:5px 8px;font-size:12px;cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))}',
      '.dw-picker-item:last-child{border-bottom:none}',
      '.dw-picker-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}',
      '.dw-picker-item-on{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}',
      '.dw-picker-check{width:14px;flex:0 0 14px;opacity:.85}',
      '.dw-picker-id{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace}',
      '.dw-picker-meta{flex:1;text-align:right;opacity:.5;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dw-detect{padding:8px 10px;margin-bottom:8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));font-size:12px}',
      '.dw-detect-line{line-height:1.6}',
      '.dw-ws{margin:2px 0}',
      '.dw-ws-title{cursor:pointer;font-size:12px;font-weight:600;padding:4px 0}',
      '.dw-ws-path{font-weight:400;opacity:.55}',
      '.dw-ws-count{font-weight:400;opacity:.45}',
    ].join('\n')

    // ---- 工具 -------------------------------------------------------------

    function isPlainObject(v) {
      return v !== null && typeof v === 'object' && !Array.isArray(v)
    }

    function labelOf(path) {
      var m = LABELS[path]
      return m ? m[0] : path
    }
    function hintOf(path) {
      var m = LABELS[path]
      return m ? m[1] : ''
    }

    function deepSet(obj, path, value) {
      var parts = path.split('.')
      var cur = obj
      for (var i = 0; i < parts.length - 1; i++) {
        var k = parts[i]
        if (!isPlainObject(cur[k])) cur[k] = {}
        cur = cur[k]
      }
      cur[parts[parts.length - 1]] = value
    }
    function deepGet(obj, path) {
      var parts = path.split('.')
      var cur = obj
      for (var i = 0; i < parts.length; i++) {
        if (cur === null || cur === undefined) return undefined
        cur = cur[parts[i]]
      }
      return cur
    }

    // ---- 控件 -------------------------------------------------------------

    function Switch(props) {
      var on = !!props.value
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        className: 'dw-switch',
        onClick: function () { props.onChange(!on) },
      })
    }

    // 废弃/无用字段：面板不显示、保存时剥除（不再写回 profile 覆盖层；下个版本从 schema/config 删除）
    var DEAD_PATHS = ['judge.kMin', 'judge.intervalMin', 'play.releaseMinutes', 'interrupt.count', 'actJump.chainP', 'copy.keepDays', 'mood.scale']
    // 高级字段：默认平铺显示（2026-11-16 作者要求"暂时不用收作高级项"）；
    // 以后要收折叠，把字段路径填回这个数组即可（渲染逻辑保留）
    var ADVANCED_PATHS = []
    // 入睡确认档位：0-1 每 0.1、1-3 每 0.5、3-5 每 1（2026-11-16 作者定）
    var CONFIRM_STEPS = (function () {
      var out = []
      for (var i = 0; i <= 10; i++) out.push(i / 10)
      out.push(1.5, 2, 2.5, 3, 4, 5)
      return out
    })()

    function stripDeadPaths(cfg) {
      var out = JSON.parse(JSON.stringify(cfg || {}))
      DEAD_PATHS.forEach(function (p) {
        var parts = p.split('.')
        var obj = out
        for (var i = 0; i < parts.length - 1; i++) obj = obj ? obj[parts[i]] : null
        if (obj && typeof obj === 'object') delete obj[parts[parts.length - 1]]
      })
      return out
    }

    // 概率/比例类字段：显示与保存都限制在小数点后一位（避免 0.333333 这种难算的值）
    var PROB_SUFFIX = { '.p': 1, '.residueP': 1, '.missP': 1, '.startleP': 1, '.sceneP': 1, '.timeP': 1, '.chainP': 1, '.linkage': 1, '.hitP': 1 }
    function isProbPath(p) {
      var i = String(p).lastIndexOf('.')
      return i >= 0 && !!PROB_SUFFIX[String(p).slice(i)]
    }
    function roundProb(v) {
      return typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : v
    }
    function roundProbPaths(cfg) {
      // 只钳制到 0-1，不改小数位（默认值 0.05/0.02 必须原样保留）
      var out = JSON.parse(JSON.stringify(cfg || {}))
      Object.keys(out).forEach(function (k) {
        var v = out[k]
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          Object.keys(v).forEach(function (sub) {
            if (isProbPath(k + '.' + sub) && typeof v[sub] === 'number') {
              v[sub] = Math.min(1, Math.max(0, v[sub]))
            }
          })
        }
      })
      return out
    }

    // 次数类字段：面板只接受非负整数（下拉选择）
    var COUNT_SUFFIX = { '.dreamsPerDay': 1, '.kMin': 1, '.count': 1, '.threshold': 1, '.retry': 1, '.keepDays': 1, '.factor': 1, '.max': 1 }
    // 各次数项的可选范围（下拉选项）与步进
    var COUNT_RANGES = { '.retry': [0, 10], '.dreamsPerDay': [0, 10], '.count': [0, 5], '.keepDays': [1, 10], '.threshold': [1, 30], '.factor': [1, 5], '.max': [50, 500] }
    var COUNT_STEPS = { '.max': 50 }
    function countSuffix(p) {
      var s = String(p)
      var i = s.lastIndexOf('.')
      // 顶层字段（如 retry）没有点号：补一个点再查表，否则会漏成普通数字输入框
      return i >= 0 ? s.slice(i) : '.' + s
    }
    function isCountPath(p) { return !!COUNT_SUFFIX[countSuffix(p)] }
    function countRange(p) { return COUNT_RANGES[countSuffix(p)] || [0, 10] }
    function countStep(p) { return COUNT_STEPS[countSuffix(p)] || 1 }
    function IntSelect(props) {
      var range = props.range || [0, 10]
      var step = Math.max(1, Math.floor(Number(props.step) || 1))
      var opts = []
      for (var i = range[0]; i <= range[1]; i += step) opts.push(h('option', { key: i, value: String(i) }, String(i)))
      var cur = Math.round(Number(props.value))
      if (!isFinite(cur)) cur = range[0]
      // 归到最近的步进档，再夹在范围内
      cur = range[0] + Math.round((cur - range[0]) / step) * step
      cur = Math.min(range[1], Math.max(range[0], cur))
      return h('select', {
        className: 'dw-input dw-time dw-select dw-int',
        value: String(cur),
        onChange: function (e) { props.onChange(Number(e.target.value)) },
      }, opts)
    }

    // 数字输入：只接受数字与小数点；其他字符**直接拒绝**（框内根本不出现），并短暂红框提醒
    var NUM_TEXT = /^[0-9]*\.?[0-9]*$/
    function NumberInput(props) {
      var decimals = typeof props.decimals === 'number' ? props.decimals : null
      var isInt = !!props.integer
      var pmin = typeof props.min === 'number' ? props.min : null
      var pmax = typeof props.max === 'number' ? props.max : null
      var state = useState(null)
      var draft = state[0]
      var setDraft = state[1]
      var warnState = useState(false)
      var warn = warnState[0]
      var setWarn = warnState[1]
      var norm = function (v) {
        if (typeof v !== 'number' || !isFinite(v)) return v
        if (isInt) v = Math.round(v)
        if (decimals !== null) { var f = Math.pow(10, decimals); v = Math.round(v * f) / f }
        if (pmin !== null && v < pmin) v = pmin
        if (pmax !== null && v > pmax) v = pmax
        return v
      }
      // 显示用原值（设计约定默认值里有 0.05/0.02，不能因为显示取整就把它们改成 0.1/0.0）；
      // 只有用户输入时才按 decimals 归一
      var base = (props.value === null || props.value === undefined || Number.isNaN(props.value)) ? '' : String(props.value)
      var shown = draft !== null ? draft : base
      return h('div', { className: 'dw-num-wrap' },
        h('input', {
          className: 'dw-input dw-input-num' + (warn ? ' dw-input-invalid' : ''),
          type: 'text',
          inputMode: 'decimal',
          value: shown,
          onChange: function (e) {
            var v = e.target.value
            if (!NUM_TEXT.test(v)) { setWarn(true); return } // 非数字（符号/字母/中文）：直接拒绝，不写入框
            setWarn(false)
            setDraft(v) // 输入过程中保留原文，不打断打字
            if (v === '') { props.onChange(''); return }
            var n = Number(v)
            if (isFinite(n)) props.onChange(norm(n)) // 提交时归一（取整/一位小数/钳制范围）
          },
          onBlur: function () { setDraft(null); setWarn(false) },
        }),
        warn ? h('div', { className: 'dw-err' }, '只能输入数字') : null,
      )
    }

    /** [min, max] 之类的数字数组 → 逗号分隔输入（草稿态：ON 输入时保留原文，失焦才解析提交） */
    function NumberListInput(props) {
      var list = Array.isArray(props.value) ? props.value : []
      var [draft, setDraft] = React.useState(null)
      var shown = draft !== null ? draft : list.join(', ')
      return h('input', {
        className: 'dw-input',
        type: 'text',
        value: shown,
        placeholder: '用逗号或顿号分隔（中英文都行）',
        onChange: function (e) { setDraft(e.target.value) },
        onBlur: function () {
          var parts = String(shown).split(/[,，、]/).map(function (x) { return x.trim() }).filter(function (x) { return x !== '' })
          var nums = parts.map(Number)
          setDraft(null)
          if (nums.some(function (n) { return Number.isNaN(n) })) return // 有非数字：不提交（保持原值）
          props.onChange(nums)
        },
      })
    }

    /** 字符串数组 → 逗号分隔输入（草稿态） */
    function StringListInput(props) {
      var list = Array.isArray(props.value) ? props.value : []
      var [draft, setDraft] = React.useState(null)
      var shown = draft !== null ? draft : list.join(', ')
      return h('input', {
        className: 'dw-input',
        type: 'text',
        value: shown,
        placeholder: '用逗号或顿号分隔（中英文都行）',
        onChange: function (e) { setDraft(e.target.value) },
        onBlur: function () {
          var parts = String(shown).split(/[,，、]/).map(function (x) { return x.trim() }).filter(function (x) { return x !== '' })
          setDraft(null)
          props.onChange(parts)
        },
      })
    }

    /** 任意对象（如 bridge.keys）→ 每行 key=value 文本编辑 */
    function KVInput(props) {
      var obj = isPlainObject(props.value) ? props.value : {}
      var text = Object.keys(obj).map(function (k) { return k + '=' + String(obj[k]) }).join('\n')
      return h('textarea', {
        className: 'dw-input dw-area',
        defaultValue: text,
        placeholder: '每行一条：会话id=private:QQ号',
        onChange: function (e) {
          var out = {}
          e.target.value.split('\n').forEach(function (line) {
            var i = line.indexOf('=')
            if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
          })
          props.onChange(out)
        },
      })
    }

    // ---- 时段输入（下拉选整点/半点，显示「时:分」；内部值是小时数，0.5=00:30、24=24:00） ----
    function HourSelect(props) {
      var arr = Array.isArray(props.value) ? props.value : [8, 20]
      var opts = []
      for (var i = 0; i <= 48; i++) { // 00:00 起每半点一个，共 49 档（含 24:00）
        var hours = i / 2
        var hh = Math.floor(hours)
        var mm = i % 2 === 0 ? 0 : 30
        opts.push(h('option', { key: String(hours), value: String(hours) },
          String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0')))
      }
      var cur = function (idx) {
        var n = Number(arr[idx] ?? (idx === 0 ? 8 : 20))
        if (!isFinite(n) || n < 0) n = 0
        if (n > 24) n = 24
        return String(Math.round(n * 2) / 2) // 归一到半点步进
      }
      return h('div', { className: 'dw-inline' },
        h('select', { className: 'dw-input dw-time dw-select', value: cur(0),
          onChange: function (e) { props.onChange([Number(e.target.value), Number(cur(1))]) } }, opts),
        h('span', { className: 'dw-sep' }, '—'),
        h('select', { className: 'dw-input dw-time dw-select', value: cur(1),
          onChange: function (e) { props.onChange([Number(cur(0)), Number(e.target.value)]) } }, opts),
      )
    }

    // 概率/小时下拉（步进可选）：digits 控制显示小数位（概率 2 位、小时 1 位）
    function FloatSelect(props) {
      var range = props.range || [0, 1]
      var step = Number(props.step) || 0.05
      var digits = typeof props.digits === 'number' ? props.digits : 2
      var f = Math.pow(10, digits)
      var n = Math.round((range[1] - range[0]) / step)
      var opts = []
      for (var i = 0; i <= n; i++) {
        var v = Math.round((range[0] + i * step) * f) / f
        opts.push(h('option', { key: i, value: String(v) }, v.toFixed(digits)))
      }
      var cur = Number(props.value)
      if (!isFinite(cur)) cur = range[0]
      var idx = Math.min(n, Math.max(0, Math.round((cur - range[0]) / step)))
      var curVal = Math.round((range[0] + idx * step) * f) / f
      return h('select', {
        className: 'dw-input dw-time dw-select dw-int',
        value: String(curVal),
        onChange: function (e) { props.onChange(Number(e.target.value)) },
      }, opts)
    }

    // 枚举下拉（显示中文，值存原英文）：敏感度、降档驱动
    function EnumSelect(props) {
      var opts = props.options || []
      var cur = props.value === undefined || props.value === null ? '' : String(props.value)
      return h('select', {
        className: 'dw-input dw-time dw-select',
        value: cur,
        onChange: function (e) { props.onChange(e.target.value) },
      }, opts.map(function (o) { return h('option', { key: o[0], value: o[0] }, o[1]) }))
    }

    // 数值下拉（选项不连续，如 λ 比例）：值存数字
    function NumericSelect(props) {
      var list = Array.isArray(props.options) ? props.options : []
      var cur = typeof props.value === 'number' ? props.value : 0
      if (list.indexOf(cur) < 0) cur = list[0] || 0
      return h('select', {
        className: 'dw-input dw-time dw-select dw-int',
        value: String(cur),
        onChange: function (e) { props.onChange(Number(e.target.value)) },
      }, list.map(function (v) { return h('option', { key: String(v), value: String(v) }, String(v)) }))
    }

    // 区间下拉（两个同档位下拉，min ≤ max）：半幕字数区间、放送间隔区间
    function RangeSelect(props) {
      var range = Array.isArray(props.range) ? props.range : [50, 300]
      var step = Math.max(1, Math.round(Number(props.step) || 50))
      var lo0 = range[0]
      var hi0 = range[1]
      var clampOne = function (v) {
        var n = Math.round(Number(v))
        if (!Number.isFinite(n)) n = lo0
        return Math.min(hi0, Math.max(lo0, n))
      }
      var arr = Array.isArray(props.value) ? props.value : [lo0, hi0]
      var lo = clampOne(arr[0])
      var hi = clampOne(arr[1])
      var opts = []
      for (var i = lo0; i <= hi0; i += step) opts.push(h('option', { key: i, value: String(i) }, String(i)))
      return h('div', { className: 'dw-inline' },
        h('span', { className: 'dw-sep' }, 'min'),
        h('select', {
          className: 'dw-input dw-time dw-select dw-int',
          value: String(lo),
          onChange: function (e) { var v = Number(e.target.value); props.onChange([v, Math.max(v, hi)]) },
        }, opts),
        h('span', { className: 'dw-sep' }, 'max'),
        h('select', {
          className: 'dw-input dw-time dw-select dw-int',
          value: String(hi),
          onChange: function (e) { var v = Number(e.target.value); props.onChange([Math.min(lo, v), v]) },
        }, opts),
      )
    }

    // 小概率下拉（固定档位，不再是 0-1 自由输入）：没听见、惊跳
    var SMALL_PROB_STEPS = [0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5]
    // 幕拍概率下拉：0 / 0.25 / 0.50 / 0.75 / 1.00
    var QUARTER_PROB_STEPS = [0, 0.25, 0.5, 0.75, 1]
    function ProbSelect(props) {
      var steps = Array.isArray(props.steps) ? props.steps : SMALL_PROB_STEPS
      var v = Number(props.value)
      if (!isFinite(v)) v = steps[0]
      var cur = steps[0]
      var best = Infinity
      for (var i = 0; i < steps.length; i++) {
        var d = Math.abs(steps[i] - v)
        if (d < best) { best = d; cur = steps[i] }
      }
      return h('select', {
        className: 'dw-input dw-time dw-select dw-int',
        value: String(cur),
        onChange: function (e) { props.onChange(Number(e.target.value)) },
      }, steps.map(function (x) { return h('option', { key: String(x), value: String(x) }, x.toFixed(2)) }))
    }


    // 副本逐日可见比例：五个下拉（0=无/删除、10-100%），值数组长度 5
    function VisibilitySelect(props) {
      // 只能越来越模糊：后面的格自动压到不高于前一个格（防用户选出 10/40/20 这种倒挂）
      var normalize = function (a) {
        var out = a.slice(0, 5)
        for (var i = 1; i < out.length; i++) {
          if (out[i] > out[i - 1]) out[i] = out[i - 1]
        }
        return out
      }
      var arr = normalize(Array.isArray(props.value) ? props.value : [80, 40, 20, 0, 0])
      var steps = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
      var curAt = function (i) {
        var n = Number(arr[i])
        if (!Number.isFinite(n)) n = 0
        return Math.min(100, Math.max(0, Math.round(n / 10) * 10))
      }
      var cells = []
      for (var i = 0; i < 5; i++) {
        (function (idx) {
          var cur = curAt(idx)
          cells.push(h('select', {
            key: idx,
            className: 'dw-input dw-time dw-select dw-int',
            value: String(cur),
            onChange: function (e) {
              var out = [curAt(0), curAt(1), curAt(2), curAt(3), curAt(4)]
              out[idx] = Number(e.target.value)
              props.onChange(normalize(out))
            },
          }, steps.map(function (x) { return h('option', { key: String(x), value: String(x) }, x === 0 ? '无' : x + '%') })))
        })(i)
      }
      return h('div', { className: 'dw-inline' }, cells)
    }

    // 残留档位边界：4 个下拉（字数），必须单调递增（后面的边界自动抬到不低于前一个）
    function TiersSelect(props) {
      var arr = Array.isArray(props.value) ? props.value : [50, 100, 200, 300]
      var steps = [10, 20, 30, 50, 80, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000]
      var normalize = function (a) {
        var out = a.slice(0, 4)
        for (var i = 1; i < out.length; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1]
        return out
      }
      arr = normalize(arr.map(function (v) {
        var n = Math.round(Number(v))
        return Number.isFinite(n) ? n : 0
      }))
      var curAt = function (i) {
        var n = Math.round(Number(arr[i]))
        if (!Number.isFinite(n)) n = steps[0]
        // 非候选值（手改的）显示为最接近的档位
        var best = steps[0], bd = Infinity
        for (var k = 0; k < steps.length; k++) {
          var d = Math.abs(steps[k] - n)
          if (d < bd) { bd = d; best = steps[k] }
        }
        return best
      }
      var cells = []
      for (var i = 0; i < 4; i++) {
        (function (idx) {
          var cur = curAt(idx)
          cells.push(h('select', {
            key: idx,
            className: 'dw-input dw-time dw-select dw-int',
            value: String(cur),
            onChange: function (e) {
              var out = [curAt(0), curAt(1), curAt(2), curAt(3)]
              out[idx] = Number(e.target.value)
              props.onChange(normalize(out))
            },
          }, steps.map(function (x) { return h('option', { key: String(x), value: String(x) }, x + '字') })))
        })(i)
      }
      return h('div', { className: 'dw-inline' }, cells)
    }

    function scalarInput(path, value, onChange) {
      // 副本可见比例：五个逐日下拉
      if (path === 'copy.visibility') {
        return h(VisibilitySelect, { value: value, onChange: onChange })
      }
      // 梦醒记忆形态：二选一下拉（词句残留 / 打码梦文本）
      if (path === 'residue.form') {
        return h(EnumSelect, { value: value, onChange: onChange, options: [['words', '词句残留'], ['blur', '打码梦文本']] })
      }
      // 打码梦文本形态的可见比例：五格下拉（独立于副本）
      if (path === 'residue.visibility') {
        return h(VisibilitySelect, { value: value, onChange: onChange })
      }
      // 残留档位边界：4 个字数下拉（单调递增）
      if (path === 'residue.tiers') {
        return h(TiersSelect, { value: value, onChange: onChange })
      }
      // λ 独立覆盖：数字输入（小时）；清空 = 按比例（提交 null）
      if (path === 'judge.lambdaHours') {
        return h(NumberInput, {
          value: typeof value === 'number' ? value : '',
          decimals: 2,
          onChange: function (v) { onChange(v === '' ? null : Number(v)) },
        })
      }
      if (path === 'frame.interruptMin' || path === 'frame.naturalMin') {
        return h(IntSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, range: [10, 180], step: 10 })
      }
      // 残留保留时长：下拉（小时，0-48，每 2 一档）
      if (path === 'residue.hours') {
        return h(IntSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, range: [0, 48], step: 2 })
      }
      // 心情影响时长：下拉（小时，0-12，每 1 一档）
      if (path === 'mood.hours') {
        return h(IntSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, range: [0, 12], step: 1 })
      }
      // 轮询间隔：min/max 两个下拉（秒，1-10，每 1 一档）
      if (path === 'signal.pollIntervalSec') {
        return h(RangeSelect, { value: value, onChange: onChange, range: [1, 10], step: 1 })
      }
      // 桥接端口：整数输入、1-65535 自动钳制
      if (path === 'bridge.port') {
        return h(NumberInput, { value: typeof value === 'number' ? value : undefined, onChange: onChange, integer: true, min: 1, max: 65535 })
      }
      // 没听见/惊跳：固定档位下拉
      if (path === 'interrupt.missP' || path === 'interrupt.startleP') {
        return h(ProbSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange })
      }
      // 场景跳/时间跳基础概率：0/0.25/0.50/0.75/1.00 档位下拉
      if (path === 'actJump.sceneP' || path === 'actJump.timeP') {
        return h(ProbSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, steps: QUARTER_PROB_STEPS })
      }
      // 跳跃关联程度：0/0.25/0.50/0.75/1.00 档位下拉
      if (path === 'actJump.linkage') {
        return h(ProbSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, steps: QUARTER_PROB_STEPS })
      }
      // 半幕字数区间：min/max 两个下拉（50-300，每 50 一档）
      if (path === 'play.halfChars') {
        return h(RangeSelect, { value: value, onChange: onChange, range: [50, 300], step: 50 })
      }
      // 放送间隔区间：min/max 两个下拉（5-60 分钟，每 5 一档）
      if (path === 'play.intervalMin') {
        return h(RangeSelect, { value: value, onChange: onChange, range: [5, 60], step: 5 })
      }
      // 每次放送幕数：下拉 0.5-5、每 0.5 一档
      if (path === 'play.actsPerRelease') {
        return h(FloatSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, range: [0.5, 5], step: 0.5, digits: 1 })
      }
      // 单场梦时长上限：下拉（分钟，10-180，每 10 一档）
      if (path === 'play.maxDurationMin') {
        return h(IntSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, range: [10, 180], step: 10 })
      }
      // 拉普拉斯 λ 比例：下拉选固定档位（λ = 判定时长 / 该值；数值越大曲线越集中）
      if (path === 'judge.lambdaRatio') {
        return h(NumericSelect, { value: value, onChange: onChange, options: [1, 2, 4, 6, 8, 12, 16, 24] })
      }
      // 枚举：敏感度、降档驱动
      if (path === 'interrupt.sensitivity') {
        return h(EnumSelect, { value: value, onChange: onChange, options: [['weak', '弱'], ['mid', '中'], ['strong', '强']] })
      }
      if (path === 'copy.degrade') {
        return h(EnumSelect, { value: value, onChange: onChange, options: [['daily', '每天一降'], ['restart', '每次重启 DSH 一降']] })
      }
      // 概率下拉：0-1、每 0.05 一档（走神触发概率、残留带入概率、睡满时长命中率）
      if (path === 'wander.p' || path === 'wander.dupThreshold' || path === 'cycle.residueP' || path === 'judge.hitP') {
        const range = path === 'wander.dupThreshold' ? [0.1, 1] : [0, 1];
        return h(FloatSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, range, step: 0.05 })
      }
      // 入睡确认：下拉，0-5 小时、每 0.1 一档
      if (path === 'judge.confirmH') {
        return h(NumericSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, options: CONFIRM_STEPS })
      }
      // 最长判定时长：下拉，1-24 小时、每 1 一档
      if (path === 'judge.windowH') {
        return h(IntSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, range: [1, 24], step: 1 })
      }
      // 独处触发时长：下拉，10-120 分钟、每 5 一个档（设计约定默认 15 在档位上）
      if (path === 'wander.aloneMin') {
        return h(IntSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, range: [10, 120], step: 5 })
      }
      // 次数类：一律下拉选整数（不会再出现输入非法字符的问题）
      if (isCountPath(path)) {
        return h(IntSelect, { value: typeof value === 'number' ? value : undefined, onChange: onChange, range: countRange(path), step: countStep(path) })
      }
      if (typeof value === 'boolean') return h(Switch, { value: value, onChange: onChange })
      if (typeof value === 'number') {
        // 概率类：一位小数、0-1 之间；其它数字：原样输入（拒绝非数字）
        if (isProbPath(path)) return h(NumberInput, { value: value, onChange: onChange, decimals: 1, min: 0, max: 1 })
        return h(NumberInput, { value: value, onChange: onChange })
      }
      if (Array.isArray(value)) {
        var isNum = value.length > 0 && typeof value[0] === 'number'
        return isNum
          ? h(NumberListInput, { value: value, onChange: onChange })
          : h(StringListInput, { value: value, onChange: onChange })
      }
      if (isPlainObject(value)) return h(KVInput, { value: value, onChange: onChange })
      return h('input', {
        className: 'dw-input',
        type: 'text',
        value: value === null || value === undefined ? '' : String(value),
        onChange: function (e) { onChange(e.target.value) },
      })
    }

    function Row(props) {
      return h('div', { className: 'dw-row' },
        h('div', { className: 'dw-label' },
          labelOf(props.path),
          hintOf(props.path) ? h('div', { className: 'dw-hint' }, hintOf(props.path)) : null,
        ),
        h('div', { className: 'dw-control' }, props.children),
      )
    }

    function shortId(id) {
      var s = String(id || '')
      return s.length > 22 ? s.slice(0, 14) + '…' + s.slice(-6) : s
    }
    /** 只取路径最后两段，防止长路径撑爆列表 */
    function shortPath(p) {
      if (typeof p !== 'string' || p === '') return ''
      var parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
      if (parts.length <= 2) return p
      return '…/' + parts.slice(-2).join('/')
    }
    function fmtTime(ms) {
      try {
        var d = new Date(Number(ms))
        if (isNaN(d.getTime())) return ''
        return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      } catch (e) { return '' }
    }

    /** 作用域会话选择器：按工作区分组点选，桥接会话带徽标 */
    function ScopePicker(props) {
      var selected = Array.isArray(props.value) ? props.value.slice() : []
      var wsList = props.workspaceList && Array.isArray(props.workspaceList.workspaces) ? props.workspaceList.workspaces : []
      var bridge = props.bridge || null
      var bridgeIds = {}
      if (bridge && Array.isArray(bridge.sessions)) {
        bridge.sessions.forEach(function (s) { bridgeIds[s.sessionId] = s.key })
      }

      function toggle(id) {
        var has = selected.indexOf(id) >= 0
        var next = has ? selected.filter(function (x) { return x !== id }) : selected.concat([id])
        props.onChange(next)
      }

      var all = {}
      wsList.forEach(function (w) { w.sessions.forEach(function (s) { all[s.id] = s }) })
      // 桥接会话若不在任何工作区列表（理论上不会），补一条
      Object.keys(bridgeIds).forEach(function (sid) {
        if (!all[sid]) all[sid] = { id: sid, mtime: 0 }
      })

      return h('div', { style: { width: '100%' } },
        selected.length === 0
          ? h('div', { className: 'dw-hint', style: { marginBottom: '6px' } }, '尚未选择（插件不生效）——点下面的会话即可加入')
          : h('div', { className: 'dw-chips' }, selected.map(function (sid) {
              var meta = all[sid]
              var isBridge = !!bridgeIds[sid]
              var wsTitle = ''
              wsList.forEach(function (w) { if (w.sessions.some(function (s) { return s.id === sid })) wsTitle = w.title })
              return h('span', { key: sid, className: 'dw-chip' + (isBridge ? ' dw-chip-bridge' : '') },
                h('span', { className: 'dw-chip-text', title: sid }, (wsTitle ? wsTitle + ' · ' : '') + shortId(sid)),
                isBridge ? h('span', { className: 'dw-chip-tag' }, '桥接') : null,
                h('button', { type: 'button', className: 'dw-chip-x', onClick: function () { toggle(sid) }, title: '移除' }, '×'),
              )
            })),
        h('details', { className: 'dw-picker', open: true },
          h('summary', { className: 'dw-picker-summary' }, '从会话列表选择（按工作区分组）'),
          wsList.length === 0
            ? h('div', { className: 'dw-hint', style: { padding: '6px 0' } }, '没读到 DSH 工作区列表；可直接在下方手动填会话 id。')
            : h('div', null, wsList.map(function (w) {
                var hasBridge = w.sessions.some(function (s) { return bridgeIds[s.id] })
                var hasSelected = w.sessions.some(function (s) { return selected.indexOf(s.id) >= 0 })
                return h('details', { key: w.id, className: 'dw-ws', open: hasBridge || hasSelected },
                  h('summary', { className: 'dw-ws-title' },
                    w.title,
                    h('span', { className: 'dw-ws-path', title: w.path }, ' · ' + shortPath(w.path)),
                    h('span', { className: 'dw-ws-count' }, ' (' + w.sessions.length + ')'),
                  ),
                  h('div', { className: 'dw-picker-list' }, w.sessions.map(function (c) {
                    var on = selected.indexOf(c.id) >= 0
                    return h('div', {
                      key: c.id,
                      className: 'dw-picker-item' + (on ? ' dw-picker-item-on' : ''),
                      onClick: function () { toggle(c.id) },
                    },
                      h('span', { className: 'dw-picker-check' }, on ? '✓' : '○'),
                      h('span', { className: 'dw-picker-id', title: c.id }, shortId(c.id)),
                      bridgeIds[c.id] ? h('span', { className: 'dw-chip-tag' }, '桥接 ' + bridgeIds[c.id]) : null,
                      h('span', { className: 'dw-picker-meta' }, c.mtime ? fmtTime(c.mtime) : ''),
                    )
                  })),
                )
              })),
        ),
        h('details', { className: 'dw-picker' },
          h('summary', { className: 'dw-picker-summary' }, '手动输入'),
          h('input', {
            className: 'dw-input',
            type: 'text',
            value: selected.join(', '),
            placeholder: '英文逗号分隔多个会话 id',
            onChange: function (e) {
              var parts = e.target.value.split(/[,，、]/).map(function (x) { return x.trim() }).filter(function (x) { return x !== '' })
              props.onChange(parts)
            },
          }),
        ),
      )
    }

    /** 桥接映射：检测到映射时一键填入，仍保留手动编辑 */
    function BridgePicker(props) {
      var bridge = props.bridge || null
      var obj = props.value && typeof props.value === 'object' && !Array.isArray(props.value) ? props.value : {}
      var detected = bridge && bridge.available && Array.isArray(bridge.sessions) ? bridge.sessions : []
      var initText = Object.keys(obj).map(function (k) { return k + '=' + String(obj[k]) }).join('\n')
      var state = useState(null)
      var draft = state[0]
      var setDraft = state[1]
      var text = draft !== null ? draft : initText
      // 行格式校验：每行应形如 会话id=private:QQ号 或 会话id=group:群号
      var badLines = []
      String(text).split('\n').forEach(function (line, idx) {
        var t = line.trim()
        if (t === '') return
        var i = t.indexOf('=')
        if (i <= 0) { badLines.push(idx + 1); return }
        var key = t.slice(i + 1).trim()
        if (!/^(private:|group:)/.test(key)) badLines.push(idx + 1)
      })
      return h('div', { style: { width: '100%' } },
        detected.length
          ? h('div', { className: 'dw-detect' },
              h('div', { className: 'dw-detect-line' },
                '已从桥接自动检测到 ' + detected.length + ' 条映射：',
                h('span', { className: 'dw-mono' }, detected.map(function (d) { return d.sessionId + '=' + d.key }).join('，')),
              ),
              h('button', {
                type: 'button',
                className: 'dw-btn',
                style: { marginTop: '6px' },
                onClick: function () {
                  var next = {}
                  detected.forEach(function (d) { next[d.sessionId] = d.key })
                  setDraft(null)
                  props.onChange(next)
                },
              }, '一键填入'),
            )
          : (bridge && bridge.dir
              ? h('div', { className: 'dw-hint' }, '桥接目录存在但未读到映射（桥接尚未建立会话时正常）；可手动填。')
              : h('div', { className: 'dw-hint' }, '未配置桥接目录；没装桥接可留空。')),
        h('textarea', {
          className: 'dw-input dw-area' + (badLines.length ? ' dw-input-invalid' : ''),
          value: text,
          placeholder: '每行一条：会话id=private:QQ号（群聊写 group:群号）',
          onChange: function (e) {
            setDraft(e.target.value)
            var out = {}
            e.target.value.split('\n').forEach(function (line) {
              var i = line.indexOf('=')
              if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
            })
            props.onChange(out)
          },
          onBlur: function () { setDraft(null) },
        }),
        badLines.length ? h('div', { className: 'dw-err' }, '第 ' + badLines.join('、') + ' 行格式不对：应写成「会话id=private:QQ号」或「会话id=group:群号」') : null,
      )
    }

    // ---- 页面 -------------------------------------------------------------

    function DreamWanderSection() {
      var [config, setConfig] = useState(null)
      var [defaults, setDefaults] = useState(null)
      var [bridgeInfo, setBridgeInfo] = useState(null)
      var [workspaceList, setWorkspaceList] = useState({ workspaces: [] })
      var [error, setError] = useState('')
      var [status, setStatus] = useState('')
      var [saving, setSaving] = useState(false)
      var [staleBuild, setStaleBuild] = useState('') // 服务端 bundle 标记与页面不一致 = 页面加载的是旧代码
      var [retention, setRetention] = useState(null) // 当前生效的副本保留期（由可见比例序列推导，host 算好返回）
      var [health, setHealth] = useState(null) // 运行状态摘要（host GET 返回）
      var [warnings, setWarnings] = useState([]) // 运行期警告（如多会话限制）
      var [applyStatus, setApplyStatus] = useState(null) // 启动自检状态（failed=插件没起来）
      var [viewData, setViewData] = useState(null) // 内容查看：走神/残留/副本/正在做的梦
      var [viewBusy, setViewBusy] = useState(false)
      var [viewErr, setViewErr] = useState('')

      useEffect(function () {
        loadView()
      }, [])
      
      useEffect(function () {
        var alive = true
        apiGet().then(function (data) {
          if (!alive) return
          // 生效值 = 默认层 ← 包内配置 ← 用户覆盖（浅合并逐层覆盖，嵌套对象逐键）
          var eff = mergeDeep(mergeDeep({}, data.defaults || {}), data.inherited || {})
          eff = mergeDeep(eff, data.override || {})
          setDefaults(data.defaults || {})
          setBridgeInfo(data.bridge || null)
          setWorkspaceList(data.sessions && Array.isArray(data.sessions.workspaces) ? data.sessions : { workspaces: [] })
          setConfig(eff)
          if (typeof data.copyKeepDays === 'number') setRetention(data.copyKeepDays)
          setHealth(data.health || null)
          setWarnings(Array.isArray(data.warnings) ? data.warnings : [])
          setApplyStatus(data.applyStatus || null)
          // 页面代码自检：服务端 bundle 标记与页面内 BUILD_TAG 不一致 → 页面是旧代码
          if (data.clientBuild && data.clientBuild !== BUILD_TAG) setStaleBuild(String(data.clientBuild))
          // 上次保存失败（host 侧异步校验失败会写 panelLastError）→ 打开面板时提示
          if (data.lastError) setError('上次保存失败：' + data.lastError)
        }).catch(function (e) {
          if (alive) setError(e && e.message ? e.message : String(e))
        })
        return function () { alive = false }
      }, [])

      function mergeDeep(base, extra) {
        var out = Array.isArray(base) ? base.slice() : Object.assign({}, base)
        if (!isPlainObject(extra)) return out
        Object.keys(extra).forEach(function (k) {
          var v = extra[k]
          if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeDeep(out[k], v)
          else out[k] = v
        })
        return out
      }

      function setPath(path, value) {
        setConfig(function (prev) {
          var next = mergeDeep({}, prev)
          deepSet(next, path, value)
          return next
        })
        setStatus('')
      }

      // 桥接目录状态（按当前生效值检测；保存后刷新页面生效）
      function bridgeDirHint() {
        var dir = config && config.bridge && config.bridge.dir ? String(config.bridge.dir) : ''
        var b = bridgeInfo
        if (!dir) return '留空 = 不读桥接信号：角色的走神"独处触发"还能用，但睡着时的消息判定与中断拿不到信号'
        if (b && b.available) return '✓ 已找到桥接状态文件' + (b.sessions && b.sessions.length ? '（' + b.sessions.length + ' 条会话映射）' : '（暂无会话映射，桥接建会话后再来看）')
        return '⚠ 这个路径下没找到桥接状态文件（应包含 state/social-v2.json）——请检查目录是否填对'
      }

      // 副本保留期摘要（只读；N 由 host 按同一规则算好返回，面板不重算）
      function visibilitySummary() {
        var degrade = config && config.copy && config.copy.degrade ? config.copy.degrade : 'daily'
        if (retention === null) return '（正在读取当前保留期…）'
        if (retention === 0) return '当前生效：第 1 格是「无」——不生成副本；已有的下次结算时清掉'
        if (degrade === 'restart') return '当前生效：能翻到 ' + retention + ' 档（测试模式：每次重启降一档，再启动 ' + retention + ' 次后清掉）'
        return '当前生效：能翻到 ' + retention + ' 天前的副本；更早的在角色下次收到消息时清掉。副本日期按梦开始那天算。'
      }

      function save() {
        setSaving(true)
        setError('')
        // 只提交用户显式改动的完整配置（含默认值），交由 configEditor 校验与热应用；
        // 概率类字段统一保留一位小数；废弃字段剥离（不再写回 profile 覆盖层）
        apiPost({ config: stripDeadPaths(roundProbPaths(config)) }).then(function (data) {
          setSaving(false)
          setStatus('已保存（配置已热应用）')
          if (data && typeof data.copyKeepDays === 'number') setRetention(data.copyKeepDays)
          // 热应用是异步的（宿主先回响应、再重载插件，实测通常 0.2-0.3 秒）：
          // 片刻后拉一次，把异步校验失败即时显示出来，不用等下次打开面板
          setTimeout(function () {
            apiGet().then(function (data2) {
              if (data2 && data2.lastError) setError('保存失败：' + data2.lastError)
              if (data2 && typeof data2.copyKeepDays === 'number') setRetention(data2.copyKeepDays)
            }).catch(function () {})
          }, 700)
        }).catch(function (e) {
          setSaving(false)
          setError(e && e.message ? e.message : String(e))
        })
      }

      function resetAll() {
        if (!defaults) return
        // 恢复默认=清空用户覆盖层（宿主侧把它设为继承层，configEditor 会删除 profile 里的覆盖 entry）
        setSaving(true)
        apiPost({ reset: true }).then(function () {
          setSaving(false)
          setStatus('已恢复出厂默认（清除用户覆盖层）')
          // 覆盖层清掉后实际生效值变回插件自带配置：拉一次刷新界面
          setTimeout(function () {
            apiGet().then(function (data) {
              if (!data || !data.inherited) return
              var eff = mergeDeep(mergeDeep({}, data.defaults || {}), data.inherited || {})
              eff = mergeDeep(eff, data.override || {})
              setConfig(eff)
              if (typeof data.copyKeepDays === 'number') setRetention(data.copyKeepDays)
            }).catch(function () {})
          }, 700)
        }).catch(function (e) {
          setSaving(false)
          setError(e && e.message ? e.message : String(e))
        })
      }

      if (error && !config) {
        return h('div', { className: 'dw-section' },
          h('h3', { className: 'dw-head' }, '走神与做梦'),
          h('div', { className: 'dw-empty' }, '读取配置失败：' + error),
        )
      }
      if (!config) {
        return h('div', { className: 'dw-section' },
          h('h3', { className: 'dw-head' }, '走神与做梦'),
          h('div', { className: 'dw-empty' }, '读取中…'),
        )
      }

      // 单字段行渲染（主面板与「高级」折叠共用；case 与旧版一致）
      function renderRow(row) {
        // 梦醒记忆形态二选一：只显示当前形态用得到的字段
        var rForm = config && config.residue && config.residue.form === 'blur' ? 'blur' : 'words'
        if ((row.path === 'residue.tiers' || row.path === 'residue.hours') && rForm !== 'words') return null
        if (row.path === 'residue.visibility' && rForm !== 'blur') return null
        if (row.path === 'copy.visibility') {
          return h(Row, { key: row.path, path: row.path },
            h('div', { className: 'dw-num-wrap' },
              h(VisibilitySelect, { value: row.value, onChange: function (v) { setPath(row.path, v) } }),
              h('div', { className: 'dw-hint' }, visibilitySummary())
            ))
        }
        if (row.path === 'wander.window') {
          return h(Row, { key: row.path, path: row.path },
            h(HourSelect, { value: row.value, onChange: function (v) { setPath(row.path, v) } }))
        }
        if (row.path === 'scope') {
          return h(Row, { key: row.path, path: row.path },
            h(ScopePicker, {
              value: row.value,
              workspaceList: workspaceList,
              bridge: bridgeInfo,
              onChange: function (v) { setPath(row.path, v) },
            })
          )
        }
        if (row.path === 'bridge.dir') {
          return h(Row, { key: row.path, path: row.path },
            h('div', { className: 'dw-num-wrap' },
              scalarInput(row.path, row.value, function (v) { setPath(row.path, v) }),
              h('div', { className: 'dw-hint' }, bridgeDirHint())
            ))
        }
        if (row.path === 'bridge.keys') {
          return h(Row, { key: row.path, path: row.path },
            h(BridgePicker, {
              value: row.value,
              bridge: bridgeInfo,
              onChange: function (v) { setPath(row.path, v) },
            })
          )
        }
        return h(Row, { key: row.path, path: row.path },
          scalarInput(row.path, row.value, function (v) { setPath(row.path, v) })
        )
      }

      // 运行状态（只读，长期运行每天看这里）：来自 GET 的 health / warnings / applyStatus
      // 内容查看：走神/残留/梦境副本/正在做的梦（只读；文件原文，含打码方块）
      function loadView() {
        setViewBusy(true)
        setViewErr('')
        fetch(VIEW_API, { cache: 'no-store' }).then(readJson).then(function (d) {
          setViewData(d)
          setViewBusy(false)
        }).catch(function (e) {
          setViewErr(e && e.message ? e.message : String(e))
          setViewBusy(false)
        })
      }
      
      function renderStatus() {
        var hl = health || null
        var fmt = function (t) {
          if (!t) return '—'
          var d = new Date(t)
          return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
        }
        var uptxt = hl && hl.uptimeMs ? (Math.floor(hl.uptimeMs / 3600000) + ' 时 ' + Math.floor((hl.uptimeMs % 3600000) / 60000) + ' 分') : '—'
        var STATUS = { awake: '醒着', sleeping: '睡着（未做梦）', dreaming: '做梦中' }
        return h('details', { className: 'dw-adv', open: true },
          h('summary', {}, '运行状态（只读，长期运行看这里）'),
          applyStatus && applyStatus.status === 'failed' ? h('div', { className: 'dw-warn' }, '⚠ 插件未正常启动：' + (applyStatus.reason || '未知原因')) : null,
          warnings.map(function (w) { return h('div', { className: 'dw-warn', key: w }, '⚠ ' + w) }),
          hl ? h('div', {},
            h('div', { className: 'dw-hint' }, '插件运行 ' + uptxt + '（pid ' + (hl.pid ?? '—') + '，启动 ' + fmt(hl.applyAt) + '）'),
            h('div', { className: 'dw-hint' }, '角色：' + (STATUS[hl.status] || hl.status) +
              (hl.hitAt ? '　下一命中 ' + fmt(hl.hitAt) : '') +
              (hl.remaining !== null && hl.remaining !== undefined ? '　今日额度剩 ' + hl.remaining : '') +
              (hl.usedCount ? '（已用 ' + hl.usedCount + '）' : '')),
            h('div', { className: 'dw-hint' }, '词池 ' + (hl.freqPool ?? '—') + ' 词　今日走神 ' + (hl.wanderToday ?? 0) + ' 段　今日副本 ' + (hl.todayCopies ?? 0) + ' 份'),
            h('div', { className: 'dw-hint' }, '注入归一化 ' + ((hl.inject && hl.inject.normCount) || 0) + ' 次' +
              (hl.inject && hl.inject.changesSinceNorm ? '（未归一变化 ' + hl.inject.changesSinceNorm + '/3，走神只追加）' : '') +
              (hl.inject && hl.inject.lastNormAt ? '　上次 ' + fmt(hl.inject.lastNormAt) : '')),
            h('div', { className: 'dw-hint' }, '轮询：' + (hl.signal && hl.signal.polling ? '在跑' : '停') +
              (hl.signal && hl.signal.lastSignalAt ? '　最近信号 ' + fmt(hl.signal.lastSignalAt) : '') +
              (hl.signal && hl.signal.lastPollOk ? '　最近成功 ' + fmt(hl.signal.lastPollOk) : '') +
              (hl.signal && hl.signal.lastPollError ? '　最近错误：' + hl.signal.lastPollError : '')),
            hl.dream && hl.dream.status === 'dreaming'
              ? h('div', { className: 'dw-hint' }, '进行中：第 ' + (hl.dream.dreamHalfN ?? 0) + ' 半幕，已放出 ' + (hl.dream.dreamReleasedChars ?? 0) + ' 字')
              : null,
            hl.dream && hl.dream.lastFinish
              ? h('div', { className: 'dw-hint' }, '最近收尾：' + (hl.dream.lastFinish.reason || '') + '　' + (hl.dream.lastFinish.chars ?? 0) + ' 字　' + fmt(hl.dream.lastFinish.at))
              : null,
            hl.recentErrors && hl.recentErrors.length
              ? h('div', { className: 'dw-hint' }, '最近异常：' + hl.recentErrors.map(function (e) { return e.msg }).join('；').slice(0, 600))
              : null,
          ) : h('div', { className: 'dw-hint' }, '运行状态不可用（插件可能未启动或接口异常）'),
        )
      }

      function renderView() {
        var d = viewData
        var block = function (title, text, key) {
          return h('div', { key: key, className: 'dw-view-block' },
            h('div', { className: 'dw-view-title' }, title),
            h('pre', { className: 'dw-view-pre' }, text || '（空）'))
        }
        var summary = '内容查看（走神/残留/梦境副本' + (d && d.dreaming ? ' · 正在做梦' : '') + '）'
        return h('details', { className: 'dw-adv', onToggle: function (e) { if (e.target && e.target.open) loadView() } },
          h('summary', {}, summary),
          h('div', { className: 'dw-view-actions' },
            h('button', { type: 'button', className: 'dw-btn', style: { marginRight: 8 }, onClick: loadView, disabled: viewBusy }, viewBusy ? '读取中…' : '刷新'),
            viewErr ? h('span', { className: 'dw-status dw-status-err' }, viewErr) : null,
            !d && !viewBusy ? h('span', { className: 'dw-hint' }, '点「刷新」读取') : null),
          d ? h('div', {},
        d.enabled && (!d.enabled.dream || !d.enabled.wander || !d.enabled.scope)
          ? h('div', { className: 'dw-warn', style: { marginBottom: '6px' } }, '插件当前静默：' + (!d.enabled.dream || !d.enabled.wander ? '开关没全开' : '') + (!d.enabled.scope ? '（作用域为空）' : '') + '——去上面打开并点「保存」')
          : null,
        h('div', { className: 'dw-hint', style: { marginBottom: '6px' } }, '□ = 已打码看不清的字（时间越久越多）'),
        d.dataDir ? h('div', { className: 'dw-hint' }, '当前数据目录：' + d.dataDir) : null,
            d.dreaming ? block('正在做的梦（已放出 ' + (d.dreaming.halfN || 0) + ' 半幕）', d.dreaming.releasedText || '（还没放出来）', 'dreaming') : null,
            d.wander && d.wander.length
              ? d.wander.map(function (t, i) { return block('今天走神 ' + (i + 1), t, 'w' + i) })
              : h('div', { className: 'dw-hint' }, '今天还没有走神'),
            d.residue ? block('残留（最新：' + d.residue.name + '）', d.residue.text, 'residue') : h('div', { className: 'dw-hint' }, '没有残留'),
            d.copies && d.copies.length
              ? d.copies.map(function (c) { return block('梦境副本 ' + c.name, c.text, 'c' + c.name) })
              : h('div', { className: 'dw-hint' }, '没有梦境副本'),
            d.frame ? block('最后画面（只存内存' + (d.frame.at ? '，' + new Date(d.frame.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '，可能已过期') + '）', d.frame.text, 'frame') : null,
          ) : null)
      }
      
      // 分组：顶层标量 → GROUP_TITLES 里的组；顶层对象 → 该对象的全部子字段为一组
      var groups = {}
      Object.keys(config).forEach(function (key) {
        var title = GROUP_TITLES[key] || '其它'
        var val = config[key]
        if (isPlainObject(val)) {
          var childPaths = Object.keys(val).map(function (sub) { return key + '.' + sub })
          childPaths = childPaths.filter(function (p) { return DEAD_PATHS.indexOf(p) < 0 })
          groups[title] = groups[title] || { title: title, rows: [] }
          childPaths.forEach(function (p) { groups[title].rows.push({ path: p, value: deepGet(config, p) }) })
        } else {
          groups[title] = groups[title] || { title: title, rows: [] }
          groups[title].rows.push({ path: key, value: val })
        }
      })

      var orderedTitles = GROUP_ORDER.filter(function (t) { return !!groups[t] })
      Object.keys(groups).forEach(function (t) { if (orderedTitles.indexOf(t) < 0) orderedTitles.push(t) })

      return h('div', { className: 'dw-section' },
        h('h3', { className: 'dw-head' }, '走神与做梦'),
        h('p', { className: 'dw-sub' },
          '给角色加上走神（独处联想）与做梦（睡眠判定、梦境演出、醒后残留）能力。' +
          '改动后点「保存」，DSH 会热应用配置（无需重启）。出厂默认两个开关都关闭。' +
          h('span', { style: { opacity: 0.45, marginLeft: 6 } }, '· 客户端 ' + BUILD_TAG + '（界面不是最新时按 Ctrl+F5 强刷）')
        ),
        staleBuild ? h('div', { className: 'dw-warn' }, '页面代码是旧版（服务端 ' + staleBuild + ' / 页面 ' + BUILD_TAG + '）：请按 Ctrl+F5 强刷整页') : null,
        renderStatus(),
        renderView(),
        orderedTitles.map(function (title) {
          var rows = groups[title].rows
          var mainRows = rows.filter(function (r) { return ADVANCED_PATHS.indexOf(r.path) < 0 })
          var advRows = rows.filter(function (r) { return ADVANCED_PATHS.indexOf(r.path) >= 0 })
          return h('div', { key: title, className: 'dw-group' },
            h('div', { className: 'dw-group-title' }, title),
            GROUP_HINTS[title] ? h('div', { className: 'dw-hint', style: { margin: '-4px 0 8px' } }, GROUP_HINTS[title]) : null,
            mainRows.map(renderRow),
            advRows.length ? h('details', { className: 'dw-adv' },
              h('summary', {}, '高级（' + advRows.length + ' 项，一般不用改）'),
              advRows.map(renderRow)
            ) : null
          )
        }),
        h('div', { className: 'dw-actions' },
          h('button', { type: 'button', className: 'dw-btn dw-btn-primary', disabled: saving, onClick: save },
            saving ? '保存中…' : '保存'),
          h('button', { type: 'button', className: 'dw-btn', disabled: saving, onClick: resetAll }, '恢复默认'),
          status ? h('span', { className: 'dw-status' }, status) : null,
          error ? h('span', { className: 'dw-status dw-status-err' }, error) : null,
        ),
      )
    }

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dream-wander-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dream-wander: styles')

      // 设置页一级入口（与「人格」同级的 settings.section）
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'dream-wander',
          order: 47,
          label: function () { return '走神与做梦' },
        }, function () { return h(DreamWanderSection) })
      })
    }

    return {
      name: 'dream-wander',
      inject: ['slots'],
      apply: apply,
    }
  },
})

