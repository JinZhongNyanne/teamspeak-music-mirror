import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { usePlayerStore } from '../stores/player.js';
import { useSession } from './useSession.js';
import { isMirrorBot } from './mirrorBots.js';

export function useMirrorSourceNavigation() {
  const store = usePlayerStore();
  const session = useSession();
  const router = useRouter();
  function accessibleSource(botId?: string) {
    const mirror = store.bots.find((bot) => bot.id === (botId ?? store.activeBotId));
    const source = store.bots.find((bot) => bot.id === mirror?.mirrorSourceBotId);
    return source && !isMirrorBot(source) && session.canControlBot(source.id) ? source : null;
  }
  const source = computed(() => accessibleSource());
  async function goToSource(botId?: string) {
    const target = accessibleSource(botId);
    if (!target) return;
    store.clearScope();
    store.setActiveBotId(target.id);
    await router.push({ path: '/', query: { bot: target.id } });
  }
  return { source, accessibleSource, goToSource };
}
