import type { BotStatus } from '../stores/player.js';

export function isMirrorBot(bot: Pick<BotStatus, 'mode' | 'mirrorSourceBotId'> | null | undefined): boolean {
  return bot?.mode === 'mirror' || !!bot?.mirrorSourceBotId;
}

export function mirrorStateLabel(bot: Pick<BotStatus, 'mirrorState' | 'connected'>): string {
  switch (bot.mirrorState) {
    case 'source-offline': return '原机器人离线';
    case 'output-offline': return '镜像未连接';
    case 'syncing': return '同步播放中';
    case 'idle': return '等待原机器人播放';
    default: return bot.connected ? '等待同步' : '镜像未连接';
  }
}

export function eligibleMirrorSources(bots: BotStatus[], excludeId: string | undefined, canAccess: (id: string) => boolean): BotStatus[] {
  return bots.filter((bot) => bot.id !== excludeId && !isMirrorBot(bot) && canAccess(bot.id));
}

export function validChannelId(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim()) && Number.isSafeInteger(Number(value.trim()));
}

export function botRequestError(error: unknown, fallback: string): string {
  const message = (error as { response?: { data?: { error?: string; message?: string } } })?.response?.data;
  const raw = message?.error || message?.message;
  if (!raw) return fallback;
  if (raw.includes('Stop the bot before changing')) return '请先停止机器人，再修改方案、连接信息或目标频道。';
  if (raw.includes('Mirror configuration is locked')) return '镜像关联由部署配置文件锁定，请先修改部署配置并重启服务。';
  if (raw.includes('cannot mirror itself')) return '机器人不能镜像自身，请选择另一个独立播放实例。';
  if (raw.includes('chains and cycles')) return '不能镜像另一个镜像机器人，请选择独立播放实例。';
  if (raw.includes('fixed positive channelId')) return '镜像需要有效的正整数目标频道 ID。';
  if (raw.includes('same TeamSpeak server')) return '镜像和原机器人必须使用相同的 TeamSpeak 服务器地址与端口。';
  if (raw.includes('Mirror source bot') && raw.includes('does not exist')) return '原机器人已不存在，请刷新后重新选择。';
  return raw;
}
