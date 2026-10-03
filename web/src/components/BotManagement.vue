<template>
  <section class="bot-management">
    <h2>机器人管理</h2>
    <p v-if="!store.bots.length" class="hint">还没有机器人。先创建一个独立播放实例，再添加镜像。</p>
    <div class="bot-list">
      <article v-for="bot in store.bots" :key="bot.id" class="bot-item">
        <div class="bot-info">
          <div class="bot-title"><strong>{{ bot.name }}</strong><span class="mode-badge">{{ isMirrorBot(bot) ? '镜像' : '独立播放' }}</span></div>
          <p v-if="isMirrorBot(bot)" class="hint">原机器人：{{ bot.mirrorSourceName || (bot.mirrorSourceAccessible === false ? '无权访问' : bot.mirrorSourceBotId || '未指定') }}<template v-if="bot.fixedChannelId"> · 目标频道 {{ bot.fixedChannelId }}</template></p>
          <p class="status" :class="{ connected: bot.connected }">{{ isMirrorBot(bot) ? mirrorStateLabel(bot) : !bot.connected ? '离线' : bot.playing ? '播放中' : bot.paused ? '已暂停' : '在线' }}</p>
        </div>
        <div class="bot-actions">
          <button v-if="isMirrorBot(bot) && accessibleSource(bot.id)" @click="goToSource(bot.id)">控制原机器人</button>
          <button :disabled="!!busy[bot.id]" @click="togglePower(bot)">{{ busy[bot.id] ? '处理中…' : bot.connected ? '停止' : '启动' }}</button>
          <button :disabled="!!busy[bot.id]" @click="editingBot = bot" :aria-label="`编辑 ${bot.name}`"><Icon icon="mdi:pencil" /></button>
          <button class="danger" :disabled="!!busy[bot.id]" @click="deleteBot(bot)" :aria-label="`删除 ${bot.name}`"><Icon icon="mdi:delete" /></button>
        </div>
      </article>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="create-bot">
      <h3>创建新实例</h3>
      <BotInstanceForm :key="createVersion" @saved="createVersion++" />
    </div>
    <div v-if="editingBot" class="modal-overlay" @click.self="editingBot = null" @keydown.esc="editingBot = null">
      <div class="edit-modal" role="dialog" aria-modal="true" aria-labelledby="bot-edit-title" tabindex="-1" ref="dialogRef">
        <h3 id="bot-edit-title">编辑机器人 · {{ editingBot.name }}</h3>
        <BotInstanceForm :bot="editingBot" :key="editingBot.id" @saved="editingBot = null" @cancel="editingBot = null" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, reactive, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore, type BotStatus } from '../stores/player.js';
import { botRequestError, isMirrorBot, mirrorStateLabel } from '../composables/mirrorBots.js';
import { useMirrorSourceNavigation } from '../composables/useMirrorSourceNavigation.js';
import BotInstanceForm from './BotInstanceForm.vue';
const store = usePlayerStore();
const { accessibleSource, goToSource } = useMirrorSourceNavigation();
const editingBot = ref<BotStatus | null>(null);
const createVersion = ref(0);
const busy = reactive<Record<string, boolean>>({});
const error = ref('');
const dialogRef = ref<HTMLElement | null>(null);
let priorFocus: HTMLElement | null = null;
watch(editingBot, async (bot) => {
  if (bot) { priorFocus = document.activeElement as HTMLElement; await nextTick(); dialogRef.value?.focus(); }
  else priorFocus?.focus();
});

async function togglePower(bot: BotStatus) {
  busy[bot.id] = true;
  error.value = '';
  try { await axios.post(`/api/bot/${bot.id}/${bot.connected ? 'stop' : 'start'}`); await store.fetchBots(); }
  catch (e) { error.value = botRequestError(e, '启动或停止失败，请重试。'); }
  finally { busy[bot.id] = false; }
}

async function deleteBot(bot: BotStatus) {
  if (!confirm(`确认删除机器人 "${bot.name}"？此操作不可撤销。`)) return;
  busy[bot.id] = true;
  error.value = '';
  try {
    await axios.delete(`/api/bot/${bot.id}`);
    if (store.activeBotId === bot.id) store.activeBotId = null;
    store.removeBotStatus(bot.id);
    await store.fetchBots();
  } catch (e) { error.value = botRequestError(e, '删除失败，请重试。'); }
  finally { busy[bot.id] = false; }
}
</script>

<style scoped lang="scss">
.bot-management { margin-bottom: 36px; padding: 24px; background: var(--bg-card); border-radius: var(--radius-lg); }
h2 { font-size: 18px; margin-bottom: 16px; }
h3 { font-size: 16px; margin-bottom: 16px; }
.bot-list { display: flex; flex-direction: column; gap: 8px; }
.bot-item { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; background: var(--hover-bg); border-radius: var(--radius-md); }
.bot-info { min-width: 0; }
.bot-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; overflow-wrap: anywhere; }
.mode-badge { font-size: 11px; background: var(--color-primary-10); color: var(--color-primary); padding: 3px 6px; border-radius: var(--radius-sm); }
.hint, .status { font-size: 12px; color: var(--text-secondary); margin: 6px 0 0; line-height: 1.5; overflow-wrap: anywhere; }
.status.connected { color: var(--color-online); }
.bot-actions { display: flex; flex-wrap: wrap; gap: 6px; flex-shrink: 0; }
button { padding: 8px 12px; border-radius: var(--radius-sm); background: var(--bg-card); font-size: 12px; }
button:disabled { opacity: .5; cursor: not-allowed; }
button.danger:hover { color: #e26a6a; }
.create-bot { border-top: 1px solid var(--border-color); padding-top: 20px; margin-top: 20px; }
.error { color: #e26a6a; font-size: 13px; margin: 12px 0; }
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 200; display: flex; justify-content: center; align-items: center; padding: 16px; }
.edit-modal { width: 520px; max-width: 100%; max-height: 85vh; overflow-y: auto; background: var(--bg-secondary); border-radius: var(--radius-lg); padding: 24px; }
@media (max-width: 768px) { .bot-management { padding: 16px; } .bot-item { align-items: flex-start; flex-direction: column; gap: 10px; } .bot-actions { width: 100%; } button { min-height: 40px; } .edit-modal { padding: 18px; } }
</style>
