<template>
  <v-dialog
    :model-value="modelValue"
    max-width="1180"
    content-class="elevation-0"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card class="wardrobe-dialog rounded-2xl flex flex-row h-[700px] overflow-hidden border border-[rgba(var(--v-theme-on-surface),0.1)]">
      <!-- Shared 3D preview: always shows the actually equipped skin + cape. -->
      <div class="w-[360px] flex-shrink-0 flex flex-col items-center justify-between p-5 border-r border-[rgba(var(--v-theme-on-surface),0.08)] bg-black/25">
        <div class="w-full flex-1 min-h-0 flex items-center justify-center wardrobe-preview">
          <SkinView
            v-if="modelValue"
            :paused="false"
            :width="300"
            :height="500"
            :skin="equippedSkinUrl"
            :slim="equippedSkinSlim"
            :cape="equippedCapeUrl"
            :name="''"
            :rotation-y="activeTab === 'capes' ? capePreviewRotation : 0"
            animation="idle"
          />
        </div>

        <div class="w-full flex items-center gap-2">
          <v-btn
            variant="tonal"
            size="large"
            block
            class="font-semibold flex-1"
            :disabled="activeTab === 'skins' ? !canSaveCurrentSkinToLibrary : !equippedCapeUrl"
            @click="activeTab === 'skins' ? saveCurrentSkinToLibrary() : saveCurrentCapeToLibrary()"
          >
            <v-icon start size="18">bookmark_add</v-icon>
            {{ activeTab === 'skins' ? 'Сохранить текущий скин' : 'Сохранить текущий плащ' }}
          </v-btn>
          <v-btn
            variant="tonal"
            size="large"
            icon
            :disabled="activeTab === 'skins' ? !selectedSkin : !selectedCape"
            @click="activeTab === 'skins' ? exportSelectedSkin() : exportSelectedCape()"
          >
            <v-icon>download</v-icon>
          </v-btn>
        </div>
      </div>

      <!-- Right side -->
      <div class="flex-1 flex flex-col p-6 overflow-hidden bg-surface">
        <div class="flex items-start justify-between gap-4 mb-5 flex-none">
          <div class="min-w-0">
            <h2 class="text-xl font-bold flex items-center gap-2">
              <v-icon color="primary" size="24">accessibility</v-icon>
              Локальный гардероб
            </h2>
            <div class="text-xs opacity-50 mt-0.5">
              Выбирайте, упорядочивайте и храните свои скины и плащи локально
            </div>
          </div>

          <div class="flex items-center gap-2">
            <v-btn-toggle
              v-if="!editorOpen"
              v-model="activeTab"
              mandatory
              color="primary"
              density="comfortable"
              rounded="lg"
              class="wardrobe-tabs"
            >
              <v-btn value="skins" class="px-5 font-semibold">
                <v-icon start size="18">checkroom</v-icon>
                Скины
              </v-btn>
              <v-btn value="capes" class="px-5 font-semibold">
                <v-icon start size="18">flag</v-icon>
                Плащи
              </v-btn>
            </v-btn-toggle>
            <v-btn icon size="small" variant="text" @click="$emit('update:modelValue', false)">
              <v-icon>close</v-icon>
            </v-btn>
          </div>
        </div>

        <v-alert
          v-if="errorMessage"
          type="error"
          variant="tonal"
          density="compact"
          closable
          class="mb-4 flex-none"
          @click:close="errorMessage = ''"
        >
          {{ errorMessage }}
        </v-alert>

        <!-- Editors -->
        <template v-if="editorOpen">
          <div class="flex items-center gap-3 mb-5 flex-none">
            <v-btn icon size="small" variant="text" @click="closeEditor">
              <v-icon>arrow_back</v-icon>
            </v-btn>
            <div>
              <div class="text-xl font-bold">
                {{ activeTab === 'skins'
                  ? (editingSkin ? 'Изменить скин' : 'Новый скин')
                  : (editingCape ? 'Изменить плащ' : 'Новый плащ') }}
              </div>
              <div class="text-xs opacity-50 mt-0.5">
                {{ activeTab === 'skins' ? 'PNG скин Minecraft' : 'PNG плащ Minecraft' }}
              </div>
            </div>
          </div>

          <div class="flex-1 min-h-0 flex flex-col justify-between">
            <div class="overflow-y-auto pr-1 flex flex-col gap-5">
              <div>
                <div class="text-xs font-bold uppercase opacity-70 mb-2">Название</div>
                <v-text-field
                  v-model="draftName"
                  :placeholder="activeTab === 'skins' ? 'Мой скин' : 'Мой плащ'"
                  variant="outlined"
                  density="comfortable"
                  hide-details
                />
              </div>

              <div v-if="activeTab === 'skins'">
                <v-btn-toggle
                  v-model="draftSlim"
                  mandatory
                  density="comfortable"
                  class="w-full"
                  rounded="lg"
                >
                  <v-btn :value="false" class="flex-1 font-semibold">Classic</v-btn>
                  <v-btn :value="true" class="flex-1 font-semibold">Slim</v-btn>
                </v-btn-toggle>
              </div>

              <div v-if="!editingSkin && !editingCape">
                <div
                  class="file-drop-zone min-h-[235px] border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 hover:border-primary hover:bg-primary/5"
                  :class="draftUrl ? 'border-primary/60 bg-primary/5' : 'border-[rgba(var(--v-theme-on-surface),0.15)]'"
                  @click="pickFile"
                  @drop.prevent="onDropFile"
                  @dragover.prevent
                >
                  <v-icon size="48" color="primary" class="mb-3">upload_file</v-icon>
                  <div class="text-base font-bold">
                    {{ activeTab === 'skins' ? 'Выбрать PNG скина' : 'Выбрать PNG плаща' }}
                  </div>
                  <div class="text-xs opacity-50 mt-1.5">
                    {{ activeTab === 'skins' ? 'Поддерживаются стандартные PNG-скины Minecraft' : 'Рекомендуемый формат плаща: 64×32 PNG' }}
                  </div>
                  <div v-if="draftUrl" class="text-xs text-primary mt-4">Файл выбран</div>
                </div>
              </div>
            </div>

            <div class="flex items-center justify-end gap-3 mt-5 pt-5 border-t border-[rgba(var(--v-theme-on-surface),0.08)]">
              <v-btn variant="text" @click="closeEditor">Отмена</v-btn>
              <v-btn color="primary" :disabled="!canSaveDraft" @click="saveDraft(false)">
                {{ editingSkin || editingCape ? 'Сохранить' : 'Сохранить в гардеробе' }}
              </v-btn>
              <v-btn
                v-if="!editingSkin && !editingCape"
                color="success"
                :disabled="!canSaveDraft"
                @click="saveDraft(true)"
              >
                Сохранить и надеть
              </v-btn>
            </div>
          </div>
        </template>

        <!-- Library -->
        <template v-else>
          <div class="flex items-center justify-between gap-3 mb-4 flex-none">
            <v-text-field
              v-model="searchQuery"
              :placeholder="activeTab === 'skins' ? 'Поиск скинов' : 'Поиск плащей'"
              prepend-inner-icon="search"
              variant="outlined"
              density="compact"
              hide-details
              clearable
              class="max-w-[360px]"
            />
            <v-btn color="primary" class="font-medium" @click="openAddEditor">
              <v-icon start size="18">add</v-icon>
              {{ activeTab === 'skins' ? 'Новый скин' : 'Новый плащ' }}
            </v-btn>
          </div>

          <!-- Skins -->
          <div v-if="activeTab === 'skins'" class="flex-1 overflow-y-auto pr-1">
            <div class="grid grid-cols-4 gap-3">
              <!-- Built-in zero skin. It cannot be edited or deleted. -->
              <div
                class="default-card relative flex flex-col items-center rounded-xl cursor-pointer overflow-hidden"
                :class="isDefaultSkinEquipped ? 'is-equipped selected' : ''"
                @click="equipDefaultSkin"
              >
                <div class="relative w-full flex items-center justify-center py-5 px-3 min-h-[140px]">
                  <PlayerSkin2D :src="steveSkin" :slim="false" :width="56" :height="112" />
                  <v-chip size="x-small" variant="tonal" class="absolute top-2 right-2">Встроенный</v-chip>
                  <v-chip v-if="isDefaultSkinEquipped" size="x-small" color="success" class="absolute top-2 left-2">
                    <v-icon start size="12">check</v-icon>Надет
                  </v-chip>
                </div>
                <div class="w-full px-2.5 py-2 text-center text-[11px] font-semibold">Steve</div>
              </div>

              <UserSkinCard
                v-for="item in filteredSkins"
                :key="item.id"
                :skin="item"
                :is-selected="selectedSkin?.id === item.id"
                :is-equipped="isSkinEquipped(item)"
                @select="selectedSkin = item"
                @equip="equipSkin"
                @edit="editSkin"
                @delete="deleteSkin"
              />
            </div>
          </div>

          <!-- Capes -->
          <div v-else class="flex-1 overflow-y-auto pr-1">
            <div class="grid grid-cols-4 gap-3">
              <!-- Built-in zero cape. -->
              <div
                class="cape-card relative rounded-xl border p-3 cursor-pointer transition-colors"
                :class="isNoCapeEquipped ? 'border-success bg-success/5' : 'border-[rgba(var(--v-theme-on-surface),0.12)]'"
                @click="unequipCape"
              >
                <div class="h-[150px] flex items-center justify-center">
                  <SkinView
                    :width="105"
                    :height="150"
                    :skin="equippedSkinUrl"
                    :slim="equippedSkinSlim"
                    :name="''"
                    :rotation-y="capePreviewRotation"
                    animation="none"
                  />
                </div>
                <v-chip size="x-small" variant="tonal" class="absolute top-2 right-2">Встроенный</v-chip>
                <v-chip v-if="isNoCapeEquipped" size="x-small" color="success" class="absolute top-2 left-2">
                  <v-icon start size="12">check</v-icon>Надет
                </v-chip>
                <div class="font-semibold text-sm truncate text-center mt-2">Без плаща</div>
              </div>

              <div
                v-for="capeItem in filteredCapes"
                :key="capeItem.id"
                class="cape-card relative rounded-xl border p-3 cursor-pointer transition-colors group"
                :class="selectedCape?.id === capeItem.id || isCapeEquipped(capeItem) ? 'border-primary bg-primary/5' : 'border-[rgba(var(--v-theme-on-surface),0.12)]'"
                @click="selectedCape = capeItem"
              >
                <div class="h-[150px] flex items-center justify-center overflow-hidden">
                  <SkinView
                    :width="105"
                    :height="150"
                    :skin="equippedSkinUrl"
                    :slim="equippedSkinSlim"
                    :cape="capeItem.url"
                    :name="''"
                    :rotation-y="capePreviewRotation"
                    animation="none"
                  />
                </div>
                <v-chip v-if="isCapeEquipped(capeItem)" size="x-small" color="success" class="absolute top-2 left-2">
                  <v-icon start size="12">check</v-icon>Надет
                </v-chip>
                <div class="font-semibold text-sm truncate text-center mt-2" :title="capeItem.name">{{ capeItem.name }}</div>
                <div class="cape-actions flex justify-center gap-1 mt-2">
                  <v-btn v-if="!isCapeEquipped(capeItem)" icon="check" size="x-small" color="success" variant="flat" @click.stop="equipCape(capeItem)" />
                  <v-btn icon="edit" size="x-small" variant="flat" color="surface" @click.stop="editCape(capeItem)" />
                  <v-btn icon="delete" size="x-small" variant="flat" color="error" @click.stop="deleteCape(capeItem)" />
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </v-card>
  </v-dialog>
</template>

<script lang="ts" setup>
import PlayerSkin2D from '@/components/PlayerSkin2D.vue'
import SkinView from '@/components/SkinView.vue'
import UserSkinCard from '@/components/UserSkinCard.vue'
import steveSkin from '@/assets/steve_skin.png'
import { getDropFilePaths } from '@/composables/dropHandler'
import { useLocaleError } from '@/composables/error'
import { useNotifier } from '@/composables/notifier'
import { type SkinLibraryItem, useUserSkinLibrary } from '@/composables/userSkinLibrary'
import { type CapeLibraryItem, useUserCapeLibrary } from '@/composables/userCapeLibrary'
import { UserSkinModel } from '@/composables/userSkin'
import type { GameProfileAndTexture, UserProfile } from '@xmcl/runtime-api'

const props = defineProps<{
  modelValue: boolean
  user: UserProfile
  profile: GameProfileAndTexture
}>()

defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const { notify } = useNotifier()
const toLocaleError = useLocaleError()
const { showOpenDialog, showSaveDialog } = windowController
const skinModel = inject(UserSkinModel)

const {
  customSkins,
  allSkins,
  equippedSkinIds,
  refresh: refreshSkins,
  addSkin,
  removeSkin,
  updateSkin,
  setEquippedSkin,
} = useUserSkinLibrary()
const {
  capes,
  equippedCapeIds,
  refresh: refreshCapes,
  addCape,
  updateCape,
  removeCape,
  setEquippedCape,
} = useUserCapeLibrary()

const activeTab = ref<'skins' | 'capes'>('skins')
const searchQuery = ref('')
const selectedSkin = ref<SkinLibraryItem | null>(null)
const selectedCape = ref<CapeLibraryItem | null>(null)
const editorOpen = ref(false)
const editingSkin = ref<SkinLibraryItem | null>(null)
const editingCape = ref<CapeLibraryItem | null>(null)
const draftName = ref('')
const draftUrl = ref('')
const draftSlim = ref(false)
const errorMessage = ref('')
const savingCurrentSkin = ref(false)

const capePreviewRotation = Math.PI * 0.82
const accountKey = computed(() => `${props.user.id}:${props.profile.id}`)
const currentEquippedCapeId = computed(() => equippedCapeIds.value[accountKey.value] || '')
const currentStoredSkinId = computed(() => equippedSkinIds.value[accountKey.value] || '')
const activeProfileSkinUrl = computed(() => (props.profile?.skins ? props.profile.skins.find(s => s.state === 'ACTIVE')?.url : undefined) || props.profile?.textures?.SKIN?.url || '')
const activeProfileSlim = computed(() => {
  const active = props.profile?.skins?.find(s => s.state === 'ACTIVE')
  if (active) return active.variant === 'SLIM'
  return props.profile?.textures?.SKIN?.metadata?.model === 'slim'
})

const equippedSkinUrl = computed(() => skinModel?.skin.value || activeProfileSkinUrl.value || steveSkin)
const equippedSkinSlim = computed(() => skinModel?.slim.value ?? activeProfileSlim.value)
const equippedCapeUrl = computed(() => {
  const id = currentEquippedCapeId.value
  if (id) return capes.value.find(c => c.id === id)?.url || ''
  return ''
})
const isNoCapeEquipped = computed(() => !currentEquippedCapeId.value)
const isDefaultSkinEquipped = computed(() => {
  if (currentStoredSkinId.value) return false
  return !allSkins.value.some(s => isSkinEquipped(s))
})

const filteredSkins = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return allSkins.value
  return allSkins.value.filter(s => s.name.toLowerCase().includes(q))
})
const filteredCapes = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return capes.value
  return capes.value.filter(c => c.name.toLowerCase().includes(q))
})
const canSaveDraft = computed(() => !!draftName.value.trim() && (!!editingSkin.value || !!editingCape.value || !!draftUrl.value))
const canSaveCurrentSkinToLibrary = computed(() => {
  if (savingCurrentSkin.value || !equippedSkinUrl.value) return false
  return !customSkins.value.some(s => s.url === equippedSkinUrl.value || s.source === equippedSkinUrl.value)
})

watch(() => props.modelValue, async (open) => {
  if (!open) return
  errorMessage.value = ''
  editorOpen.value = false
  editingSkin.value = null
  editingCape.value = null
  try {
    await Promise.all([refreshSkins(), refreshCapes()])
    selectedSkin.value = allSkins.value.find(isSkinEquipped) || allSkins.value[0] || null
    selectedCape.value = capes.value.find(c => c.id === currentEquippedCapeId.value) || capes.value[0] || null
  } catch (e) {
    errorMessage.value = toLocaleError(e)
  }
})

watch(activeTab, () => {
  searchQuery.value = ''
  closeEditor()
})

function isSkinEquipped(item: SkinLibraryItem) {
  if (currentStoredSkinId.value && item.id === currentStoredSkinId.value) return true
  return !!activeProfileSkinUrl.value && (item.url === activeProfileSkinUrl.value || item.source === activeProfileSkinUrl.value)
}
function isCapeEquipped(item: CapeLibraryItem) {
  return item.id === currentEquippedCapeId.value
}

function openAddEditor() {
  editingSkin.value = null
  editingCape.value = null
  draftName.value = ''
  draftUrl.value = ''
  draftSlim.value = false
  errorMessage.value = ''
  editorOpen.value = true
}
function closeEditor() {
  editorOpen.value = false
  editingSkin.value = null
  editingCape.value = null
  draftName.value = ''
  draftUrl.value = ''
}
function editSkin(item: SkinLibraryItem) {
  editingSkin.value = item
  editingCape.value = null
  draftName.value = item.name
  draftUrl.value = item.url
  draftSlim.value = item.slim
  editorOpen.value = true
}
function editCape(item: CapeLibraryItem) {
  editingCape.value = item
  editingSkin.value = null
  draftName.value = item.name
  draftUrl.value = item.url
  editorOpen.value = true
}

async function pickFile() {
  const { filePaths } = await showOpenDialog({
    title: activeTab.value === 'skins' ? 'Выбрать скин' : 'Выбрать плащ',
    filters: [{ extensions: ['png'], name: 'PNG Images' }],
  })
  if (filePaths?.[0]) setFile(filePaths[0])
}
function onDropFile(event: DragEvent) {
  if (!event.dataTransfer) return
  const [filePath] = getDropFilePaths(event.dataTransfer.files)
  if (filePath?.toLowerCase().endsWith('.png')) setFile(filePath)
}
function setFile(filePath: string) {
  draftUrl.value = `http://launcher/media?path=${filePath}`
  if (!draftName.value) draftName.value = filePath.split(/[/\\]/).pop()?.replace(/\.png$/i, '') || (activeTab.value === 'skins' ? 'Skin' : 'Cape')
}

async function saveDraft(equipImmediately: boolean) {
  if (!canSaveDraft.value) return
  try {
    if (activeTab.value === 'skins') {
      let item: SkinLibraryItem
      if (editingSkin.value) item = await updateSkin(editingSkin.value.id, { name: draftName.value.trim(), slim: draftSlim.value })
      else item = await addSkin({ name: draftName.value.trim(), url: draftUrl.value, slim: draftSlim.value })
      selectedSkin.value = item
      if (equipImmediately) await equipSkin(item)
    } else {
      let item: CapeLibraryItem
      if (editingCape.value) item = await updateCape(editingCape.value.id, { name: draftName.value.trim() })
      else item = await addCape({ name: draftName.value.trim(), url: draftUrl.value })
      selectedCape.value = item
      if (equipImmediately) await equipCape(item)
    }
    closeEditor()
  } catch (e) {
    errorMessage.value = toLocaleError(e)
  }
}

async function equipSkin(item: SkinLibraryItem) {
  selectedSkin.value = item
  if (!skinModel) return
  try {
    skinModel.skin.value = item.url
    skinModel.slim.value = item.slim
    await skinModel.save()
    await setEquippedSkin(accountKey.value, item.id)
  } catch (e) {
    errorMessage.value = toLocaleError(e)
  }
}
async function equipDefaultSkin() {
  if (!skinModel) return
  try {
    skinModel.skin.value = steveSkin
    skinModel.slim.value = false
    await skinModel.save()
    await setEquippedSkin(accountKey.value, '')
    selectedSkin.value = null
  } catch (e) {
    errorMessage.value = toLocaleError(e)
  }
}
async function equipCape(item: CapeLibraryItem) {
  selectedCape.value = item
  try {
    await setEquippedCape(accountKey.value, item.id)
  } catch (e) {
    errorMessage.value = toLocaleError(e)
  }
}
async function unequipCape() {
  try {
    await setEquippedCape(accountKey.value, '')
    selectedCape.value = null
  } catch (e) {
    errorMessage.value = toLocaleError(e)
  }
}

async function deleteSkin(item: SkinLibraryItem) {
  try {
    await removeSkin(item.id)
    if (selectedSkin.value?.id === item.id) selectedSkin.value = allSkins.value[0] || null
  } catch (e) {
    errorMessage.value = toLocaleError(e)
  }
}
async function deleteCape(item: CapeLibraryItem) {
  try {
    await removeCape(item.id)
    if (selectedCape.value?.id === item.id) selectedCape.value = capes.value[0] || null
  } catch (e) {
    errorMessage.value = toLocaleError(e)
  }
}

async function saveCurrentSkinToLibrary() {
  if (!canSaveCurrentSkinToLibrary.value) return
  savingCurrentSkin.value = true
  try {
    const item = await addSkin({
      name: props.profile.name || 'Current skin',
      url: equippedSkinUrl.value,
      slim: equippedSkinSlim.value,
    })
    selectedSkin.value = item
    await setEquippedSkin(accountKey.value, item.id)
  } catch (e) {
    errorMessage.value = toLocaleError(e)
  } finally {
    savingCurrentSkin.value = false
  }
}
async function saveCurrentCapeToLibrary() {
  // Local equipped capes already live in this library, so there is nothing to duplicate.
  notify({ level: 'info', title: 'Плащ уже сохранён в локальном гардеробе' })
}

async function exportSelectedSkin() {
  if (!selectedSkin.value || !skinModel?.exportTo) return
  const fileName = selectedSkin.value.name.replace(/[<>:"/\\|?*]/g, '_')
  const { filePath } = await showSaveDialog({
    title: 'Сохранить скин',
    defaultPath: `${fileName}.png`,
    filters: [{ extensions: ['png'], name: 'PNG Images' }],
  })
  if (!filePath) return
  try {
    await skinModel.exportTo({ path: filePath, url: selectedSkin.value.url })
  } catch (e) {
    errorMessage.value = toLocaleError(e)
  }
}
async function exportSelectedCape() {
  if (!selectedCape.value || !skinModel?.exportTo) return
  const fileName = selectedCape.value.name.replace(/[<>:"/\\|?*]/g, '_')
  const { filePath } = await showSaveDialog({
    title: 'Сохранить плащ',
    defaultPath: `${fileName}.png`,
    filters: [{ extensions: ['png'], name: 'PNG Images' }],
  })
  if (!filePath) return
  try {
    await skinModel.exportTo({ path: filePath, url: selectedCape.value.url })
  } catch (e) {
    errorMessage.value = toLocaleError(e)
  }
}
</script>

<style scoped>
.wardrobe-dialog {
  background: rgba(var(--v-theme-surface), 0.96);
  backdrop-filter: blur(20px);
}
.wardrobe-preview {
  background: radial-gradient(circle at 50% 50%, rgba(var(--v-theme-primary), 0.08), transparent 68%);
}
.wardrobe-tabs {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1);
}
.file-drop-zone {
  background: rgba(var(--v-theme-surface), 0.5);
}
.default-card {
  background: rgba(var(--v-theme-on-surface), 0.03);
  transition: background 0.2s ease, box-shadow 0.2s ease;
}
.default-card:hover {
  background: rgba(var(--v-theme-on-surface), 0.07);
}
.default-card.selected {
  background: rgba(var(--v-theme-primary), 0.1);
  box-shadow: inset 0 0 0 1.5px rgba(var(--v-theme-primary), 0.5);
}
.cape-card {
  background: rgba(var(--v-theme-on-surface), 0.03);
}
.cape-actions {
  opacity: 0;
  transition: opacity 0.2s ease;
}
.cape-card:hover .cape-actions {
  opacity: 1;
}
</style>