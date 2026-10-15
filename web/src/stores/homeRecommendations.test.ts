import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import axios from 'axios';
import { usePlayerStore, type PlaylistItem } from './player.js';

const playlist = (id: string, platform = 'qq'): PlaylistItem => ({
  id, name: id, coverUrl: '', songCount: 10, platform,
});

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.restoreAllMocks());

describe('refreshRecommendPlaylists', () => {
  it('requests a new batch despite a fresh home cache and replaces only the selected section', async () => {
    const store = usePlayerStore();
    const old = playlist('old');
    const next = playlist('next');
    store.lastFetchTime = Date.now();
    store.recommendPlaylists.qq = [old];
    store.recommendPlaylists.netease = [playlist('other', 'netease')];
    store.dailySongs.qq = [{ id: 'song', name: 'Daily', artist: '', album: '', duration: 1, coverUrl: '', platform: 'qq' }];
    store.userPlaylists.qq = [old];
    const before = {
      time: store.lastFetchTime,
      daily: [...store.dailySongs.qq],
      user: [...store.userPlaylists.qq],
      other: [...store.recommendPlaylists.netease],
    };
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: { playlists: [next] } });

    await store.refreshRecommendPlaylists('qq');

    expect(get).toHaveBeenCalledExactlyOnceWith('/api/music/recommend/playlists', {
      params: { platform: 'qq', refresh: '1' },
    });
    expect(store.recommendPlaylists.qq).toEqual([next]);
    expect(store.recommendPlaylists.netease).toEqual(before.other);
    expect(store.dailySongs.qq).toEqual(before.daily);
    expect(store.userPlaylists.qq).toEqual(before.user);
    expect(store.lastFetchTime).toBe(before.time);
    expect(store.refreshingRecommendations.qq).toBe(false);
  });

  it('keeps the current batch on failure, reports the error, and permits retry', async () => {
    const store = usePlayerStore();
    const old = playlist('old');
    store.recommendPlaylists.qq = [old];
    const get = vi.spyOn(axios, 'get').mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ data: { playlists: [playlist('retry')] } });

    await store.refreshRecommendPlaylists('qq');

    expect(store.recommendPlaylists.qq).toEqual([old]);
    expect(store.notification).toMatchObject({ message: '推荐歌单刷新失败，请稍后重试', type: 'error' });
    expect(store.refreshingRecommendations.qq).toBe(false);
    await store.refreshRecommendPlaylists('qq');
    expect(get).toHaveBeenCalledTimes(2);
    expect(store.recommendPlaylists.qq).toEqual([playlist('retry')]);
  });

  it('prevents duplicate requests for a source while allowing another source to refresh', async () => {
    const store = usePlayerStore();
    let resolve!: (value: { data: { playlists: PlaylistItem[] } }) => void;
    const pending = new Promise<{ data: { playlists: PlaylistItem[] } }>((done) => { resolve = done; });
    const get = vi.spyOn(axios, 'get').mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ data: { playlists: [playlist('other', 'netease')] } });

    const first = store.refreshRecommendPlaylists('qq');
    expect(store.refreshingRecommendations.qq).toBe(true);
    await store.refreshRecommendPlaylists('qq');
    expect(get).toHaveBeenCalledTimes(1);
    await store.refreshRecommendPlaylists('netease');
    expect(get).toHaveBeenCalledTimes(2);
    expect(store.refreshingRecommendations.qq).toBe(true);
    resolve({ data: { playlists: [playlist('next')] } });
    await first;
    expect(store.recommendPlaylists.qq).toEqual([playlist('next')]);
    expect(store.refreshingRecommendations.qq).toBe(false);
  });
});
