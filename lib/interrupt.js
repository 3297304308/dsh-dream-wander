// 中断与敏感度：做梦期间的外部信号按档位响应（设计约定十节）
// 信号来源：桥接唤醒提示文本（buildWakePromptV2）里的精确 reason
//   "原因：有人拍了一拍"→poke；"原因：atMention@seqN"→at；"原因：nameMention@seqN"→name；
//   "原因：private"→private；keyword:/question/probability/speaker:/anyMessage→group 普通消息（不计数）。
// 信号计数权威在轮询通道（真实 seq + 消息对象分类）；pre-step 只负责吞/放行，见 index.js。
// 桥接潜水期群聊消息不投递 DSH，只能靠 unread 轮询拿到——这就是轮询通道存在的原因。
export class Interrupt {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
  }

  // 从唤醒提示文本判定信号类型
  classify(text) {
    const t = text ?? '';
    if (t.includes('原因：有人拍了一拍')) return 'poke';
    const m = t.match(/原因：([^\s\n]+?)(?:@seq|$)/);
    if (m) {
      const r = m[1];
      if (r === 'private') return 'private';
      if (r === 'atMention') return 'at';
      if (r === 'nameMention') return 'name';
      return 'group'; // keyword:xx / question / probability / speaker:xx / anyMessage
    }
    // 兜底：旧版文本判定（无 reason 的桥接版本）；不含"@"（群聊 @ 他人会误判为点名她）
    if (t.includes('拍了拍')) return 'poke';
    if (this.cfg.interrupt.fullName && t.includes(this.cfg.interrupt.fullName)) return 'name';
    return 'other';
  }

  // 从桥接 unread 消息对象判定信号类型（轮询通道；设计约定十节信号口径）
  // 消息结构实测：{seq, sender, userId, text, plain, quoteTargetIsSelf, kind:'poke'?, poke?{targetIsSelf}}
  classifyMessage(msg, key) {
    if (!msg) return 'group';
    const k = String(key ?? '');
    if (msg.kind === 'poke') {
      // 拍她 vs 拍别人：targetIsSelf 才当指向性信号（拍别人=无关杂音）
      return msg.poke?.targetIsSelf ? 'poke' : 'group';
    }
    if (k.startsWith('private:')) return 'private';
    // 引用她的消息=点名（设计约定：未配置完整称呼时点名仅按引用判定）
    if (msg.quoteTargetIsSelf) return 'name';
    const text = String(msg.plain ?? msg.text ?? '');
    const fullName = String(this.cfg.interrupt?.fullName ?? '');
    // @ 判定必须在"点名"之前：@+称呼 = 被 @（at，中档计数+变形）；含称呼但无 @ = 点名（name，中档即断）。
    // 旧实现先判 name，导致 at 分支永远不可达、中档@被当成点名立即断梦（2026-11-16 mock 测试发现）
    if (fullName && /@\S/.test(text) && text.includes(fullName)) {
      return 'at';
    }
    if (fullName && text.includes(fullName)) return 'name';
    return 'group';
  }

  // 在做梦期间收到消息：返回处理结果（type 可由 classifyMessage 给出；缺省走文本 classify）
  // shapeSrc=变形素材用的"原声"：轮询通道传真实消息正文；pre-step 通道只拿得到桥接唤醒提示全文，
  // 传空字符串 → 变形只用类型化描述，绝不把"【唤醒】/你有新消息/原因：…"写进梦提示词（审查 M3）
  // -> { action: 'ignore' | 'continue' | 'interrupt', groggy?: string, shape?: string, counting: boolean }
  handleDreamSignal(st, signalText, isPrivate, presetType, shapeSrc) {
    const it = this.cfg.interrupt;
    const sens = it.sensitivity;
    let type = presetType ?? this.classify(signalText);
    if (type === 'other' && isPrivate) type = 'private';
    if (type === 'other') type = 'group';

    // 强档：群聊普通消息不计数不响应
    if (sens === 'strong' && type === 'group') return { action: 'ignore' };

    // 是否进入计数/是否立即中断
    let immediate = false;
    let counting = true;
    let shape = false;
    if (sens === 'weak') {
      counting = true;
      shape = ['poke', 'at', 'name'].includes(type);
    } else if (sens === 'mid') {
      if (type === 'name' || type === 'private') immediate = true;
      shape = ['poke', 'at'].includes(type);
    } else { // strong
      if (type === 'group') return { action: 'ignore' };
      immediate = true; // poke/at/name/private 一次即醒
    }
    if (immediate) return { action: 'interrupt', counting };

    // 抖动（仅进入计数的信号）：5% 没听见、2% 惊跳
    const u = Math.random();
    if (u < it.missP) return { action: 'ignore', counting }; // 没听见：不计数不哼唧不变形
    if (u < it.missP + it.startleP) return { action: 'interrupt', counting }; // 惊跳：直接中断

    // 计数（设计约定十节【定】：满 2 次即断，机制定值、不提供配置）
    st.interruptCount = (st.interruptCount ?? 0) + 1;
    if (st.interruptCount >= 2) {
      st.interruptCount = 0;
      return { action: 'interrupt', counting };
    }
    // 未断：代发迷糊语+变形混入
    const pool = sens === 'weak' ? it.weakPool : it.midPool;
    const groggy = pool.length ? pool[Math.floor(Math.random() * pool.length)] : '';
    const shapeText = shape ? this.#shapeOf(type, shapeSrc ?? signalText) : null;
    return { action: 'continue', groggy, shape: shapeText, counting };
  }

  // 变形素材：与原声关联、不离谱（轻包装原文）
  // text 为空（pre-step 通道拿不到可信原声）→ 只用类型化描述，不夹任何原文
  // 文本里的系统模板行（【唤醒】标题、"原因：…@seqN"、"你有新消息"、分隔线）一律剔掉，
  // 否则会被当成"原声"写进下一半幕的梦提示词→穿帮（审查 M3）
  #shapeOf(type, text) {
    const clean = String(text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l
        && !/^【[^】]*】/.test(l)
        && !/^原因[:：]/.test(l)
        && !/你有新(的)?消息/.test(l)
        && !/^[-—─=*]+$/.test(l))
      .join(' ')
      .slice(0, 30);
    const hint = clean ? `（${clean}）` : '';
    if (type === 'poke') return `远处有人轻轻碰了碰什么${hint}`;
    if (type === 'at') return `好像听见谁在叫我的名字${hint}`;
    if (type === 'name') return `梦里闪过一个熟悉的声音${hint}`;
    return clean;
  }

  // 梦结束时清计数
  clearCount(st) { delete st.interruptCount; }
}
