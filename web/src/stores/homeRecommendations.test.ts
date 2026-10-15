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
  for (const source of ['netease', 'qq', 'kugou'] as const) {
    it.each([
      { homeFails: false, refreshFails: false },
      { homeFails: true, refreshFails: false },
      { homeFails: false, refreshFails: true },
      { homeFails: true, refreshFails: true },
    ])(`protects ${source} from an older home response (home failure: $homeFails, refresh failure: $refreshFails)`, async ({ homeFails, refreshFails }) => {
      const store = usePlayerStore();
      store.enabledProviders = [source];
      store.authStatus[source] = true;
      store.recommendPlaylists[source] = [playlist('visible', source)];
      vi.spyOn(store, 'fetchProviders').mockResolvedValue();
      vi.spyOn(store, 'fetchFavorites').mockResolvedValue();
      let releaseHome!: () => void;
      const delayedSongs = new Promise<{ data: { songs: never[] } }>((resolve) => {
        releaseHome = () => resolve({ data: { songs: [] } });
      });
      let homeStarted!: () => void;
      const started = new Promise<void>((resolve) => { homeStarted = resolve; });
      vi.spyOn(axios, 'get').mockImplementation((url, config) => {
        if (url === '/api/auth/status') return Promise.resolve({ data: { loggedIn: true } });
        if (url === '/api/music/recommend/songs') {
          homeStarted();
          return delayedSongs;
        }
        if (url === '/api/music/recommend/playlists') {
          const manual = config?.params?.refresh === '1';
          if (manual ? refreshFails : homeFails) return Promise.reject(new Error('network'));
          return Promise.resolve({ data: { playlists: [playlist(manual ? 'new-batch' : 'stale-home', source)] } });
        }
        return Promise.resolve({ data: { playlists: [] } });
      });

      const home = store.fetchHomeData();
      await started;
      await store.refreshRecommendPlaylists(source);
      const expected = [playlist(refreshFails ? 'visible' : 'new-batch', source)];
      expect(store.recommendPlaylists[source]).toEqual(expected);
      releaseHome();
      await home;

      expect(store.recommendPlaylists[source]).toEqual(expected);
      expect(store.refreshingRecommendations[source]).toBe(false);
    });
  }

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
