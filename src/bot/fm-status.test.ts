import { describe, expect, it, vi } from "vitest";
import { BotInstance } from "./instance.js";
import { PlayQueue } from "../audio/queue.js";
import { createDatabase } from "../data/database.js";

function fixture(platform: string | null, active = true, state = "playing") {
  const queue = new PlayQueue();
  queue.add({
    id: "song",
    name: "Song from another source",
    artist: "Artist",
    album: "Album",
    platform: "netease",
    coverUrl: "",
    duration: 180,
  });
  queue.play();
  return Object.assign(Object.create(BotInstance.prototype), {
    id: "source",
    name: "Music",
    connected: true,
    isFmMode: active,
    fmProvider: platform ? { platform } : null,
    queue,
    player: {
      getState: () => state,
      getVolume: () => 75,
      getElapsed: () => 42,
      resetFailures: vi.fn(),
    },
    resolveAndPlay: vi.fn(async () => true),
    logger: { info: vi.fn(), warn: vi.fn() },
  });
}

describe("FM source in public bot status", () => {
  it.each(["qq", "netease", "kugou", "jellyfin"])(
    "reports the active %s provider independently of queued song metadata",
    (platform) => {
      const bot = fixture(platform);
      const before = bot.queue.snapshot();
      const status = bot.getStatus();
      expect(status.fmPlatform).toBe(platform);
      expect(status.currentSong?.platform).toBe("netease");
      expect(bot.queue.snapshot()).toEqual(before);
      expect(bot.resolveAndPlay).not.toHaveBeenCalled();
    },
  );

  it.each(["playing", "paused", "idle"])(
    "retains the FM source while the player is %s",
    (state) => {
      expect(fixture("qq", true, state).getStatus().fmPlatform).toBe("qq");
    },
  );

  it("reports null when FM is inactive, even with a stale provider or a QQ song", () => {
    const bot = fixture("qq", false);
    bot.queue.current().platform = "qq";
    expect(bot.getStatus().fmPlatform).toBeNull();
    expect(fixture(null).getStatus().fmPlatform).toBeNull();
  });

  it("reports the persisted FM provider after restoring a paused queue", async () => {
    const db = createDatabase(":memory:");
    try {
      const bot = fixture(null, false, "idle");
      const saved = {
        botId: bot.id,
        ...bot.queue.snapshot(),
        isFmMode: true,
        fmPlatform: "qq",
        paused: true,
      };
      db.saveQueueState(saved);
      bot.queue.clear();
      bot.config = { savedQueuesEnabled: true };
      bot.database = db;
      bot.getProviderFor = vi.fn((platform: string) => ({ platform }));
      await bot.restoreQueueFromSnapshot();

      expect(bot.getProviderFor).toHaveBeenCalledExactlyOnceWith("qq");
      expect(bot.getStatus()).toMatchObject({
        fmPlatform: "qq",
        paused: true,
        currentSong: { platform: "netease" },
      });
      expect(db.getQueueState(bot.id)).toMatchObject(saved);
      expect(bot.resolveAndPlay).toHaveBeenCalledExactlyOnceWith(
        bot.queue.current(),
        true,
      );
    } finally {
      db.close();
    }
  });

  it("mirrors the source bot's FM state instead of its own provider or current song", () => {
    const source = fixture("qq");
    const target = fixture("netease");
    target.id = "output";
    target.name = "Mirror";
    target.connected = false;
    target.mirrorSource = () => source.getStatus();
    expect(target.getStatus()).toMatchObject({
      id: "output",
      name: "Mirror",
      connected: false,
      fmPlatform: "qq",
      currentSong: { platform: "netease" },
    });
    source.isFmMode = false;
    expect(target.getStatus().fmPlatform).toBeNull();
  });
});
