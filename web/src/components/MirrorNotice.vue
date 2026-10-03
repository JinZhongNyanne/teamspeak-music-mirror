<template>
  <aside v-if="store.isMirror" class="mirror-notice" aria-label="镜像机器人说明">
    <div>
      <strong>镜像机器人 · {{ store.activeBot?.name }}</strong>
      <p>原机器人：{{ store.activeBot?.mirrorSourceName || store.activeBot?.mirrorSourceBotId || '未指定' }} · {{ mirrorStateLabel(store.activeBot!) }}</p>
      <p>音乐、队列、音量与头像跟随原机器人。点歌和播放控制请切换到原机器人。</p>
    </div>
    <button v-if="source" @click="goToSource()">控制原机器人</button>
    <span v-else class="access-hint">当前账号无法访问原机器人</span>
  </aside>
</template>

<script setup lang="ts">
import { usePlayerStore } from '../stores/player.js';
import { mirrorStateLabel } from '../composables/mirrorBots.js';
import { useMirrorSourceNavigation } from '../composables/useMirrorSourceNavigation.js';
const store = usePlayerStore();
const { source, goToSource } = useMirrorSourceNavigation();
</script>

<style scoped lang="scss">
.mirror-notice { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px; margin-bottom: 24px; background: var(--color-primary-10); border: 1px solid var(--border-color); border-radius: var(--radius-md); font-size: 13px; }
p { margin: 6px 0 0; color: var(--text-secondary); line-height: 1.5; }
button { padding: 10px 14px; border-radius: var(--radius-sm); background: var(--color-primary); color: white; flex-shrink: 0; }
.access-hint { font-size: 12px; color: var(--text-tertiary); }
@media (max-width: 768px) { .mirror-notice { align-items: flex-start; flex-direction: column; gap: 12px; } }
</style>
