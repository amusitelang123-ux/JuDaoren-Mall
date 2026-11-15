<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi } from '@admin/api'
import type { AdminBrand, AdminCategoryNode, SpecGroupItem } from '@admin/api'
import { useAdminStore } from '@admin/stores/admin'

const admin = useAdminStore()
const canEdit = admin.hasPerm('product:create') || admin.hasPerm('product:update')

const tab = ref('category')
const loading = ref(false)

const categories = ref<AdminCategoryNode[]>([])
const brands = ref<AdminBrand[]>([])
const specGroups = ref<SpecGroupItem[]>([])

/* --------------------------------- 分类 ----------------------------------- */
const catDialog = reactive({ visible: false, mode: 'create' as 'create' | 'edit', id: 0, parentId: 0, name: '', sort: 0, status: 1 })

function openCreateCategory(parent?: AdminCategoryNode) {
  Object.assign(catDialog, { visible: true, mode: 'create', id: 0, parentId: parent?.id ?? 0, name: '', sort: 0, status: 1 })
}

function openEditCategory(node: AdminCategoryNode) {
  Object.assign(catDialog, { visible: true, mode: 'edit', id: node.id, parentId: node.parentId, name: node.name, sort: node.sort, status: node.status })
}

async function submitCategory() {
  if (!catDialog.name) {
    ElMessage.warning('请输入分类名称')
    return
  }
  try {
    if (catDialog.mode === 'create') {
      await adminApi.categoryApi.create({ name: catDialog.name, parentId: catDialog.parentId, sort: catDialog.sort, status: catDialog.status })
    } else {
      await adminApi.categoryApi.update(catDialog.id, { name: catDialog.name, sort: catDialog.sort, status: catDialog.status })
    }
    ElMessage.success('已保存')
    catDialog.visible = false
    await loadCategories()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  }
}

async function removeCategory(node: AdminCategoryNode) {
  try {
    await ElMessageBox.confirm(`确定删除分类「${node.name}」吗？`, '提示', { type: 'warning' })
  } catch {
    return
  }
  try {
    await adminApi.categoryApi.remove(node.id)
    ElMessage.success('已删除')
    await loadCategories()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败')
  }
}

/* --------------------------------- 品牌 ----------------------------------- */
const brandDialog = reactive({
  visible: false,
  mode: 'create' as 'create' | 'edit',
  id: 0,
  name: '',
  logo: '',
  sort: 0,
  status: 1,
})
const brandUploading = ref(false)

function openCreateBrand() {
  Object.assign(brandDialog, { visible: true, mode: 'create', id: 0, name: '', logo: '', sort: 0, status: 1 })
}

function openEditBrand(row: AdminBrand) {
  Object.assign(brandDialog, {
    visible: true,
    mode: 'edit',
    id: row.id,
    name: row.name,
    logo: row.logo || '',
    sort: row.sort,
    status: row.status,
  })
}

async function onBrandUpload(file: File) {
  if (!file.type.startsWith('image/')) {
    ElMessage.warning('请选择图片文件')
    return false
  }
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.warning('图片大小不能超过 5MB')
    return false
  }

  brandUploading.value = true
  try {
    const res = await adminApi.uploadApi.image(file)
    brandDialog.logo = res.url
    ElMessage.success('品牌图片已上传')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '上传失败')
  } finally {
    brandUploading.value = false
  }
  return false
}

async function submitBrand() {
  if (!brandDialog.name.trim()) {
    ElMessage.warning('请输入品牌名称')
    return
  }
  try {
    const payload = {
      name: brandDialog.name.trim(),
      logo: brandDialog.logo.trim(),
      sort: brandDialog.sort,
      status: brandDialog.status,
    }
    if (brandDialog.mode === 'create') {
      await adminApi.brandApi.create(payload)
    } else {
      await adminApi.brandApi.update(brandDialog.id, payload)
    }
    ElMessage.success('已保存')
    brandDialog.visible = false
    await loadBrands()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  }
}

async function removeBrand(row: AdminBrand) {
  try {
    await ElMessageBox.confirm(`确定删除品牌「${row.name}」吗？`, '提示', { type: 'warning' })
  } catch {
    return
  }
  try {
    await adminApi.brandApi.remove(row.id)
    ElMessage.success('已删除')
    await loadBrands()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败')
  }
}

/* ------------------------------- 规格模板 --------------------------------- */
const specDialog = reactive({ visible: false, mode: 'create' as 'create' | 'edit', id: 0, name: '', valuesText: '' })

function openCreateSpec() {
  Object.assign(specDialog, { visible: true, mode: 'create', id: 0, name: '', valuesText: '' })
}

function openEditSpec(row: SpecGroupItem) {
  Object.assign(specDialog, { visible: true, mode: 'edit', id: row.id, name: row.name, valuesText: row.values.join(',') })
}

async function submitSpec() {
  if (!specDialog.name) {
    ElMessage.warning('请输入规格组名')
    return
  }
  const values = specDialog.valuesText
    .split(/[,，\s]+/)
    .map((v) => v.trim())
    .filter(Boolean)
  try {
    if (specDialog.mode === 'create') {
      await adminApi.specApi.create({ name: specDialog.name, values })
    } else {
      await adminApi.specApi.update(specDialog.id, { name: specDialog.name, values })
    }
    ElMessage.success('已保存')
    specDialog.visible = false
    await loadSpecGroups()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  }
}

async function removeSpec(row: SpecGroupItem) {
  try {
    await ElMessageBox.confirm(`确定删除规格组「${row.name}」吗？`, '提示', { type: 'warning' })
  } catch {
    return
  }
  try {
    await adminApi.specApi.remove(row.id)
    ElMessage.success('已删除')
    await loadSpecGroups()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败')
  }
}

/* --------------------------------- 加载 ----------------------------------- */
async function loadCategories() {
  categories.value = await adminApi.categoryApi.tree()
}
async function loadBrands() {
  brands.value = await adminApi.brandApi.list()
}
async function loadSpecGroups() {
  specGroups.value = await adminApi.specApi.groups()
}

onMounted(async () => {
  loading.value = true
  try {
    await Promise.all([loadCategories(), loadBrands(), loadSpecGroups()])
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败')
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div v-loading="loading">
    <el-card shadow="never">
      <el-tabs v-model="tab">
        <el-tab-pane label="商品分类" name="category">
          <div class="pane-head">
            <el-button v-if="canEdit" type="primary" @click="openCreateCategory()">新增一级分类</el-button>
          </div>
          <el-tree
            :data="categories"
            node-key="id"
            default-expand-all
            :props="{ label: 'name', children: 'children' }"
          >
            <template #default="{ data }">
              <div class="tree-node">
                <span>{{ data.name }}</span>
                <el-tag v-if="data.status !== 1" type="info" size="small">停用</el-tag>
                <span class="tree-node__actions" v-if="canEdit">
                  <el-button link type="primary" @click.stop="openCreateCategory(data)">添加子类</el-button>
                  <el-button link type="primary" @click.stop="openEditCategory(data)">编辑</el-button>
                  <el-button link type="danger" @click.stop="removeCategory(data)">删除</el-button>
                </span>
              </div>
            </template>
          </el-tree>
        </el-tab-pane>

        <el-tab-pane label="品牌" name="brand">
          <div class="pane-head">
            <el-button v-if="canEdit" type="primary" @click="openCreateBrand">新增品牌</el-button>
          </div>
          <el-table :data="brands" stripe>
            <el-table-column label="ID" prop="id" width="80" />
            <el-table-column label="品牌名" prop="name" />
            <el-table-column label="品牌图片" width="140">
              <template #default="{ row }">
                <el-image
                  v-if="row.logo"
                  :src="row.logo"
                  :preview-src-list="[row.logo]"
                  preview-teleported
                  fit="cover"
                  class="brand-thumb"
                />
                <span v-else class="muted">未设置</span>
              </template>
            </el-table-column>
            <el-table-column label="排序" prop="sort" width="90" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column v-if="canEdit" label="操作" width="150">
              <template #default="{ row }">
                <el-button link type="primary" @click="openEditBrand(row)">编辑</el-button>
                <el-button link type="danger" @click="removeBrand(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="规格模板" name="spec">
          <div class="pane-head">
            <el-button v-if="canEdit" type="primary" @click="openCreateSpec">新增规格组</el-button>
          </div>
          <el-table :data="specGroups" stripe>
            <el-table-column label="ID" prop="id" width="80" />
            <el-table-column label="规格组名" prop="name" width="160" />
            <el-table-column label="规格值">
              <template #default="{ row }">
                <el-tag v-for="v in row.values" :key="v" class="spec-tag">{{ v }}</el-tag>
                <span v-if="!row.values.length" class="muted">暂无</span>
              </template>
            </el-table-column>
            <el-table-column v-if="canEdit" label="操作" width="150">
              <template #default="{ row }">
                <el-button link type="primary" @click="openEditSpec(row)">编辑</el-button>
                <el-button link type="danger" @click="removeSpec(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="catDialog.visible" :title="catDialog.mode === 'create' ? '新增分类' : '编辑分类'" width="420px">
      <el-form label-width="80px">
        <el-form-item label="分类名"><el-input v-model="catDialog.name" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="catDialog.sort" :min="0" /></el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="catDialog.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="catDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitCategory">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="brandDialog.visible" :title="brandDialog.mode === 'create' ? '新增品牌' : '编辑品牌'" width="560px">
      <el-form label-width="88px">
        <el-form-item label="品牌名">
          <el-input v-model="brandDialog.name" maxlength="50" show-word-limit />
        </el-form-item>
        <el-form-item label="品牌图片">
          <div class="brand-image-field">
            <el-upload
              class="brand-image-upload"
              :show-file-list="false"
              :before-upload="onBrandUpload"
              :disabled="brandUploading"
              accept="image/*"
            >
              <div v-if="brandDialog.logo" class="brand-image-preview" :class="{ 'is-uploading': brandUploading }">
                <img :src="brandDialog.logo" alt="品牌图片预览" />
                <span class="brand-image-mask">{{ brandUploading ? '上传中…' : '点击更换' }}</span>
              </div>
              <div v-else class="brand-image-empty" :class="{ 'is-uploading': brandUploading }">
                <span class="brand-image-plus">+</span>
                <span>{{ brandUploading ? '上传中…' : '上传品牌图片' }}</span>
              </div>
            </el-upload>
            <div class="brand-image-side">
              <el-input v-model="brandDialog.logo" placeholder="或粘贴网络图片地址" clearable />
              <p class="brand-image-tip">建议 16:9 / 4:3 横图，将作为用户端品牌专区封面展示</p>
              <el-button v-if="brandDialog.logo" link type="danger" @click="brandDialog.logo = ''">移除图片</el-button>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="排序"><el-input-number v-model="brandDialog.sort" :min="0" /></el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="brandDialog.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="brandDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitBrand">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="specDialog.visible" :title="specDialog.mode === 'create' ? '新增规格组' : '编辑规格组'" width="460px">
      <el-form label-width="90px">
        <el-form-item label="规格组名"><el-input v-model="specDialog.name" placeholder="如 颜色 / 尺码" /></el-form-item>
        <el-form-item label="规格值">
          <el-input v-model="specDialog.valuesText" type="textarea" :rows="3" placeholder="多个值用逗号分隔，如：白色 黑色,蓝色" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="specDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitSpec">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.pane-head {
  margin-bottom: 12px;
}
.tree-node {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  padding-right: 12px;
}
.tree-node__actions {
  margin-left: auto;
}
.spec-tag {
  margin-right: 6px;
}
.brand-thumb {
  width: 104px;
  height: 60px;
  border-radius: 6px;
  border: 1px solid #e5e7eb;
  display: block;
  cursor: zoom-in;
}
.brand-image-field {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  width: 100%;
}
.brand-image-upload {
  flex: none;
}
.brand-image-preview,
.brand-image-empty {
  width: 180px;
  height: 110px;
  border-radius: 8px;
  overflow: hidden;
}
.brand-image-preview {
  position: relative;
  background: #f5f6f8;
  cursor: pointer;
}
.brand-image-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.brand-image-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(17, 24, 39, 0.48);
  color: #fff;
  font-size: 13px;
  opacity: 0;
  transition: opacity 0.2s;
}
.brand-image-preview:hover .brand-image-mask,
.brand-image-preview.is-uploading .brand-image-mask {
  opacity: 1;
}
.brand-image-empty {
  border: 1px dashed #cbd5e1;
  background: #fafbfc;
  color: #94a3b8;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s;
}
.brand-image-empty:hover {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}
.brand-image-plus {
  font-size: 22px;
  line-height: 1;
}
.brand-image-side {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.brand-image-tip {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #94a3b8;
}
.muted {
  color: #9aa3af;
  font-size: 13px;
}
</style>
