import { describe, expect, it, vi } from "vitest";
import { collectArtistSongs } from "./player.js";
import type { ArtistSongPage, Song } from "../../music/provider.js";

function song(id: string): Song {
  return {
    id,
    name: `song-${id}`,
    artist: "Adele",
    album: "25",
    duration: 200,
    coverUrl: "c",
    platform: "netease",
  };
}

function page(ids: string[], total: number, hasMore: boolean): ArtistSongPage {
  return { songs: ids.map(song), total, hasMore };
}

describe("collectArtistSongs (play-artist all:true)", () => {
  it("walks every page until hasMore is false and de-duplicates ids", async () => {
    const pages: Record<number, ArtistSongPage> = {
      0: page(["1", "2"], 4, true),
      100: page(["2", "3"], 4, true),
      200: page(["4"], 4, false),
    };
    const fetchPage = vi.fn(async (_id: string, offset = 0, _limit = 100) => pages[offset] ?? page([], 4, false));

    const songs = await collectArtistSongs(fetchPage as any, "artist-1");

    expect(songs.map((s) => s.id)).toEqual(["1", "2", "3", "4"]);
    expect(fetchPage.mock.calls.map((c) => c[1])).toEqual([0, 100, 200]);
    expect(fetchPage.mock.calls[0][2]).toBe(100);
  });

  it("stops at the 500-track safety cap", async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => ({
      songs: Array.from({ length: 100 }, () => song(String(n++))),
      total: 100000,
      hasMore: true,
    }));

    const songs = await collectArtistSongs(fetchPage as any, "a");

    expect(songs).toHaveLength(500);
    expect(fetchPage).toHaveBeenCalledTimes(5);
  });

  it("stops on an empty page even when hasMore claims otherwise", async () => {
    const fetchPage = vi.fn(async () => page([], 9, true));

    expect(await collectArtistSongs(fetchPage as any, "a")).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("returns the first page unchanged when it is already complete", async () => {
    const fetchPage = vi.fn(async () => page(["1"], 1, false));

    const songs = await collectArtistSongs(fetchPage as any, "a");

    expect(songs.map((s) => s.id)).toEqual(["1"]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
