<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi } from '@admin/api'
import type {
  AdminAiBadFeedback,
  AdminAiConversation,
  AdminAiEvalSummary,
  AdminAiMessage,
  AdminAiUsage,
  AdminCopyResult,
  AdminCopyScene,
  AdminCopyVariant,
} from '@admin/api'
import { useAdminStore } from '@admin/stores/admin'

/**
 * AI 平台页：从「一张客服用量卡片」升级为「分模块用量 + 质量指标 + 场景开关 + 文案工坊 + 评测」。
 * 对应改进方向 §8.1/§8.2 与 §9.1：AI 的成本、效果与开关都要能在后台看到并掐得掉。
 */

const admin = useAdminStore()

const loading = ref(false)
const rebuilding = ref(false)
const usage = ref<AdminAiUsage | null>(null)
const runtime = ref<{ scenarios: { scenario: string; module: string; enabled: boolean; envEnabled: boolean; settingEnabled: boolean | null; grayUserIds: number[] }[]; breakers: Record<string, { failures: number; open: boolean }>; cache: { entries: number } } | null>(null)

const ACTIVE_TAB = ref('overview')

/* ------------------------------ 会话列表 ------------------------------ */
const list = ref<AdminAiConversation[]>([])
const total = ref(0)
const query = reactive({
  keyword: '',
  status: undefined as number | undefined,
  page: 1,
  pageSize: 10,
})

const STATUS_TEXT: Record<number, string> = { 1: '进行中', 2: '已转人工', 3: '已关闭' }
const ROLE_TEXT: Record<string, string> = { user: '用户', assistant: 'AI 客服', tool: '工具' }

const drawer = reactive({
  visible: false,
  title: '',
  loading: false,
  messages: [] as AdminAiMessage[],
})

/* ------------------------------ 文案工坊 ------------------------------ */
const copyScenes: { value: AdminCopyScene; label: string }[] = [
  { value: 'product', label: '商品标题/卖点' },
  { value: 'coupon', label: '优惠券文案' },
  { value: 'notice', label: '店铺公告' },
  { value: 'seckill', label: '秒杀文案' },
]
const copyForm = reactive({ scene: 'product' as AdminCopyScene, brief: '', tone: '' })
const copying = ref(false)
const copyResult = ref<AdminCopyResult | null>(null)

/* ------------------------------- 评测 ------------------------------- */
const evaluating = ref(false)
const evalSummaries = ref<AdminAiEvalSummary[]>([])
const badFeedback = ref<AdminAiBadFeedback[]>([])

function statusType(status: number) {
  if (status === 2) return 'success'
  if (status === 3) return 'info'
  return 'warning'
}

function money(value: number | undefined): string {
  return `¥${Number(value ?? 0).toFixed(4)}`
}

const budgetRows = computed(() =>
  (usage.value?.budgets ?? []).map((item) => ({
    ...item,
    label: item.module === 'chat' ? '用户端' : item.module === 'admin' ? '后台' : '离线任务',
    percent: item.limit > 0 ? Math.min(100, Math.round((item.spent / item.limit) * 100)) : 0,
  })),
)

const scenarioRows = computed(() =>
  (runtime.value?.scenarios ?? []).map((item) => ({
    ...item,
    source: item.settingEnabled === null ? '.env' : 'settings',
    gray: item.grayUserIds.length ? item.grayUserIds.join(',') : '—',
  })),
)

async function loadUsage() {
  try {
    usage.value = await adminApi.aiApi.usage()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '用量加载失败')
  }
}

async function loadRuntime() {
  try {
    runtime.value = await adminApi.aiApi.runtime()
  } catch {
    runtime.value = null
  }
}

async function loadList() {
  loading.value = true
  try {
    const res = await adminApi.aiApi.conversations({ ...query })
    list.value = res.list
    total.value = res.total
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '会话加载失败')
  } finally {
    loading.value = false
  }
}

async function refresh() {
  await Promise.all([loadUsage(), loadRuntime(), loadList()])
}

function search() {
  query.page = 1
  void loadList()
}

function reset() {
  query.keyword = ''
  query.status = undefined
  search()
}

async function openConversation(row: AdminAiConversation) {
  drawer.visible = true
  drawer.title = `会话 #${row.id} · ${row.nickname}`
  drawer.loading = true
  drawer.messages = []
  try {
    drawer.messages = await adminApi.aiApi.messages(row.id)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '消息加载失败')
  } finally {
    drawer.loading = false
  }
}

async function rebuild() {
  try {
    await ElMessageBox.confirm(
      '将重新采集 FAQ、公告、物流公司、运费模板与平台规则，覆盖现有知识切片。确定执行？',
      '重建知识库',
      { type: 'warning' },
    )
  } catch {
    return
  }
  rebuilding.value = true
  try {
    const result = await adminApi.aiApi.rebuild()
    ElMessage.success(`知识库已重建：共 ${result.total} 条切片`)
    await loadUsage()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '重建失败')
  } finally {
    rebuilding.value = false
  }
}

async function generateCopy() {
  if (!copyForm.brief.trim()) {
    ElMessage.warning('请先填写运营要点，例如「产品名 + 核心卖点 + 价格」')
    return
  }
  copying.value = true
  try {
    copyResult.value = await adminApi.aiApi.copywriting({
      scene: copyForm.scene,
      brief: copyForm.brief.trim(),
      tone: copyForm.tone.trim() || undefined,
    })
    if (copyResult.value.filtered > 0) {
      ElMessage.warning(
        `${copyResult.value.filtered} 条文案命中违禁词（${copyResult.value.bannedWords.join('、')}）已被拦截`,
      )
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '生成失败')
  } finally {
    copying.value = false
  }
}

async function copyToClipboard(variant: AdminCopyVariant) {
  const text = [variant.title, variant.subtitle, variant.body].filter(Boolean).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制，请人工确认后再保存')
  } catch {
    ElMessage.warning('复制失败，请手动选择文本')
  }
}

async function runEval() {
  evaluating.value = true
  try {
    const res = await adminApi.aiApi.evaluate()
    evalSummaries.value = res.summaries
    if (!res.total) ElMessage.warning('评测集为空，请先导入 ai_eval_cases')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '评测失败')
  } finally {
    evaluating.value = false
  }
}

async function loadBadFeedback() {
  try {
    badFeedback.value = await adminApi.aiApi.badFeedback(10)
  } catch {
    badFeedback.value = []
  }
}

onMounted(() => {
  void refresh()
  void loadBadFeedback()
})
</script>

<template>
  <div class="ai-page">
    <el-card shadow="never" class="head">
      <div class="head__main">
        <div>
          <h2>AI 平台</h2>
          <p class="muted">
            客服 / 搜索理解 / 文案 / 坐席辅助共用一套治理：按模块限流与预算、按场景开关、调用可审计、效果可评测。
          </p>
        </div>
        <div class="head__actions">
          <el-tag :type="usage?.mode === 'deepseek' ? 'success' : 'warning'" effect="light">
            {{
              usage?.mode === 'deepseek'
                ? `DeepSeek · ${usage.model}`
                : usage?.usingFallback
                  ? '演示模式（未配置 Key）'
                  : '演示模式（mock）'
            }}
          </el-tag>
          <el-button
            v-if="admin.hasPerm('ai:manage')"
            :loading="rebuilding"
            type="primary"
            plain
            @click="rebuild"
          >
            重建知识库
          </el-button>
          <el-button :loading="loading" @click="refresh">刷新</el-button>
        </div>
      </div>
    </el-card>

    <el-tabs v-model="ACTIVE_TAB" class="tabs">
      <!-- ------------------------------ 概览 ------------------------------ -->
      <el-tab-pane label="概览" name="overview">
        <div class="stats">
          <div class="stat">
            <span class="stat__label">今日调用</span>
            <b class="stat__value">{{ usage?.today.calls ?? 0 }}</b>
            <span class="stat__hint">近 7 天 {{ usage?.week.calls ?? 0 }} 次</span>
          </div>
          <div class="stat">
            <span class="stat__label">今日成本</span>
            <b class="stat__value">{{ money(usage?.today.cost) }}</b>
            <span class="stat__hint">按配置单价估算</span>
          </div>
          <div class="stat">
            <span class="stat__label">兜底率</span>
            <b class="stat__value">{{ usage?.quality.fallbackRate ?? 0 }}%</b>
            <span class="stat__hint">降级 {{ usage?.quality.fallbackCalls ?? 0 }} 次</span>
          </div>
          <div class="stat">
            <span class="stat__label">转人工率</span>
            <b class="stat__value">{{ usage?.quality.transferRate ?? 0 }}%</b>
            <span class="stat__hint">已转人工 {{ usage?.totals.transferred ?? 0 }} 个会话</span>
          </div>
          <div class="stat">
            <span class="stat__label">回答好评率</span>
            <b class="stat__value">{{ usage?.quality.upRate ?? 0 }}%</b>
            <span class="stat__hint">
              👍 {{ usage?.quality.up ?? 0 }} / 👎 {{ usage?.quality.down ?? 0 }}
            </span>
          </div>
        </div>

        <el-card shadow="never">
          <div class="card-head">
            <b>分模块预算（今日）</b>
            <span class="muted">后台与用户端不再共享一个额度，用超了只掐对应模块</span>
          </div>
          <div class="budget">
            <div v-for="row in budgetRows" :key="row.module" class="budget__item">
              <div class="budget__head">
                <span>{{ row.label }}</span>
                <span class="muted">¥{{ row.spent.toFixed(4) }} / ¥{{ row.limit }}</span>
              </div>
              <el-progress
                :percentage="row.percent"
                :status="row.percent >= 100 ? 'exception' : row.percent > 80 ? 'warning' : undefined"
                :show-text="false"
              />
            </div>
          </div>
        </el-card>

        <el-card shadow="never">
          <div class="card-head">
            <b>场景开关</b>
            <span class="muted">
              三级开关：.env → settings 表（30s 热更）→ 指定用户灰度。知识库索引：
              {{ usage?.knowledgeIndexedAt ? usage.knowledgeIndexedAt.replace('T', ' ').slice(0, 19) : '尚未建立' }}
            </span>
          </div>
          <el-table :data="scenarioRows" size="small">
            <el-table-column prop="scenario" label="场景" width="180" />
            <el-table-column prop="module" label="模块" width="100" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
                  {{ row.enabled ? '已开启' : '已关闭' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="source" label="生效来源" width="110" />
            <el-table-column prop="gray" label="灰度用户" min-width="120" />
            <el-table-column label="熔断" width="120">
              <template #default="{ row }">
                <span class="muted">
                  {{ runtime?.breakers[row.module]?.open ? '已熔断' : '正常' }}
                </span>
              </template>
            </el-table-column>
          </el-table>
          <p class="muted tip">
            缓存条目 {{ runtime?.cache.entries ?? 0 }} 个；修改开关可在「系统配置」里写 settings：
            <code>ai.scenario.search_parse.enabled = 1</code>。
          </p>
        </el-card>
      </el-tab-pane>

      <!-- ------------------------------ 用量 ------------------------------ -->
      <el-tab-pane label="分模块用量" name="usage">
        <el-card shadow="never">
          <div class="card-head">
            <b>近 7 天按模块 / 场景下钻</b>
            <span class="muted">缓存命中不计费；兜底次数包含超时与结构化校验失败</span>
          </div>
          <el-table :data="usage?.byModule ?? []" size="small">
            <el-table-column prop="moduleLabel" label="模块" width="100" />
            <el-table-column prop="scenario" label="场景" width="170" />
            <el-table-column prop="calls" label="调用" width="90" />
            <el-table-column label="Token" width="110">
              <template #default="{ row }">{{ Number(row.tokens).toLocaleString() }}</template>
            </el-table-column>
            <el-table-column label="成本" width="110">
              <template #default="{ row }">{{ money(row.cost) }}</template>
            </el-table-column>
            <el-table-column prop="avgLatency" label="平均延迟" width="110">
              <template #default="{ row }">{{ row.avgLatency }} ms</template>
            </el-table-column>
            <el-table-column prop="failures" label="失败" width="80" />
            <el-table-column prop="fallbacks" label="兜底" width="80" />
            <el-table-column prop="cacheHits" label="缓存命中" width="100" />
          </el-table>
        </el-card>

        <el-card shadow="never">
          <div class="card-head">
            <b>近 7 天调用趋势</b>
          </div>
          <el-table :data="usage?.daily ?? []" size="small">
            <el-table-column prop="date" label="日期" width="130" />
            <el-table-column prop="calls" label="调用次数" width="110" />
            <el-table-column label="Token">
              <template #default="{ row }">{{ Number(row.tokens).toLocaleString() }}</template>
            </el-table-column>
            <el-table-column label="成本">
              <template #default="{ row }">{{ money(row.cost) }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ------------------------------ 会话 ------------------------------ -->
      <el-tab-pane label="客服会话" name="chat">
        <el-card shadow="never">
          <el-form :inline="true" @submit.prevent="search">
            <el-form-item label="关键词">
              <el-input
                v-model="query.keyword"
                placeholder="标题 / 最后消息 / 订单号"
                clearable
                style="width: 220px"
              />
            </el-form-item>
            <el-form-item label="状态">
              <el-select v-model="query.status" placeholder="全部" clearable style="width: 130px">
                <el-option
                  v-for="(label, value) in STATUS_TEXT"
                  :key="value"
                  :label="label"
                  :value="Number(value)"
                />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="search">查询</el-button>
              <el-button @click="reset">重置</el-button>
            </el-form-item>
          </el-form>

          <el-table v-loading="loading" :data="list" stripe>
            <el-table-column label="ID" prop="id" width="70" />
            <el-table-column label="用户" width="140">
              <template #default="{ row }">
                <div class="user-cell">
                  <span>{{ row.nickname }}</span>
                  <span v-if="row.phone" class="muted">{{ row.phone }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="订单号" width="170" show-overflow-tooltip>
              <template #default="{ row }">{{ row.orderNo || '—' }}</template>
            </el-table-column>
            <el-table-column label="最后消息" min-width="240" show-overflow-tooltip>
              <template #default="{ row }">{{ row.lastMessage || row.title || '—' }}</template>
            </el-table-column>
            <el-table-column label="消息数" prop="messageCount" width="90" />
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag :type="statusType(row.status)" size="small">
                  {{ STATUS_TEXT[row.status] ?? row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="最近活跃" width="170">
              <template #default="{ row }">{{ row.lastMessageAt || row.createdAt }}</template>
            </el-table-column>
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openConversation(row)">查看</el-button>
              </template>
            </el-table-column>
          </el-table>

          <div class="pager">
            <el-pagination
              background
              layout="total, prev, pager, next"
              :total="total"
              :current-page="query.page"
              :page-size="query.pageSize"
              @current-change="(p: number) => { query.page = p; loadList() }"
            />
          </div>
        </el-card>
      </el-tab-pane>

      <!-- ---------------------------- 文案工坊 ---------------------------- -->
      <el-tab-pane label="文案工坊" name="copy">
        <el-card shadow="never">
          <div class="card-head">
            <b>营销文案生成</b>
            <span class="muted">一次 3 个版本，广告法违禁词整条拦截；产物需人工确认后自行保存</span>
          </div>
          <el-form label-width="90px" class="copy-form">
            <el-form-item label="文案类型">
              <el-select v-model="copyForm.scene" style="width: 200px">
                <el-option v-for="s in copyScenes" :key="s.value" :label="s.label" :value="s.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="运营要点">
              <el-input
                v-model="copyForm.brief"
                type="textarea"
                :rows="3"
                maxlength="300"
                show-word-limit
                placeholder="例如：云栖家居 纯棉加厚保暖被，适合秋冬，269 元，支持 7 天无理由"
              />
            </el-form-item>
            <el-form-item label="语气偏好">
              <el-input v-model="copyForm.tone" placeholder="可选，例如：克制、简洁、促销感强" />
            </el-form-item>
            <el-form-item>
              <el-button
                type="primary"
                :loading="copying"
                :disabled="!admin.hasPerm('ai:marketing')"
                @click="generateCopy"
              >
                生成文案
              </el-button>
              <span v-if="!admin.hasPerm('ai:marketing')" class="muted">（缺少 ai:marketing 权限）</span>
            </el-form-item>
          </el-form>

          <el-alert
            v-if="copyResult?.degraded"
            type="warning"
            :closable="false"
            show-icon
            title="AI 暂不可用，下面是模板兜底文案（仍需人工确认）"
            class="copy-alert"
          />

          <div v-if="copyResult" class="copy-list">
            <div v-for="(variant, index) in copyResult.variants" :key="index" class="copy-card">
              <div class="copy-card__head">
                <b>{{ variant.title }}</b>
                <el-tag size="small" type="warning" effect="plain">AI 生成</el-tag>
                <el-button link type="primary" @click="copyToClipboard(variant)">复制</el-button>
              </div>
              <p v-if="variant.subtitle" class="copy-card__sub">{{ variant.subtitle }}</p>
              <p class="copy-card__body">{{ variant.body }}</p>
              <div class="copy-card__tags">
                <el-tag v-for="tag in variant.tags" :key="tag" size="small" effect="plain">{{ tag }}</el-tag>
              </div>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <!-- ------------------------------ 评测 ------------------------------ -->
      <el-tab-pane label="评测" name="eval">
        <el-card shadow="never">
          <div class="card-head">
            <b>评测集</b>
            <span class="muted">ai_eval_cases 逐条比对；准确率、降级率、P95 延迟一目了然</span>
          </div>
          <el-button
            type="primary"
            :loading="evaluating"
            :disabled="!admin.hasPerm('ai:manage')"
            @click="runEval"
          >
            运行评测
          </el-button>
          <p v-if="!evalSummaries.length" class="muted tip">还没有结果。点击「运行评测」跑一遍当前用例。</p>

          <div v-for="summary in evalSummaries" :key="summary.scenario" class="eval-block">
            <div class="eval-block__head">
              <b>{{ summary.scenario }}</b>
              <span>
                准确率 {{ summary.accuracy }}%（{{ summary.passed }}/{{ summary.total }}）· 降级率
                {{ summary.degradedRate }}% · 平均 {{ summary.avgLatency }}ms · P95 {{ summary.p95Latency }}ms
              </span>
            </div>
            <el-table :data="summary.cases" size="small">
              <el-table-column prop="id" label="#" width="60" />
              <el-table-column label="结果" width="80">
                <template #default="{ row }">
                  <el-tag :type="row.passed ? 'success' : 'danger'" size="small">
                    {{ row.passed ? 'PASS' : 'FAIL' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="input" label="输入" width="220" show-overflow-tooltip />
              <el-table-column prop="latencyMs" label="延迟" width="90">
                <template #default="{ row }">{{ row.latencyMs }} ms</template>
              </el-table-column>
              <el-table-column label="失败原因" min-width="240">
                <template #default="{ row }">
                  <span class="muted">{{ row.failed.join(' | ') || '—' }}</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-card>

        <el-card shadow="never">
          <div class="card-head">
            <b>最近差评</b>
            <span class="muted">👎 样本可整理进评测集，形成「反馈 → 评测 → 改进」闭环</span>
          </div>
          <p v-if="!badFeedback.length" class="muted">暂无差评</p>
          <el-table v-else :data="badFeedback" size="small">
            <el-table-column prop="messageId" label="消息" width="90" />
            <el-table-column prop="reason" label="原因" width="160" />
            <el-table-column prop="correctedAnswer" label="用户纠错" min-width="220" show-overflow-tooltip />
            <el-table-column prop="createdAt" label="时间" width="200" />
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-drawer v-model="drawer.visible" :title="drawer.title" size="560px">
      <div v-loading="drawer.loading" class="chat">
        <p v-if="!drawer.messages.length && !drawer.loading" class="muted">暂无消息</p>
        <div
          v-for="m in drawer.messages"
          :key="m.id"
          class="msg"
          :class="`is-${m.role === 'user' ? 'user' : 'ai'}`"
        >
          <div class="msg__meta">
            <span>{{ ROLE_TEXT[m.role] ?? m.role }}</span>
            <span class="muted">{{ m.createdAt }}</span>
            <span v-if="m.tokens" class="muted">{{ m.tokens }} tokens</span>
            <span v-if="m.rating === 1">👍</span>
            <span v-else-if="m.rating === -1">👎 {{ m.ratingReason }}</span>
          </div>
          <div class="msg__bubble">{{ m.content }}</div>
          <div v-if="m.citations.length" class="msg__cites">
            <el-tag v-for="(c, i) in m.citations" :key="i" size="small" type="info" effect="plain">
              [{{ i + 1 }}] {{ c.title }}
            </el-tag>
          </div>
          <div v-if="m.toolCalls.length" class="msg__tools">
            <span v-for="(t, i) in m.toolCalls" :key="i" class="muted">🔧 {{ t.name }}</span>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.ai-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.head__main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.head h2 {
  font-size: 18px;
  margin-bottom: 6px;
}
.head .muted {
  font-size: 12.5px;
}
.head__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.tabs :deep(.el-tabs__content) {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}
.stat {
  background: #fff;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat__label {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}
.stat__value {
  font-size: 22px;
  line-height: 1.3;
}
.stat__hint {
  font-size: 11.5px;
  color: var(--el-text-color-secondary, #909399);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.card-head .muted {
  font-size: 12px;
}
.budget {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.budget__head {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  margin-bottom: 4px;
}
.tip {
  font-size: 12px;
  margin-top: 10px;
  line-height: 1.7;
}
.tip code {
  background: #f5f7fa;
  border-radius: 4px;
  padding: 1px 6px;
}
.user-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.user-cell .muted {
  font-size: 11.5px;
}
.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.copy-form {
  max-width: 720px;
}
.copy-alert {
  margin-bottom: 12px;
}
.copy-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}
.copy-card {
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 8px;
  padding: 12px 14px;
}
.copy-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.copy-card__head b {
  font-size: 14.5px;
}
.copy-card__sub {
  font-size: 12.5px;
  color: var(--el-text-color-secondary, #909399);
  margin-top: 4px;
}
.copy-card__body {
  font-size: 13px;
  line-height: 1.7;
  margin-top: 6px;
}
.copy-card__tags {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.eval-block {
  margin-top: 16px;
}
.eval-block__head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 13px;
}
.chat {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 120px;
}
.msg {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.msg.is-user {
  align-items: flex-end;
}
.msg__meta {
  display: flex;
  gap: 10px;
  font-size: 11.5px;
  align-items: center;
}
.msg__bubble {
  max-width: 92%;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f5f7fa;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg.is-user .msg__bubble {
  background: #fff3e8;
}
.msg__cites {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.msg__tools {
  display: flex;
  gap: 10px;
  font-size: 11.5px;
}
@media (max-width: 1100px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .head__main {
    flex-direction: column;
  }
  .head__actions {
    justify-content: flex-start;
  }
}
</style>
