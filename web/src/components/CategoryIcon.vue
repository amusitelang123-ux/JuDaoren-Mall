<script setup lang="ts">
import { computed } from 'vue'
import type { Category } from '@/api/types'
import { getCategoryIcon, getNamedCategoryIcon } from '@/utils/categoryIcon'

const props = withDefaults(
  defineProps<{
    /** 分类数据；与 name 二选一 */
    category?: Pick<Category, 'id' | 'name' | 'icon'> | null
    /** 特殊图标名，例如 all */
    name?: string
    /** 渲染尺寸（px） */
    size?: number
  }>(),
  { size: 20 },
)

const meta = computed(() =>
  props.category ? getCategoryIcon(props.category) : props.name ? getNamedCategoryIcon(props.name) : null,
)

const pixelSize = computed(() => `${props.size}px`)

/** 未收录的分类保留后端下发的 emoji，避免出现空白 */
const fallback = computed(() => props.category?.icon?.trim() || '🏷️')
</script>

<template>
  <img
    v-if="meta"
    class="cat-icon"
    :src="meta.src"
    :width="size"
    :height="size"
    :style="{ width: pixelSize, height: pixelSize }"
    alt=""
    aria-hidden="true"
    draggable="false"
    decoding="async"
  />
  <span
    v-else
    class="cat-icon cat-icon--emoji"
    :style="{ width: pixelSize, height: pixelSize, fontSize: `${Math.round(size * 0.92)}px` }"
    aria-hidden="true"
  >{{ fallback }}</span>
</template>

<style scoped>
.cat-icon {
  display: inline-block;
  flex: none;
  object-fit: contain;
  vertical-align: middle;
  user-select: none;
}

.cat-icon--emoji {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  font-style: normal;
}
</style>
