# 小兔鲜电商 · AI 深度集成实施说明

> 对应文档：`docs/AI深度集成-改进方向.md`（下称「方向文档」）。
> 本文记录**这一轮实际落地了什么、怎么验、哪些地方和原方案不同以及为什么**。
> 版本：v1（2026-11-15）

---

## 0. 一句话总结

方向文档提出的「前提 P（平台化）+ 主线 A1（语义搜索）+ C3（文案）+ C5（坐席辅助）+ 主线 C 的评测护栏」
已经落地；`aiChatService.ts`（681 行）不再是 AI 的唯一入口，业务侧通过一层平台调用 AI，
**AI 关掉、超时、被熔断时业务全部照常**。

---

## 1. 落地对照表

| 方向文档条目 | 状态 | 落点 |
| --- | --- | --- |
| §3 前提 P：抽出 `core / rag / tools / scenarios` | ✅ | `server/src/ai/` |
| §3.2 步骤 1：审计与治理抽离，`module` 由参数传入 | ✅ | `ai/core/{guard,audit}.ts` |
| §3.2 步骤 2：工具注册表 + `authz(ctx)` | ✅ | `ai/tools/{registry,order,product}.ts` |
| §3.2 步骤 3：RAG 改 `KnowledgeSource[]` 注册表 | ✅ | `ai/rag/sources/*`、`ai/rag/{retriever,sync}.ts` |
| §3.2 步骤 4：提示词拆分（通用规则 / 场景段落） | ✅ | `ai/prompts/base.ts` + 各场景自带 |
| §3.2 步骤 5：客服场景迁移，路由与接口契约不动 | ✅ | `ai/scenarios/customerService.ts` |
| §3.3-1 工具入参 zod 校验 | ✅ | `registry.executeTool` 先 `schema.safeParse` |
| §3.3-2 限流/预算按 module 拆 | ✅ | `AI_BUDGET_*` / `AI_RATE_*`，chat/admin/other 三档 |
| §3.3-3 审计 `module` 维度 + 场景下钻 | ✅ | `ai_call_logs.scenario/cache_hit/fallback_reason` + 后台「分模块用量」 |
| §3.3-4 结构化输出统一收口 | ✅ | `ai/core/output.ts` + `runAiTask` 重试 1 次后降级 |
| §3.3-5 知识源注册表 | ✅ | 加一类知识只需新增 `ai/rag/sources/xxx.ts` |
| §3.3-6 结果缓存 | ✅ | `ai/core/cache.ts`，按 `scenario + hash(入参)` 缓存 10 分钟 |
| §3.3-7 场景开关三级 | ✅ | `.env` → `settings`（30s 热更）→ `grayUserIds` |
| §4 A1 查询理解 + 结果页 chips + 搜索埋点 + 热词 | ✅ | `ai/scenarios/searchParse.ts`、搜索页、`search_logs` |
| §4 A1 召回换 FULLTEXT(ngram) | ⚠️ 改为 Node 内打分 | 见 §4.1 |
| §4 A2 商品问答 / 评论洞察 / 离线打标 job | ❌ 未做（迭代 2） | — |
| §5 B 购物车凑单 / 订单动作提案（L3） | ❌ 未做（迭代 4） | — |
| §6 C1 经营日报 / 受控问数 | ❌ 未做（迭代 3） | — |
| §6 C2 退款审核建议 / 异常订单 | ❌ 未做（迭代 3） | — |
| §6 C3 营销文案生成 + 违禁词 | ✅ | `ai/scenarios/marketingCopy.ts`、后台文案工坊 |
| §6 C4 推荐 / 库存预测 | ❌ 未做（迭代 4） | — |
| §6 C5 坐席辅助（归类 + 相似工单 + 草稿） | ✅ | `ai/scenarios/helpdeskDraft.ts`、工单列表「AI 辅助」 |
| §6 C5 主动服务（事件驱动触达） | ❌ 未做（迭代 2） | — |
| §9.1 评测集 + `npm run ai:eval` | ✅ | `ai/eval/*`、`ai_eval_cases`、后台「评测」页 |
| §9.2 回答反馈 👍/👎 + 纠错 | ✅ | `ai_feedback`、客服面板、后台差评样本 |
| §9.2 兜底率 / 转人工率指标 | ✅ | 后台「概览」卡片 |

---

## 2. 新的目录与职责

```
server/src/
├── adapters/ai/          只负责「跟厂商说话」：OpenAI 协议、SSE、超时
│   └── mock.ts           话术按 scenario 注册，不再写死客服正则
├── ai/
│   ├── core/
│   │   ├── run.ts        runAiTask()：场景开关 → 限流 → 预算 → 熔断 → 缓存
│   │   │                 → 模型（工具轮次）→ 结构化校验（重试 1 次）→ 降级 → 审计
│   │   ├── guard.ts      滑动窗口限流 / 分模块预算 / 熔断 / 三级场景开关 / 硬超时
│   │   ├── audit.ts      writeCallLog() 统一入口 + 成本估算
│   │   ├── output.ts     JSON 宽容提取 → zod 严格校验
│   │   └── cache.ts      结果缓存（10 分钟 / 500 条上限）
│   ├── rag/
│   │   ├── sources/      faq / notice / logistics / freight / policy 五个知识源
│   │   ├── retriever.ts  中文二元组 + BM25（原实现平移，导出 tokenize 复用）
│   │   └── sync.ts       遍历注册表写入 ai_kb_chunks（幂等）
│   ├── tools/
│   │   ├── registry.ts   工具注册 + zod 校验 + authz + 可用工具过滤
│   │   ├── order.ts      订单/物流（只读，强制按 userId 过滤）
│   │   └── product.ts    商品检索/详情（新增，「把货纳入认知」）
│   ├── scenarios/
│   │   ├── customerService.ts  客服（会话、落库、转人工）
│   │   ├── searchParse.ts      查询理解（规则基线 + 模型 + 逐级放宽）
│   │   ├── marketingCopy.ts    文案（3 版本 + 违禁词拦截 + 模板兜底）
│   │   └── helpdeskDraft.ts    坐席辅助（归类 + 相似工单 + 草稿）
│   ├── prompts/base.ts   角色/事实/知识/规则装配 + 通用 8 条规则
│   ├── eval/             评测执行器与 CLI
│   ├── feedback.ts       👍/👎 与质量指标
│   └── index.ts          统一出口（业务只 import { ai }）
└── services/
    ├── aiAdminService.ts 后台查询（会话、用量、质量、评测编排）
    └── aiPolicies.ts     平台规则文本（知识源之一）
```

`services/aiChatService.ts`、`aiKnowledgeService.ts`、`aiPrompt.ts` 已删除，能力分别迁移到
`ai/scenarios/customerService.ts`、`ai/rag/*`、`ai/prompts/base.ts`。

---

## 3. 数据层变更

迁移：`server/database/migrations/20261115000027-ai-platform-upgrade.js`

| 变更 | 用途 |
| --- | --- |
| `ai_call_logs` + `scenario` / `cache_hit` / `fallback_reason` | 分场景成本下钻、算兜底率 |
| `ai_feedback`（新表） | 👍/👎 + 纠错文本，唯一键 `(message_id, user_id)` |
| `ai_eval_cases`（新表） | 评测集用例，`expect_json` 按字段比对 |
| `search_logs`（新表） | 关键词、解析结果、命中数、预留点击商品 |
| `feedbacks` + `ai_category` / `ai_summary` | 坐席辅助归类，AI 不可用时空着 |

种子数据：

- `20261115000015-ai-domain-permissions.js` — 权限码 `ai:search` / `ai:marketing` / `ai:helpdesk`
- `20261115000016-ai-eval-cases.js` — 16 条评测用例（12 条查询理解 + 4 条知识召回）
- `20261115000018-ai-scenario-settings.js` — 四个场景开关的 `settings` 默认值

---

## 4. 关键决策与偏离说明

### 4.1 没有引入 `FULLTEXT(ngram)`，改为 Node 内打分

方向文档 §4 A1 建议把 `LIKE` 换成 `MATCH ... AGAINST`。当前库内 SKU 只有百级，
加全文索引带来的收益抵不上「多一个需要解释的组件」的成本，因此改为：

1. 关键词按**中英文边界拆词**后做 `LIKE` 并集召回（解决「白色T恤」匹配不到「纯棉 T 恤」）；
2. 候选集（上限 200）在 Node 内按 `0.6×文本相关 + 0.3×属性命中 + 0.1×销量/评分` 重排；
3. 属性过滤走 `product_attributes` 的一次轻量子查询，多个属性词取**并集**。

语料过千时把 `buildWhere` 的 `LIKE` 换成 `MATCH` 即可，打分与分页逻辑不用动。

### 4.2 搜索解析超时：文档 300ms → 实际 2500ms

2000ms 以下是实测：deepseek-flash 生成这段结构化 JSON 需要 **1.2–2.5s**，
300ms 预算会让 AI 路径**永远跑到降级分支**，功能等于不存在。

因此默认 `AI_SEARCH_PARSE_TIMEOUT_MS=2500`，并配合前端的**渐进渲染**：

- 搜索页先用原始关键词出结果（不等 AI）；
- 解析回来后渲染「AI 理解为」chips，并把结构化条件补进列表（一次合并刷新）；
- 超时/关闭时只显示一行降级提示，搜索主链路完全不受影响。

需要严格锁定搜索延迟时，把该值改回 300 即可——行为完全等价，只是永远走规则解析。

### 4.3 零结果风险用「逐级放宽」消掉

解析出多个条件容易筛成 0 条（模型多想了品牌或品类）。`searchParse` 在计数为 0 时按
**属性 → 品牌 → 品类 → 价格** 逐级放宽，并把被放宽的条件回传给前端提示
「没有完全匹配的商品，已放宽价格条件」。实测「露营用的帐篷，400元以内」时，
模型多给了「户外露营」品类导致 0 条，放宽后命中 1 条。

### 4.4 没有给 `ai_kb_chunks` 加 `embedding` 列

DeepSeek 无 embedding 接口，`AI_EMBEDDING_ENABLED` 恒为 false，加列只会留下一个永远为空的字段。
等真正接入第三方 embedding 时随那次迁移一起加，符合方向文档「不要让 embedding 成为硬依赖」。

### 4.5 用户端预算兼容旧变量

`AI_BUDGET_CHAT_CNY` 未配置时回落到旧的 `AI_DAILY_BUDGET_CNY`，避免已有部署升级后
额度突然从 20 元掉到 12 元。`admin` / `other` 使用新默认值（6 / 2 元）。

预算只分 3 个桶，而审计按 4 个 module 记录：`chat → chat`、`admin → admin`、
`search / other → other`。这样搜索解析的开销不会成为没有上限的免费通道。

### 4.6 中文数字进规则层而不是只交给模型

「预算三百以内的台灯」是最常见的说法之一，正则只认 `\d+` 会直接漏掉价格。
在规则解析里补了 12 行中文数字转换（三百 → 300、两百五十 → 250），
让**规则基线**也能覆盖这类问法——这比多打一次模型便宜得多。

---

## 5. 接口与权限

| 接口 | 说明 | 权限 |
| --- | --- | --- |
| `POST /api/client/v1/ai/messages/:id/feedback` | 👍/👎 + 纠错 | 登录用户 |
| `POST /api/client/v1/ai/search/parse` | 查询理解（失败也不报错） | 可选登录 |
| `GET /api/client/v1/search/hot` | 热门搜索（`search_logs` 聚合，无数据回退销量榜） | 公开 |
| `GET /api/admin/ai/usage` | 分模块用量、预算、质量指标 | `ai:view` |
| `GET /api/admin/ai/scenarios` | 场景开关、灰度、熔断、缓存规模 | `ai:view` |
| `POST /api/admin/ai/copywriting` | 文案生成（不写库） | `ai:marketing` |
| `POST /api/admin/ai/feedback/:id/draft` | 坐席辅助（不写回复，只回填草稿） | `ai:helpdesk` |
| `GET /api/admin/ai/feedback/bad` | 最近差评样本 | `ai:view` |
| `POST /api/admin/ai/eval` | 跑评测集 | `ai:manage` |
| `POST /api/admin/ai/knowledge/rebuild` | 重建知识库 | `ai:manage` |

后台写操作（文案生成）统一走 `writeAdminLog()` 留痕。

---

## 6. 更新后的「反模式」对照（方向文档 §11）

| 文档里的反模式 | 本轮的处置 |
| --- | --- |
| 1. 不要继续在 `aiChatService.ts` 里加 if/else | 文件已删除，客服逻辑搬进场景，治理搬到 core |
| 2. 不要把商品全量同步进 `ai_kb_chunks` | 商品走工具 + SQL 按需取摘要，未进知识库 |
| 3. 不要让 embedding 成为硬依赖 | 未引入，全链路不依赖向量 |
| 4. 不要让 mock 写死客服话术 | `registerMockScenario()` 按场景注册，已注册客服与查询理解 |
| 5. 不要复用业务连接跑问数 SQL | 本轮未做问数（迭代 3），已知需要独立只读连接 |
| 6. 不要在前端渲染模型返回的 HTML | 所有输出都是纯文本，前端 `white-space: pre-wrap` |
| 7. 不写 `ai_action_logs` 就别开写接口 | L3 动作未做，未开任何 AI 写接口 |
| 8. 不要用「接了几个模型」当成果 | 交付物是：平台层 + 兜底率/好评率指标 + 评测集 |

---

## 7. 实测结果（2026-11-15，deepseek-flash）

**查询理解**（`npm run ai:eval -- --scenario=search_parse`，真实模型）

```
准确率 100% (12/12)  降级率 0%  平均 1251ms  P95 1529ms
```

样例输出：

| 输入 | 解析结果 |
| --- | --- |
| 预算三百以内的台灯 | `{keyword:台灯, category:家居生活, maxPrice:300}` |
| 有没有便宜点的洗发水，100元以下 | `{keyword:洗发水, category:洗护清洁, maxPrice:100, sortBy:priceAsc}` |
| 露营用的帐篷，400元以内 | `{keyword:帐篷, maxPrice:400}`（模型多给的品类被放宽掉） |

**离线基线**（`npm run ai:eval -- --mock`）

```
search_parse 准确率 100% (12/12) 降级率 0%
customer_service 准确率 100% (4/4)  平均 3ms
```

即「AI 关掉时业务照常」这条验收标准是可测的：规则基线同样跑满分。

**客服**：带订单号提问时模型真实调用 `get_order_logistics`，命中承运商与运单号并给出引用；
`ai_messages.tool_calls` 有完整留痕，`ai_feedback` 落库成功。

**场景开关**：把 `ai.scenario.search_parse.enabled` 改成 0，下一次解析 22ms 返回
`degraded=true, fallbackReason=disabled`，不再产生模型调用；改回 1 立即恢复 AI 路径。

---

## 8. 仍未做的事（以及做之前必须先定的前提）

| 未做 | 为什么现在不做 | 做之前需要 |
| --- | --- | --- |
| A2 评论洞察 / 问大家 | 需要离线 job + 3 张新表，方向文档排期在迭代 2 | 先有稳定的商品工具与评测集 |
| B1/B2 动作提案（L3） | 一旦「能写」，误操作成本远高于收益 | 先定动作白名单、二次确认与 `ai_action_logs` |
| C1 经营问数 | 需要**独立只读连接**，不能复用业务连接 | 建只读账号 + 白名单视图 + 语句校验 |
| C2 退款建议 | 涉及资金，误拒不可接受 | 先有历史退款标注集做一致性验证 |
| C4 推荐/库存预测 | 不依赖大模型，是独立的算法线 | 行为埋点积累足够样本 |
| C5 主动服务 | 需要事件驱动的触达通道与限频策略 | 先在消息中心打通「系统通知」 |
| 向量检索 | DeepSeek 无 embedding；语料规模还不需要 | 评测集证明「召回是瓶颈」 |

---

## 9. 怎么验证这一轮改动

```bash
# 1) 建表 + 种子
cd server
npm run db:migrate
npx sequelize-cli db:seed --seed 20261115000015-ai-domain-permissions.js
npx sequelize-cli db:seed --seed 20261115000016-ai-eval-cases.js
npx sequelize-cli db:seed --seed 20261115000018-ai-scenario-settings.js

# 2) 类型检查 + 启动
npm run typecheck
npm run dev

# 3) 评测（有 Key 走真实模型，--mock 走规则基线）
npm run ai:eval
npm run ai:eval -- --mock

# 4) 前端
cd ../web && npm run typecheck && npm run build && npm run build:admin
```

手动路径：

1. 用户端搜索「预算三百以内的台灯」→ 结果页出现「AI 理解为：台灯 / 家居生活 / ≤¥300」chips，点掉「家居生活」列表立即放宽；
2. 客服弹窗提问后对回答点 👍/👎 → 后台「AI 平台 → 概览」好评率变化；
3. 后台「留言工单 → AI 辅助」→ 弹出归类、命中规则、相似工单与回复草稿（草稿不自动发送）；
4. 后台「AI 平台 → 文案工坊」→ 生成 3 个版本，含违禁词的版本被拦下并提示；
5. 后台「AI 平台 → 场景开关」→ 看到每个场景的生效来源（`.env` / `settings`）与熔断状态。
