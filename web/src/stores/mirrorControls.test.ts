import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import axios from 'axios';
import { usePlayerStore, type Song } from './player.js';

const song: Song = { id: 'song', name: 'Song', artist: '', album: '', duration: 120, coverUrl: '', platform: 'netease' };

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.restoreAllMocks());

describe('mirror player write protection', () => {
  it('blocks every transport and queue action without posting to either the mirror or its source', async () => {
    const post = vi.spyOn(axios, 'post');
    const get = vi.spyOn(axios, 'get');
    const store = usePlayerStore();
    store.bots = [{ id: 'mirror', name: 'Mirror', connected: true, playing: true, paused: false, currentSong: song, queueSize: 1, volume: 50, playMode: 'seq', mode: 'mirror', mirrorSourceBotId: 'source' }];
    store.activeBotId = 'mirror';
    const originalBot = { ...store.activeBot };
    await store.playAtIndex(0);
    await store.play('song');
    await store.playById('song');
    await store.playSong(song);
    await store.playNextSong(song);
    await store.addToQueue('song');
    await store.addToQueueById('song');
    await store.addSong(song);
    await store.playPlaylist('playlist');
    await store.playAlbum('album');
    await store.playArtist('artist');
    await store.pause();
    await store.resume();
    await store.next();
    await store.prev();
    await store.stop();
    await store.seek(60);
    await store.setVolume(90);
    await store.setMode('random');
    await store.startFm();
    await store.playJellyfinGenre('genre');
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(store.activeBot).toEqual(originalBot);
    expect(store.timings).toEqual({});
    expect(store.activeBotId).toBe('mirror');
    expect(store.notification?.message).toContain('原机器人');
  });

  it('still permits an independent bot to change volume', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    const store = usePlayerStore();
    store.bots = [{ id: 'source', name: 'Source', connected: true, playing: false, paused: false, currentSong: null, queueSize: 0, volume: 50, playMode: 'seq', mode: 'music' }];
    store.activeBotId = 'source';
    await store.setVolume(90);
    expect(post).toHaveBeenCalledWith('/api/player/source/volume', { volume: 90 });
    expect(store.activeBot?.volume).toBe(90);
  });

  it('does not write to a mirror selected while Bilibili metadata is loading', async () => {
    const post = vi.spyOn(axios, 'post');
    const store = usePlayerStore();
    store.bots = [
      { id: 'source', name: 'Source', connected: true, playing: false, paused: false, currentSong: null, queueSize: 0, volume: 50, playMode: 'seq', mode: 'music' },
      { id: 'mirror', name: 'Mirror', connected: true, playing: false, paused: false, currentSong: null, queueSize: 0, volume: 50, playMode: 'seq', mode: 'mirror' },
    ];
    store.activeBotId = 'source';
    vi.spyOn(store, 'checkBilibiliMultiPart').mockImplementation(async () => {
      store.activeBotId = 'mirror';
      return false;
    });
    const biliSong: Song = { ...song, platform: 'bilibili', id: 'BVtest' };
    for (const action of ['playSong', 'playNextSong', 'addSong'] as const) {
      store.activeBotId = 'source';
      await store[action](biliSong);
    }
    expect(post).not.toHaveBeenCalled();
  });
});
