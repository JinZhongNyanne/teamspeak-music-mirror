import { beforeEach, describe, expect, it, vi } from "vitest";
const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("axios", () => ({ default: { create: () => ({ post, get }) } }));
import { QQMusicProvider } from "./qq.js";

// Actual feed pages contain 20 items and report FromLimit=400 unchanged.
// FromLimit is an inclusive request bound, not the next-page cursor. HasMore
// can already be false for nonempty pages well below that bound.
const response = (
  first = "1000",
  more: unknown = true,
  fromLimit: unknown = 400,
  count = 20,
) => ({
  data: {
    code: 0,
    req_0: {
      code: 0,
      data: {
        List: Array.from({ length: count }, (_, i) => ({
          Playlist: {
            basic: {
              tid: String(BigInt(first) + BigInt(i)),
              title: `Fixture ${i}`,
              song_cnt: 18,
              play_cnt: 9999,
              cover: { medium_url: "http://fixture/cover" },
            },
          },
        })),
        FromLimit: fromLimit,
        HasMore: more,
      },
    },
  },
});
const emptyPage = (list: unknown) => ({
  data: {
    code: 0,
    req_0: { code: 0, data: { List: list, FromLimit: 400, HasMore: false } },
  },
});
const offsets = () => post.mock.calls.map((call) => call[1].req_0.param.From);
function pagedFeed() {
  post.mockImplementation(async (_path, payload) => {
    const from = payload.req_0.param.From as number;
    return response(String(1000 + from), from < 40);
  });
}
beforeEach(() => {
  post.mockReset();
  get.mockReset();
});

describe("QQ recommendation feed", () => {
  it("maps 20 real-shaped feed entries and advances only on explicit refresh", async () => {
    const p = new QQMusicProvider("http://fixture");
    post.mockResolvedValue(response());
    const items = await p.getRecommendPlaylists();
    expect(items).toHaveLength(20);
    expect(items[0]).toEqual({
      id: "1000",
      name: "Fixture 0",
      coverUrl: "https://fixture/cover",
      songCount: 18,
      platform: "qq",
    });
    expect(items[19].id).toBe("1019");
    await p.getRecommendPlaylists();
    post.mockResolvedValue(response("2000"));
    await p.getRecommendPlaylists(true);
    await p.getRecommendPlaylists();
    expect(offsets()).toEqual([0, 0, 20, 20]);
    expect(post.mock.calls[0][1].req_0).toMatchObject({
      module: "music.playlist.PlaylistSquare",
      method: "GetRecommendFeed",
      param: { From: 0, Size: 20 },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("requests 0, 20, 40, 60 despite constant FromLimit and early false HasMore", async () => {
    const p = new QQMusicProvider("http://fixture");
    pagedFeed();
    const batches = [];
    for (const refresh of [false, true, true, true]) {
      batches.push(
        (await p.getRecommendPlaylists(refresh)).map((item) => item.id),
      );
    }
    expect(offsets()).toEqual([0, 20, 40, 60]);
    expect(new Set(batches.flat()).size).toBe(80);
  });

  it("includes the valid From=400 page before wrapping from 420 to 0", async () => {
    const p = new QQMusicProvider("http://fixture");
    pagedFeed();
    const firstIds = [];
    for (let i = 0; i < 22; i++) {
      firstIds.push((await p.getRecommendPlaylists(i !== 0))[0].id);
    }
    expect(offsets()).toEqual([
      ...Array.from({ length: 21 }, (_, i) => i * 20),
      0,
    ]);
    expect(firstIds[20]).toBe("1400");
    expect(firstIds[21]).toBe("1000");
    expect(new Set(firstIds.slice(0, 21)).size).toBe(21);
  });

  it("advances by requested Size=20 even when a valid page contains fewer items", async () => {
    const p = new QQMusicProvider("http://fixture");
    post
      .mockResolvedValueOnce(response("1000", true, 400, 7))
      .mockResolvedValueOnce(response("2000", false, 400, 3))
      .mockResolvedValueOnce(response("3000"));
    expect(await p.getRecommendPlaylists()).toHaveLength(7);
    expect(await p.getRecommendPlaylists(true)).toHaveLength(3);
    await p.getRecommendPlaylists(true);
    expect(offsets()).toEqual([0, 20, 40]);
  });

  it.each([
    undefined,
    null,
    "400",
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    {},
  ])(
    "does not wrap or jump based on invalid FromLimit=%s",
    async (fromLimit) => {
      const p = new QQMusicProvider("http://fixture");
      post.mockImplementation(async (_path, payload) => {
        const result = response(String(1000 + payload.req_0.param.From), false);
        result.data.req_0.data.FromLimit = fromLimit;
        return result;
      });
      await p.getRecommendPlaylists();
      await p.getRecommendPlaylists(true);
      await p.getRecommendPlaylists(true);
      expect(offsets()).toEqual([0, 20, 40]);
    },
  );

  it("retries the same next cursor after failures without returning an empty success", async () => {
    const p = new QQMusicProvider("http://fixture");
    post.mockResolvedValueOnce(response());
    await p.getRecommendPlaylists();
    post.mockRejectedValueOnce(Error("secret-bearing request"));
    await expect(p.getRecommendPlaylists(true)).rejects.toThrow("暂时无法刷新");
    post.mockResolvedValueOnce(response("2000"));
    await p.getRecommendPlaylists(true);
    expect(offsets()).toEqual([0, 20, 20]);
  });

  it.each([[], null])(
    "recovers an empty/null non-first List with one first-page retry (%s)",
    async (list) => {
      const p = new QQMusicProvider("http://fixture");
      post.mockResolvedValueOnce(response());
      await p.getRecommendPlaylists();
      post
        .mockResolvedValueOnce(emptyPage(list))
        .mockResolvedValueOnce(response("3000"));
      expect((await p.getRecommendPlaylists(true))[0].id).toBe("3000");
      expect(offsets()).toEqual([0, 20, 0]);
    },
  );

  it("bounds empty-page fallback to one retry and preserves the last good next cursor", async () => {
    const p = new QQMusicProvider("http://fixture");
    post.mockResolvedValueOnce(response());
    await p.getRecommendPlaylists();
    post
      .mockResolvedValueOnce(emptyPage(null))
      .mockResolvedValueOnce(emptyPage([]));
    await expect(p.getRecommendPlaylists(true)).rejects.toThrow("暂时无法刷新");
    expect(offsets()).toEqual([0, 20, 0]);
    post.mockResolvedValueOnce(response("2000"));
    await p.getRecommendPlaylists(true);
    expect(offsets()).toEqual([0, 20, 0, 20]);
  });

  it.each([
    { code: 1, req_0: { code: 0, data: { List: [] } } },
    { code: 0, req_0: { code: 1, data: { List: [] } } },
    { code: 0, req_0: { code: 0, data: {} } },
    { code: 0, req_0: { code: 0, data: { List: "invalid" } } },
    { code: 0, req_0: { code: 0, data: { List: [{}] } } },
    { code: 0, req_0: { code: 0, data: { List: [] } } },
    { code: 0, req_0: { code: 0, data: { List: null } } },
  ])(
    "rejects invalid or empty first-page responses without another request",
    async (data) => {
      const p = new QQMusicProvider("http://fixture");
      post.mockResolvedValue({ data });
      await expect(p.getRecommendPlaylists()).rejects.toThrow("暂时无法刷新");
      expect(offsets()).toEqual([0]);
    },
  );

  it.each([
    {},
    { List: undefined },
    { List: "invalid" },
    { List: {} },
    { List: [{}] },
  ])(
    "rejects missing/malformed non-first List instead of disguising it as end-of-feed",
    async (data) => {
      const p = new QQMusicProvider("http://fixture");
      post.mockResolvedValueOnce(response());
      await p.getRecommendPlaylists();
      post.mockResolvedValueOnce({
        data: { code: 0, req_0: { code: 0, data } },
      });
      await expect(p.getRecommendPlaylists(true)).rejects.toThrow(
        "暂时无法刷新",
      );
      expect(offsets()).toEqual([0, 20]);
    },
  );

  it("coalesces concurrent requests", async () => {
    const p = new QQMusicProvider("http://fixture");
    let resolve!: (value: unknown) => void;
    post.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const one = p.getRecommendPlaylists(true);
    const two = p.getRecommendPlaylists(true);
    expect(post).toHaveBeenCalledTimes(1);
    resolve(response());
    expect(await one).toEqual(await two);
  });

  it("does not swallow an explicit refresh during an ordinary read", async () => {
    const p = new QQMusicProvider("http://fixture");
    let resolve!: (value: unknown) => void;
    post
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValueOnce(response("2000"));
    const initial = p.getRecommendPlaylists();
    const firstClick = p.getRecommendPlaylists(true);
    const secondClick = p.getRecommendPlaylists(true);
    resolve(response());
    expect((await initial)[0].id).toBe("1000");
    expect((await firstClick)[0].id).toBe("2000");
    expect(await secondClick).toEqual(await firstClick);
    expect(offsets()).toEqual([0, 20]);
  });

  it("resets pagination on login and ignores the old account's response", async () => {
    const p = new QQMusicProvider("http://fixture");
    p.setCookie("uin=12345; qqmusic_key=old");
    post.mockResolvedValueOnce(response());
    await p.getRecommendPlaylists();
    let resolve!: (value: unknown) => void;
    post.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const old = p.getRecommendPlaylists(true);
    p.setCookie("uin=56789; qqmusic_key=new");
    post.mockResolvedValueOnce(response("3000"));
    await p.getRecommendPlaylists();
    resolve(response("2000"));
    await expect(old).rejects.toThrow("暂时无法刷新");
    post.mockResolvedValueOnce(response("4000"));
    await p.getRecommendPlaylists(true);
    expect(offsets()).toEqual([0, 20, 0, 20]);
    expect(post.mock.calls[2][2].headers.Cookie).toContain("uin=56789");
  });
});
