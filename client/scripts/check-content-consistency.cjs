const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildContentGenerationFiles, runContentGenerationAgent } = require('../electron/services/contentGenerationAgent.cjs');
const { CONSISTENCY_TOOLS, LEDGER_FILE, sectionAuditText } = require('../electron/services/contentGenerationConsistencyTools.cjs');
const { editContentSections } = require('../electron/services/contentGenerationEditTools.cjs');
const { createPiSession } = require('../electron/services/pi/piSessionFactory.cjs');

// 使用真实输入与业务工具，只模拟小节核对模型和主 Agent 的决策，修复子任务执行真实 Pi 原生 edit。
async function check() {
  const { Type } = await import('typebox');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '正文一致性-'));
  const workspaceDir = path.join(root, '中文工作区');
  const targets = ['one', 'two'].map((id, index) => ({ item: { id, number: `1.${index + 1}`, title: `小节${index + 1}`, content_mode: 'ai-generate' } }));
  const files = buildContentGenerationFiles({ outline: targets.map(target => target.item), targets, plans: {},
    projectOverview: '工期六十天', globalFacts: [{ title: '工期', content: '六十天' }], globalFactsMode: 'placeholder',
    wordControl: {}, generationOptions: { imageQuantity: 'none' }, template: { config: {} }, documentIds: [],
  });
  const figure = '<figure id="图" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">保留原图的生图提示词</template><img alt="图" data-yb-asset-ref="图片/原图.png"><figcaption>现场</figcaption></figure>';
  const sectionHtml = id => `<!-- yibiao:block -->\n<p id="${id}_p1">仅属于${id}的材料，工期六十天。</p>\n<!-- yibiao:block -->\n<ol id="${id}_ol1"><li>进场</li><li>验收</li></ol>\n<!-- yibiao:block -->\n<table id="${id}_t1"><caption>参数表</caption><tr><th>项目</th><th>数值</th></tr><tr><td>工期</td><td>60天</td></tr></table>\n<!-- yibiao:block -->\n${figure.replace('id="图"', `id="${id}_fig1"`)}\n<!-- yibiao:block -->\n<p id='${id}_sq'>单引号编号段落</p>\n<!-- yibiao:block -->\n<p>缺少编号段落</p>`;
  let savedState;
  let action;
  let childAction;
  let activeTools;
  let failExtract = new Set();
  const progress = [];
  const warmups = [];
  const requests = [];
  const pause = new Error('模拟暂停');
  const ledgerJson = path.join(workspaceDir, '正文一致性事实台账.json');
  const readLedger = () => fs.readFileSync(path.join(workspaceDir, LEDGER_FILE), 'utf8');

  // 各场景共用相同的最小文件输入，避免依赖用户数据库或外部模型。
  function reset() {
    savedState = {};
    requests.length = 0;
    warmups.length = 0;
    failExtract = new Set();
    for (const file of files) {
      const destination = path.join(workspaceDir, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content, 'utf8');
    }
    for (const file of ['正文一致性事实台账.json', LEDGER_FILE]) fs.rmSync(path.join(workspaceDir, file), { force: true });
    fs.mkdirSync(path.join(workspaceDir, '图片'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '图片/原图.png'), Buffer.from([1]));
    fs.mkdirSync(path.join(workspaceDir, '正文'), { recursive: true });
    for (const { item } of targets) fs.writeFileSync(path.join(workspaceDir, `正文/${item.id}.html`), sectionHtml(item.id), 'utf8');
    fs.writeFileSync(path.join(workspaceDir, '正文生成结果.json'), JSON.stringify({ sections: targets.map(({ item }) => ({ section_id: item.id, file: `正文/${item.id}.html`, words: 8 })) }), 'utf8');
  }
  // 核对模型返回带方括号的段落 ID，验证程序的输出边界规整与校验。
  const aiService = {
    async chat(request) { warmups.push(request); return ''; },
    async requestJson(request) {
      requests.push(request);
      const id = request.logTitle.includes('小节1') ? 'one' : 'two';
      if (failExtract.has(id)) throw new Error(`模拟${id}核对失败`);
      const output = request.normalizer(id === 'one'
        ? { issues: [], facts: [{ category: '时间与时限', subject: '工期', value: '六十天', block_id: '[one_p1]', quote: '工期六十天' }] }
        : { issues: [{ block_id: 'two_t1', type: '与全局事实冲突', problem: '表格工期写成60天以外的口径', evidence: '全局事实：工期六十天', suggestion: '统一为六十天' }],
          facts: [{ category: '时间与时限', subject: '工期', value: '60天', block_id: 'two_t1', quote: '工期 | 60天' }, { category: '人员与岗位', subject: '项目负责人', value: '1名', block_id: '', quote: '' }] });
      request.validator(output);
      return output;
    },
  };
  const service = {
    hasPersistentTaskSession: () => true,
    loadPersistentTask: () => ({ state: savedState, paths: { workspaceDir } }),
    updatePersistentTask(_key, partial) { savedState = { ...savedState, ...structuredClone(partial) }; },
    async runTask(payload) {
      if (!payload.primary_session) return childAction(payload);
      const tools = payload.create_tools({ Type, workspaceDir, setActiveTools: names => { activeTools = names; } });
      // 与 Runtime 一致：发送下一阶段提示词前等待与压缩并行的程序步骤。
      const handoff = async () => { payload.validateOutput({}, { workspace_dir: workspaceDir }); return payload.continueTask({}, { workspace_dir: workspaceDir }); };
      const next = async () => {
        const continuation = await handoff();
        await continuation?.await_before_prompt;
        return continuation;
      };
      const finish = issues => tools.find(tool => tool.name === 'complete-consistency-round').execute('finish', { summary: '检查了工期和跨节承诺', remaining_issues: issues });
      await action({ payload, tools, next, handoff, finish });
      return { workspace_dir: workspaceDir };
    },
  };
  const run = resume => runContentGenerationAgent({ agentService: service, aiService, signal: new AbortController().signal, resume,
    hasKnowledgeBase: false, buildFiles: () => files, onConsistencyProgress: state => progress.push(structuredClone(state)),
  });
  try {
    // 核对输入只保留段落 ID、正文、表格数据和图注，不含标签、注释、行号及图片提示词。
    const text = sectionAuditText(`${sectionHtml('one')}\r\n<!-- yibiao:block -->\r\n<table id="one_t2" data-yb-preset="imageText"><tr><td>${figure}</td><td>左图说明</td></tr></table>`);
    assert.match(text, /^\[one_p1\] 仅属于one的材料，工期六十天。$/m);
    assert.match(text, /^\[one_ol1\] 1\. 进场\n2\. 验收$/m);
    assert.match(text, /^\[one_t1\] 表：参数表\n项目 \| 数值\n工期 \| 60天$/m);
    assert.match(text, /^\[one_fig1\] \[图 one_fig1：现场\]$/m);
    assert.match(text, /^\[one_sq\] 单引号编号段落$/m);
    assert.match(text, /^\[第6块\] 缺少编号段落$/m);
    // 上下标和换行保留原意，不把 10³ 读成 103，也不让换行两侧文字粘连。
    const units = sectionAuditText('<p id="unit">风量≥30 m<sup>3</sup>/(h·人)，浓度10<sup>-6</sup>，CO<sub>2</sub>，指数x<sup>n+1</sup>，比较<sup>a&lt;b</sup>，甲方<br>乙方</p><table id="unit_t"><tr><td>值守<br/>2名</td><td>硬件<br>3名</td></tr></table>');
    assert.equal(units, '[unit] 风量≥30 m^3/(h·人)，浓度10^-6，CO_2，指数x^(n+1)，比较^(a<b)，甲方 乙方\n[unit_t] 值守 2名 | 硬件 3名');
    assert.match(text, /^\[one_t2\] \[图 图：现场\] \| 左图说明$/m);
    assert.doesNotMatch(text, /生图提示词|<|yibiao:block|L0000/);

    // 进入审计先并发核对各小节并生成台账，主 Agent 只拿台账接手，且没有 edit/write。
    reset();
    action = async ({ payload, next, handoff, finish }) => {
      const start = await handoff();
      assert.equal(start.stage, 'auditing');
      assert.equal(start.compact_before_prompt, true);
      assert.ok(start.await_before_prompt instanceof Promise, '小节核对交给 Runtime 与压缩并行');
      assert.equal(savedState.consistency.status, 'extracting', '交接返回时核对仍在进行，不阻塞压缩');
      await start.await_before_prompt;
      assert.equal(requests.length, 2);
      assert.equal(warmups.length, 1, '多节核对前预热公共前缀');
      assert.equal(warmups[0].output_token_limit, 1);
      assert.equal(requests[0].messages[0].content, requests[1].messages[0].content, '核对 system 全轮相同');
      const shared = requests.map(request => request.messages[1].content.split('\n\n本节：')[0]);
      assert.equal(shared[0], shared[1], '公共材料在前，便于复用前缀缓存');
      assert.equal(shared[0], warmups[0].messages[1].content);
      assert.ok(requests.every(request => !/生图提示词|<p|yibiao:block/.test(request.messages[1].content)), '核对输入不含 HTML 和图片提示词');
      assert.ok(requests[0].messages[1].content.includes('[one_p1] 仅属于one的材料'));
      assert.ok(!requests[0].messages[1].content.includes('仅属于two的材料'), '核对请求只含本节正文');
      assert.throws(() => requests[0].validator({ issues: [], facts: [{ category: '时间与时限', subject: '工期', value: '六十天', block_id: 'two_p1', quote: '' }] }), /block_id 不存在/);
      // 校验与核对输入同源：单引号 id、程序补的块序号及图片 id 均可引用。
      requests[0].validator({ issues: [{ block_id: '第6块', type: '小节内部矛盾', problem: '前后不一致', evidence: '', suggestion: '' }],
        facts: [{ category: '其他', subject: '单引号段落', value: '已编号', block_id: 'one_sq', quote: '' }, { category: '其他', subject: '图片', value: '现场', block_id: 'one_fig1', quote: '' }] });
      assert.throws(() => requests[0].validator({ issues: [{ block_id: '', type: '润色建议', problem: '文风', evidence: '', suggestion: '' }], facts: [] }), /合法 type/);
      const ledger = readLedger();
      assert.ok(ledger.indexOf('1.1 小节1｜小节 ID：one｜文件：正文/one.html') < ledger.indexOf('1.2 小节2'));
      assert.match(ledger, /小节核对发现的问题（共 1 项）\n1\. \[1\.2 小节2｜two｜two_t1\] 与全局事实冲突：/);
      assert.match(ledger, /### 时间与时限\n- 工期：六十天 —— 1\.1 \[one_p1\]“工期六十天”\n- 工期：60天 —— 1\.2 \[two_t1\]/);
      assert.match(ledger, /### 人员与岗位\n- 项目负责人：1名 —— 1\.2 \[未定位\]/);
      assert.equal(savedState.consistency.status, 'running');
      assert.equal(savedState.consistency.extract_completed, 2);
      assert.ok(progress.some(state => state.status === 'extracting'));
      assert.match(start.prompt, /正文一致性事实台账\.md/);
      assert.match(start.prompt, /一次完成审计和修复，不分轮次/);
      assert.match(start.prompt, /没有 edit 权限，所有修改都通过 repair-sections 完成/);
      assert.ok(start.prompt.includes('以“【待填写】”标记'), '内嵌事实处理要求，无须整读编排决策');
      assert.doesNotMatch(start.prompt, /知识库/);
      assert.deepEqual(activeTools, CONSISTENCY_TOOLS);
      for (const name of ['edit', 'write', 'check-word-count', 'adjust-sections', 'generate-sections', 'bash']) {
        assert.equal(activeTools.includes(name), false);
        assert.throws(() => payload.before_tool_call({ toolCall: { name }, args: { path: '正文/one.html' } }), /正文编辑期间不能|当前阶段仅统计字数/);
      }
      assert.equal((await next()).stage, 'auditing', '未提交结论不能跳过审计');
      await finish(['采购人未明确驻场人员总数与岗位配置的对应关系']);
      assert.throws(() => payload.before_tool_call({ toolCall: { name: 'repair-sections' }, args: {} }), /结论已经提交/);
      assert.equal((await next()).complete, true, '提交结论后直接结束，不开下一轮');
    };
    await run(false);
    assert.equal(savedState.consistency.status, 'completed');
    assert.deepEqual(savedState.consistency.remaining_issues, ['采购人未明确驻场人员总数与岗位配置的对应关系']);
    assert.equal(requests.length, 2, '遗留问题不触发重新核对');
    action = async ({ payload, next }) => {
      assert.match(payload.prompt, /已经结束/);
      assert.equal((await next()).complete, true);
    };
    await run(true);
    assert.equal(requests.length, 2, '已完成的审计恢复时不再核对');

    // 核对失败保留已完成小节，恢复时只补未完成小节，台账完整后才交给主 Agent。
    reset();
    failExtract = new Set(['two']);
    action = async ({ next }) => {
      await assert.rejects(next(), /1 个小节一致性核对失败.*重试时只核对剩余小节/);
      throw pause;
    };
    await assert.rejects(run(false), error => error === pause);
    assert.equal(savedState.consistency.status, 'extracting');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(ledgerJson, 'utf8')).sections), ['one']);
    assert.equal(fs.existsSync(path.join(workspaceDir, LEDGER_FILE)), false, '台账不完整时不生成主 Agent 读取的文件');
    failExtract = new Set();
    requests.length = 0;
    warmups.length = 0;
    action = async ({ payload }) => {
      assert.equal(payload.initial_stage, 'auditing');
      assert.equal(payload.files.length, 0);
      assert.deepEqual(requests.map(request => request.logTitle), ['一致性核对-1.2-小节2'], '恢复只核对剩余小节');
      assert.equal(warmups.length, 0, '单节核对不预热');
      assert.equal(savedState.consistency.status, 'running');
      assert.match(readLedger(), /小节核对发现的问题（共 1 项）/);
      assert.match(payload.prompt, /正文一致性事实台账\.md/);
      throw pause;
    };
    await assert.rejects(run(true), error => error === pause);
    requests.length = 0;
    action = async ({ finish, next }) => {
      assert.equal(requests.length, 0, '比对阶段恢复不重复核对');
      await finish([]);
      assert.equal((await next()).complete, true);
    };
    await run(true);

    // 检索只在目标小节纯文本中匹配，不命中图片提示词，并返回段落 ID。
    reset();
    fs.writeFileSync(path.join(workspaceDir, '正文/outside.html'), '<p id="x">工期六十天</p>', 'utf8');
    action = async ({ next, tools, finish }) => {
      await next();
      const search = tools.find(tool => tool.name === 'search-sections');
      const found = (await search.execute('search', { keywords: ['工期', '不存在'] })).details;
      assert.equal(found.total, 4);
      assert.equal(found.truncated, false);
      assert.deepEqual(found.matches.map(match => `${match.section_id}/${match.block_id}`), ['one/one_p1', 'one/one_t1', 'two/two_p1', 'two/two_t1']);
      assert.equal((await search.execute('prompt', { keywords: ['生图提示词'] })).details.total, 0);
      assert.equal((await search.execute('scope', { keywords: ['验收'], section_ids: ['two'] })).details.matches[0].section_id, 'two');
      await finish([]);
    };
    await run(false);

    // 并发修复：真实原生 edit、图片保护、失败登记与重试，并返回改动段落前后文本。
    reset();
    const repairContents = new Map(targets.map(({ item }) => {
      const html = `<!-- yibiao:block -->\r\n<p id="${item.id}_p1">仅属于${item.id}的小节材料${'完整正文😀'.repeat(1000)}</p>\r\n<!-- yibiao:block -->\r\n<p id="${item.id}_p2">工期六十天</p><table id="${item.id}_t1"><tr><td>参数</td><td>六十天</td></tr></table>${figure}`;
      fs.writeFileSync(path.join(workspaceDir, `正文/${item.id}.html`), html, 'utf8');
      return [`正文/${item.id}.html`, html];
    }));
    let started = 0;
    let release;
    let bothStarted;
    const gate = new Promise(resolve => { release = resolve; });
    const startedGate = new Promise(resolve => { bothStarted = resolve; });
    let failOne = true;
    const batchPrompts = [];
    childAction = async payload => {
      started++;
      if (failOne) batchPrompts.push(payload.prompt);
      if (started === 2) bothStarted();
      await gate;
      assert.equal(payload.failure_handled_by_parent, true);
      assert.equal(payload.workspace_dir, workspaceDir);
      assert.deepEqual(payload.active_tools, ['read', 'edit', 'report-failure']);
      assert.equal(payload.summary_enabled, false);
      assert.match(payload.prompt, /据此直接使用 edit 修改，不要先 read 本节文件/);
      assert.match(payload.prompt, /段落 ID 只用于定位/);
      assert.ok(payload.prompt.includes(fs.readFileSync(path.join(workspaceDir, '受限HTML生成规范.md'), 'utf8')));
      assert.ok(payload.prompt.endsWith(repairContents.get(payload.output_file)), '输入必须包含本节完整原文，保留换行、表格和图片');
      const otherId = payload.output_file.endsWith('one.html') ? 'two' : 'one';
      assert.ok(!payload.prompt.includes(`仅属于${otherId}的小节材料`), '不注入其他小节正文');
      if (!failOne) assert.match(payload.prompt, /失败后重新派发前的最新内容/);
      assert.match(payload.prompt, /只修复主 Agent 指定的问题/);
      if (failOne && payload.output_file.endsWith('one.html')) throw new Error('模拟可恢复子任务失败');
      const created = await createPiSession({ workspaceDir, environment: { shellPath: process.env.ComSpec, layout: { agentDir: path.join(root, 'agent') }, instructions: '测试原生编辑', env: {} },
        config: {}, timeoutMs: 60000, summaryEnabled: false, proxyInfo: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        activeTools: payload.active_tools, beforeFileWrite: payload.before_file_write, beforeToolCall: payload.before_tool_call,
      });
      try {
        const edit = created.session.agent.state.tools.find(tool => tool.name === 'edit');
        const original = fs.readFileSync(path.join(workspaceDir, payload.output_file), 'utf8');
        await assert.rejects(edit.execute('bad', { path: payload.output_file, edits: [{ oldText: figure, newText: '' }] }), /受保护图片/);
        assert.equal(fs.readFileSync(path.join(workspaceDir, payload.output_file), 'utf8'), original);
        await edit.execute('fix', { path: payload.output_file, edits: [{ oldText: '工期六十天', newText: '工期统一为六十天' }] });
        payload.validateOutput({ output_content: fs.readFileSync(path.join(workspaceDir, payload.output_file), 'utf8') });
      } finally { created.session.dispose(); }
      return {};
    };
    action = async ({ next, tools, finish }) => {
      await next();
      const repair = tools.find(tool => tool.name === 'repair-sections');
      const invalid = (await repair.execute('invalid', { sections: [{ section_id: 'outside', instructions: '修复' }] })).details.results;
      assert.match(invalid[0].error, /不属于本轮目标：outside.*原样复制/);
      assert.equal(started, 0, 'ID 错误的项不派发子任务');
      const batch = repair.execute('batch', { sections: targets.map(({ item }) => ({ section_id: item.id, instructions: '统一工期六十天' })) });
      await startedGate;
      await assert.rejects(finish([]), /等待全部/);
      release();
      const results = (await batch).details.results;
      assert.deepEqual(results.map(item => item.status), ['error', 'success']);
      assert.equal(results[0].changes, undefined, '失败小节不返回改动');
      assert.deepEqual(results[1].changes, [{ block_id: 'two_p2', before: '工期六十天', after: '工期统一为六十天' }], '只返回改动段落前后文本');
      // 同批子会话共用规则和规范在前，小节身份与正文在“本次任务”之后，便于复用请求前缀缓存。
      const shared = batchPrompts.map(prompt => prompt.slice(0, prompt.indexOf('本次任务：')));
      assert.equal(batchPrompts.length, 2);
      assert.equal(shared[0], shared[1]);
      assert.ok(!targets.some(({ item }) => shared[0].includes(`正文/${item.id}.html`)), '公共段不含小节文件');
      await assert.rejects(finish([]), /修复任务未成功/);
      throw pause;
    };
    await assert.rejects(run(false), error => error === pause);
    assert.deepEqual(savedState.consistency.failed_sections, ['one']);
    const sourceFile = path.join(workspaceDir, '正文/one.html');
    const latestHtml = `${repairContents.get('正文/one.html')}<p>失败后重新派发前的最新内容</p>`;
    fs.writeFileSync(sourceFile, latestHtml, 'utf8');
    repairContents.set('正文/one.html', latestHtml);
    failOne = false;
    requests.length = 0;
    action = async ({ next, tools, finish }) => {
      assert.equal(requests.length, 0, '修复阶段恢复不重复核对');
      await assert.rejects(finish([]), /修复任务未成功/);
      const result = await tools.find(tool => tool.name === 'repair-sections').execute('retry', { sections: [{ section_id: 'one', instructions: '统一工期六十天' }] });
      assert.equal(result.details.results[0].status, 'success');
      assert.deepEqual(result.details.results[0].changes.map(change => change.block_id), ['one_p2']);
      await finish([]);
      assert.equal((await next()).complete, true);
    };
    await run(true);
    assert.equal(started, 3, '重试只重新派发失败小节');

    // 批次输入边界与并发：错误 ID 不拖累同批并给出候选，同节要求合并，统一规则下发，不同批次并发且同一小节互斥。
    reset();
    const childPrompts = [];
    const childGates = new Map();
    let childFailures = new Set();
    const hold = id => {
      const entry = {};
      entry.wait = new Promise(resolve => { entry.release = resolve; });
      entry.startedPromise = new Promise(resolve => { entry.started = resolve; });
      childGates.set(id, entry);
      return entry;
    };
    childAction = async payload => {
      const id = decodeURIComponent(path.basename(payload.output_file, '.html'));
      childPrompts.push({ id, prompt: payload.prompt });
      const entry = childGates.get(id);
      if (entry) { entry.started(); await entry.wait; }
      if (childFailures.has(id)) throw new Error(`模拟${id}修复失败`);
      const file = path.join(workspaceDir, payload.output_file);
      if (payload.prompt.includes('改工期')) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('工期六十天', '工期统一为六十天'), 'utf8');
      return {};
    };
    action = async ({ next, tools, finish }) => {
      await next();
      const repair = tools.find(tool => tool.name === 'repair-sections');
      assert.equal(repair.executionMode, undefined, '修复批次不强制整轮串行');
      assert.equal(tools.find(tool => tool.name === 'complete-consistency-round').executionMode, 'sequential');
      const mixed = (await repair.execute('mixed', { sections: [
        { section_id: 'two-typo', instructions: '改工期' },
        { section_id: 'one', instructions: '改工期' },
        { section_id: 'one', instructions: '补充说明依据' },
      ] })).details.results;
      assert.deepEqual(mixed.map(item => [item.section_id, item.status]), [['two-typo', 'error'], ['one', 'success']]);
      assert.match(mixed[0].error, /不属于本轮目标：two-typo.*1\.2 小节2（two）/);
      assert.deepEqual(mixed[1].changes, [{ block_id: 'one_p1', before: '仅属于one的材料，工期六十天。', after: '仅属于one的材料，工期统一为六十天。' }]);
      const merged = childPrompts.filter(item => item.id === 'one');
      assert.equal(merged.length, 1, '同一小节的多项要求合并为一个子任务');
      assert.match(merged[0].prompt, /改工期\n补充说明依据/);
      // 统一规则进入同批公共段；只需自查的小节收到自查要求，不修改也能成功结束。
      childPrompts.length = 0;
      const ruled = (await repair.execute('rules', { rules: '工期统一写作六十天', sections: [{ section_id: 'one', instructions: '' }, { section_id: 'two', instructions: '' }] })).details.results;
      assert.deepEqual(ruled.map(item => [item.status, item.changes.length]), [['success', 0], ['success', 0]]);
      const shared = childPrompts.map(item => item.prompt.slice(0, item.prompt.indexOf('本次任务：')));
      assert.equal(shared[0], shared[1]);
      assert.match(shared[0], /本批统一修复规则[\s\S]*工期统一写作六十天/);
      assert.ok(childPrompts.every(item => item.prompt.slice(item.prompt.indexOf('本次任务：')).includes('按本批统一修复规则在本节全文按语义自查')));
      assert.match((await repair.execute('empty', { sections: [{ section_id: 'one', instructions: ' ' }] })).details.results[0].error, /缺少修复要求/);
      // 不同批次并发执行；同一小节正在修复时逐项拒绝；失败登记基于最新状态，先结束的批次不覆盖其他批次。
      const holdOne = hold('one');
      const holdTwo = hold('two');
      childFailures = new Set(['one']);
      const first = repair.execute('first', { sections: [{ section_id: 'one', instructions: '改工期' }] });
      const second = repair.execute('second', { sections: [{ section_id: 'two', instructions: '改工期' }] });
      await Promise.all([holdOne.startedPromise, holdTwo.startedPromise]);
      assert.deepEqual([...savedState.consistency.failed_sections].sort(), ['one', 'two']);
      assert.match((await repair.execute('busy', { sections: [{ section_id: 'one', instructions: '改工期' }] })).details.results[0].error, /正在其他批次中修复/);
      await assert.rejects(finish([]), /等待全部/);
      holdTwo.release();
      assert.equal((await second).details.results[0].status, 'success');
      assert.deepEqual(savedState.consistency.failed_sections, ['one'], '先结束的批次只移除自己的成功小节');
      holdOne.release();
      assert.equal((await first).details.results[0].status, 'error');
      assert.deepEqual(savedState.consistency.failed_sections, ['one']);
      childGates.clear();
      childFailures = new Set();
      assert.equal((await repair.execute('retry', { sections: [{ section_id: 'one', instructions: '改工期' }] })).details.results[0].status, 'success');
      await finish([]);
    };
    await run(false);
    assert.equal(savedState.consistency.status, 'completed');

    // 共用入口默认不注入材料，其他编辑任务仍要求自行读取文件。
    let defaultPrompt;
    await editContentSections({ jobs: [{ section_id: 'one', instructions: '默认编辑路径' }],
      targets: new Map([['one', { id: 'one', number: '1.1', title: '小节1', file: '正文/one.html' }]]),
      workspaceDir, signal: new AbortController().signal, activity: { pending: 0 },
      agentService: { async runTask(payload) { defaultPrompt = payload.prompt; } },
      title: '默认编辑', instructions: '保留原流程',
    });
    assert.match(defaultPrompt, /先完整读取该文件及受限HTML生成规范.md/);
    assert.doesNotMatch(defaultPrompt, /本小节启动时的完整 HTML|仅属于one的小节材料/);
    console.log('通过：纯文本核对输入、核对与压缩并行、前缀预热、台账分组、主 Agent 无 edit、单轮提交即结束、核对失败只补剩余、检索、真实并发修复及改动对比、图片保护及失败重试、错误 ID 部分执行与候选、同节合并、统一规则自查、多批次并发与按小节互斥。');
  } finally {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
