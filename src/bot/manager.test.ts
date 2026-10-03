import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { BotManager } from "./manager.js";
import { createDatabase, type BotDatabase } from "../data/database.js";
import { createPermissionStore } from "../data/permissions.js";
import { getDefaultConfig, loadConfig, saveConfig, type BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
import type { MusicProvider } from "../music/provider.js";
import type { AvatarStore } from "../data/avatars.js";
import type { SpotifyOAuth } from "../music/spotify/spotify-oauth.js";

// removeBot only calls logger.info; provide the full shape it could touch.
const stubLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return stubLogger;
  },
} as unknown as Logger;

describe("BotManager.removeBot — guest scope pruning", () => {
  const dirs: string[] = [];
  let db: BotDatabase;

  function makeTmpConfigPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "tsmusicbot-manager-test-"));
    dirs.push(dir);
    return join(dir, "config.json");
  }

  function makeManager(config: BotConfig, configPath: string): BotManager {
    db = createDatabase(":memory:");
    const permissions = createPermissionStore(db.db);
    saveConfig(configPath, config);
    return new BotManager(
      {} as unknown as MusicProvider,
      {} as unknown as MusicProvider,
      {} as unknown as MusicProvider,
      db,
      config,
      stubLogger,
      {} as unknown as AvatarStore,
      permissions,
      configPath
    );
  }

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("prunes a deleted bot from guestMode.bots (array) and persists", async () => {
    const configPath = makeTmpConfigPath();
    const config = getDefaultConfig();
    config.guestMode.bots = ["botA", "botB"];
    const manager = makeManager(config, configPath);

    await manager.removeBot("botA");

    expect(config.guestMode.bots).toEqual(["botB"]);
    // Persisted file must also reflect the prune.
    expect(loadConfig(configPath).guestMode.bots).toEqual(["botB"]);
  });

  it('leaves guestMode.bots === "all" unchanged (no crash, no change)', async () => {
    const configPath = makeTmpConfigPath();
    const config = getDefaultConfig();
    config.guestMode.bots = "all";
    const manager = makeManager(config, configPath);

    await manager.removeBot("botA");

    expect(config.guestMode.bots).toBe("all");
    expect(loadConfig(configPath).guestMode.bots).toBe("all");
  });
});

// --- Spotify OAuth threading (Task 6, C3.1) --------------------------------
// The single process-wide SpotifyOAuth built in index.ts must reach every bot's
// SpotifyController: index -> BotManager (trailing positional arg) -> BotInstance
// -> controller. createBot() builds a REAL (side-effect-free) SpotifyController,
// so we assert the shared instance surfaces via the controller's getOAuth().
describe("BotManager — spotifyOAuth threading to bot controllers (C3.1)", () => {
  const dirs: string[] = [];
  let db: BotDatabase | undefined;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = undefined;
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("forwards its shared SpotifyOAuth into a created bot's controller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsmusicbot-oauth-thread-"));
    dirs.push(dir);
    const configPath = join(dir, "config.json");
    const config = getDefaultConfig();
    saveConfig(configPath, config);
    db = createDatabase(":memory:");
    const permissions = createPermissionStore(db.db);
    const provider = {} as unknown as MusicProvider;
    const sentinel = {} as unknown as SpotifyOAuth;

    const manager = new BotManager(
      provider,
      provider,
      provider,
      db,
      config,
      stubLogger,
      {} as unknown as AvatarStore,
      permissions,
      configPath,
      undefined, // localProvider
      undefined, // kugouProvider
      undefined, // spotifyProvider
      join(dir, "spotify"), // spotifyDataDir
      sentinel, // spotifyOAuth (the single shared instance)
    );

    const bot = await manager.createBot({
      name: "b1",
      serverAddress: "localhost",
      serverPort: 9987,
      nickname: "b1",
    });

    // Full chain observed: the manager's single shared instance is the exact
    // one the per-bot controller now owns (getOAuth() returns it unchanged).
    expect(bot.getSpotifyController().getOAuth()).toBe(sentinel);

    bot.disconnect();
  });
});


describe("per-bot mirror schemes", () => {
  let db: BotDatabase;
  let manager: BotManager;
  let dir: string;
  const params = { name: "Music", nickname: "Music", serverAddress: "TS.Example.", serverPort: 9987 };
  function setup() {
    dir = mkdtempSync(join(tmpdir(), "mirror-schemes-"));
    db = createDatabase(":memory:");
    const provider = {} as MusicProvider;
    manager = new BotManager(provider, provider, provider, db, getDefaultConfig(), stubLogger,
      {} as AvatarStore, createPermissionStore(db.db), join(dir, "config.json"));
    return manager;
  }
  afterEach(() => {
    manager?.shutdown();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("persists independent settings and forwards to multiple outputs with one deduplicated audience", async () => {
    setup();
    const source = await manager.createBot(params);
    const targetA = await manager.createBot({ ...params, serverAddress: " ts.example ", name: "A", channelId: "9", mirrorSourceBotId: source.id });
    const targetB = await manager.createBot({ ...params, name: "B", channelId: "10", mirrorSourceBotId: source.id });
    expect(manager.getBotConfig(targetA.id)).toMatchObject({ mirrorSourceBotId: source.id, mirrorConfigLocked: false });
    expect(manager.getBotMirrorInfo(targetB.id)).toMatchObject({ mode: "mirror", mirrorSourceName: "Music", fixedChannelId: "10", mirrorState: "source-offline" });
    const sendA = vi.spyOn(targetA, "sendMirroredFrame").mockImplementation(() => {});
    const sendB = vi.spyOn(targetB, "sendMirroredFrame").mockImplementation(() => {});
    const frame = Buffer.from([1, 2]);
    source.getPlayer().emit("frame", frame);
    expect(sendA).toHaveBeenCalledWith(frame);
    expect(sendB).toHaveBeenCalledWith(frame);
    vi.spyOn(targetA, "getMirrorAudienceIds").mockResolvedValue(new Set([10, 11]));
    vi.spyOn(targetB, "getMirrorAudienceIds").mockResolvedValue(new Set([11, 12]));
    expect(await (source as any).mirrorAudience()).toEqual(new Set([10, 11, 12]));
    vi.mocked(targetB.getMirrorAudienceIds).mockResolvedValueOnce(null);
    expect(await (source as any).mirrorAudience()).toBeNull();
    const changed = vi.spyOn(source, "notifyMirrorAudienceChanged").mockImplementation(() => {});
    targetA.emit("mirrorAudienceChanged", true);
    targetB.emit("disconnected");
    expect(changed.mock.calls).toEqual([[true], [false]]);
    await manager.removeBot(targetA.id);
    expect(source.getPlayer().listenerCount("frame")).toBe(2);
    expect(await (source as any).mirrorAudience()).toEqual(new Set([11, 12]));
  });

  it("rejects missing sources, self links, chains, cycles, foreign servers and unfixed channels without saving", async () => {
    setup();
    const source = await manager.createBot(params);
    const target = await manager.createBot({ ...params, channelId: "9", mirrorSourceBotId: source.id });
    await expect(manager.createBot({ ...params, channelId: "9", mirrorSourceBotId: "absent" })).rejects.toThrow("does not exist");
    await expect(manager.createBot({ ...params, channelId: "9", mirrorSourceBotId: target.id })).rejects.toThrow("chains");
    await expect(manager.createBot({ ...params, mirrorSourceBotId: source.id })).rejects.toThrow("channelId");
    await expect(manager.createBot({ ...params, channelId: "0", mirrorSourceBotId: source.id })).rejects.toThrow("channelId");
    await expect(manager.createBot({ ...params, serverPort: 9988, channelId: "9", mirrorSourceBotId: source.id })).rejects.toThrow("same TeamSpeak server");
    expect(() => manager.updateBot(source.id, { channelId: "9", mirrorSourceBotId: source.id })).toThrow("itself");
    expect(() => manager.updateBot(source.id, { channelId: "9", mirrorSourceBotId: target.id })).toThrow("chains");
    const other = await manager.createBot({ ...params, name: "Other" });
    expect(() => manager.updateBot(source.id, { channelId: "9", mirrorSourceBotId: other.id })).toThrow("chains");
    expect(() => manager.updateBot(source.id, { serverAddress: "elsewhere" })).toThrow("same TeamSpeak server");
    await expect(manager.removeBot(source.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(db.getBotInstances()).toHaveLength(3);
    expect(manager.getBotConfig(source.id)?.mirrorSourceBotId).toBe("");
  });

  it("allows a connected unchanged full form and name edit, but requires stop for connection or mode changes", async () => {
    setup();
    const source = await manager.createBot(params);
    const target = await manager.createBot({ ...params, channelId: "9", mirrorSourceBotId: source.id });
    vi.spyOn(target, "isConnectionActive").mockReturnValue(true);
    const config = manager.getBotConfig(target.id)!;
    manager.updateBot(target.id, { ...config, serverProtocol: undefined, name: "Renamed" });
    expect(target.name).toBe("Renamed");
    expect(() => manager.updateBot(target.id, { channelId: "10" })).toThrow("Stop the bot");
    expect(() => manager.updateBot(target.id, { mirrorSourceBotId: "" })).toThrow("Stop the bot");
    vi.mocked(target.isConnectionActive).mockReturnValue(false);
    manager.updateBot(target.id, { mirrorSourceBotId: "" });
    expect(target.isMirrorTarget()).toBe(false);
    expect((target as any).mirrorQueue).toBeNull();
    expect(manager.getBotMirrorInfo(target.id).mode).toBe("music");
    expect(source.getPlayer().listenerCount("frame")).toBe(1);
    expect((source as any).mirrorAudience).toBeNull();
    await manager.removeBot(source.id);
  });

  it("loads and wires all mirrors before connecting and never restores their independent queue", async () => {
    setup();
    const source = await manager.createBot(params);
    const output = await manager.createBot({ ...params, channelId: "9", mirrorSourceBotId: source.id });
    manager.shutdown();
    const connections: boolean[] = [];
    const { BotInstance } = await import("./instance.js");
    const connect = vi.spyOn(BotInstance.prototype, "connect").mockImplementation(async function (this: import("./instance.js").BotInstance) {
      connections.push(this.isMirrorTarget());
      expect(manager.getBot(output.id)?.isMirrorTarget()).toBe(true);
    });
    db.saveBotInstance({ ...manager.getBotConfig(source.id)!, autoStart: true });
    db.saveBotInstance({ ...manager.getBotConfig(output.id)!, autoStart: true });
    await manager.loadSavedBots();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connections).toEqual([false, true]);
  });

  it("recreates a stopped output with its updated fixed channel and detaches the old instance", async () => {
    setup();
    const source = await manager.createBot(params);
    const output = await manager.createBot({ ...params, channelId: "9", mirrorSourceBotId: source.id });
    manager.updateBot(output.id, { channelId: "10" });
    const { BotInstance } = await import("./instance.js");
    vi.spyOn(BotInstance.prototype, "connect").mockResolvedValue();
    await manager.startBot(output.id);
    const replacement = manager.getBot(output.id)!;
    expect(replacement).not.toBe(output);
    expect(replacement.isMirrorTarget()).toBe(true);
    expect((replacement as any).mirrorChannelId).toBe("10");
    expect(output.listenerCount("mirrorAudienceChanged")).toBe(0);
    expect(source.getPlayer().listenerCount("frame")).toBe(2);
  });

  it("fails closed on an invalid saved scheme before creating or connecting any instances", async () => {
    setup();
    const source = await manager.createBot(params);
    manager.shutdown();
    db.saveBotInstance({ ...manager.getBotConfig(source.id)!, mirrorSourceBotId: "missing", autoStart: true });
    await expect(manager.loadSavedBots()).rejects.toThrow("does not exist");
    expect(manager.getAllBots()).toHaveLength(0);
  });

  it("keeps file-configured bindings effective and locked while allowing unchanged forms", async () => {
    setup();
    const source = await manager.createBot(params);
    const target = await manager.createBot({ ...params, channelId: "9" });
    manager.shutdown();
    writeFileSync(join(dir, "mirror.json"), JSON.stringify({ sourceBotId: source.id, targetBotId: target.id }));
    const provider = {} as MusicProvider;
    manager = new BotManager(provider, provider, provider, db, getDefaultConfig(), stubLogger,
      {} as AvatarStore, createPermissionStore(db.db), join(dir, "config.json"));
    await manager.loadSavedBots();
    expect(manager.getBotConfig(target.id)).toMatchObject({ mirrorSourceBotId: source.id, mirrorConfigLocked: true });
    manager.updateBot(target.id, { ...manager.getBotConfig(target.id)!, serverProtocol: undefined, name: "Output" });
    expect(() => manager.updateBot(target.id, { mirrorSourceBotId: "" })).toThrow("locked");
    expect(() => manager.updateBot(target.id, { channelId: "10" })).toThrow("locked");
    await expect(manager.removeBot(source.id)).rejects.toThrow("被 1 个镜像使用");
  });
});
