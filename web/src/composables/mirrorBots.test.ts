import { describe, expect, it } from 'vitest';
import { eligibleMirrorSources, isMirrorBot, mirrorStateLabel, validChannelId } from './mirrorBots.js';
import type { BotStatus } from '../stores/player.js';

const bot = (id: string, extra: Partial<BotStatus> = {}): BotStatus => ({ id, name: id, connected: false, playing: false, paused: false, currentSong: null, queueSize: 0, volume: 50, playMode: 'seq', ...extra });

describe('mirror bot presentation and configuration', () => {
  it('recognizes a mirror when its source ID is masked by permissions', () => {
    expect(isMirrorBot(bot('mirror', { mode: 'mirror', mirrorSourceAccessible: false }))).toBe(true);
    expect(isMirrorBot(bot('legacy', { mirrorSourceBotId: 'source' }))).toBe(true);
    expect(isMirrorBot(bot('music'))).toBe(false);
  });

  it('offers accessible independent sources, including offline sources, without chains or self-reference', () => {
    const bots = [bot('source'), bot('offline'), bot('self'), bot('private'), bot('mirror', { mode: 'mirror' }), bot('legacy', { mirrorSourceBotId: 'source' })];
    expect(eligibleMirrorSources(bots, 'self', id => id !== 'private').map(bot => bot.id)).toEqual(['source', 'offline']);
  });

  it.each(['', '0', '-1', '1.5', '1e2', 'abc', '01', '9007199254740992'])('rejects invalid fixed channel ID %j', value => {
    expect(validChannelId(value)).toBe(false);
  });

  it('accepts a positive integer channel ID', () => {
    expect(validChannelId('12')).toBe(true);
    expect(validChannelId(' 12 ')).toBe(true);
  });

  it('distinguishes an offline source from an offline mirror output', () => {
    expect(mirrorStateLabel(bot('mirror', { connected: true, mirrorState: 'source-offline' }))).toBe('原机器人离线');
    expect(mirrorStateLabel(bot('mirror', { mirrorState: 'output-offline' }))).toBe('镜像未连接');
    expect(mirrorStateLabel(bot('mirror', { mirrorState: 'syncing' }))).toBe('同步播放中');
    expect(mirrorStateLabel(bot('mirror', { mirrorState: 'idle' }))).toBe('等待原机器人播放');
  });
});
