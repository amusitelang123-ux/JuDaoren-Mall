import dotenv from 'dotenv'

dotenv.config()

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    name: process.env.DB_NAME || 'xtx_mall',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'change_me_in_production',
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '2h',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
  },
  upload: {
    driver: process.env.UPLOAD_DRIVER || 'local',
    dir: process.env.UPLOAD_DIR || './uploads',
    baseUrl: process.env.UPLOAD_BASE_URL || 'http://localhost:3000/uploads',
  },
  adapter: {
    pay: process.env.PAY_ADAPTER || 'sandbox',
    paySecret: process.env.PAY_SECRET || 'xtx_sandbox_secret',
    sms: process.env.SMS_ADAPTER || 'console',
    logistics: process.env.LOGISTICS_ADAPTER || 'mock',
  },
  /**
   * AI 能力。密钥只从环境变量读取，不落库、不进日志。
   * DEEPSEEK_API_KEY 留空时自动降级为 mock 适配器，保证无网/无 Key 也能演示。
   *
   * 治理参数按 module 拆分（chat / admin / other）：后台 Copilot 与用户端抢额度的
   * 问题在平台层就解决，而不是等第二个场景上线时再回头改。
   */
  ai: {
    enabled: (process.env.AI_ENABLED ?? 'true') !== 'false',
    adapter: process.env.AI_ADAPTER || 'deepseek',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 25000),
    maxTokens: Number(process.env.AI_MAX_TOKENS || 900),
    temperature: Number(process.env.AI_TEMPERATURE || 0.3),
    /** 已废弃：保留仅用于向分模块预算回退（AI_BUDGET_* 优先） */
    dailyBudget: Number(process.env.AI_DAILY_BUDGET_CNY || 20),
    /** 分模块每日成本上限（元）：用户端 / 后台 / 其它 */
    budget: {
      chat: Number(process.env.AI_BUDGET_CHAT_CNY || process.env.AI_DAILY_BUDGET_CNY || 12),
      admin: Number(process.env.AI_BUDGET_ADMIN_CNY || 6),
      other: Number(process.env.AI_BUDGET_OTHER_CNY || 2),
    },
    /** 分模块每分钟提问上限（单用户 / 单管理员） */
    rateLimit: {
      chat: Number(process.env.AI_RATE_CHAT_PER_MIN || 12),
      admin: Number(process.env.AI_RATE_ADMIN_PER_MIN || 30),
      other: Number(process.env.AI_RATE_OTHER_PER_MIN || 60),
    },
    /** 部署级场景开关（settings 表可在运行期覆盖） */
    scenarios: (process.env.AI_SCENARIOS || 'customer_service,search_parse,marketing_copy,helpdesk_draft')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    /**
     * 搜索解析硬预算：超时即退回纯关键词检索。
     *
     * 改进方向文档建议 300ms；实测 deepseek-flash 生成这段 JSON 需要 1.2–2.5s，
     * 300ms 会让 AI 路径永远跑不到。这里默认 2500ms，并配合前端「先用原话出结果、
     * 解析回来再细化」的渐进策略——首屏不等这次调用，超时也只是少一层筛选。
     * 需要严格锁定搜索延迟时，用 AI_SEARCH_PARSE_TIMEOUT_MS 收紧到 300。
     */
    searchParseTimeoutMs: Number(process.env.AI_SEARCH_PARSE_TIMEOUT_MS || 2500),
    /** 结果缓存 TTL（毫秒）；设为 0 关闭 */
    cacheTtlMs: Number(process.env.AI_CACHE_TTL_MS || 600_000),
    /** 熔断：连续失败次数阈值与熔断窗口（毫秒） */
    breaker: {
      threshold: Number(process.env.AI_BREAKER_THRESHOLD || 5),
      cooldownMs: Number(process.env.AI_BREAKER_COOLDOWN_MS || 60_000),
    },
    /** 向量能力（默认关闭；关闭时全链路可用） */
    embeddingEnabled: (process.env.AI_EMBEDDING_ENABLED ?? 'false') === 'true',
    embeddingModel: process.env.AI_EMBEDDING_MODEL || '',
    /** 成本估算单价（元 / 百万 token），仅用于后台统计展示 */
    priceInPerM: Number(process.env.AI_PRICE_IN_PER_M || 2),
    priceOutPerM: Number(process.env.AI_PRICE_OUT_PER_M || 8),
    /** 送入模型的历史消息条数 */
    maxHistory: Number(process.env.AI_MAX_HISTORY || 8),
  },
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','),
}
