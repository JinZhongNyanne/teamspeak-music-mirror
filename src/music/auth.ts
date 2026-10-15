import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Platforms with a persisted credential blob. For jellyfin the "cookie" is a
 *  JSON string carrying the access token / userId / deviceId (see jellyfin.ts). */
type CookiePlatform = "netease" | "qq" | "bilibili" | "kugou" | "jellyfin";

export interface CookieStore {
  save(platform: CookiePlatform, cookie: string): void;
  load(platform: CookiePlatform): string;
}

export function createCookieStore(cookieDir: string): CookieStore {
  if (!fs.existsSync(cookieDir)) {
    fs.mkdirSync(cookieDir, { recursive: true });
  }

  return {
    save(platform: CookiePlatform, cookie: string): void {
      const filePath = path.join(cookieDir, `${platform}.json`);
      // Replace atomically so a restart during automatic renewal cannot leave
      // a truncated credential file. Temp files stay private and are cleaned.
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(
          temporary,
          JSON.stringify({ cookie, updatedAt: new Date().toISOString() }),
          { encoding: "utf-8", mode: 0o600, flag: "wx" }
        );
        fs.renameSync(temporary, filePath);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },

    load(platform: CookiePlatform): string {
      const filePath = path.join(cookieDir, `${platform}.json`);
      if (!fs.existsSync(filePath)) return "";
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return data.cookie ?? "";
      } catch {
        return "";
      }
    },
  };
}
