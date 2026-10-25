import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("axios", () => ({ default: { create: () => ({ get, post }) } }));
import { QQMusicProvider } from "./qq.js";

const cookie = (uin = "12345", ageHours = 24) =>
  `uin=${uin}; qm_keyst=old-key; qqmusic_key=old-key; psrf_qqopenid=fixture-openid; psrf_qqaccess_token=fixture-access; psrf_qqrefresh_token=fixture-refresh; psrf_musickey_createtime=${Math.floor(Date.now() / 1000 - ageHours * 3600)}; psrf_access_token_expiresAt=${Math.floor(Date.now() / 1000 + 30 * 86400)}; tmeLoginType=2`;
const reply = (uin = "12345") => ({
  data: {
    code: 0,
    req_0: {
      code: 0,
      data: {
        musicid: uin,
        musickey: "new-key",
        access_token: "new-access",
        refresh_token: "new-refresh",
        expired_at: Math.floor(Date.now() / 1000 + 30 * 86400),
      },
    },
  },
});
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
};

describe("QQ credential renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    get.mockReset();
    post.mockReset();
  });
  afterEach(() => vi.useRealTimers());
  it("renews an ageing music key once for concurrent callers and persists before using it", async () => {
    const p = new QQMusicProvider("http://fixture");
    const save = vi.fn();
    p.setPersist(save);
    p.setCookie(cookie());
    const response = deferred();
    post.mockReturnValue(response.promise);
    const first = p.refreshCookie();
    const second = p.refreshCookie();
    expect(post).toHaveBeenCalledTimes(1);
    response.resolve(reply());
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toBe(p.getCookie());
    expect(p.getCookie()).toContain("qm_keyst=new-key");
    await p.refreshCookie();
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("does not renew fresh credentials and never sends incomplete credentials", async () => {
    const p = new QQMusicProvider("http://fixture");
    p.setCookie(cookie("12345", 0));
    expect(await p.refreshCookie()).toBe(false);
    p.setCookie("uin=12345; qqmusic_key=key");
    expect(await p.refreshCookie()).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
  it("retains old credentials and backs off on network or malformed response", async () => {
    const p = new QQMusicProvider("http://fixture");
    const old = cookie();
    p.setCookie(old);
    const save = vi.fn();
    p.setPersist(save);
    post.mockRejectedValueOnce(new Error("credential-bearing upstream error"));
    expect(await p.refreshCookie()).toBe(false);
    expect(p.getCookie()).toBe(old);
    expect(save).not.toHaveBeenCalled();
    await p.refreshCookie();
    expect(post).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3600000);
    post.mockResolvedValue({ data: { code: 0, req_0: { code: 0, data: {} } } });
    expect(await p.refreshCookie()).toBe(false);
    expect(p.getCookie()).toBe(old);
  });
  it("cannot overwrite a newer manual login, including same-cookie reimport", async () => {
    const p = new QQMusicProvider("http://fixture");
    const old = cookie();
    p.setCookie(old);
    const save = vi.fn();
    p.setPersist(save);
    const response = deferred();
    post.mockReturnValue(response.promise);
    const pending = p.refreshCookie();
    p.setCookie(old);
    response.resolve(reply());
    expect(await pending).toBe(false);
    expect(p.getCookie()).toBe(old);
    expect(save).not.toHaveBeenCalled();
  });
  it("does not switch active credentials if persistence fails", async () => {
    const p = new QQMusicProvider("http://fixture");
    const old = cookie();
    p.setCookie(old);
    p.setPersist(() => {
      throw Error("disk full");
    });
    post.mockResolvedValue(reply());
    expect(await p.refreshCookie()).toBe(false);
    expect(p.getCookie()).toBe(old);
  });
  it("logs only a sanitized upstream code when renewal is rejected", async () => {
    const logger = { warn: vi.fn() } as any;
    const p = new QQMusicProvider("http://fixture", logger);
    p.setCookie(cookie());
    post.mockResolvedValue({ data: { code: 0, req_0: { code: 10006 } } });
    expect(await p.refreshCookie()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      { platform: "qq", code: 10006 },
      "QQ cookie renewal rejected",
    );
    expect(logger.warn.mock.calls[0][0]).not.toHaveProperty("cookie");
  });
  it("uses renewed credentials for playback requests", async () => {
    const p = new QQMusicProvider("http://fixture");
    p.setCookie(cookie());
    post.mockResolvedValue(reply());
    get.mockResolvedValue({
      data: { data: { playUrl: { song: { url: "https://fixture/audio" } } } },
    });
    expect(await p.getSongUrl("song")).toEqual({
      url: "https://fixture/audio",
      trialDuration: undefined,
    });
    expect(get.mock.calls[0][1].params.cookie).toContain("qqmusic_key=new-key");
  });
});

describe("QQ auth status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    get.mockReset();
    post.mockReset();
  });
  afterEach(() => vi.useRealTimers());
  it("rejects QR confirmation without a new credential", async () => {
    const p = new QQMusicProvider("http://fixture");
    p.setCookie("uin=12345; qqmusic_key=old");
    post.mockResolvedValue({ data: { isOk: true, session: {} } });
    expect(await p.checkQrCodeStatus("fixture-qrsig|123")).toBe("expired");
    expect(p.getCookie()).toBe("uin=12345; qqmusic_key=old");
  });
  it("accepts QQMusic uin alias and cookies without spaces", async () => {
    const p = new QQMusicProvider("http://fixture");
    p.setCookie("x=y;qqmusic_uin=o0012345;qqmusic_key=key");
    get.mockResolvedValue({ data: { code: 0 } });
    expect((await p.getAuthStatus()).loggedIn).toBe(true);
    expect(get.mock.calls[0][1].params.uin).toBe("12345");
  });
  it("distinguishes a temporary outage from an explicit authentication rejection", async () => {
    const p = new QQMusicProvider("http://fixture");
    p.setCookie("uin=12345; qqmusic_key=key");
    get.mockResolvedValueOnce({ data: { code: 0 } });
    expect((await p.getAuthStatus()).loggedIn).toBe(true);
    get.mockRejectedValueOnce(Error("timeout"));
    expect((await p.getAuthStatus()).loggedIn).toBe(true);
    vi.advanceTimersByTime(16 * 60000);
    get.mockRejectedValueOnce(Error("timeout"));
    await expect(p.getAuthStatus()).rejects.toThrow("temporarily unavailable");
    get.mockResolvedValueOnce({ data: { code: 1000 } });
    expect(await p.getAuthStatus()).toEqual({ loggedIn: false });
    get.mockRejectedValueOnce(Error("timeout"));
    await expect(p.getAuthStatus()).rejects.toThrow("temporarily unavailable");
  });
  it("does not cache another account's in-flight authentication result", async () => {
    const p = new QQMusicProvider("http://fixture");
    p.setCookie("uin=12345; qqmusic_key=key");
    const response = deferred();
    get.mockReturnValue(response.promise);
    const pending = p.getAuthStatus();
    await Promise.resolve();
    await Promise.resolve();
    p.setCookie("uin=67890; qqmusic_key=other");
    response.resolve({ data: { code: 0 } });
    await expect(pending).rejects.toThrow("temporarily unavailable");
  });
});
