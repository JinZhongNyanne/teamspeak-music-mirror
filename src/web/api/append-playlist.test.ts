import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { PlayMode, PlayQueue } from "../../audio/queue.js";
import { BotInstance } from "../../bot/instance.js";
import type { Song } from "../../music/provider.js";
import { createPlayerRouter } from "./player.js";

function song(id: string): Song {
  return { id, name: id, artist: "artist", album: "album", duration: 180, coverUrl: "", platform: "qq" };
}

function fixture(state = "playing", user: any = { role: "admin", username: "Alice" }) {
  const queue = new PlayQueue();
  queue.addMany([song("old-1"), song("old-2"), song("old-3")]);
  queue.playAt(1);
  queue.setMode(PlayMode.RandomLoop);
  const player = { getState: vi.fn(() => state), stop: vi.fn(), resetFailures: vi.fn(), pause: vi.fn() };
  const provider = { platform: "qq", getPlaylistSongs: vi.fn(async () => [song("new-1"), song("new-2")]) };
  const bot: any = {
    playGate: Promise.resolve(),
    getProviderFor: vi.fn(() => provider),
    getQueueManager: () => queue,
    getPlayer: () => player,
    getStatus: vi.fn(() => ({ paused: state === "paused" })),
    resolveAndPlay: vi.fn(async () => true),
    emit: vi.fn(),
    disableFmMode: vi.fn(),
    cleanupQueuedLocalSongs: vi.fn(),
    isMirrorTarget: vi.fn(() => false),
    isLocalAudioEnabled: () => false,
    executeCommand: vi.fn(async () => "legacy command"),
  };
  bot.runExclusive = (fn: () => Promise<unknown>) => BotInstance.prototype.runExclusive.call(bot, fn);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = user; next(); });
  app.use("/api/player", createPlayerRouter({ getBot: () => bot } as any, { error: vi.fn() } as any));
  const append = (body = { playlistId: "list", platform: "qq" }) =>
    request(app).post("/api/player/b/append-playlist").send(body);
  return { app, append, queue, player, provider, bot };
}

describe("append-playlist", () => {
  it.each(["playing", "paused"])("appends in provider order and preserves a %s queue and current song", async (state) => {
    const f = fixture(state);
    const before = f.queue.list();
    const current = f.queue.current();
    const clear = vi.spyOn(f.queue, "clear");
    const playAt = vi.spyOn(f.queue, "playAt");
    const res = await f.append();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, added: 2 });
    expect(f.provider.getPlaylistSongs).toHaveBeenCalledExactlyOnceWith("list");
    expect(f.queue.list().map((s) => s.id)).toEqual(["old-1", "old-2", "old-3", "new-1", "new-2"]);
    expect(f.queue.list().slice(0, 3)).toEqual(before);
    expect(f.queue.current()).toBe(current);
    expect(f.queue.getCurrentIndex()).toBe(1);
    expect(f.queue.getMode()).toBe(PlayMode.RandomLoop);
    expect(f.queue.list()[3]).toMatchObject({ platform: "qq", requestedBy: "Alice" });
    expect(clear).not.toHaveBeenCalled();
    expect(playAt).not.toHaveBeenCalled();
    expect(f.player.stop).not.toHaveBeenCalled();
    expect(f.player.pause).not.toHaveBeenCalled();
    expect(f.player.resetFailures).not.toHaveBeenCalled();
    expect(f.bot.resolveAndPlay).not.toHaveBeenCalled();
    expect(f.bot.disableFmMode).not.toHaveBeenCalled();
    expect(f.bot.cleanupQueuedLocalSongs).not.toHaveBeenCalled();
    expect(f.bot.executeCommand).not.toHaveBeenCalled();
    expect(f.bot.emit).toHaveBeenCalledWith("stateChange");
  });

  it("starts the first newly appended song only when idle, retaining older rows and mode", async () => {
    const f = fixture("idle");
    const res = await f.append();
    expect(res.status).toBe(200);
    expect(f.queue.list().map((s) => s.id)).toEqual(["old-1", "old-2", "old-3", "new-1", "new-2"]);
    expect(f.queue.current()?.id).toBe("new-1");
    expect(f.queue.getCurrentIndex()).toBe(3);
    expect(f.queue.getMode()).toBe(PlayMode.RandomLoop);
    expect(f.bot.resolveAndPlay).toHaveBeenCalledExactlyOnceWith(f.queue.current());
    expect(f.player.resetFailures).toHaveBeenCalledOnce();
    expect(f.player.stop).not.toHaveBeenCalled();
  });

  it("retains a restored/recovering pause even while the audio player itself is idle", async () => {
    const f = fixture("idle");
    f.bot.getStatus.mockReturnValueOnce({ paused: true });
    expect((await f.append()).status).toBe(200);
    expect(f.queue.getCurrentIndex()).toBe(1);
    expect(f.queue.size()).toBe(5);
    expect(f.bot.resolveAndPlay).not.toHaveBeenCalled();
    expect(f.player.resetFailures).not.toHaveBeenCalled();
  });

  it.each(["empty", "failed"])("leaves playback and the queue untouched for an %s provider response", async (result) => {
    const f = fixture();
    const before = f.queue.snapshot();
    if (result === "empty") f.provider.getPlaylistSongs.mockResolvedValueOnce([]);
    else f.provider.getPlaylistSongs.mockRejectedValueOnce(new Error("provider offline"));
    const res = await f.append();
    expect(res.status).toBe(result === "empty" ? 200 : 500);
    if (result === "empty") expect(res.body).toMatchObject({ ok: false, added: 0 });
    expect(f.queue.snapshot()).toEqual(before);
    expect(f.player.stop).not.toHaveBeenCalled();
    expect(f.bot.resolveAndPlay).not.toHaveBeenCalled();
    expect(f.bot.emit).not.toHaveBeenCalled();
  });

  it("does not mutate the queue while provider lookup is pending", async () => {
    const f = fixture();
    let finish!: (songs: Song[]) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    f.provider.getPlaylistSongs.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => { finish = resolve; });
    });
    const before = f.queue.snapshot();
    const pending = f.append().then((res) => res);
    await waiting;
    expect(f.queue.snapshot()).toEqual(before);
    // Another request may queue a track while the provider fetch is in flight.
    f.queue.add(song("concurrent"));
    finish([song("new-1"), song("new-2")]);
    expect((await pending).status).toBe(200);
    expect(f.queue.list().map((s) => s.id)).toEqual(["old-1", "old-2", "old-3", "concurrent", "new-1", "new-2"]);
    expect(f.queue.getCurrentIndex()).toBe(1);
  });

  it("serializes idle startup with overlapping single-song playback", async () => {
    const f = fixture("idle");
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    f.bot.resolveAndPlay.mockImplementationOnce(async () => { started(); await hold; return true; });
    const pending = f.append().then((res) => res);
    await waiting;
    const next = f.bot.runExclusive(async () => {
      f.queue.add(song("concurrent"));
      f.queue.playAt(f.queue.size() - 1);
    });
    await Promise.resolve();
    expect(f.queue.current()?.id).toBe("new-1");
    release();
    await Promise.all([pending, next]);
    expect(f.queue.current()?.id).toBe("concurrent");
  });

  it.each([
    { role: "member", capabilities: new Set(), bots: "all" },
    { role: "guest", capabilities: new Set(["player.queue"]), bots: "all", guest: { addToQueue: true, playCollection: true } },
    { role: "member", capabilities: new Set(["player.queue"]), bots: new Set(["other-bot"]) },
  ])("enforces existing queue capability, guest and bot-access rules ($role)", async (user) => {
    const f = fixture("playing", user);
    expect((await f.append()).status).toBe(403);
    expect(f.provider.getPlaylistSongs).not.toHaveBeenCalled();
    expect(f.queue.size()).toBe(3);
  });

  it("allows a queue-capable member without granting playback-control capability", async () => {
    const f = fixture("paused", { role: "member", username: "Bob", capabilities: new Set(["player.queue"]), bots: new Set(["b"]) });
    expect((await f.append()).status).toBe(200);
    expect(f.queue.list()[3]?.requestedBy).toBe("Bob");
    expect(f.queue.getCurrentIndex()).toBe(1);
  });

  it("retains mirror-target write refusal and disabled local-audio protection", async () => {
    const f = fixture();
    f.bot.isMirrorTarget.mockReturnValueOnce(true);
    expect((await f.append()).status).toBe(409);
    expect((await f.append({ playlistId: "list", platform: "local" })).status).toBe(403);
    expect(f.provider.getPlaylistSongs).not.toHaveBeenCalled();
  });

  it.each(["", "   ", 42, null])("rejects invalid playlistId %s before touching providers", async (playlistId) => {
    const f = fixture();
    expect((await request(f.app).post("/api/player/b/append-playlist").send({ playlistId, platform: "qq" })).status).toBe(400);
    expect(f.provider.getPlaylistSongs).not.toHaveBeenCalled();
  });

  it("keeps the legacy playlist command compatible", async () => {
    const f = fixture();
    expect((await request(f.app).post("/api/player/b/playlist").send({ playlistId: "123", platform: "qq" })).status).toBe(200);
    expect(f.bot.executeCommand).toHaveBeenCalledOnce();
    expect(f.provider.getPlaylistSongs).not.toHaveBeenCalled();
  });
});
