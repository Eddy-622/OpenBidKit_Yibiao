const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { editContentSections } = require('./contentGenerationEditTools.cjs');
const { warmSharedPrefix } = require('./contentGenerationPrefixWarmup.cjs');

const CONSISTENCY_TOOLS = ['read', 'find', 'ls', 'ask-user', 'search-sections', 'repair-sections', 'complete-consistency-round', 'report-failure'];
const LEDGER_JSON = '正文一致性事实台账.json';
const LEDGER_FILE = '正文一致性事实台账.md';
const ISSUE_TYPES = ['与全局事实冲突', '与项目概述冲突', '与已还原底稿冲突', '小节内部矛盾', '无依据引用', '无依据设定'];
const FACT_CATEGORIES = ['人员与岗位', '数量与配置', '时间与时限', '频次与周期', '职责分工', '服务范围', '技术参数', '承诺与标准', '其他'];
const SEARCH_LIMIT = 80;
const SNIPPET_LENGTH = 400;

const readDecisions = workspaceDir => JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文编排决策.json'), 'utf8'));

// 审计只看正文事实：按顶层元素拆块，去掉标签、注释和图片提示词，保留段落 ID、图注及表格数据。
function auditBlocks(html) {
  const $ = cheerio.load(String(html).replace(/\r\n/g, '\n'), null, false);
  $('template').remove();
  // 上下标和换行按原意转成可读符号：10<sup>3</sup> 写作 10^3 而非 103，换行前后文字不粘连。
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const [tag, symbol] of [['sup', '^'], ['sub', '_']]) {
    $(tag).each((_index, item) => {
      const value = $(item).text().trim();
      $(item).replaceWith(!value ? '' : escape(/^-?[\p{L}\p{N}.]+$/u.test(value) ? `${symbol}${value}` : `${symbol}(${value})`));
    });
  }
  $('br').replaceWith(' ');
  const text = node => $(node).text().replace(/\s+/g, ' ').trim();
  const figure = node => `[图 ${$(node).attr('id') || ''}：${text($(node).find('figcaption')) || $(node).find('img').attr('alt') || '无图注'}]`;
  function cell(node) {
    const figures = $(node).find('figure').toArray().map(figure);
    const rest = $(node).clone();
    rest.find('figure').remove();
    return [...figures, text(rest)].filter(Boolean).join(' ');
  }
  return $.root().children().toArray().map((node, index) => {
    let body;
    if (node.name === 'figure') body = figure(node);
    else if (node.name === 'table') {
      const caption = text($(node).children('caption'));
      const rows = $(node).find('tr').toArray().map(row => $(row).children('th, td').toArray().map(cell).join(' | '));
      body = [caption && `表：${caption}`, ...rows].filter(Boolean).join('\n');
    } else if (node.name === 'ol' || node.name === 'ul') {
      body = $(node).children('li').toArray().map((item, itemIndex) => `${node.name === 'ol' ? `${itemIndex + 1}.` : '-'} ${text(item)}`).join('\n');
    } else body = text(node);
    const id = $(node).attr('id') || `第${index + 1}块`;
    // 与展示同源收集可引用 ID：顶层块（含程序补的块序号）及其内部图片等元素，不受属性引号写法影响。
    return { id, text: body, ids: [id, ...$(node).find('[id]').toArray().map(item => $(item).attr('id'))] };
  }).filter(block => block.text);
}

const formatAuditBlocks = blocks => blocks.map(block => `[${block.id}] ${block.text}`).join('\n');

function sectionAuditText(html) {
  return formatAuditBlocks(auditBlocks(html));
}

// 修复结果只返回改动段落的前后文本，主 Agent 据此核实，无须整节重读。
function blockChanges(beforeHtml, afterHtml) {
  const before = new Map(auditBlocks(beforeHtml).map(block => [block.id, block.text]));
  const after = auditBlocks(afterHtml);
  const changes = after.filter(block => before.get(block.id) !== block.text)
    .map(block => ({ block_id: block.id, before: before.get(block.id) ?? '', after: block.text }));
  const afterIds = new Set(after.map(block => block.id));
  for (const [id, text] of before) if (!afterIds.has(id)) changes.push({ block_id: id, before: text, after: '' });
  return changes;
}

function readLedger(workspaceDir) {
  const file = path.join(workspaceDir, LEDGER_JSON);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { sections: {} };
}

function writeWorkspaceFile(workspaceDir, file, content) {
  const target = path.join(workspaceDir, file);
  fs.writeFileSync(`${target}.tmp`, content, 'utf8');
  fs.renameSync(`${target}.tmp`, target);
}

// 按目录顺序列出问题，事实按类别和主体排列，便于主 Agent 相邻比对跨节口径。
function buildLedgerMarkdown(targets, ledger) {
  const label = section => `${section.number} ${section.title}`;
  const issues = targets.flatMap(section => ledger.sections[section.id].issues.map(issue => ({ section, issue })));
  const facts = targets.flatMap(section => ledger.sections[section.id].facts.map(fact => ({ section, fact })));
  const factLines = FACT_CATEGORIES.flatMap(category => {
    const group = facts.filter(({ fact }) => fact.category === category)
      .sort((left, right) => left.fact.subject.localeCompare(right.fact.subject, 'zh-Hans-CN'));
    return group.length ? [`### ${category}`, ...group.map(({ section, fact }) => `- ${fact.subject}：${fact.value} —— ${section.number} [${fact.block_id || '未定位'}]${fact.quote ? `“${fact.quote}”` : ''}`), ''] : [];
  });
  return [
    '# 正文一致性事实台账',
    '程序并发核对本轮各目标小节后汇总，只读。方括号内为原小节 HTML 中元素的 id；核实原文时使用 search-sections 或定点读取原小节文件。',
    '',
    '## 小节目录',
    ...targets.map(section => `- ${label(section)}｜小节 ID：${section.id}｜文件：${section.file}`),
    '',
    `## 一、小节核对发现的问题（共 ${issues.length} 项）`,
    ...(issues.length ? issues.map(({ section, issue }, index) => `${index + 1}. [${label(section)}｜${section.id}｜${issue.block_id || '未定位'}] ${issue.type}：${issue.problem}；依据：${issue.evidence}；建议：${issue.suggestion}`) : ['无']),
    '',
    `## 二、关键事实（共 ${facts.length} 条，按类别及主体排列）`,
    ...(facts.length ? factLines : ['无']),
  ].join('\n');
}

// 全轮相同的核对规则放在 system，公共材料在前、本节内容在后，便于并发请求复用前缀缓存。
function buildExtractionSystem(requirements, hasOriginalPlan) {
  return `你负责投标正文一致性审计中的单小节核对，只处理本次请求提供的一个小节，不改写正文。任务包括两部分。
一、核对问题（issues）：检查本节与全局事实设定、项目概述${hasOriginalPlan ? '、本节已还原底稿' : ''}是否冲突；本节内部的事实、参数、数量、时间、职责、范围和承诺是否前后矛盾；是否存在没有实际依据的引用（如材料未提供的标准规范编号、文件、案例、证书）或无依据新增的主体、岗位和数值。判断前核对相关表述的对象、适用条件和时间范围，因对象、条件或阶段不同产生的合理差异不属于问题。冲突以全局事实设定为准。本项目的事实处理要求：${requirements} 生成阶段允许补充设定，不代表审计可以用新的无依据值消除冲突；缺少确定依据时如实说明，不把【待填写】替换为猜测值。只报告确认的问题，不提润色、文风或篇幅建议；没有问题时 issues 为空数组。
二、事实台账（facts）：抽取本节中可能在其他小节再次出现、需要全文保持一致的关键事实，如人员数量与岗位、设备与资源数量、时间节点与响应时限、频次周期、职责归属、服务范围、技术参数和承诺标准。同一事实只记一次；不抽取通用描述、流程说明或没有具体值、具体归属的表述。
输出一个 JSON 对象：{"issues":[{"block_id":"段落ID","type":"问题类型","problem":"问题说明","evidence":"依据，引用全局事实或本节原文","suggestion":"建议的统一修改"}],"facts":[{"category":"类别","subject":"事实主体，如“物联网卡数量”","value":"本节中的值或结论","block_id":"段落ID","quote":"本节原文摘录，不超过40字"}]}
type 只能取：${ISSUE_TYPES.join('、')}。category 只能取：${FACT_CATEGORIES.join('、')}。block_id 使用正文方括号内的 ID，无法对应具体段落时填空字符串。只输出 JSON，不输出其他内容。`;
}

// 各小节并发核对并落盘，暂停或失败后只补未完成的小节；程序步骤不经过主会话模型。
async function extractConsistencyLedger({ aiService, workspaceDir, signal, onActivity, hasOriginalPlan, reset = false, onProgress = () => {} }) {
  const decisions = readDecisions(workspaceDir);
  const read = file => fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  if (reset) for (const file of [LEDGER_JSON, LEDGER_FILE]) fs.rmSync(path.join(workspaceDir, file), { force: true });
  const ledger = readLedger(workspaceDir);
  const { targets } = decisions;
  const done = () => targets.filter(section => ledger.sections[section.id]).length;
  const report = (items, extra = {}) => onActivity?.({ progress: { step: 'consistency-extract', label: '正在并发核对小节事实', unit: '节', total: targets.length, items, ...extra } });
  const pending = targets.filter(section => !ledger.sections[section.id]);
  report(targets.map(section => ({ id: section.id, status: ledger.sections[section.id] ? 'success' : 'pending' })));
  onProgress(done(), targets.length);
  if (pending.length) {
    const system = buildExtractionSystem(decisions.global_facts_requirements, hasOriginalPlan);
    const sharedInput = `项目概述：\n${read('项目概述.md')}\n\n全局事实设定（完整内容）：\n${read('全局事实设定.md')}`;
    if (pending.length > 1) await warmSharedPrefix({ aiService, system, sharedInput, signal, onActivity, logTitle: '一致性核对-公共前缀预热', label: '一致性核对公共材料' });
    const results = await Promise.allSettled(pending.map(async section => {
      try {
        signal.throwIfAborted();
        report([{ id: section.id, status: 'running' }]);
        const blocks = auditBlocks(read(section.file));
        const ids = new Set(blocks.flatMap(block => block.ids));
        const restored = hasOriginalPlan && section.restored_content ? `本节已还原底稿（完整内容）：\n${read(section.restored_content.file)}\n\n` : '';
        const result = await aiService.requestJson({
          signal, logTitle: `一致性核对-${section.number}-${section.title}`, progressLabel: `一致性核对 ${section.number}`,
          failureMessage: `小节 ${section.number} ${section.title} 的一致性核对结果不是有效 JSON`,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `${sharedInput}\n\n本节：${section.number} ${section.title}（小节 ID：${section.id}）\n${restored}本节正文（方括号内为段落 ID）：\n${formatAuditBlocks(blocks)}` },
          ],
          normalizer: output => ({
            issues: (output?.issues || []).map(issue => ({ ...issue, block_id: String(issue?.block_id ?? '').replace(/^\[|\]$/g, '') })),
            facts: (output?.facts || []).map(fact => ({ ...fact, block_id: String(fact?.block_id ?? '').replace(/^\[|\]$/g, '') })),
          }),
          validator(output) {
            const text = value => typeof value === 'string' && value.trim();
            const checkBlock = id => { if (id && !ids.has(id)) throw new Error(`block_id 不存在：${id}`); };
            for (const issue of output.issues) {
              if (!ISSUE_TYPES.includes(issue.type) || !text(issue.problem) || typeof issue.evidence !== 'string' || typeof issue.suggestion !== 'string') throw new Error('issues 每项须包含合法 type 及 problem、evidence、suggestion');
              checkBlock(issue.block_id);
            }
            for (const fact of output.facts) {
              if (!FACT_CATEGORIES.includes(fact.category) || !text(fact.subject) || !text(fact.value) || typeof fact.quote !== 'string') throw new Error('facts 每项须包含合法 category 及 subject、value、quote');
              checkBlock(fact.block_id);
            }
          },
        });
        signal.throwIfAborted();
        ledger.sections[section.id] = result;
        writeWorkspaceFile(workspaceDir, LEDGER_JSON, JSON.stringify(ledger, null, 2));
        report([{ id: section.id, status: 'success' }]);
        onProgress(done(), targets.length);
      } catch (error) {
        report([{ id: section.id, status: signal.aborted ? 'cancelled' : 'error' }]);
        throw error;
      }
    }));
    signal.throwIfAborted();
    const failed = results.filter(item => item.status === 'rejected');
    if (failed.length) throw new Error(`${failed.length} 个小节一致性核对失败，已完成的小节会保留，重试时只核对剩余小节：${failed[0].reason?.message || failed[0].reason}`);
  }
  writeWorkspaceFile(workspaceDir, LEDGER_FILE, buildLedgerMarkdown(targets, ledger));
  report([], { label: '小节事实核对完成', done: true });
  return ledger;
}

// 单轮审计：主 Agent 基于台账比对，统一经 repair-sections 修复，缺少依据的问题只记录。
function buildConsistencyPrompt(state, { hasKnowledgeBase, hasOriginalPlan, workspaceDir }) {
  if (state.status === 'completed') return '一致性审计已经结束。保留现有正文及结果清单，读取正文生成结果.json并标记 task_complete=true；不要重新审计、修复或调整字数。';
  const { global_facts_requirements: requirements } = readDecisions(workspaceDir);
  return `现在执行全文一致性审计，一次完成审计和修复，不分轮次。程序已并发核对本轮每个目标小节，结果汇总在《${LEDGER_FILE}》：包括各小节与全局事实设定、项目概述${hasOriginalPlan ? '、已还原底稿' : ''}的冲突，小节内部矛盾和无依据引用，以及按类别排列的关键事实。
1. 完整阅读全局事实设定.md和该台账，不必逐节通读正文。本项目的事实处理要求：${requirements}
2. 复核台账列出的小节问题，剔除因对象、适用条件或阶段不同而产生的合理差异；再按类别比对各小节事实，找出跨小节的数量、时间、职责、范围、参数和承诺矛盾。冲突以全局事实设定为准；全局事实未规定时，依据已有材料确定统一值，不通过新增无依据的值消除冲突。需要核实原文时，用 search-sections 按关键词定位段落，或定点读取原小节文件；${hasKnowledgeBase ? '知识库按需检索核实来源；' : ''}不要逐节通读全部正文。
3. 确定全部问题的统一结论后，调用一次 repair-sections，把所有需要修改的小节放入同一批。每项 instructions 写清段落 ID、问题及依据、统一修改结论，子任务按该结论修复，不自行选择另一套口径。本阶段你没有 edit 权限，所有修改都通过 repair-sections 完成。
4. 根据 repair-sections 返回的 changes（改动段落修改前后的文本）核实修复结果；只对失败或明显漏改的小节再次派发，已修好的小节不重复派发。子任务失败必须重新派发，不能当作完成。
5. 缺少确定依据、需要采购人确认的问题，不在正文中猜测取值，不将【待填写】替换为猜测值，也不为此继续审计，直接写入 remaining_issues 并注明小节、证据和原因。能依据材料修复的问题必须在提交前修复。
6. 全部修复完成后调用 complete-consistency-round 提交结论，完成标记放在该调用上；提交后审计结束，程序进入后续流程。本次目标内没有问题时直接提交。
已插入的图片块、图注、提示词、引用、顺序和图片表格布局受写入前保护；普通文字可改，原表格和实质信息应保留。只修复审计确认的问题，不做无关润色；不检查总字数、不调用扩缩写。审计结论仅覆盖本次目标小节，不将局部检查表述为全文审计通过。正文留在原小节 HTML 文件中，不修改输入资料、台账、其他小节或业务数据库。`;
}

// 主 Agent 检索、派发修复及提交结论；子任务失败随持久会话保存。
function createContentGenerationConsistencyTools({ agentService, signal, activity, validateHtml, validateResult, onActivity, consistency }, { Type, workspaceDir }) {
  const result = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
  const read = file => fs.readFileSync(path.join(workspaceDir, file), 'utf8');
  function requireRound() {
    const state = consistency.get();
    if (!state || state.status !== 'running') throw new Error('当前不在可修复的一致性审计阶段');
    if (activity.pending) throw new Error('请等待全部并发任务结束');
    return state;
  }
  return [{
    name: 'search-sections', label: '检索目标小节正文',
    description: '在本轮目标小节最新正文的纯文本中按关键词检索段落，任一关键词命中即返回小节及段落 ID，用于核实台账中的事实或确认修复范围。检索文本不含 HTML 标记和图片提示词。',
    parameters: Type.Object({
      keywords: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: '关键词，按原文字面匹配，不支持正则。' }),
      section_ids: Type.Optional(Type.Array(Type.String(), { description: '可选，限定检索的小节 ID；不填检索本轮全部目标小节。' })),
    }),
    async execute(_callId, params) {
      const scope = params.section_ids?.length ? new Set(params.section_ids) : null;
      const keywords = params.keywords.map(keyword => keyword.toLowerCase());
      const matches = [];
      let total = 0;
      for (const section of readDecisions(workspaceDir).targets) {
        if (scope && !scope.has(section.id)) continue;
        for (const block of auditBlocks(read(section.file))) {
          const lower = block.text.toLowerCase();
          const positions = keywords.map(keyword => lower.indexOf(keyword)).filter(index => index >= 0);
          if (!positions.length) continue;
          total += 1;
          if (matches.length >= SEARCH_LIMIT) continue;
          const start = Math.max(0, Math.min(...positions) - SNIPPET_LENGTH / 2);
          const text = block.text.length <= SNIPPET_LENGTH ? block.text
            : `${start ? '…' : ''}${block.text.slice(start, start + SNIPPET_LENGTH)}${start + SNIPPET_LENGTH < block.text.length ? '…' : ''}`;
          matches.push({ section_id: section.id, number: section.number, title: section.title, block_id: block.id, text });
        }
      }
      return result({ total, truncated: total > matches.length, matches });
    },
  }, {
    name: 'repair-sections', label: '并发修复一致性问题', executionMode: 'sequential',
    description: '主 Agent 审计并确定统一修复口径后，将本轮全部需要修改的小节一次提交，分配给子任务并发修复。各子任务原生 edit 自己的小节，保留图片，不检查或调整字数。返回各节状态及 changes（改动段落修改前后的纯文本）；失败返回主 Agent 重新派发。',
    parameters: Type.Object({ sections: Type.Array(Type.Object({ section_id: Type.String(), instructions: Type.String() }), { minItems: 1 }) }),
    async execute(_callId, params, toolSignal) {
      const state = requireRound();
      // 注册工具时编排尚未完成，实际修复时才读取最终目标。
      const targets = new Map(readDecisions(workspaceDir).targets.map(section => [section.id, section]));
      // 先登记待完成项，取消或中断恢复后仍需处理，不能直接提交结论。
      const failed = new Set([...(state.failed_sections || []), ...params.sections.map(job => job.section_id)]);
      const ids = params.sections.map(job => job.section_id);
      if (new Set(ids).size !== ids.length || ids.some(id => !targets.has(id))) throw new Error('只能修复本次目标小节，一批不能重复提交同一小节');
      const before = new Map(ids.map(id => [id, read(targets.get(id).file)]));
      consistency.save({ ...state, failed_sections: [...failed] });
      const results = await editContentSections({ jobs: params.sections, targets, workspaceDir, agentService, signal, toolSignal, activity, validateHtml, onActivity,
        title: '一致性修复', preloadInput: true, instructions: '只修复主 Agent 指定的问题，遵循其修改结论、统一事实口径与证据，不作无关改写，不检查或调整总字数。',
      });
      for (const item of results) if (item.status === 'success') failed.delete(item.section_id);
      consistency.save({ ...consistency.get(), failed_sections: [...failed] });
      return result({ results: results.map(item => item.status === 'success'
        ? { ...item, changes: blockChanges(before.get(item.section_id), read(targets.get(item.section_id).file)) } : item) });
    },
  }, {
    name: 'complete-consistency-round', label: '提交一致性审计结论', executionMode: 'sequential',
    description: '全部修复完成并核实后提交审计结论，提交后审计结束，不再进行下一轮。',
    parameters: Type.Object({
      summary: Type.String(),
      remaining_issues: Type.Array(Type.String(), { description: '仅列出缺少确定依据、需要采购人确认而无法修复的问题，注明小节、证据和原因；能依据材料修复的问题须在提交前修复。为空表示本次目标内无已知未解决问题。' }),
    }),
    async execute(_callId, params) {
      const state = requireRound();
      if (state.failed_sections?.length) throw new Error(`以下修复任务未成功，请先重新安排：${state.failed_sections.join('、')}`);
      validateResult();
      const next = { ...state, summary: params.summary, remaining_issues: params.remaining_issues, status: 'completed' };
      consistency.save(next);
      return result(next);
    },
  }];
}

module.exports = { CONSISTENCY_TOOLS, LEDGER_FILE, sectionAuditText, extractConsistencyLedger, buildConsistencyPrompt, createContentGenerationConsistencyTools };
