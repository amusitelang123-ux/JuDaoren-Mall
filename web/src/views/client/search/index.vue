<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ProductBrowser from '@/components/ProductBrowser.vue'
import { aiApi } from '@/api'
import type {
  AiChipField,
  AiHotKeyword,
  AiSearchChip,
  AiSearchParseResult,
  ProductFilterPatch,
} from '@/api/types'
import { useAppStore } from '@/stores/app'

/**
 * 搜索页：关键词检索 + AI 查询理解（改进方向 §4 A1）。
 *
 * 关键交互：
 * - 先用原始关键词把结果拉出来（主链路不等 AI）；
 * - 解析结果回来后渲染「AI 理解为」chips，并把结构化条件补进商品列表；
 * - 用户点掉某个 chip 即可修正，不需要重新输入整句话；
 * - 解析超时/关闭时只显示一行降级提示，搜索本身完全不受影响。
 */

const route = useRoute()
const router = useRouter()
const app = useAppStore()

const keyword = computed(() => String(route.query.keyword ?? ''))
const hot = ref<AiHotKeyword[]>([])
const parsed = ref<AiSearchParseResult | null>(null)
const parsing = ref(false)
/** 被用户点掉的 chip，key 为 `field:value` */
const dropped = ref<string[]>([])

let parseSeq = 0

const chipKey = (chip: AiSearchChip) => `${chip.field}:${chip.value}`
const visibleChips = computed(() => (parsed.value?.chips ?? []).filter((chip) => !dropped.value.includes(chipKey(chip))))

function isDropped(field: AiChipField, value: string | number | null): boolean {
  return dropped.value.includes(`${field}:${value ?? ''}`)
}

/**
 * 传给 ProductBrowser 的结构化条件；用户点掉的条件不再生效。
 *
 * 注意：parsed 存在时**始终**返回完整对象（未选中的字段为 undefined），
 * 这样「点掉某个 chip」才能把对应条件真正撤掉，而不是沿用上一次的值。
 */
const browserFilters = computed<ProductFilterPatch | undefined>(() => {
  const p = parsed.value?.parsed
  if (!p) return undefined
  return {
    categoryId: p.categoryId && !isDropped('category', p.categoryId) ? p.categoryId : undefined,
    brandId: p.brandId && !isDropped('brand', p.brandId) ? p.brandId : undefined,
    maxPrice:
      p.maxPrice !== null && !isDropped('price', 'range') && !isDropped('price', 'max')
        ? p.maxPrice
        : undefined,
    minPrice:
      p.minPrice !== null && !isDropped('price', 'range') && !isDropped('price', 'min')
        ? p.minPrice
        : undefined,
    sortBy: p.sortBy !== 'default' && !isDropped('sort', p.sortBy) ? p.sortBy : undefined,
  }
})

/** 搜索词优先用解析后的关键词（更干净），解析不可用或用户点掉时用原话 */
const searchKeyword = computed(() => {
  const p = parsed.value?.parsed
  if (!p?.keyword) return keyword.value
  if (isDropped('keyword', p.keyword)) return keyword.value
  return p.keyword
})

async function parse(keywordText: string) {
  const seq = ++parseSeq
  dropped.value = []
  parsed.value = null
  if (!keywordText) return
  parsing.value = true
  try {
    const result = await aiApi.parseSearch(keywordText)
    if (seq !== parseSeq) return
    parsed.value = result
  } catch {
    // 解析失败不提示：搜索本身已在正常工作
    if (seq === parseSeq) parsed.value = null
  } finally {
    if (seq === parseSeq) parsing.value = false
  }
}

function dropChip(chip: AiSearchChip) {
  const key = chipKey(chip)
  dropped.value = dropped.value.includes(key)
    ? dropped.value.filter((item) => item !== key)
    : [...dropped.value, key]
}

function quickSearch(kw: string) {
  app.pushHistory(kw)
  router.push({ path: '/search', query: { keyword: kw } })
}

const relaxedText = computed(() => {
  const map: Record<string, string> = {
    attribute: '规格',
    brand: '品牌',
    category: '品类',
    price: '价格',
  }
  const relaxed = parsed.value?.relaxed ?? []
  return relaxed.map((item) => map[item] ?? item).join('、')
})

watch(keyword, (value) => void parse(value), { immediate: true })

onMounted(async () => {
  try {
    const items = await aiApi.searchHot()
    if (items.length) hot.value = items
  } catch {
    // 热门搜索拿不到就退回内置词
  }
})

const hotKeywords = computed(() =>
  hot.value.length ? hot.value.map((item) => item.keyword) : app.hotKeywords,
)
</script>

<template>
  <div class="page">
    <div class="container">
      <template v-if="keyword">
        <div class="search-head card">
          <h1 class="search-head__title">
            搜索 “<span>{{ keyword }}</span>”
          </h1>

          <div v-if="visibleChips.length" class="search-head__ai">
            <span class="ai-label">AI 理解为</span>
            <button
              v-for="chip in visibleChips"
              :key="chipKey(chip)"
              type="button"
              class="ai-chip"
              :title="`点击移除条件：${chip.label}`"
              @click="dropChip(chip)"
            >
              {{ chip.label }}<i class="ai-chip__x">×</i>
            </button>
            <span class="ai-hint">{{ parsed?.resultCount ?? 0 }} 件商品</span>
          </div>
          <p v-else-if="parsing" class="muted search-head__note">正在理解你的搜索…</p>

          <p v-if="parsed && !parsing && parsed.degraded" class="muted search-head__note">
            查询理解暂不可用，已按关键词检索
          </p>
          <p v-if="relaxedText" class="muted search-head__note">
            没有完全匹配的商品，已放宽{{ relaxedText }}条件
          </p>

          <div class="search-head__chips">
            <span class="muted">相关搜索：</span>
            <button v-for="h in hotKeywords.slice(0, 5)" :key="h" @click="quickSearch(h)">{{ h }}</button>
          </div>
        </div>
        <ProductBrowser :keyword="searchKeyword" :filters="browserFilters" />
      </template>

      <template v-else>
        <div class="search-empty card">
          <h1>搜索小兔鲜</h1>
          <div class="search-empty__block">
            <h3>搜索历史
              <button v-if="app.searchHistory.length" @click="app.clearHistory()">清除</button>
            </h3>
            <div class="search-empty__chips">
              <button v-for="h in app.searchHistory" :key="h" class="chip" @click="quickSearch(h)">{{ h }}</button>
              <span v-if="!app.searchHistory.length" class="muted">暂无搜索历史</span>
            </div>
          </div>
          <div class="search-empty__block">
            <h3>热门搜索</h3>
            <div class="search-empty__chips">
              <button v-for="h in hotKeywords" :key="h" class="chip chip--hot" @click="quickSearch(h)">{{ h }}</button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.search-head {
  padding: 18px 20px;
  margin-bottom: 18px;
}
.search-head__title {
  font-size: 20px;
  margin-bottom: 10px;
}
.search-head__title span {
  color: var(--amz-price);
}
.search-head__ai {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 10px;
  background: var(--bg-subtle);
  border-radius: 8px;
}
.ai-label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 600;
}
.ai-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid #d6e6ff;
  background: #f2f7ff;
  color: var(--amz-link);
  border-radius: 100px;
  padding: 3px 10px;
  font-size: 12.5px;
  cursor: pointer;
}
.ai-chip:hover {
  background: #e6f0ff;
}
.ai-chip__x {
  font-style: normal;
  font-size: 13px;
  opacity: 0.6;
}
.ai-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-left: auto;
}
.search-head__note {
  font-size: 12.5px;
  margin-bottom: 8px;
}
.search-head__chips {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
}
.search-head__chips button {
  background: none;
  border: none;
  color: var(--amz-link);
  font-size: 13px;
  padding: 0;
}
.search-head__chips button:hover {
  text-decoration: underline;
}
.search-empty {
  padding: 30px;
}
.search-empty h1 {
  font-size: 24px;
  margin-bottom: 24px;
}
.search-empty__block {
  margin-bottom: 22px;
}
.search-empty__block h3 {
  font-size: 15px;
  margin-bottom: 10px;
  display: flex;
  justify-content: space-between;
}
.search-empty__block h3 button {
  background: none;
  border: none;
  color: var(--amz-link);
  font-size: 13px;
}
.search-empty__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.chip {
  background: #f0f2f2;
  border: none;
  border-radius: 100px;
  padding: 6px 16px;
  font-size: 14px;
}
.chip--hot {
  background: #fff4e5;
  color: #b45309;
}
.chip:hover {
  background: #e3e6e6;
}
</style>
