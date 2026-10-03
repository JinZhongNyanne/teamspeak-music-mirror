import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { BotInstance } from "./instance.js";
import { ManagedVoiceClientRegistry } from "./managed-voice-clients.js";
import { MirrorRelay, loadMirrorConfig } from "./mirror.js";
import { createPlayerRouter } from "../web/api/player.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("mirror configuration", () => {
  it("is optional and rejects an invalid/self-referencing route", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-mirror-"));
    dirs.push(dir);
    const filename = join(dir, "mirror.json");
    expect(loadMirrorConfig(filename, {})).toBeNull();
    writeFileSync(filename, JSON.stringify({ sourceBotId: "source", targetBotId: "target" }));
    expect(loadMirrorConfig(filename, {})).toEqual({ sourceBotId: "source", targetBotId: "target" });
    for (const value of [null, {}, { sourceBotId: "same", targetBotId: "same" },
      { sourceBotId: " same ", targetBotId: "same" },
      { sourceBotId: "source", targetBotId: "  " },
      { sourceBotId: 1, targetBotId: "target" }]) {
      writeFileSync(filename, JSON.stringify(value));
      expect(() => loadMirrorConfig(filename, {})).toThrow("distinct");
    }
  });

  it("uses environment IDs without reading a missing or invalid configuration file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-mirror-"));
    dirs.push(dir);
    const filename = join(dir, "mirror.json");
    const env = { MIRROR_SOURCE_BOT_ID: " source ", MIRROR_TARGET_BOT_ID: " target " };
    expect(loadMirrorConfig(filename, env)).toEqual({ sourceBotId: "source", targetBotId: "target" });
    writeFileSync(filename, "invalid JSON");
    expect(loadMirrorConfig(filename, { ...env, MIRROR_CONFIG_PATH: "" }))
      .toEqual({ sourceBotId: "source", targetBotId: "target" });
  });

  it.each([
    { MIRROR_SOURCE_BOT_ID: "source" },
    { MIRROR_TARGET_BOT_ID: "target" },
    { MIRROR_SOURCE_BOT_ID: "", MIRROR_TARGET_BOT_ID: "" },
    { MIRROR_SOURCE_BOT_ID: "source", MIRROR_TARGET_BOT_ID: " " },
    { MIRROR_SOURCE_BOT_ID: "same", MIRROR_TARGET_BOT_ID: " same " },
  ])("rejects incomplete or invalid environment IDs without falling back to the file: %j", (env) => {
    const dir = mkdtempSync(join(tmpdir(), "ts-mirror-"));
    dirs.push(dir);
    const filename = join(dir, "mirror.json");
    writeFileSync(filename, JSON.stringify({ sourceBotId: "source", targetBotId: "target" }));
    expect(() => loadMirrorConfig(filename, env)).toThrow("MIRROR_SOURCE_BOT_ID and MIRROR_TARGET_BOT_ID");
  });

  it("reads MIRROR_CONFIG_PATH instead of the default file and fails on missing explicit paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-mirror-"));
    dirs.push(dir);
    const filename = join(dir, "mirror.json");
    const customPath = join(dir, "custom.json");
    writeFileSync(filename, "invalid JSON");
    writeFileSync(customPath, JSON.stringify({ sourceBotId: " source ", targetBotId: " target " }));
    expect(loadMirrorConfig(filename, { MIRROR_CONFIG_PATH: customPath }))
      .toEqual({ sourceBotId: "source", targetBotId: "target" });
    expect(() => loadMirrorConfig(filename, { MIRROR_CONFIG_PATH: join(dir, "missing.json") }))
      .toThrow();
    expect(() => loadMirrorConfig(filename, { MIRROR_CONFIG_PATH: " " })).toThrow("MIRROR_CONFIG_PATH");
  });
});

function relayBot(): any {
  const bot = new EventEmitter() as any;
  const player = new EventEmitter();
  bot.getPlayer = () => player;
  bot.connected = true;
  bot.getStatus = () => ({ playing: true, connected: bot.connected });
  const avatars = new EventEmitter();
  const profile = {
    getAppliedAvatar: vi.fn(() => bot.appliedAvatar),
    subscribeAvatar: (listener: (bytes: Buffer | null) => void) => {
      avatars.on("avatar", listener);
      return () => avatars.off("avatar", listener);
    },
    mirrorAvatar: vi.fn(async () => {}),
  };
  bot.avatars = avatars;
  bot.getProfileManager = () => profile;
  bot.setMirrorSource = vi.fn();
  bot.setMirrorAudience = vi.fn();
  bot.getQueue = () => [];
  bot.getMirrorAudienceIds = vi.fn(async () => new Set([10, 11]));
  bot.notifyMirrorAudienceChanged = vi.fn();
  bot.sendMirroredFrame = vi.fn();
  return bot;
}

describe("one playback clock with an isolated output", () => {
  it("forwards current encoded frames, survives target failure, and detaches old instances", () => {
    const relay = new MirrorRelay();
    const source = relayBot(), target = relayBot(), replacement = relayBot();
    relay.bind(source, target);
    const frame = Buffer.from([1, 3, 5, 7]);
    source.getPlayer().emit("frame", frame);
    expect(target.sendMirroredFrame).toHaveBeenCalledWith(frame);
    target.sendMirroredFrame.mockImplementation(() => { throw new Error("socket closed"); });
    expect(() => source.getPlayer().emit("frame", frame)).not.toThrow();
    relay.bind(replacement, target);
    expect(source.getPlayer().listenerCount("frame")).toBe(0);
    expect(target.listenerCount("mirrorAudienceChanged")).toBe(1);
    relay.dispose();
    expect(replacement.getPlayer().listenerCount("frame")).toBe(0);
    expect(target.listenerCount("mirrorAudienceChanged")).toBe(0);
  });

  it("replays actual cached bytes on bind and reconnect, skips disconnected output and detaches", async () => {
    const relay = new MirrorRelay();
    const source = relayBot(), target = relayBot();
    source.appliedAvatar = Buffer.from("idle custom");
    target.connected = false;
    relay.bind(source, target);
    expect(target.getProfileManager().mirrorAvatar).not.toHaveBeenCalled();
    target.connected = true;
    target.emit("connected");
    expect(target.getProfileManager().mirrorAvatar).toHaveBeenLastCalledWith(source.appliedAvatar, expect.any(Function));
    target.emit("connected");
    expect(target.getProfileManager().mirrorAvatar).toHaveBeenLastCalledWith(source.appliedAvatar, expect.any(Function));
    source.appliedAvatar = Buffer.from("cover");
    source.avatars.emit("avatar", source.appliedAvatar);
    target.emit("connected");
    expect(target.getProfileManager().mirrorAvatar).toHaveBeenLastCalledWith(source.appliedAvatar, expect.any(Function));
    target.connected = false;
    source.appliedAvatar = null;
    source.avatars.emit("avatar", null);
    expect(target.getProfileManager().mirrorAvatar).toHaveBeenCalledTimes(4);
    target.connected = true;
    target.emit("connected");
    expect(target.getProfileManager().mirrorAvatar).toHaveBeenLastCalledWith(null, expect.any(Function));
    target.getProfileManager().mirrorAvatar.mockRejectedValueOnce(new Error("output failed"));
    source.avatars.emit("avatar", Buffer.from("new"));
    await new Promise(resolve => setImmediate(resolve));
    const bound = target.getProfileManager().mirrorAvatar.mock.calls.at(-1)[1];
    relay.dispose();
    expect(bound()).toBe(false);
    expect(source.avatars.listenerCount("avatar")).toBe(0);
    expect(target.listenerCount("connected")).toBe(0);
  });

  it("counts the output audience and propagates return/leave events", async () => {
    const relay = new MirrorRelay();
    const source = relayBot(), target = relayBot();
    relay.bind(source, target);
    expect(await source.setMirrorAudience.mock.calls.at(-1)[0]()).toEqual(new Set([10, 11]));
    const state = vi.fn();
    target.on("stateChange", state);
    source.emit("stateChange");
    expect(state).toHaveBeenCalledOnce();
    target.emit("mirrorAudienceChanged", true);
    target.emit("disconnected");
    expect(source.notifyMirrorAudienceChanged.mock.calls).toEqual([[true], [false]]);
    relay.dispose();
  });
});

function mirrorInstance(): any {
  return Object.assign(Object.create(BotInstance.prototype), {
    id: "target", name: "音乐镜像", connected: true,
    mirrorSource: () => ({ id: "source", name: "音乐", connected: true, playing: true, elapsed: 42 }),
    mirrorChannelId: "9",
    tsClient: { sendVoiceData: vi.fn(), getChannelId: () => 9n },
  });
}

describe("output-only BotInstance", () => {
  it("rejects chat/REST commands and every public playback entry before side effects", async () => {
    const bot = mirrorInstance();
    for (const call of [
      () => bot.executeCommand({ name: "move", args: "1" }, undefined, "user"),
      () => bot.executeCommand({ name: "play", args: "song" }, undefined, "user"),
      () => bot.resolveAndPlay({ id: "song" }),
      () => bot.playSingleSong({ id: "song" }),
      () => bot.loadSavedQueue([], "replace"),
      () => bot.startFm({}),
      () => bot.playNext(),
    ]) await expect(call()).rejects.toThrow("mirrors audio");
    expect(() => bot.seek(5)).toThrow("mirrors audio");
    // A chat event is ignored before parsing/permission queries.
    await bot.handleTextMessage({ message: "!move 1" });
  });

  it("only sends in the fixed channel while connected and mirrors source status", () => {
    const bot = mirrorInstance();
    const frame = Buffer.from([3, 2, 1]);
    bot.sendMirroredFrame(frame);
    expect(bot.tsClient.sendVoiceData).toHaveBeenCalledWith(frame);
    expect(bot.tsClient.sendVoiceData.mock.calls[0][0]).not.toBe(frame);
    expect(bot.getStatus()).toMatchObject({ id: "target", name: "音乐镜像", playing: true, elapsed: 42 });
    bot.tsClient.getChannelId = () => 8n;
    bot.sendMirroredFrame(frame);
    bot.connected = false;
    bot.tsClient.getChannelId = () => 9n;
    bot.sendMirroredFrame(frame);
    expect(bot.tsClient.sendVoiceData).toHaveBeenCalledTimes(1);
  });

  it("aggregates audience without pausing on unknown output occupancy", async () => {
    const bot = Object.assign(Object.create(BotInstance.prototype), {
      connected: true, lifecycleGeneration: 1, occupancyRequest: 0,
      tsClient: { getClientId: () => 1, getClientsInChannel: async () => [{ id: 1 }] },
      managedVoiceClients: new ManagedVoiceClientRegistry(),
      voiceServerScope: { host: "test", voicePort: 9987 },
      mirrorAudience: async () => new Set([10, 11]),
      handleOccupancy: vi.fn(),
    });
    await bot.refreshOccupancy();
    expect(bot.handleOccupancy).toHaveBeenCalledWith(2);
    bot.mirrorAudience = async () => null;
    await bot.refreshOccupancy();
    expect(bot.handleOccupancy).toHaveBeenCalledTimes(1);
    bot.mirrorAudience = async () => new Set();
    await bot.refreshOccupancy();
    expect(bot.handleOccupancy).toHaveBeenLastCalledWith(0);
  });

  it("excludes both managed bots and deduplicates listeners in a shared room", async () => {
    const registry = new ManagedVoiceClientRegistry();
    const scope = { host: "test", voicePort: 9987 };
    registry.register(scope, 1, "source");
    registry.register(scope, 2, "target");
    let clients = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 3 }];
    const bot = Object.assign(Object.create(BotInstance.prototype), {
      connected: true, lifecycleGeneration: 1, occupancyRequest: 0,
      tsClient: { getClientId: () => 1, getClientsInChannel: async () => clients },
      managedVoiceClients: registry, voiceServerScope: scope,
      mirrorAudience: async () => new Set([3]), handleOccupancy: vi.fn(),
    });
    await bot.refreshOccupancy();
    expect(bot.handleOccupancy).toHaveBeenLastCalledWith(1);
    clients = [{ id: 1 }, { id: 2 }];
    bot.mirrorAudience = async () => new Set();
    await bot.refreshOccupancy();
    expect(bot.handleOccupancy).toHaveBeenLastCalledWith(0);
    clients = [{ id: 2 }];
    await bot.refreshOccupancy();
    expect(bot.handleOccupancy).toHaveBeenCalledTimes(2);
  });

  it("treats output query failures and channel changes as unknown", async () => {
    let channel = 19n;
    const client = {
      getClientId: () => 2, getChannelId: () => channel,
      getClientsInChannel: vi.fn(async () => [{ id: 2 }, { id: 3 }]),
    };
    const bot = Object.assign(Object.create(BotInstance.prototype), {
      connected: true, lifecycleGeneration: 1, tsClient: client,
      managedVoiceClients: new ManagedVoiceClientRegistry(),
      voiceServerScope: { host: "test", voicePort: 9987 },
    });
    expect(await bot.getMirrorAudienceIds()).toEqual(new Set([3]));
    client.getClientsInChannel.mockResolvedValueOnce([]);
    expect(await bot.getMirrorAudienceIds()).toBeNull();
    client.getClientsInChannel.mockImplementationOnce(async () => {
      channel = 20n;
      return [{ id: 2 }, { id: 3 }];
    });
    expect(await bot.getMirrorAudienceIds()).toBeNull();
    bot.connected = false;
    expect(await bot.getMirrorAudienceIds()).toEqual(new Set());
  });

  it("returns an isolated source queue view", () => {
    const queue = [{ id: "song", name: "original", artists: ["artist"] }];
    const bot = Object.assign(Object.create(BotInstance.prototype), {
      mirrorQueue: () => queue,
    });
    const view = bot.getQueue();
    expect(view).toEqual(queue);
    view[0].name = "changed";
    view[0].artists.push("other");
    view.pop();
    expect(queue).toEqual([{ id: "song", name: "original", artists: ["artist"] }]);
  });

  it("preserves manual pauses and never idle-disconnects the output", () => {
    const bot = Object.assign(Object.create(BotInstance.prototype), {
      connected: true, autoPaused: false, idleTimer: null,
      player: { getState: () => "paused" },
      handleOccupancy: vi.fn(), refreshOccupancy: vi.fn(async () => {}),
    });
    bot.notifyMirrorAudienceChanged(true);
    expect(bot.handleOccupancy).not.toHaveBeenCalled();
    bot.autoPaused = true;
    bot.notifyMirrorAudienceChanged(true);
    expect(bot.handleOccupancy).toHaveBeenCalledWith(1);
    expect(() => mirrorInstance().handleOccupancy(0)).not.toThrow();
  });

  it("blocks REST routes that bypass executeCommand", async () => {
    const bot = mirrorInstance();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = { role: "admin" }; next(); });
    app.use("/api/player", createPlayerRouter({ getBot: () => bot } as any, {} as any));
    for (const route of ["play-song", "play-artist", "seek", "fm", "resume"]) {
      const response = await request(app).post(`/api/player/target/${route}`).send({});
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("control the source");
    }
  });
});
