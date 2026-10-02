<template>
  <v-dialog
    :model-value="modelValue"
    max-width="900"
    content-class="elevation-0"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card class="cape-library-dialog rounded-2xl h-[620px] overflow-hidden border border-[rgba(var(--v-theme-on-surface),0.1)] flex flex-row">
      <div class="w-[280px] flex-shrink-0 flex flex-col items-center p-6 border-r border-[rgba(var(--v-theme-on-surface),0.08)] bg-black/25">
        <div class="w-full text-xs font-bold uppercase tracking-wider opacity-60 mb-6">
          Предпросмотр плаща
        </div>

        <div class="flex-1 flex items-center justify-center">
          <PlayerCape v-if="selectedCape" :src="selectedCape.url" />
          <div v-else class="flex flex-col items-center gap-3 opacity-40 text-center">
            <v-icon size="56">flag</v-icon>
            <span class="text-sm">Плащ не выбран</span>
          </div>
        </div>

        <div class="w-full flex flex-col gap-2">
          <div class="text-center font-bold truncate mb-2" :title="selectedCape?.name">
            {{ selectedCape?.name || 'Нет плаща' }}
          </div>
          <v-btn
            color="primary"
            size="large"
            block
            :disabled="!selectedCape || isSelectedEquipped"
            @click="equipSelected"
          >
            <v-icon start>{{ isSelectedEquipped ? 'check_circle' : 'check' }}</v-icon>
            {{ isSelectedEquipped ? 'Надет' : 'Надеть' }}
          </v-btn>
          <v-btn
            v-if="currentEquippedCapeId"
            variant="tonal"
            block
            @click="unequipCape"
          >
            <v-icon start>close</v-icon>
            Снять плащ
          </v-btn>
        </div>
      </div>

      <div class="flex-1 flex flex-col p-6 overflow-hidden bg-surface">
        <template v-if="editorOpen">
          <div class="flex items-center justify-between mb-5">
            <div class="flex items-center gap-3">
              <v-btn icon size="small" variant="text" @click="closeEditor">
                <v-icon>arrow_back</v-icon>
              </v-btn>
              <div>
                <h2 class="text-xl font-bold">{{ editingCape ? 'Изменить плащ' : 'Новый плащ' }}</h2>
                <div class="text-xs opacity-50 mt-0.5">PNG 64×32</div>
              </div>
            </div>
            <v-btn icon size="small" variant="text" @click="$emit('update:modelValue', false)">
              <v-icon>close</v-icon>
            </v-btn>
          </div>

          <v-alert
            v-if="errorMessage"
            type="error"
            variant="tonal"
            density="compact"
            closable
            class="mb-4"
            @click:close="errorMessage = ''"
          >
            {{ errorMessage }}
          </v-alert>

          <div class="flex-1 flex flex-col gap-5">
            <div>
              <div class="text-xs font-bold uppercase opacity-70 mb-2">Название</div>
              <v-text-field
                v-model="draftName"
                placeholder="Мой плащ"
                variant="outlined"
                density="comfortable"
                hide-details
              />
            </div>

            <div v-if="!editingCape">
              <div
                class="file-drop-zone min-h-[240px] border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 hover:border-primary hover:bg-primary/5"
                :class="draftUrl ? 'border-primary/60 bg-primary/5' : 'border-[rgba(var(--v-theme-on-surface),0.15)]'"
                @click="pickFile"
                @drop.prevent="onDropFile"
                @dragover.prevent
              >
                <v-icon size="48" color="primary" class="mb-3">upload_file</v-icon>
                <div class="text-base font-bold">Выбрать PNG плаща</div>
                <div class="text-xs opacity-50 mt-1.5">Рекомендуемый формат: 64×32 PNG</div>
                <div v-if="draftUrl" class="text-xs text-primary mt-4">Файл выбран</div>
              </div>
            </div>
          </div>

          <div class="flex justify-end gap-3 pt-5 border-t border-[rgba(var(--v-theme-on-surface),0.08)]">
            <v-btn variant="text" @click="closeEditor">Отмена</v-btn>
            <v-btn color="primary" :disabled="!canSaveDraft" @click="saveDraft(false)">
              {{ editingCape ? 'Сохранить' : 'Сохранить в гардеробе' }}
            </v-btn>
            <v-btn v-if="!editingCape" color="success" :disabled="!canSaveDraft" @click="saveDraft(true)">
              Сохранить и надеть
            </v-btn>
          </div>
        </template>

        <template v-else>
          <div class="flex items-center justify-between gap-3 mb-5">
            <div>
              <h2 class="text-xl font-bold flex items-center gap-2">
                <v-icon color="primary">flag</v-icon>
                Локальные плащи
              </h2>
              <div class="text-xs opacity-50 mt-0.5">Плащ будет использоваться LoM Skin Loader при запуске игры</div>
            </div>
            <div class="flex items-center gap-2">
              <v-btn color="primary" @click="openAddEditor">
                <v-icon start>add</v-icon>
                Новый плащ
              </v-btn>
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
            class="mb-4"
            @click:close="errorMessage = ''"
          >
            {{ errorMessage }}
          </v-alert>

          <div class="flex items-center justify-between gap-3 mb-4">
            <v-text-field
              v-model="searchQuery"
              placeholder="Поиск"
              prepend-inner-icon="search"
              variant="outlined"
              density="compact"
              hide-details
              clearable
              class="max-w-[280px]"
            />
            <div class="text-xs opacity-60">Сохранено: {{ capes.length }}</div>
          </div>

          <div class="flex-1 overflow-y-auto pr-1">
            <div v-if="filteredCapes.length" class="grid grid-cols-4 gap-3">
              <div
                v-for="capeItem in filteredCapes"
                :key="capeItem.id"
                class="relative rounded-xl border p-3 cursor-pointer transition-colors"
                :class="selectedCape?.id === capeItem.id ? 'border-primary bg-primary/5' : 'border-[rgba(var(--v-theme-on-surface),0.12)]'"
                @click="selectedCape = capeItem"
              >
                <div class="h-[145px] flex items-center justify-center overflow-hidden">
                  <PlayerCape :src="capeItem.url" />
                </div>
                <div class="font-semibold text-sm truncate text-center mt-2" :title="capeItem.name">{{ capeItem.name }}</div>
                <v-chip v-if="isEquipped(capeItem)" size="x-small" color="success" variant="tonal" class="absolute top-2 left-2">Надет</v-chip>
                <div class="flex justify-center gap-1 mt-2">
                  <v-btn icon="check" size="x-small" variant="text" :disabled="isEquipped(capeItem)" @click.stop="equip(capeItem)" />
                  <v-btn icon="edit" size="x-small" variant="text" @click.stop="edit(capeItem)" />
                  <v-btn icon="delete" size="x-small" variant="text" color="error" @click.stop="remove(capeItem)" />
                </div>
              </div>
            </div>
            <div v-else class="w-full h-full flex flex-col items-center justify-center text-center opacity-50 py-16">
              <v-icon size="56" class="mb-3">flag</v-icon>
              <div class="font-semibold">Плащей пока нет</div>
              <div class="text-xs mt-1">Добавь PNG плаща и нажми «Сохранить и надеть»</div>
            </div>
          </div>
        </template>
      </div>
    </v-card>
  </v-dialog>
</template>

<script lang="ts" setup>
import PlayerCape from '@/components/PlayerCape.vue'
import { getDropFilePaths } from '@/composables/dropHandler'
import { useUserCapeLibrary, type CapeLibraryItem } from '@/composables/userCapeLibrary'
import type { GameProfileAndTexture, UserProfile } from '@xmcl/runtime-api'

const props = defineProps<{
  modelValue: boolean
  user: UserProfile
  profile: GameProfileAndTexture
}>()

defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const { showOpenDialog } = windowController
const { capes, equippedCapeIds, refresh, addCape, updateCape, removeCape, setEquippedCape } = useUserCapeLibrary()

const selectedCape = ref<CapeLibraryItem | null>(null)
const searchQuery = ref('')
const editorOpen = ref(false)
const editingCape = ref<CapeLibraryItem | null>(null)
const draftName = ref('')
const draftUrl = ref('')
const errorMessage = ref('')
const accountKey = computed(() => `${props.user.id}:${props.profile.id}`)
const currentEquippedCapeId = computed(() => equippedCapeIds.value[accountKey.value] || '')
const isSelectedEquipped = computed(() => !!selectedCape.value && selectedCape.value.id === currentEquippedCapeId.value)
const canSaveDraft = computed(() => !!draftName.value.trim() && (!!editingCape.value || !!draftUrl.value))
const filteredCapes = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return capes.value
  return capes.value.filter(cape => cape.name.toLowerCase().includes(query))
})

watch(() => props.modelValue, async (open) => {
  if (!open) return
  errorMessage.value = ''
  editorOpen.value = false
  await refresh()
  selectedCape.value = capes.value.find(cape => cape.id === currentEquippedCapeId.value) || capes.value[0] || null
})

function isEquipped(cape: CapeLibraryItem) {
  return cape.id === currentEquippedCapeId.value
}

function openAddEditor() {
  editingCape.value = null
  draftName.value = ''
  draftUrl.value = ''
  errorMessage.value = ''
  editorOpen.value = true
}

function edit(cape: CapeLibraryItem) {
  editingCape.value = cape
  draftName.value = cape.name
  draftUrl.value = cape.url
  errorMessage.value = ''
  editorOpen.value = true
}

function closeEditor() {
  editorOpen.value = false
  editingCape.value = null
  errorMessage.value = ''
}

async function pickFile() {
  const { filePaths } = await showOpenDialog({
    title: 'Выбрать плащ',
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
  if (!draftName.value) draftName.value = filePath.split(/[/\\]/).pop()?.replace(/\.png$/i, '') || 'Cape'
}

async function saveDraft(equipImmediately: boolean) {
  if (!canSaveDraft.value) return
  try {
    if (editingCape.value) {
      const updated = await updateCape(editingCape.value.id, { name: draftName.value.trim() })
      selectedCape.value = updated
    } else {
      const created = await addCape({ name: draftName.value.trim(), url: draftUrl.value })
      selectedCape.value = created
      if (equipImmediately) await setEquippedCape(accountKey.value, created.id)
    }
    closeEditor()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
  }
}

async function equip(cape: CapeLibraryItem) {
  selectedCape.value = cape
  await equipSelected()
}

async function equipSelected() {
  if (!selectedCape.value) return
  try {
    await setEquippedCape(accountKey.value, selectedCape.value.id)
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
  }
}

async function unequipCape() {
  try {
    await setEquippedCape(accountKey.value, '')
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
  }
}

async function remove(cape: CapeLibraryItem) {
  try {
    await removeCape(cape.id)
    if (selectedCape.value?.id === cape.id) selectedCape.value = capes.value[0] || null
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<style scoped>
.cape-library-dialog {
  background: rgba(var(--v-theme-surface), 0.95);
  backdrop-filter: blur(20px);
}
.file-drop-zone {
  background: rgba(var(--v-theme-surface), 0.5);
}
</style>
