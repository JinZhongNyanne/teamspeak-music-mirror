import { describe, expect, it } from "vitest";
import {
  buildQqRefreshRequest,
  isQqRefreshDue,
  mergeQqRefreshResponse,
  parseQqCookie,
  qqCookieUin,
} from "./qq-auth.js";

const now = Date.UTC(2026, 9, 15);
const seconds = now / 1000;
// Synthetic credentials only. Never load production cookies in these tests.
const cookie = `uin=o0012345; qqmusic_key=old-key; qm_keyst=old-key; psrf_qqopenid=fake-open; psrf_qqaccess_token=fake-access; psrf_qqrefresh_token=fake-refresh; psrf_musickey_createtime=${seconds}; psrf_access_token_expiresAt=${seconds + 7 * 86400}; unrelated=keep=a==`;
const success = (data: Record<string, unknown> = {}) => ({
  code: 0,
  req_0: { code: 0, data: { musickey: "new-key", musicid: "12345", ...data } },
});

describe("QQ cookie renewal helpers", () => {
  it("parses arbitrary separator spacing and preserves equals in values", () => {
    expect(parseQqCookie(" a=1;b=two==; c=3; malformed; =bad ")).toEqual({
      a: "1",
      b: "two==",
      c: "3",
    });
    expect(qqCookieUin("a=x;uin=o0012345")).toBe("12345");
    expect(qqCookieUin("qqmusic_uin=9007199254740993")).toBe(
      "9007199254740993",
    );
    expect(qqCookieUin("uin=invalid;qqmusic_uin=12345")).toBe("12345");
    expect(parseQqCookie("__proto__=safe").__proto__).toBe("safe");
  });

  it("builds the QQ CGI Login renewal payload with optional refresh key", () => {
    expect(buildQqRefreshRequest(cookie)).toEqual({
      comm: {
        ct: 24,
        cv: 4747474,
        platform: "yqq.json",
        chid: "0",
        uin: "12345",
        g_tk: 1733897498,
        g_tk_new_20200303: 1733897498,
        format: "json",
        inCharset: "utf-8",
        outCharset: "utf-8",
        notice: 0,
        need_new_code: 1,
        tmeLoginType: 2,
      },
      req_0: {
        module: "music.login.LoginServer",
        method: "Login",
        param: {
          openid: "fake-open",
          access_token: "fake-access",
          refresh_token: "fake-refresh",
          expired_in: seconds + 7 * 86400,
          musicid: "12345",
          musickey: "old-key",
          refresh_key: "",
          loginMode: 2,
        },
      },
    });
    const request = buildQqRefreshRequest(
      cookie + "; psrf_qqrefresh_key=optional-key",
    ) as any;
    expect(request.req_0.param.refresh_key).toBe("optional-key");
  });

  it.each([
    "uin",
    "qqmusic_key",
    "psrf_qqopenid",
    "psrf_qqaccess_token",
    "psrf_qqrefresh_token",
  ])("rejects incomplete credentials missing %s", (key) => {
    const fields = parseQqCookie(cookie);
    delete fields[key];
    if (key === "qqmusic_key") delete fields.qm_keyst;
    const incomplete = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .join(";");
    expect(buildQqRefreshRequest(incomplete)).toBeNull();
    expect(isQqRefreshDue(incomplete, now)).toBe(false);
  });

  it.each(["; login_type=2", "; tmeLoginType=1", "; qqmusic_key=W_X_fake"])(
    "does not send unsupported WeChat credentials through QQ renewal: %s",
    (suffix) => {
      expect(buildQqRefreshRequest(cookie + suffix)).toBeNull();
    },
  );

  it("renews after twelve hours, before access expiry, and when creation is unknown", () => {
    expect(isQqRefreshDue(cookie, now)).toBe(false);
    expect(isQqRefreshDue(cookie, now + 12 * 3600000 - 1)).toBe(false);
    expect(isQqRefreshDue(cookie, now + 12 * 3600000)).toBe(true);
    expect(
      isQqRefreshDue(
        cookie + `; psrf_access_token_expiresAt=${seconds + 86400}`,
        now,
      ),
    ).toBe(true);
    expect(
      isQqRefreshDue(cookie + "; psrf_musickey_createtime=invalid", now),
    ).toBe(true);
    expect(
      isQqRefreshDue(cookie + `; psrf_musickey_createtime=${now}`, now),
    ).toBe(false);
  });

  it("merges rotated keys, tokens and Unix timestamps without losing unrelated cookies", () => {
    const merged = mergeQqRefreshResponse(
      cookie,
      success({
        refresh_token: "rotated-refresh",
        access_token: "rotated-access",
        openid: "rotated-open",
        unionid: "fake-union",
        refresh_key: "rotated-refresh-key",
        expired_at: String(now + 86400000),
        musickeycreatetime: String(seconds + 1),
      }),
      now,
    );
    expect(parseQqCookie(merged!)).toMatchObject({
      uin: "12345",
      qqmusic_key: "new-key",
      qm_keyst: "new-key",
      unrelated: "keep=a==",
      psrf_qqrefresh_token: "rotated-refresh",
      psrf_qqaccess_token: "rotated-access",
      psrf_qqopenid: "rotated-open",
      psrf_qqunionid: "fake-union",
      psrf_qqrefresh_key: "rotated-refresh-key",
      psrf_musickey_createtime: String(seconds + 1),
      psrf_access_token_expiresAt: String(seconds + 86400),
    });
  });

  it("retains omitted optional credentials and accepts an omitted response account identifier", () => {
    const merged = mergeQqRefreshResponse(
      cookie,
      success({ musicid: undefined }),
      now,
    );
    expect(parseQqCookie(merged!)).toMatchObject({
      psrf_qqrefresh_token: "fake-refresh",
      psrf_qqaccess_token: "fake-access",
      psrf_musickey_createtime: String(seconds),
      psrf_access_token_expiresAt: String(seconds + 7 * 86400),
    });
  });

  it.each([
    null,
    {},
    { code: 0 },
    { code: 0, req_0: { data: { musickey: "x" } } },
    { code: 0, req_0: { code: 1000, data: { musickey: "x" } } },
    { code: 1, req_0: { code: 0, data: { musickey: "x" } } },
    success({ musickey: "" }),
    success({ musickey: "   " }),
    success({ musickey: 123 }),
    success({ musicid: "other-account" }),
    success({ musicid: "67890" }),
    success({ musicid: "12345", str_musicid: "67890" }),
    success({ musicid: Number.MAX_SAFE_INTEGER + 1 }),
    success({ musickey: "injected; cookie=value" }),
    success({ refresh_token: "bad\r\nvalue" }),
  ])(
    "rejects failed, malformed, cross-account or delimiter-injected responses %#",
    (response) => {
      expect(mergeQqRefreshResponse(cookie, response, now)).toBeNull();
    },
  );
});
