/** QQ Web cookies carry both short-lived music keys and refresh credentials.
 * Protocol references (not an official public API):
 * https://github.com/L-1124/QQMusicApi/blob/main/qqmusic_api/modules/login.py
 * https://github.com/Suxiaoqinx/QQMusicapi/blob/main/src/modules/login.js
 */

export function parseQqCookie(cookie: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const pair of cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key) result[key] = pair.slice(separator + 1).trim();
  }
  return result;
}

function normalizedUin(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  // Do not pass account identifiers through Number: some exceed 2**53.
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  const text = String(value).trim().replace(/^o/, "");
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, "") : "";
}

export function qqCookieUin(cookie: string): string {
  const fields = parseQqCookie(cookie);
  return normalizedUin(fields.uin) || normalizedUin(fields.qqmusic_uin);
}

function positiveNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function unixSeconds(value: unknown): number | null {
  const number = positiveNumber(value);
  return number === null
    ? null
    : Math.floor(number >= 1e12 ? number / 1000 : number);
}

function qqGtk(musicKey: string): number {
  let hash = 5381;
  for (let i = 0; i < musicKey.length; i++) {
    hash = (hash + (hash << 5) + musicKey.charCodeAt(i)) | 0;
  }
  return hash & 0x7fffffff;
}

export function isQqRefreshDue(cookie: string, nowMs: number): boolean {
  if (!buildQqRefreshRequest(cookie)) return false;
  const fields = parseQqCookie(cookie);
  const created = unixSeconds(fields.psrf_musickey_createtime);
  const expires = unixSeconds(fields.psrf_access_token_expiresAt);
  const now = nowMs / 1000;
  return (
    created === null ||
    now - created >= 12 * 60 * 60 ||
    (expires !== null && expires - now <= 24 * 60 * 60)
  );
}

/** Returns null for incomplete credentials and unsupported login types.
 * Web login_type=1 is QQ, whereas CGI tmeLoginType=2 is QQ.
 * refresh_key is optional: both reference clients default it to an empty string.
 */
export function buildQqRefreshRequest(
  cookie: string,
): Record<string, unknown> | null {
  const fields = parseQqCookie(cookie);
  const uin = qqCookieUin(cookie);
  const musicKey = fields.qqmusic_key || fields.qm_keyst;
  if (
    !uin ||
    uin === "0" ||
    !musicKey ||
    !fields.psrf_qqopenid ||
    !fields.psrf_qqaccess_token ||
    !fields.psrf_qqrefresh_token
  )
    return null;
  if (
    musicKey.startsWith("W_X") ||
    fields.login_type === "2" ||
    (fields.tmeLoginType && fields.tmeLoginType !== "2")
  )
    return null;
  const gtk = qqGtk(musicKey);
  return {
    comm: {
      ct: 24,
      cv: 4747474,
      platform: "yqq.json",
      chid: "0",
      uin,
      g_tk: gtk,
      g_tk_new_20200303: gtk,
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
        openid: fields.psrf_qqopenid,
        access_token: fields.psrf_qqaccess_token,
        refresh_token: fields.psrf_qqrefresh_token,
        expired_in: unixSeconds(fields.psrf_access_token_expiresAt) ?? 0,
        musicid: uin,
        musickey: musicKey,
        refresh_key: fields.psrf_qqrefresh_key || fields.refresh_key || "",
        loginMode: 2,
      },
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Validate the whole CGI envelope before replacing any credentials.
 * Missing optional rotated fields preserve their existing cookie values.
 */
export function mergeQqRefreshResponse(
  cookie: string,
  response: unknown,
  nowMs: number,
): string | null {
  const body = record(response);
  const request = record(body?.req_0);
  const data = record(request?.data);
  if (
    body?.code !== 0 ||
    request?.code !== 0 ||
    !data ||
    typeof data.musickey !== "string" ||
    !data.musickey.trim()
  )
    return null;
  const uin = qqCookieUin(cookie);
  if (!uin || uin === "0") return null;
  for (const value of [data.musicid, data.str_musicid, data.uin]) {
    if (
      value !== undefined &&
      value !== null &&
      value !== "" &&
      normalizedUin(value) !== uin
    )
      return null;
  }
  const fields = parseQqCookie(cookie);
  // A successful response must not introduce cookie delimiters or line breaks.
  const updates: Record<string, string> = {
    qm_keyst: data.musickey.trim(),
    qqmusic_key: data.musickey.trim(),
    psrf_musickey_createtime: String(
      unixSeconds(data.musickeycreatetime) ?? Math.floor(nowMs / 1000),
    ),
  };
  const aliases: Record<string, string> = {
    openid: "psrf_qqopenid",
    access_token: "psrf_qqaccess_token",
    refresh_token: "psrf_qqrefresh_token",
    unionid: "psrf_qqunionid",
    refresh_key: "psrf_qqrefresh_key",
  };
  for (const [source, target] of Object.entries(aliases)) {
    if (typeof data[source] === "string" && data[source].trim())
      updates[target] = data[source].trim();
  }
  const expires = unixSeconds(data.expired_at);
  if (expires !== null) updates.psrf_access_token_expiresAt = String(expires);
  if (Object.values(updates).some((value) => /[;\r\n]/.test(value)))
    return null;
  Object.assign(fields, updates);
  // Canonical uin makes imported qqmusic_uin-only cookies work with the bundled API.
  fields.uin = uin;
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}
