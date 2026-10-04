<template>
  <div
    class="relative flex flex-col items-center justify-center gap-2"
    @mouseenter="hover = true"
    @mouseleave="hover = false"
  >
    <div class="absolute top-4 flex flex-none flex-shrink gap-4">
      <v-fab-transition>
        <v-btn
          v-if="inspect && modified"
          icon="clear"
          color="secondary"
          size="small"
          style="z-index: 3"
          :disabled="pending"
          @click="reset"
        />
      </v-fab-transition>
    </div>
    <!-- Slim/Classic toggle (top-right, hover only) -->
    <transition name="fade-transition">
      <v-btn-toggle
        v-if="!hideControls && hover && canUploadSkin"
        v-model="slimToggle"
        mandatory
        density="compact"
        class="absolute top-2 right-2 skin-model-toggle"
        style="z-index: 3;"
        rounded="lg"
      >
        <v-btn
          v-shared-tooltip.top="() => t('userSkin.classic')"
          size="x-small"
          :value="false"
        >
          <v-icon size="16">accessibility_new</v-icon>
        </v-btn>
        <v-btn
          v-shared-tooltip.top="() => t('userSkin.slim')"
          size="x-small"
          :value="true"
        >
          <v-icon size="16">accessibility</v-icon>
        </v-btn>
      </v-btn-toggle>
    </transition>
    <SkinView
      :paused="paused"
      :height="300"
      :skin="skin"
      :slim="inferModelType ? undefined : slim"
      :cape="displayCapeUrl"
      :name="''"
      :animation="hover ? 'running' : selected ? 'walking' : 'idle'"
      @model="onModelChange"
      @error="onPreviewError"
      @drop.prevent="dropSkin"
      @dragover.prevent="() => {}"
    />
    <div v-if="!hideControls" class="absolute bottom-4 flex flex-none flex-shrink gap-4">
      <v-fab-transition>
        <v-btn
          v-show="!inspect && modified"
          v-shared-tooltip="() => t('userSkin.reset')"
          icon="clear"
          color="secondary"
          size="small"
          style="z-index: 3;"
          :disabled="pending"
          @click="reset"
        />
      </v-fab-transition>
      <SpeedDial
        :value="hover || modified"
        :has-skin="canUploadSkin"
        :has-cape="canUploadCape"
        :disabled="pending"
        :open-library="() => (isSkinLibraryDialogShown = true)"
        :upload="() => (isImportSkinDialogShown = true)"
        :save="exportSkin"
        :load="loadSkin"
      />
      <v-fab-transition>
        <v-btn
          v-show="!inspect && modified"
          icon="save"
          color="secondary"
          size="small"
          style="z-index: 3"
          :disabled="pending"
          @click="save_"
        />
      </v-fab-transition>
    </div>
    <v-dialog v-model="isImportSkinDialogShown" width="400">
      <ImportSkinUrlForm @input="importSkinFromUrl" />
    </v-dialog>
    <UserSkinLibraryDialog
      v-model="isSkinLibraryDialogShown"
      :user="user"
      :profile="profile"
    />
  </div>
</template>

<script lang="ts" setup>
import SkinView from '@/components/SkinView.vue'
import UserSkinLibraryDialog from '@/components/UserSkinLibraryDialog.vue'
import { getDropFilePaths } from '@/composables/dropHandler'
import { useLocalCapeUrl } from '@/composables/userCapeLibrary'
import { useUserSkinLibrary } from '@/composables/userSkinLibrary'
import { vSharedTooltip } from '@/directives/sharedTooltip'
import { GameProfileAndTexture, UserProfile } from '@xmcl/runtime-api'
import { useNotifier } from '../composables/notifier'
import { useLocaleError } from '../composables/error'
import {
  PlayerNameModel,
  UserSkinModel,
  UserSkinRenderPaused,
  usePlayerName,
  useUserSkin,
} from '../composables/userSkin'
import ImportSkinUrlForm from './UserSkinImportUrlForm.vue'
import SpeedDial from './UserSkinSpeedDial.vue'

const props = withDefaults(
  defineProps<{
    user: UserProfile
    profile: GameProfileAndTexture
    inspect?: boolean
    hideControls?: boolean
  }>(),
  { inspect: false, hideControls: false },
)
const { t } = useI18n()
const hover = ref(false)
const { notify } = useNotifier()
const toLocaleError = useLocaleError()
const {
  customSkins,
  addSkin: addSkinToLibrary,
  updateSkin: updateLibrarySkin,
} = useUserSkinLibrary()

const gameProfile = computed(() => props.profile)
const selected = computed(() => props.user.selectedProfile === props.profile.id)
const name = inject(PlayerNameModel, () => usePlayerName(gameProfile), true)

const {
  skin,
  slim,
  save,
  exportTo,
  loading,
  modified,
  reset,
  inferModelType,
  cape,
  canUploadCape,
  canUploadSkin,
} = inject(
  UserSkinModel,
  () =>
    useUserSkin(
      computed(() => props.user.id),
      gameProfile,
      computed(() => props.user),
    ),
  true,
)
const paused = inject(UserSkinRenderPaused, () => ref(false), true)
const pending = computed(() => loading.value)

// Local wardrobe capes are what `prepareLaunchCape` exports to the game and what
// the wardrobe preview renders; `cape` is the Mojang cape kept on the profile.
// Only the first one is visible from the side panel without this.
const localCapeUrl = useLocalCapeUrl(computed(() => props.user.id), gameProfile)
const displayCapeUrl = computed(() => localCapeUrl.value || cape.value || '')

const slimToggle = computed({
  get: () => slim.value,
  set: (v: boolean) => { slim.value = v; inferModelType.value = false },
})
const { showOpenDialog, showSaveDialog } = windowController
const isImportSkinDialogShown = ref(false)
const isSkinLibraryDialogShown = ref(false)
const pendingLibraryImport = ref<{ source: string; name: string } | null>(null)

function getSkinName(source: string) {
  const clean = source.split(/[?#]/, 1)[0]
  const fileName = clean.split(/[/\\]/).pop() || ''
  try {
    return decodeURIComponent(fileName).replace(/\.png$/i, '') || 'Skin'
  } catch {
    return fileName.replace(/\.png$/i, '') || 'Skin'
  }
}

function stageImportedSkin(source: string, displayName?: string) {
  pendingLibraryImport.value = {
    source,
    name: displayName || getSkinName(source),
  }
  inferModelType.value = true
  skin.value = source
}

async function persistImportedSkin(modelType: 'default' | 'slim') {
  const pendingImport = pendingLibraryImport.value
  if (!pendingImport) return

  // Clear first so repeated skinview3d model events cannot create duplicates.
  pendingLibraryImport.value = null
  const isSlim = modelType !== 'default'

  try {
    const existing = customSkins.value.find(item => item.source === pendingImport.source || item.url === pendingImport.source)
    if (existing) {
      if (existing.slim !== isSlim) {
        await updateLibrarySkin(existing.id, { slim: isSlim })
      }
      return
    }

    await addSkinToLibrary({
      name: pendingImport.name,
      url: pendingImport.source,
      slim: isSlim,
    })
  } catch (e) {
    notify({
      level: 'error',
      title: 'Не удалось сохранить скин в локальный гардероб',
      body: toLocaleError(e),
    })
  }
}

const onModelChange = (modelType: 'default' | 'slim') => {
  if (inferModelType.value) {
    console.log('infer model ' + modelType)
    slim.value = modelType !== 'default'
    inferModelType.value = false
  }
  if (pendingLibraryImport.value) {
    void persistImportedSkin(modelType)
  }
}
const onPreviewError = (error: string) => {
  pendingLibraryImport.value = null
  if (error === 'invalid-skin-size') {
    notify({
      level: 'error',
      title: t('userSkin.invalidImageTitle'),
      body: t('userSkin.invalidImage'),
    })
  }
}

async function loadSkin() {
  if (!canUploadSkin.value) return
  const { filePaths } = await showOpenDialog({
    title: t('userSkin.importFile'),
    filters: [{ extensions: ['png'], name: 'PNG Images' }],
  })
  if (filePaths && filePaths[0]) {
    const filePath = filePaths[0]
    stageImportedSkin(`http://launcher/media?path=${filePath}`, getSkinName(filePath))
  }
}
function importSkinFromUrl(url: string) {
  isImportSkinDialogShown.value = false
  stageImportedSkin(url)
}
async function exportSkin() {
  const { filePath } = await showSaveDialog({
    title: t('userSkin.saveTitle'),
    defaultPath: `${name.value}.png`,
    filters: [{ extensions: ['png'], name: 'PNG Images' }],
  })
  if (filePath) {
    exportTo({ path: filePath, url: skin.value })
  }
}
async function dropSkin(e: DragEvent) {
  if (!canUploadSkin.value) return
  if (e.dataTransfer) {
    const [filePath] = getDropFilePaths(e.dataTransfer.files)
    if (filePath) {
      stageImportedSkin(`http://launcher/media?path=${filePath}`, getSkinName(filePath))
    }
  }
}

const save_ = async () => {
  try {
    await save()
    notify({ level: 'success', title: t('userSkin.upload') })
  } catch (e) {
    notify({
      level: 'error',
      title: t('userSkin.uploadFailed'),
      body: toLocaleError(e),
    })
  }
}
</script>

<style>
.my-slider-x-transition-enter-active {
  transition: 0.3 cubic-bezier(0.25, 0.8, 0.5, 1);
}

.my-slider-x-transition-leave-active {
  transition: 0.3 cubic-bezier(0.25, 0.8, 0.5, 1);
}

.my-slider-x-transition-move {
  transition: transform 0.6s;
}

.my-slider-x-transition-enter {
  transform: translateX(100%);
}

.my-slider-x-transition-leave-to {
  transform: translateX(100%);
}

.skin-model-toggle {
  background: rgba(var(--v-theme-on-surface), 0.08) !important;
  backdrop-filter: blur(8px);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1) !important;
}

.skin-model-toggle .v-btn {
  color: rgba(var(--v-theme-on-surface), 0.5) !important;
}

.skin-model-toggle .v-btn--active {
  color: rgb(var(--v-theme-on-surface)) !important;
  background: rgba(var(--v-theme-on-surface), 0.12) !important;
}
</style>
