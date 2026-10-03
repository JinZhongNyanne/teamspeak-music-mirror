import type { BotInstance } from "../bot/instance.js";
import type { BotManager } from "../bot/manager.js";

export function canAccessBot(scope: "all" | Set<string> | undefined, id: string): boolean {
  return scope === "all" || scope?.has(id) === true;
}

/** Apply the same mirror metadata and source visibility to HTTP and sockets. */
export function botStatusForScope(manager: BotManager, bot: BotInstance, scope: "all" | Set<string> | undefined) {
  const info = manager.getBotMirrorInfo?.(bot.id);
  if (!info) return bot.getStatus();
  const accessible = !info.mirrorSourceBotId || canAccessBot(scope, info.mirrorSourceBotId);
  return {
    ...bot.getStatus(), ...info,
    mirrorSourceAccessible: accessible,
    ...(!accessible ? { mirrorSourceBotId: undefined, mirrorSourceName: undefined } : {}),
  };
}
