import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createMusicRouter } from "./music.js";
import type { MusicProvider } from "../../music/provider.js";
const getRecommendPlaylists = vi.fn();
const provider = (platform: string) =>
  ({ platform, getRecommendPlaylists }) as unknown as MusicProvider;
beforeEach(() => {
  getRecommendPlaylists.mockReset().mockResolvedValue([]);
});
const app = () => {
  const app = express();
  app.use(
    "/api/music",
    createMusicRouter(
      provider("netease"),
      provider("qq"),
      provider("bilibili"),
      pino({ level: "silent" }),
    ),
  );
  return app;
};
describe("recommendation refresh API", () => {
  it("passes explicit refresh and prevents cached responses", async () => {
    const r = await request(app()).get(
      "/api/music/recommend/playlists?platform=qq&refresh=1",
    );
    expect(r.status).toBe(200);
    expect(getRecommendPlaylists).toHaveBeenCalledWith(true);
    expect(r.headers["cache-control"]).toBe("no-store");
  });
  it("keeps an ordinary read on its current batch", async () => {
    await request(app()).get("/api/music/recommend/playlists?platform=qq");
    expect(getRecommendPlaylists).toHaveBeenCalledWith(false);
  });
  it("reports failures so the client can retain its previous cards", async () => {
    getRecommendPlaylists.mockRejectedValue(Error("temporarily unavailable"));
    expect(
      (
        await request(app()).get(
          "/api/music/recommend/playlists?platform=qq&refresh=1",
        )
      ).status,
    ).toBe(500);
  });
});
