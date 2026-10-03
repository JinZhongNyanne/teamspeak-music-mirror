<template>
  <form class="bot-form" @submit.prevent="save">
    <p v-if="loading" class="hint" role="status">读取机器人配置中…</p>
    <p v-if="legacyLocked" class="notice">此机器人的镜像方案由部署配置文件指定（legacy mirror.sourceBotId），网页不能更改方案或原机器人。请在部署配置中修改并重启服务。</p>
    <p v-else-if="sourceUnavailable" class="notice">当前账号无法访问原机器人，镜像关系为只读。请由有权访问原机器人的管理员修改。</p>
    <p v-if="connected" class="notice">机器人正在运行。修改方案、连接信息或目标频道前，请先停止机器人；名称可直接保存。</p>
    <fieldset :disabled="loading || saving || !!loadError">
      <label>名称<input v-model="form.name" required maxlength="100" placeholder="我的音乐机器人" /></label>
      <label>机器人方案
        <select aria-label="机器人方案" v-model="mode" :disabled="connectionLocked || relationLocked">
          <option value="music">独立播放</option>
          <option value="mirror">镜像机器人</option>
        </select>
      </label>
      <p class="hint">{{ mode === 'mirror' ? '将同一 TeamSpeak 服务器上的原机器人音频同步到另一个固定频道。可创建多个镜像，原机器人离线时会等待，不会替你启动原机器人。' : '拥有独立的播放器、播放队列和音乐控制。' }}</p>
      <template v-if="mode === 'mirror'">
        <label>原机器人
          <select aria-label="原机器人" v-model="form.mirrorSourceBotId" :disabled="connectionLocked || relationLocked || sourceLoading" :required="!sourceUnavailable" @change="loadSource">
            <option value="">{{ sourceUnavailable ? '无权访问原机器人' : '请选择原机器人' }}</option>
            <option v-if="form.mirrorSourceBotId && !sources.some(bot => bot.id === form.mirrorSourceBotId)" :value="form.mirrorSourceBotId">{{ props.bot?.mirrorSourceName || '当前原机器人（不可选择）' }}</option>
            <option v-for="bot in sources" :key="bot.id" :value="bot.id">{{ bot.name }}{{ bot.connected ? '' : '（离线）' }}</option>
          </select>
        </label>
        <p v-if="!sources.length && !relationLocked" class="hint">没有可用的原机器人。请先创建独立播放实例，或获取该实例的访问权限。</p>
        <p v-if="sourceLoading" class="hint" role="status">正在读取原机器人的服务器地址…</p>
      </template>
      <div class="form-row">
        <label class="server-field">服务器地址<input v-model="form.serverAddress" required :readonly="mode === 'mirror'" :disabled="connectionLocked" placeholder="ts.example.com" /></label>
        <label>端口<input v-model.number="form.serverPort" type="number" min="1" max="65535" required :readonly="mode === 'mirror'" :disabled="connectionLocked" /></label>
      </div>
      <p v-if="mode === 'mirror'" class="hint">服务器地址与端口跟随原机器人。镜像仅支持同一服务器。</p>
      <label>昵称<input v-model="form.nickname" :disabled="connectionLocked" placeholder="MusicBot" /></label>
      <label v-if="mode === 'music'">默认频道名称（可选）<input v-model="form.defaultChannel" :disabled="connectionLocked || !!form.channelId" placeholder="音乐频道" /></label>
      <label>{{ mode === 'mirror' ? '镜像目标频道 ID（必填）' : '默认频道 ID（可选）' }}
        <input v-model="form.channelId" inputmode="numeric" :required="mode === 'mirror'" pattern="[1-9][0-9]*" :disabled="connectionLocked || (mode === 'music' && !!form.defaultChannel)" placeholder="如 12" />
      </label>
      <label>频道密码（可选）<input v-model="form.channelPassword" type="password" autocomplete="new-password" :disabled="connectionLocked" /></label>
      <label>服务器密码（可选）<input v-model="form.serverPassword" type="password" autocomplete="new-password" :disabled="connectionLocked" /></label>
      <p v-if="mode === 'mirror'" class="hint">头像自动跟随原机器人，镜像不使用独立自定义头像。</p>
      <label v-else>自定义头像（可选）
        <CustomAvatarRow v-if="props.bot" :bot-id="props.bot.id" />
        <AvatarUpload v-else v-model="avatar" />
      </label>
      <label v-if="!props.bot" class="checkbox-label"><input v-model="autoStart" type="checkbox" />创建后启动机器人</label>
    </fieldset>
    <p v-if="error || loadError" class="error" role="alert">{{ error || loadError }}</p>
    <div class="actions">
      <button v-if="props.bot" type="button" :disabled="saving" @click="emit('cancel')">取消</button>
      <button v-if="loadError" type="button" @click="loadConfig">重试读取</button>
      <button v-if="sourceError" type="button" @click="loadSource">重试读取原机器人</button>
      <button class="primary" type="submit" :disabled="loading || saving || sourceLoading || !!loadError || !!sourceError">{{ saving ? '保存中…' : props.bot ? '保存' : '创建' }}</button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import axios from 'axios';
import { usePlayerStore, type BotStatus } from '../stores/player.js';
import { useSession } from '../composables/useSession.js';
import { botRequestError, eligibleMirrorSources, isMirrorBot, validChannelId } from '../composables/mirrorBots.js';
import AvatarUpload from './AvatarUpload.vue';
import CustomAvatarRow from './CustomAvatarRow.vue';

const props = defineProps<{ bot?: BotStatus }>();
const emit = defineEmits<{ saved: []; cancel: [] }>();
const store = usePlayerStore();
const session = useSession();
const mode = ref<'music' | 'mirror'>(isMirrorBot(props.bot) ? 'mirror' : 'music');
const form = reactive({ name: props.bot?.name ?? '', serverAddress: '', serverPort: 9987, nickname: 'MusicBot', defaultChannel: '', channelId: '', channelPassword: '', serverPassword: '', mirrorSourceBotId: props.bot?.mirrorSourceBotId ?? '' });
const loading = ref(!!props.bot);
const saving = ref(false);
const sourceLoading = ref(false);
const error = ref('');
const loadError = ref('');
const sourceError = ref('');
const legacyLocked = ref(!!props.bot?.mirrorConfigLocked && props.bot?.mirrorSourceAccessible !== false);
const sourceUnavailable = ref(props.bot?.mirrorSourceAccessible === false);
const avatar = ref<string | null>(null);
const autoStart = ref(false);
const connected = computed(() => store.bots.find(bot => bot.id === props.bot?.id)?.connected ?? false);
const relationLocked = computed(() => legacyLocked.value || sourceUnavailable.value);
const connectionLocked = computed(() => !!props.bot && (connected.value || relationLocked.value));
const sources = computed(() => eligibleMirrorSources(store.bots, props.bot?.id, session.canControlBot));
let sourceRequest = 0;

watch(mode, (value) => {
  error.value = '';
  sourceError.value = '';
  sourceRequest++;
  sourceLoading.value = false;
  if (value === 'mirror') form.defaultChannel = '';
  else form.mirrorSourceBotId = '';
  if (!props.bot) autoStart.value = value === 'mirror';
});

async function loadConfig() {
  if (!props.bot) return;
  loading.value = true;
  loadError.value = '';
  try {
    const { data } = await axios.get(`/api/bot/${props.bot.id}/config`);
    for (const key of ['serverAddress', 'nickname', 'defaultChannel', 'channelPassword', 'serverPassword', 'mirrorSourceBotId'] as const) form[key] = data[key] ?? '';
    form.serverPort = data.serverPort ?? 9987;
    form.channelId = String(data.channelId ?? data.fixedChannelId ?? '');
    sourceUnavailable.value = data.mirrorSourceAccessible === false || props.bot.mirrorSourceAccessible === false;
    legacyLocked.value = !!data.mirrorConfigLocked && !sourceUnavailable.value;
    mode.value = isMirrorBot(data) || isMirrorBot(props.bot) ? 'mirror' : 'music';
  } catch (e) {
    loadError.value = botRequestError(e, '读取配置失败，请重试后再保存。');
  } finally { loading.value = false; }
}

async function loadSource() {
  const request = ++sourceRequest;
  error.value = '';
  sourceError.value = '';
  if (!form.mirrorSourceBotId) { sourceLoading.value = false; return; }
  sourceLoading.value = true;
  try {
    const { data } = await axios.get(`/api/bot/${form.mirrorSourceBotId}/config`);
    if (request !== sourceRequest || mode.value !== 'mirror') return;
    form.serverAddress = data.serverAddress ?? '';
    form.serverPort = data.serverPort ?? 9987;
  } catch (e) {
    if (request !== sourceRequest) return;
    sourceError.value = botRequestError(e, '读取原机器人配置失败，请重新选择。');
    error.value = sourceError.value;
  } finally { if (request === sourceRequest) sourceLoading.value = false; }
}

async function save() {
  if (loading.value || saving.value || sourceLoading.value || loadError.value || sourceError.value) return;
  error.value = '';
  if (mode.value === 'mirror' && !sourceUnavailable.value && !form.mirrorSourceBotId) { error.value = '请选择原机器人。'; return; }
  if (mode.value === 'mirror' && !validChannelId(form.channelId)) { error.value = '请输入有效的正整数目标频道 ID。'; return; }
  saving.value = true;
  try {
    // Hidden/legacy source relationships must never be cleared by a partial edit.
    const { mirrorSourceBotId, ...configuration } = form;
    const payload = { ...configuration, name: form.name.trim(), serverAddress: form.serverAddress.trim(), channelId: form.channelId.trim(), nickname: form.nickname.trim() || form.name.trim(), defaultChannel: mode.value === 'mirror' ? '' : form.defaultChannel, ...(!relationLocked.value ? { mirrorSourceBotId: mode.value === 'mirror' ? mirrorSourceBotId : '' } : {}) };
    if (props.bot) await axios.put(`/api/bot/${props.bot.id}`, connectionLocked.value ? { name: payload.name } : payload);
    else {
      const { data } = await axios.post('/api/bot', { ...payload, autoStart: autoStart.value });
      store.notify('机器人已创建', 'info');
      if (mode.value === 'music' && avatar.value && data.id) {
        try { await axios.put(`/api/bot/${data.id}/avatar`, { dataUrl: avatar.value }); }
        catch (e) { store.notify(botRequestError(e, '机器人已创建，但头像保存失败，请在编辑中重试。'), 'error'); }
      }
      if (autoStart.value && data.id) {
        try { await axios.post(`/api/bot/${data.id}/start`); }
        catch (e) { store.notify(botRequestError(e, '机器人已创建，但启动失败，请检查连接后点击启动。'), 'error'); }
      }
    }
    await store.fetchBots();
    emit('saved');
  } catch (e) { error.value = botRequestError(e, '保存失败，请检查配置后重试。'); }
  finally { saving.value = false; }
}

onMounted(loadConfig);
</script>

<style scoped lang="scss">
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
label { display: block; margin-bottom: 12px; font-size: 13px; font-weight: 500; }
input:not([type='checkbox']), select { display: block; width: 100%; margin-top: 5px; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--hover-bg); color: var(--text-primary); font: inherit; }
input:focus, select:focus { outline: 2px solid var(--color-primary); outline-offset: 1px; }
input:disabled, select:disabled { opacity: .6; cursor: not-allowed; }
.form-row { display: flex; gap: 12px; }
.form-row > label { flex: 1; min-width: 0; }
.form-row .server-field { flex: 3; }
.hint, .notice { font-size: 12px; color: var(--text-secondary); line-height: 1.6; margin: 0 0 14px; }
.notice { padding: 12px; background: var(--color-paused-15); border-radius: var(--radius-sm); }
.checkbox-label { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
button { padding: 10px 16px; background: var(--hover-bg); border-radius: var(--radius-sm); font-size: 13px; }
button.primary { background: var(--color-primary); color: white; }
button:disabled { opacity: .5; cursor: not-allowed; }
.error { color: #e26a6a; font-size: 13px; line-height: 1.5; }
</style>
