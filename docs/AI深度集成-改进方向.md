# 小兔鲜电商 · AI 深度集成改进方向

> **版本 v2**，基于当前代码库实测：54 张表、30 个 service，AI 相关代码只有 `ai*.ts` 这 5 个文件（含提示词与规则常量）加 `adapters/ai` 一组适配器。
>
> v1（`docs/AI功能方向建议.md`）写于 AI 客服落地之前，其「方向 1 · 智能客服」已完成。本文在原方向清单之上回答一个新问题：**为什么现在只有客服，以及"更深度"到底指什么。**
>
> **本轮实施说明见 [`docs/AI深度集成-实施说明.md`](./AI深度集成-实施说明.md)**：前提 P（平台层）、A1 查询理解、C3 文案、C5 坐席辅助与评测护栏已落地；A2 / B / C1 / C2 / C4 仍未做，实施说明里逐条写了原因与前置条件。

---

## 0. 结论先行

三句话：

1. **现状不是「AI 少」，而是「AI 孤岛」**。全库范围内对 AI 模块的引用**全部**发生在 `ai*.ts` 与 `adapters/ai/` 内部；`productService`、`orderService`、`commentService`、`cartService` 对 AI **零引用**。AI 是挂在商城旁边的一个子系统，没有渗进任何业务链路。

2. **「深度」有三条主线**：把「货」纳入 AI 的认知（广度）→ 从「会答」到「能做」（链路）→ 有评测、有预算、有兜底（可控）。缺任何一条，功能再多也只是薄。

3. **动手顺序必须是「先拆平台层，再铺场景」**。`aiChatService.ts` 已有 681 行，会话/限流/预算/工具/落库全耦合。直接在上面继续加业务，每加一个方向就要复制一份限流与审计代码；第一次重构的 5 人天，后面每个方向都要摊。

---

## 1. 现状诊断：AI 是一个闭环子系统

### 1.1 已经扎实的部分（不要推倒重来）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 厂商适配器分层 | `server/src/adapters/ai/{types,index,deepseek,mock}.ts` | 对齐 OpenAI 协议；Key 缺失自动降级 mock，答辩断网不炸 |
| 中文词法检索 | `aiKnowledgeService.ts` | 二元组 + BM25，语料百级时 < 5ms，不引入向量库的判断是对的 |
| 工具调用 | `aiChatService.ts` `executeTool()` | 两个工具均强制 `userId` 过滤，只能查本人订单 |
| SSE 事件协议 | `meta / thinking / delta / tool / done / error` | 前端 `AiChatPanel.vue` 已消费，可复用 |
| 调用审计 | `ai_call_logs`（token/cost/latency/status） | 表设计已预留 `module` 维度 |
| 成本熔断 | `assertBudget()` + `AI_DAILY_BUDGET_CNY` | 教学项目里少见的清醒设计 |
| 转人工 | `transferToHuman()` → `feedbacks` 工单 | 与现有客服流打通，而非另起一套 |

### 1.2 为什么还是"薄"——可核对的证据

| # | 证据 | 位置 | 后果 |
| --- | --- | --- | --- |
| 1 | AI 代码自闭环，业务层零调用 | 全库 grep：引用只出现在 `ai*.ts`、`adapters/ai` | AI 无法感知搜索、加购、下单、售后 |
| 2 | 审计维度只有一种 | 仅 2 处 `AiCallLog.create`，`module` 恒为 `'chat'` | 无法按场景看成本，多场景上线必然失控 |
| 3 | 知识库是封闭集合 | `syncKnowledgeBase()` 只吸收 `faqs` / `notices` / `logistics_companies` / `freight_templates` / `AI_POLICIES` | **AI 不懂"货"**：能答"怎么退货"，答不了"175 穿 L 还是 XL" |
| 4 | 无向量检索 | `aiKnowledgeService.ts` 注释：DeepSeek 无 embedding 接口；`MIN_SCORE = 1.6` 硬阈值 | 换个领域（商品、评论）召回立刻失效，阈值得重调 |
| 5 | 工具全部只读 | `executeTool()` 两条路径都是 `Order.findOne` | AI 只能"说"，不能"做" |
| 6 | 对话没有评价 | `AiChatPanel.vue` 只有「转人工」，无 👍/👎 | 无法判断答得对不对，也就没有评测集 |
| 7 | 开关需重启 | `config.ai.*` 全部来自 `process.env` | `settings` 表的 30s 缓存机制现成，却没用上 AI 开关 |
| 8 | 场景无治理 | 权限码只有 `ai:view` / `ai:manage` | 后台只有一张「客服用量」卡片 |

### 1.3 边界图

```
 用户端页面                     后端业务层                    AI 子系统
┌──────────────┐          ┌──────────────────┐      ┌─────────────────────┐
│ 搜索 / 详情   │          │ productService    │      │ aiChatService        │
│ 购物车/结算   │ ───────► │ cartService       │      │  ├ 限流 12/min        │
│ 订单 / 售后   │          │ orderService      │      │  ├ 预算 assertBudget  │
└──────┬───────┘          │ refundService     │      │  ├ 工具 get_order_*   │
       │                  │ commentService    │      │  └ 落库 / 审计        │
       │                  └──────────────────┘      │ aiKnowledgeService   │
       │                          ▲                 │  └ BM25 / 5 类知识源  │
       └── 仅「联系客服」弹窗 ─────┼────────────────►│ adapters/ai           │
                                  │                 └─────────────────────┘
                        业务代码对 AI 零调用（可 grep 验证）
```

---

## 2. 「深度」的定义：四级阶梯 + 三条主线

| 层级 | 定义 | 当前 | 本项目目标 |
| --- | --- | --- | --- |
| **L1 问答** | 只读，答完即止 | ✅ 客服已达标 | 保持并加评测 |
| **L2 建议** | 给结构化建议 + 理由，人来决定 | ❌ | **大面积铺开**（退款建议、补货建议、文案草稿、凑单建议） |
| **L3 动作** | AI 生成可执行动作，用户确认后系统执行 | ❌ | **试点 2 处**（购物车凑单、订单/售后动作） |
| **L4 编排** | 多步自主完成任务 | ❌ | **只在后台**（经营 Copilot，白名单只读 SQL） |

判断：本项目最有"深度"感、风险又可控的落点是 **L2 铺开 + L3 试点 + L4 后台受限**。全线冲 L4 在教学项目里既不必要，也守不住。

三条主线 + 一个前提：

- **主线 A｜认知广度**：AI 只知道规则，不知道商品、评论、行为 → 把「货」纳入上下文。
- **主线 B｜链路深度**：所有工具只读 → 输出"建议 + 可确认动作"，动作落回现有 REST 接口。
- **主线 C｜工程可信**：无评价、无评测、无分模块预算 → 度量与护栏先行。
- **前提 P｜平台化**：一个编排器 → 场景注册 + 工具注册 + 统一治理。

---

## 3. 前提 P：把客服编排抽成 AI 平台层（P0，约 5 人天）

### 3.1 目标结构

```
server/src/ai/                    ← 新增平台层（adapters/ai 继续只管厂商协议）
├── core/
│   ├── run.ts        runAiTask({ module, system, messages, tools, schema, userId, signal })
│   ├── guard.ts      限流（按 module 配额）/ 预算（按 module 分配）/ 超时 / 熔断
│   ├── audit.ts      writeCallLog()：ai_call_logs 统一入口
│   └── output.ts     zod 校验 → 失败重试 1 次 → 降级到规则
├── rag/
│   ├── sources/      faq.ts / notice.ts / logistics.ts / freight.ts / policy.ts / product.ts
│   ├── retriever.ts  BM25（搬现有实现）+ 可选向量 + RRF 融合
│   └── sync.ts       KnowledgeSource 注册表版 syncKnowledgeBase
├── tools/
│   ├── registry.ts   { name, description, parameters, schema, authz, execute }
│   ├── order.ts      搬入 get_order_detail / get_order_logistics
│   └── product.ts    新增 search_products / get_product_detail
└── scenarios/
    ├── customerService.ts   ← 原 aiChatService 主体
    ├── searchParse.ts
    └── commentInsight.ts
```

职责边界：`adapters/ai` 只管「跟厂商说话」，`ai/` 管「场景、工具、治理」。这条线划清之后，加模型的成本与加场景的成本才互不干扰。

### 3.2 迁移五步（每步可独立发版，`npm run typecheck` 兜底）

| 步骤 | 动作 | 现状代码 |
| --- | --- | --- |
| 1 | 抽审计与治理 | `checkRateLimit()` / `assertBudget()` / `estimateCost()` / 两处 `AiCallLog.create` → `core/guard.ts` + `core/audit.ts`，`module` 由参数传入而非硬编码 |
| 2 | 抽工具注册表 | `aiPrompt.ts` 的 `AI_TOOLS` + `aiChatService.ts` 的 `executeTool()` → `tools/registry.ts`；鉴权从"函数内写死 userId"改为注册项统一的 `authz(ctx)` |
| 3 | 抽 RAG | `searchKnowledge()` / `syncKnowledgeBase()` → `rag/`，改为 `KnowledgeSource[]` 注册；加商品源只新增一个文件 |
| 4 | 拆提示词 | `buildSystemPrompt()` 的通用规则保留，场景专属段落由 `scenarios/*` 自带 |
| 5 | 场景落地 | `aiChatService.chat()` → `scenarios/customerService.ts`，路由与接口契约**完全不动** |

### 3.3 平台层必须解决的 7 件事（缺一件后面都要还债）

1. **工具注册要带 zod 入参校验**。当前 `parseToolArguments()` 只做 `JSON.parse`，`{}` 也能通过——模型幻觉参数时直接落到 `executeTool`。
2. **限流与预算按 module 拆**。当前全局 12 次/分钟 + 单一 `AI_DAILY_BUDGET_CNY`；后台 Copilot 上线后会与用户端抢额度，必须拆成 `chat / search / admin / other` 四份。
3. **审计的 `module` 维度**。表已预留，代码没用起来；后台用量页要能按模块下钻。
4. **结构化输出统一收口**。`zod.safeParse` + 重试 1 次 + 降级到规则，绝不把裸文本写库。
5. **知识源注册表**。否则每加一类数据都要改 `syncKnowledgeBase` 的分组对象。
6. **结果缓存**。FAQ 类、搜索解析类问题重复率极高，按 `module + hash(messages)` 缓存 10 分钟即可显著降本。
7. **场景开关三级**：`.env`（部署级）→ `settings` 表（运行期热更，30s 缓存现成）→ 单用户灰度。当前只有第一级，改开关要重启。

---

## 4. 主线 A：把「货」纳入 AI 的认知

> 电商的 AI 如果不懂商品，就只是个包装得更好的 FAQ。这是当前最值得补的一块。

### A1 · 语义搜索与查询理解 ★性价比最高

- **现状**：`productService.listProducts()` 只对 `name` / `subtitle` 做 `LIKE %kw%`；schema 无 FULLTEXT 索引；`search/index.vue` 只有搜索历史与热门词，热门词来自前端 `app.hotKeywords`。
- **做法**
  1. **召回换底座**：MySQL 8 内置 `FULLTEXT(name, subtitle) WITH PARSER ngram`（中文可用、能走索引），把 `LIKE` 换成 `MATCH ... AGAINST`；语料千级时也可直接复用 `aiKnowledgeService.tokenize()` 在 Node 内算分。
  2. **查询理解**：`scenarios/searchParse.ts` 把「200 块以内的白色 T 恤」解析成 `{ keyword, categoryId, brandId, maxPrice, attrs[], sortBy }`，zod 校验。**300ms 预算，超时或校验失败直接退回纯关键词检索**——搜索是主链路，不能因为 AI 挂掉而不可用。
  3. **排序融合**：`0.5×文本相关 + 0.3×属性命中 + 0.2×销量/评分`，或用 RRF 融合词法/语义两路排名。
  4. **结果页可解释**：顶部渲染「AI 理解为：白色 T 恤 · ≤200 元 · 女装」的 chips，用户可点掉某一项修正。
- **新增**：`search_logs(keyword, parsed_json, result_count, clicked_product_id, user_id)`；`POST /api/client/v1/ai/search/parse`；`GET /api/client/v1/search/hot`（由 `search_logs` 聚合，取代前端硬编码）。
- **风险**：延迟；过度解析导致零结果；**价格、库存、上下架过滤绝不能交给模型**，模型只负责"把话翻译成参数"。
- **验收**：50 条测试 query，解析准确率 ≥ 85%，零结果率 ≤ 5%，P99 ≤ 400ms；关掉 AI 后搜索功能无任何退化。

### A2 · 商品问答与评论洞察 ★把客服变成导购

- **现状**：`product/detail.vue` 的评价 Tab 只有列表与好评率；`product_comments` 有 `score` / `content` / `images` / `replyContent`，后台 `comment/list.vue` 只能按内容 `LIKE` 搜。
- **做法**
  1. **离线打标**：新增 `jobs/analyzeComments.ts`（沿用现有 `setInterval` + `unref()` 模式，在 `server.ts` 注册），增量分析新评论 → `{ sentiment, topics[], summary, adOrAbuse }` → 写 `ai_comment_insights`，**不污染 `product_comments` 主表**，便于重跑与回滚。
  2. **商品级聚合**：job 汇总出「好评点 Top3 / 差评点 Top3」写入 `product_insights`；`GET /products/:id/insights` 直读预计算结果，详情页首屏**不调模型**。
  3. **「问大家」**：`POST /products/:id/ask` → 先查 `product_qa` 相似问（复用 BM25 分词），命中直接返回；未命中才调模型，上下文 = 商品属性 + 评论摘要 + 政策知识库，答案落库供后人复用。
  4. **后台一键回复草稿**：生成后填进输入框，人工确认才写 `replyContent`。
- **新增**：`ai_comment_insights`、`product_insights`、`product_qa`；`GET /products/:id/insights`、`POST /products/:id/ask`；后台详情页「大家怎么说」卡片；权限码 `ai:comment`。
- **风险**：摘要失真、差评情绪外露、恶意刷评。措辞统一中性；先过 `status=1` 审核再分析；上下文只给结构化属性，防止模型编造参数。
- **验收**：抽检 50 条摘要准确率 ≥ 85%；「问大家」答案引用率；详情页 LCP 不劣化。

### A3 · 知识边界与 embedding 的取舍（一个必须先定的决策）

- **商品不要进 `ai_kb_chunks` 全量同步**。几千 SKU + `detail_html` 会撑爆 `ensureIndex()` 的内存索引（当前实现是全量载入 + 60s 重建）。商品检索走 **SQL + 按需取摘要进 prompt**，只把「商品卖点/参数」这类稳定短文本做知识化。
- **DeepSeek 没有 embedding 接口**，这是既定约束。若引入第三方向量模型（bge-m3 等），必须满足：`AI_EMBEDDING_ENABLED=false` 时全链路可用；embedding 存 JSON、Node 内算余弦（语料 < 5k 完全够用）。
- **第一版不要上向量数据库**。词法为主、向量可选，是当前语料规模下最稳的工程判断。等评测集证明"召回确实是瓶颈"再换，否则就是给答辩加一个自己讲不清的组件。

---

## 5. 主线 B：从「会答」到「能做」（L3 试点）

核心设计原则：**AI 不直连写库，只产出"动作提案"，由前端二次确认后调现有 REST 接口**。这样事务、幂等、审计、权限全部复用现有实现，AI 退化成"填表员"——这是风险最低的深度集成方式。

### B1 · 购物车与结算助手

- **现状**：`cart/index.vue`、`order/confirm.vue` 纯表单；`couponApi.preview()` 已能算出最优券。
- **做法**：`POST /api/client/v1/ai/cart/advice`，**服务端重新查库**拿购物车快照（不信前端传的金额）→ 输出建议文案 + `actions[]`，如 `[{ type: 'add_to_cart', productId, skuId, quantity }, { type: 'receive_coupon', couponId }]`。前端渲染「采纳」按钮，点击走现有 `cartApi.add` / `couponApi.receive`。
- **典型问法**：「帮我把这单凑到包邮还差多少」「有更划算的券吗」「这三件能一起用满减吗」。
- **风险**：金额必须用 `couponService` 重算，模型只做解释；`actions` 必须白名单 + 后端二次校验。
- **验收**：建议采纳率；action 合法性 100%（后端再校验一次，失败即丢弃）。

### B2 · 订单与售后动作

- **现状**：`orderService` 已有 `remindShip` / `cancel` / `confirm`；`refundService.apply` 已有完整校验。
- **做法**：把工具从只读扩到「提案型」——`propose_action({ type, params })` 只返回结构化提案，前端渲染确认卡片，用户点确认才调接口。适合的场景：催发货、取消订单、发起退款、修改地址。
- **风险**：诱导误操作。不可逆动作（取消订单、退款）必须展示参数与后果并二次确认；每次提案与确认都写 `ai_action_logs`。
- **验收**：动作落地成功率、误操作率 0、每条动作可追溯到会话。

---

## 6. 主线 C：后台 Copilot 与算法线

### C1 · 经营日报与受控问数 ★B 端演示效果最强

- **现状**：`statsService` 已有 7 个统计查询（趋势、商品排行、分类销售、用户分析、订单状态分布、营销效果…）+ CSV 导出，`stat_daily` 已预聚合，`dashboard/index.vue` 用 echarts 渲染 3 张图 + 指标卡——运营要看数得自己逐个点、自己下结论。
- **做法**
  1. **自动日报**：每日 job 汇总 GMV / 订单 / 退款 / 新客 / TOP 商品（复用 `statDailyService`）→ 模型生成「昨日简报 + 3 条可执行建议」→ `ai_reports` → 后台首屏卡片。
  2. **自然语言问数**：**独立只读连接**（`DB_AI_*`，不复用业务连接）+ 白名单视图 + 仅允许 `SELECT` + 强制 `LIMIT 200` + 5s 超时 + SQL 形状校验，结果再交模型解释。
  3. 答不了就明确回「无法从现有数据回答」，不许硬编。
- **新增**：`ai_reports`、`v_order_daily` / `v_product_sales` 视图；`GET /admin/ai/daily-report`、`POST /admin/ai/ask`；权限码 `ai:copilot`。
- **风险**：SQL 注入、越权、慢查询。三道闸：独立只读账号、语句白名单、超时熔断。
- **验收**：30 条问题集正确率；执行日志中写操作次数为 0。

### C2 · 退款审核建议与异常订单识别

- **现状**：`order_refunds` 有 `reason` / `images` / `audit_remark`，状态 `0 待审核` 完全靠人工；`orders.is_abnormal` 只有后台手工触发的 `markAbnormal()`，**没有自动识别**。
- **做法**
  1. **退款建议**：输入该用户历史退款次数/间隔、订单金额、退款理由、凭证图数量 → 输出 `{ suggestion: approve | reject | manual, reasons[], riskScore }`，写 `ai_refund_advices`，后台详情页旁挂「AI 建议」，人工按钮不变。
  2. **异常订单**：规则引擎（同 IP 多账号、短时高频下单、地址与手机号不一致、大额新客，数据源 `user_login_logs` / `orders`）+ 模型打分 → 自动置 `is_abnormal` 并写 `abnormal_reason`，直接复用现有 `onlyAbnormal` 筛选与告警流。
- **风险**：**绝不可自动拒绝退款**；模型只给建议；必须留痕 + 保留申诉入口。
- **验收**：与人工结论一致率；误拒 0；异常订单召回率与人工抽检对比。

### C3 · 营销文案生成（最快见效）

- **现状**：`adminMarketingService` 有 20 余个管理函数（券、横幅、公告、秒杀、满减），文案段全靠手填；商品标题/卖点则在 `adminProductService` 里同样手填。
- **做法**：商品/券/公告/秒杀四类模板，一次给 3 个版本，结构化输出**直接回填表单、不自动保存**；广告法违禁词表（最、第一、国家级、100%）前置过滤。
- **风险**：编造参数与资质。产物打「AI 生成」标记，必须人工确认。
- **验收**：运营采纳率；违禁词拦截率 100%。

### C4 · 推荐与库存预测（不烧 token 的算法线）

这两块**不依赖大模型**，是独立的算法亮点，建议与 LLM 线并行推进：

- **个性化推荐**：行为加权（浏览 1 / 收藏 3 / 加购 4 / 支付 5，时间衰减）→ item-CF + 内容相似 → 离线 job 写 `recommend_cache(user_id, product_id, score, reason, scene)`，接口只读缓存，`reason` 字段让推荐可解释。评估用近 7 天订单做 hold-out，比 hit-rate@10 与「按销量」基线——这个对比实验本身就是很好的答辩材料。当前 `getRecommendProducts()` 只按 `salesCount` 排。
- **库存预测**：日销量序列 → 指数平滑 / Holt-Winters → 安全库存 = z×σ×√(补货周期)，补货点 = 预测需求 + 安全库存 − 在途 → `inventory_forecasts`。库存页把静态 `warn_stock` 升级为「预计断货日」「建议补货量」。当前 `inventoryService.listStockAlerts()` 只有阈值判断。
- **风险**：秒杀/大促 uplift 会让预测失真，需把 `seckill_products` 计划量作为特征。

### C5 · 深化现有客服：坐席辅助与主动服务 ★成本最低的"深度"

这两个不是新场景，而是把已经在跑的客服 AI 往业务纵深推——不新增表结构，收益却很直接。

- **坐席辅助（AI 帮人工客服）**：后台 `feedback/list.vue` 处理工单时，AI 自动做三件事：① 归类与优先级（咨询/投诉/建议 + 紧急度）；② 检索相似历史工单与命中的知识条款；③ 生成回复草稿，人工确认后才写 `reply_content`。复用 `rag/` 与 `runAiTask`，只需给 `feedbacks` 加 `ai_category` / `ai_summary` 两个字段。
- **主动服务（AI 进入流程而非入口）**：订单超时未发货、退款超时未审核、物流 48 小时无更新时，由现有 job 机制触发 AI 生成「解释 + 下一步」，经消息中心或客服弹窗主动触达。这是 AI 第一次由**业务事件**驱动，而不是由用户点开弹窗驱动——机制上是明显更深的一层。
  - **风险**：打扰。必须限频、可关闭，且模板兜底（模型不可用时退回固定话术），否则一次误推送比不推送更糟。
- **验收**：人工首次回复耗时下降；主动触达的差评挽回率；关闭开关后流程无影响。

---

## 7. 数据层：新增表与索引

| 表 | 用途 | 关键字段 | 归属 |
| --- | --- | --- | --- |
| `search_logs` | 搜索词与效果埋点 | `keyword` `parsed_json` `result_count` `clicked_product_id` `user_id` | A1 |
| `ai_comment_insights` | 评论打标结果 | `comment_id` `sentiment` `topics` `summary` `model_version` | A2 |
| `product_insights` | 商品级好评/差评聚合 | `product_id` `good_points` `bad_points` `version` | A2 |
| `product_qa` | 商品问答沉淀 | `product_id` `question` `answer` `source_comment_ids` | A2 |
| `ai_action_logs` | L3 动作提案与确认留痕 | `conversation_id` `action_type` `payload` `confirmed` | B |
| `ai_feedback` | 回答 👍/👎 与纠错 | `message_id` `rating` `reason` `corrected_answer` | C 主线 |
| `ai_reports` | 自动日报 | `report_date` `content` `metrics_json` | C1 |
| `ai_refund_advices` | 退款审核建议 | `refund_id` `suggestion` `reasons` `risk_score` | C2 |
| `recommend_cache` | 离线推荐结果 | `user_id` `product_id` `score` `reason` `scene` | C4 |
| `inventory_forecasts` | 补货预测 | `sku_id` `forecast_date` `predicted_qty` `safety_stock` `reorder_point` | C4 |
| `ai_eval_cases` | 评测集 | `module` `input` `expect_json` `tags` | 主线 C |

字段级改动（不新建表）：

- `ai_kb_chunks` 增加 `embedding JSON NULL`（可选，默认不填）、`source_type` 枚举扩展 `product`。
- `ai_call_logs` 已有 `module`，建议补 `scenario`、`cache_hit`、`fallback_reason`，让"兜底率"可观测。
- `products` 增加 `FULLTEXT(name, subtitle) WITH PARSER ngram` 索引；`product_attributes` 若要做属性级检索，补 `(name, value)` 联合索引。
- `feedbacks` 增加 `ai_category` / `ai_summary`（坐席辅助），保持主表结构不变，AI 不可用时该两列为空即可。

---

## 8. 接口、权限与配置

### 8.1 接口（沿用现有前缀与统一响应体）

| 接口 | 说明 | 主线 |
| --- | --- | --- |
| `POST /api/client/v1/ai/search/parse` | 查询理解（调试与前端 chips 共用） | A1 |
| `GET /api/client/v1/search/hot` | 热门搜索（由 `search_logs` 聚合） | A1 |
| `GET /api/client/v1/products/:id/insights` | 好评点/差评点摘要 | A2 |
| `POST /api/client/v1/products/:id/ask` | 问大家 | A2 |
| `POST /api/client/v1/ai/cart/advice` | 凑单/用券建议 + actions | B1 |
| `POST /api/client/v1/ai/action/:type` | 动作提案（不执行） | B2 |
| `GET /api/admin/ai/daily-report` | 昨日经营简报 | C1 |
| `POST /api/admin/ai/ask` | 受控自然语言问数 | C1 |
| `POST /api/admin/ai/refund-advice/:id` | 退款审核建议 | C2 |
| `POST /api/admin/ai/copywriting` | 文案生成 | C3 |
| `POST /api/admin/ai/feedback/:id/draft` | 坐席辅助：归类 + 相似工单 + 回复草稿 | C5 |
| `GET /api/admin/ai/usage?module=` | 分模块用量（扩展现有接口） | C |

### 8.2 权限码

现有 `ai:view` / `ai:manage` 保留，新增按域拆分：`ai:search`、`ai:comment`、`ai:copilot`、`ai:refund`、`ai:marketing`。所有 AI 后台写操作统一走 `writeAdminLog()` 留痕（`adminService.ts` 已有该工具）。

### 8.3 配置

```env
# 场景开关（与 settings 表配合可热更）
AI_SCENARIOS=customer_service,search

# 分模块限额：当前 AI_DAILY_BUDGET_CNY 是全局单一额度，
# 后台 Copilot 上线后会与用户端抢额度，必须拆
AI_BUDGET_CHAT_CNY=12
AI_BUDGET_ADMIN_CNY=6
AI_BUDGET_OTHER_CNY=2
AI_RATE_CHAT_PER_MIN=12
AI_RATE_OTHER_PER_MIN=60

# 搜索解析预算：超时即退回关键词检索
AI_SEARCH_PARSE_TIMEOUT_MS=300

# 向量能力（默认关闭，关闭时全链路可用）
AI_EMBEDDING_ENABLED=false
AI_EMBEDDING_MODEL=

# 经营问数：独立只读连接，不复用业务连接
AI_READONLY_DB_URL=mysql://readonly:***@127.0.0.1:3306/xtx_mall
```

---

## 9. 评测与护栏：怎样证明「深度」真的有效

功能数量说服不了人，评测集可以。

### 9.1 评测集

`ai_eval_cases(module, input, expect_json, tags)` + 脚本 `npm run ai:eval`，输出：准确率、引用命中率、拒答率、兜底率、平均/P95 延迟、单次成本。基线永远是「规则版」或「上一版 prompt」，没有对比就没有改进。

### 9.2 护栏清单（逐条对应现有代码）

| 护栏 | 现状 | 待补 |
| --- | --- | --- |
| 金额不经模型 | ✅ 客服未涉及 | 搜索/凑单必须服务端重算 |
| 库存不扣减 | ✅ | 保持 |
| 订单状态机不碰 | ✅ | L3 动作只提案不执行 |
| 工具鉴权 | ✅ 函数内写死 `userId` | 迁到注册表统一 `authz(ctx)` |
| 提示词注入防护 | ⚠️ 仅 prompt 规则（第 6 条） | 缺输出侧校验与越权检测 |
| PII 脱敏 | ✅ `maskPhone()` | 评论/问答场景补地址脱敏 |
| 成本封顶 | ⚠️ 全局单一额度 | 按 module 拆分 |
| 超时降级 | ⚠️ 有 `timeoutMs`，无降级路径 | 搜索解析必须有 300ms 降级 |
| 离线可演示 | ✅ `AI_ADAPTER=mock` | mock 需按 scenario 注册，不能继续写死客服话术 |
| 回答反馈 | ❌ | 👍/👎 + 纠错，喂回评测集 |

**关键单一指标：兜底率**（转人工率 + 拒答率）。客服 AI 的兜底率一旦下降而准确率不变，说明知识边界扩对了。

---

## 10. 路线图

| 迭代 | 内容 | 产出 | 建议周期 |
| --- | --- | --- | --- |
| **0** | 平台层抽取 + 👍/👎 + 分模块审计 + 评测集骨架 | 不动业务，纯重构 | 1 周 |
| **1** | A1 语义搜索 + C3 文案生成 + C5 坐席辅助 | 低风险、见效快，顺带验证平台层好不好用 | 1–2 周 |
| **2** | A2 商品问答/评论洞察（含 3 张新表 + job）+ C5 主动服务 | AI 开始"懂货"，并进入业务流程 | 2 周 |
| **3** | C1 日报/问数 + C2 退款建议 | B 端，靠"只读 + 只建议"控风险 | 2 周 |
| **4** | B1/B2 动作试点 + C4 推荐/预测 | 链路闭环与算法亮点并行 | 2–3 周 |

顺序理由：0 让后面每一步都少写一份重复代码；1 用最低风险场景验证平台层与坐席辅助；2 补上最大的认知缺口并让 AI 由事件驱动；3 拉高演示效果；4 做深但放在可控之后。

---

## 11. 本项目特有的反模式

1. **不要继续在 `aiChatService.ts` 里加 if/else**。681 行已经到耦合上限，先拆再长。
2. **不要把商品全量同步进 `ai_kb_chunks`**。`ensureIndex()` 是全量内存索引 + 60s 重建，几千 SKU 会直接卡死。
3. **不要让 embedding 成为硬依赖**。DeepSeek 无 embedding 接口，离线答辩必须能跑；向量只能是可选增强。
4. **不要让 mock 继续写死客服话术**。`mock.ts` 里 `composeAnswer()` 全是客服正则，第二个场景就得大改——改成按 scenario 注册 canned response。
5. **不要复用业务数据库连接跑问数 SQL**。独立只读账号是最低成本的隔离。
6. **不要在前端渲染模型返回的 HTML**。`products.detail_html` 已存在，别顺手让模型输出富文本。
7. **不要给 AI 开写接口而不留 `ai_action_logs`**。没有留痕的"自动执行"在教学项目里是减分项。
8. **不要用"接了几个模型"当成果**。这个项目真正的亮点是：AI 只做辅助、失败可降级、调用可审计、效果可评测。

---

## 12. 一页纸

- **客服已经是 L1 的及格线以上**，问题不在它，而在它是孤岛。
- **补四件事**：让 AI 懂"货"（搜索 + 商品问答 + 评论洞察）；让 AI 能"做"（动作提案 + 人工确认 + 复用现有接口）；让 AI 进"流程"（坐席辅助 + 由业务事件主动触达）；让 AI 可"量"（分模块预算 + 评测集 + 兜底率）。
- **先做一件事**：抽平台层。它不产生任何新页面，但决定后面每个方向的成本曲线。
- **按顺序**：平台层 → 搜索/文案/坐席辅助 → 商品问答/主动服务 → 后台 Copilot → 动作与算法线。
- **判断标准**：不是"多接了几个模型"，而是「AI 关掉时业务是否照常、AI 出错时用户是否可兜底、AI 贵了是否可以按模块掐掉」。
