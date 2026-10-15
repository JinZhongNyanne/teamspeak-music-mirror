import { beforeEach, describe, expect, it, vi } from "vitest";
const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("axios", () => ({ default: { create: () => ({ post, get }) } }));
import { QQMusicProvider } from "./qq.js";
const response = (id = "123", next = 20, more: boolean | number = true) => ({
  data: {
    code: 0,
    req_0: {
      code: 0,
      data: {
        List: [
          {
            Playlist: {
              basic: {
                tid: id,
                title: "Fixture",
                song_cnt: 18,
                play_cnt: 9999,
                cover: { medium_url: "http://fixture/cover" },
              },
            },
          },
        ],
        FromLimit: next,
        HasMore: more,
      },
    },
  },
});
const offsets = () => post.mock.calls.map((call) => call[1].req_0.param.From);
beforeEach(() => {
  post.mockReset();
  get.mockReset();
});
describe("QQ recommendation feed", () => {
  it("maps the new feed and advances only on explicit refresh", async () => {
    const p = new QQMusicProvider("http://fixture");
    post.mockResolvedValue(response());
    expect(await p.getRecommendPlaylists()).toEqual([
      {
        id: "123",
        name: "Fixture",
        coverUrl: "https://fixture/cover",
        songCount: 18,
        platform: "qq",
      },
    ]);
    await p.getRecommendPlaylists();
    post.mockResolvedValue(response("456", 40));
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
  it("retries the same next cursor after failures without returning an empty success", async () => {
    const p = new QQMusicProvider("http://fixture");
    post.mockResolvedValueOnce(response());
    await p.getRecommendPlaylists();
    post.mockRejectedValueOnce(Error("secret-bearing request"));
    await expect(p.getRecommendPlaylists(true)).rejects.toThrow("暂时无法刷新");
    post.mockResolvedValueOnce(response("456", 40));
    await p.getRecommendPlaylists(true);
    expect(offsets()).toEqual([0, 20, 20]);
  });
  it("wraps to the beginning after the final page", async () => {
    const p = new QQMusicProvider("http://fixture");
    post.mockResolvedValueOnce(response());
    await p.getRecommendPlaylists();
    post.mockResolvedValueOnce(response("456", 40, false));
    await p.getRecommendPlaylists(true);
    post.mockResolvedValueOnce(response());
    await p.getRecommendPlaylists(true);
    expect(offsets()).toEqual([0, 20, 0]);
  });
  it("recovers a stale end cursor with one first-page retry", async () => {
    const p = new QQMusicProvider("http://fixture");
    post.mockResolvedValueOnce(response());
    await p.getRecommendPlaylists();
    post
      .mockResolvedValueOnce({
        data: { code: 0, req_0: { code: 0, data: { List: [] } } },
      })
      .mockResolvedValueOnce(response("999"));
    expect((await p.getRecommendPlaylists(true))[0].id).toBe("999");
    expect(offsets()).toEqual([0, 20, 0]);
  });
  it.each([
    { code: 1, req_0: { code: 0, data: { List: [] } } },
    { code: 0, req_0: { code: 1, data: { List: [] } } },
    { code: 0, req_0: { code: 0, data: {} } },
    { code: 0, req_0: { code: 0, data: { List: [{}] } } },
    { code: 0, req_0: { code: 0, data: { List: [] } } },
  ])("rejects invalid responses", async (data) => {
    const p = new QQMusicProvider("http://fixture");
    post.mockResolvedValue({ data });
    await expect(p.getRecommendPlaylists()).rejects.toThrow("暂时无法刷新");
  });
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
      .mockResolvedValueOnce(response("456", 40));
    const initial = p.getRecommendPlaylists();
    const firstClick = p.getRecommendPlaylists(true);
    const secondClick = p.getRecommendPlaylists(true);
    resolve(response());
    expect((await initial)[0].id).toBe("123");
    expect((await firstClick)[0].id).toBe("456");
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
    post.mockResolvedValueOnce(response("789"));
    await p.getRecommendPlaylists();
    resolve(response("456"));
    await expect(old).rejects.toThrow("暂时无法刷新");
    post.mockResolvedValueOnce(response("890", 40));
    await p.getRecommendPlaylists(true);
    expect(offsets()).toEqual([0, 20, 0, 20]);
    expect(post.mock.calls[2][2].headers.Cookie).toContain("uin=56789");
  });
});
