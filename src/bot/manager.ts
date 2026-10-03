import crypto from "node:crypto";
import { loadMirrorConfig, MirrorRelay, type MirrorConfig } from "./mirror.js";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  BotInstance,
  type BotInstanceOptions,
} from "./instance.js";
import type { MusicProvider } from "../music/provider.js";
import { YouTubeProvider } from "../music/youtube.js";
import type { BotDatabase, BotInstance as SavedBot } from "../data/database.js";
import { saveConfig, type BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";

import type { ServerProtocol } from "../ts-protocol/client.js";
import type { AvatarStore } from "../data/avatars.js";
import type { PermissionStore } from "../data/permissions.js";
import type { SpotifyOAuth } from "../music/spotify/spotify-oauth.js";
import { normalizeManagedVoiceHost, ManagedVoiceClientRegistry } from "./managed-voice-clients.js";

/**
 * Run bot.connect() with a hard deadline. If the handshake hangs (e.g. the
 * server silently drops the connection after initivexpand2), we tear the
 * instance down instead of waiting for the library's 60s idle timeout, so
 * the HTTP /start call returns promptly and the UI doesn't lock up.
 */
async function connectWithTimeout(
  bot: BotInstance,
  ms: number,
  logger: Logger
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`connect timeout after ${ms}ms`)),
      ms
    );
  });
  try {
    await Promise.race([bot.connect(), timeout]);
  } catch (err) {
    logger.warn(
      { err, botId: bot.id },
      "Connect failed or timed out — tearing down instance"
    );
    try {
      bot.disconnect();
    } catch {
      // ignore teardown errors
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class MirrorConfigurationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "MirrorConfigurationError";
  }
}

export interface CreateBotParams {
  name: string;
  serverAddress: string;
  serverPort: number;
  queryPort?: number;
  nickname: string;
  defaultChannel?: string;
  channelId?: string;
  channelPassword?: string;
  autoStart?: boolean;
  /** Force TS3 or TS6 protocol; omit or "unknown" for auto-detect. */
  serverProtocol?: ServerProtocol;
  /** API key for TS6 HTTP Query (port 10080/10443). */
  ts6ApiKey?: string;
  /** Password required to join the TS server. */
  serverPassword?: string;
  /** Empty selects independent music playback. */
  mirrorSourceBotId?: string;
}

export class BotManager extends EventEmitter {
  private bots = new Map<string, BotInstance>();
  private readonly managedVoiceClients = new ManagedVoiceClientRegistry();
  private neteaseProvider: MusicProvider;
  private qqProvider: MusicProvider;
  private bilibiliProvider: MusicProvider;
  private youtubeProvider: MusicProvider;
  private localProvider: MusicProvider;
  private kugouProvider: MusicProvider;
  private spotifyProvider: MusicProvider;
  private jellyfinProvider: MusicProvider;
  private spotifyDataDir: string;
  private readonly spotifyOAuth?: SpotifyOAuth;
  private database: BotDatabase;
  private config: BotConfig;
  private logger: Logger;
  private avatarStore: AvatarStore;
  private permissions: PermissionStore;
  private configPath: string;
  private readonly mirror: MirrorConfig | null;
  private readonly mirrorRelays = new Map<string, MirrorRelay>();

  constructor(
    neteaseProvider: MusicProvider,
    qqProvider: MusicProvider,
    bilibiliProvider: MusicProvider,
    database: BotDatabase,
    config: BotConfig,
    logger: Logger,
    avatarStore: AvatarStore,
    permissions: PermissionStore,
    configPath: string,
    localProvider?: MusicProvider,
    kugouProvider?: MusicProvider,
    spotifyProvider?: MusicProvider,
    spotifyDataDir?: string,
    spotifyOAuth?: SpotifyOAuth,
    jellyfinProvider?: MusicProvider
  ) {
    super();
    this.neteaseProvider = neteaseProvider;
    this.qqProvider = qqProvider;
    this.bilibiliProvider = bilibiliProvider;
    this.youtubeProvider = new YouTubeProvider();
    this.localProvider = localProvider ?? neteaseProvider;
    this.kugouProvider = kugouProvider ?? neteaseProvider;
    this.spotifyProvider = spotifyProvider ?? neteaseProvider;
    this.jellyfinProvider = jellyfinProvider ?? neteaseProvider;
    this.spotifyDataDir = spotifyDataDir ?? path.join(process.cwd(), "data", "spotify");
    this.spotifyOAuth = spotifyOAuth;
    // Let the local provider see which uploads are still referenced by any
    // bot's queue, so it never deletes a file another queue/bot still needs.
    const referenceable = this.localProvider as Partial<{
      setInUseResolver: (resolver: () => Set<string>) => void;
    }>;
    referenceable.setInUseResolver?.(() => this.getReferencedLocalSongIds());
    this.database = database;
    this.config = config;
    this.logger = logger;
    this.avatarStore = avatarStore;
    this.permissions = permissions;
    this.configPath = configPath;
    this.mirror = loadMirrorConfig(path.join(path.dirname(configPath), "mirror.json"));
  }

  async createBot(params: CreateBotParams): Promise<BotInstance> {
    const id = crypto.randomUUID();
    const saved: SavedBot = {
      id, name: params.name, serverAddress: params.serverAddress,
      serverPort: params.serverPort, nickname: params.nickname,
      defaultChannel: params.defaultChannel ?? "", channelId: params.channelId ?? "",
      channelPassword: params.channelPassword ?? "", autoStart: params.autoStart ?? false,
      serverProtocol: params.serverProtocol ?? "", ts6ApiKey: params.ts6ApiKey ?? "",
      serverPassword: params.serverPassword ?? "", mirrorSourceBotId: params.mirrorSourceBotId?.trim() ?? "",
    };
    this.validateMirrorBots([...this.database.getBotInstances(), saved]);

    const bot = new BotInstance({
      id,
      name: params.name,
      tsOptions: {
        host: params.serverAddress,
        port: params.serverPort,
        queryPort: params.queryPort ?? 10011,
        nickname: params.nickname,
        defaultChannel: params.defaultChannel,
        channelId: params.channelId,
        channelPassword: params.channelPassword,
        serverPassword: params.serverPassword,
        serverProtocol: params.serverProtocol,
        ts6ApiKey: params.ts6ApiKey,
      },
      neteaseProvider: this.neteaseProvider,
      qqProvider: this.qqProvider,
      bilibiliProvider: this.bilibiliProvider,
      youtubeProvider: this.youtubeProvider,
      localProvider: this.localProvider,
      kugouProvider: this.kugouProvider,
      spotifyProvider: this.spotifyProvider,
      jellyfinProvider: this.jellyfinProvider,
      database: this.database,
      config: this.config,
      logger: this.logger,
      avatarStore: this.avatarStore,
      managedVoiceClients: this.managedVoiceClients,
      spotifyDataDir: this.spotifyDataDir,
      spotifyOAuth: this.spotifyOAuth,
    });

    this.database.saveBotInstance(saved);
    this.bots.set(id, bot);
    this.rewireMirror();
    this.emit("botInstance", bot);

    this.logger.info({ botId: id, name: params.name }, "Bot instance created");
    return bot;
  }

  async removeBot(id: string): Promise<void> {
    const dependents = this.database.getBotInstances().filter((bot) => this.sourceId(bot) === id);
    if (dependents.length) throw new MirrorConfigurationError(`该机器人被 ${dependents.length} 个镜像使用，请先解除镜像关联再删除。`, 409);
    if (id === this.mirror?.targetBotId) throw new MirrorConfigurationError("Mirror configuration is locked by environment/file settings; remove that binding first", 409);
    const bot = this.bots.get(id);
    if (bot) {
      bot.disconnect();
      this.bots.delete(id);
    }
    this.database.deleteBotInstance(id);
    this.rewireMirror();
    this.permissions.pruneBot(id);
    // Prune the deleted bot from the guest scope allow-list (mirrors permissions.pruneBot).
    if (Array.isArray(this.config.guestMode.bots) && this.config.guestMode.bots.includes(id)) {
      this.config.guestMode.bots = this.config.guestMode.bots.filter((b) => b !== id);
      saveConfig(this.configPath, this.config);
    }
    this.emit("botInstanceRemoved", id);
    this.logger.info({ botId: id }, "Bot instance removed");
  }

  updateBot(id: string, params: Partial<CreateBotParams>): void {
    const instances = this.database.getBotInstances();
    const existing = instances.find((bot) => bot.id === id);
    if (!existing) throw new Error(`Bot ${id} not found`);
    const next: SavedBot = {
      ...existing,
      name: params.name ?? existing.name,
      serverAddress: params.serverAddress ?? existing.serverAddress,
      serverPort: params.serverPort ?? existing.serverPort,
      nickname: params.nickname ?? existing.nickname,
      defaultChannel: params.defaultChannel ?? existing.defaultChannel,
      channelId: params.channelId ?? existing.channelId,
      channelPassword: params.channelPassword ?? existing.channelPassword,
      serverProtocol: params.serverProtocol ?? existing.serverProtocol,
      ts6ApiKey: params.ts6ApiKey ?? existing.ts6ApiKey,
      serverPassword: params.serverPassword ?? existing.serverPassword,
      autoStart: params.autoStart ?? existing.autoStart,
      mirrorSourceBotId: params.mirrorSourceBotId?.trim() ?? existing.mirrorSourceBotId ?? "",
    };
    const connectionKeys = ["serverAddress", "serverPort", "nickname", "defaultChannel", "channelId", "channelPassword", "serverProtocol", "ts6ApiKey", "serverPassword"] as const;
    const connectionChanged = connectionKeys.some((key) => next[key] !== existing[key]);
    const modeChanged = this.sourceId(existing) !== (params.mirrorSourceBotId === undefined ? this.sourceId(existing) : next.mirrorSourceBotId);
    if (id === this.mirror?.targetBotId && (connectionChanged || modeChanged)) {
      throw new MirrorConfigurationError("Mirror configuration is locked by environment/file settings; edit that binding first", 409);
    }
    const bot = this.bots.get(id);
    if (bot?.isConnectionActive() && (connectionChanged || modeChanged)) {
      throw new MirrorConfigurationError("Stop the bot before changing its connection or mirror scheme", 409);
    }
    this.validateMirrorBots(instances.map((saved) => saved.id === id ? next : saved));
    this.database.saveBotInstance(next);
    if (bot) bot.name = next.name;
    // startBot reconstructs the TeamSpeak client using the updated saved channel.
    this.rewireMirror();
    bot?.emit("stateChange");
    this.logger.info({ botId: id }, "Bot instance config updated");
  }

  getBotConfig(id: string): (SavedBot & { mirrorConfigLocked: boolean }) | undefined {
    const saved = this.database.getBotInstances().find((bot) => bot.id === id);
    return saved ? { ...saved, mirrorSourceBotId: this.sourceId(saved), mirrorConfigLocked: id === this.mirror?.targetBotId } : undefined;
  }

  getBotMirrorInfo(id: string): {
    mode: "music" | "mirror";
    mirrorSourceBotId: string;
    mirrorSourceName: string;
    mirrorState: "source-offline" | "output-offline" | "syncing" | "idle";
    mirrorConfigLocked: boolean;
    fixedChannelId: string;
  } {
    const saved = this.database.getBotInstances().find((bot) => bot.id === id);
    const sourceId = saved ? this.sourceId(saved) : "";
    const source = sourceId ? this.bots.get(sourceId) : undefined;
    const output = this.bots.get(id);
    return {
      mode: sourceId ? "mirror" : "music",
      mirrorSourceBotId: sourceId,
      mirrorSourceName: source?.name ?? this.database.getBotInstances().find((bot) => bot.id === sourceId)?.name ?? "",
      mirrorState: !sourceId ? "idle" : !source?.isConnected() ? "source-offline" : !output?.isConnected() ? "output-offline" : source.getStatus().playing ? "syncing" : "idle",
      mirrorConfigLocked: id === this.mirror?.targetBotId,
      fixedChannelId: sourceId ? saved?.channelId ?? "" : "",
    };
  }

  getBot(id: string): BotInstance | undefined {
    return this.bots.get(id);
  }

  getAllBots(): BotInstance[] {
    return Array.from(this.bots.values());
  }

  /** Local upload ids still referenced by any bot's queue. The local provider
   *  uses this to avoid deleting a file another queue/bot is still using. */
  getReferencedLocalSongIds(): Set<string> {
    const ids = new Set<string>();
    for (const bot of this.bots.values()) {
      for (const song of bot.getQueueManager().list()) {
        if (song.platform === "local") ids.add(song.id);
      }
    }
    return ids;
  }

  async startBot(id: string): Promise<void> {
    const oldBot = this.bots.get(id);
    if (!oldBot) throw new Error(`Bot ${id} not found`);

    this.validateMirrorBots(this.database.getBotInstances());

    // Always tear down the outgoing instance before creating a replacement.
    // Covers three cases:
    //   1. oldBot is fully connected (manual restart)
    //   2. oldBot is mid-handshake from a prior rapid start (isConnected()
    //      still returns false but the library client is live and will leak
    //      a TS session if we abandon it)
    //   3. oldBot was just created by createBot but never connected — the
    //      disconnect call is a cheap no-op here.
    // Calling disconnect() is idempotent (disconnectEmitted guards event
    // emission), so this is safe in all states.
    oldBot.disconnect();

    // Reload config from database so updated settings (channel, nickname, etc.) take effect
    const saved = this.database.getBotInstances().find((i) => i.id === id);
    if (saved) {
      const proto = saved.serverProtocol as "ts3" | "ts6" | "" | undefined;
      const bot = new BotInstance({
        id: saved.id,
        name: saved.name,
        tsOptions: {
          host: saved.serverAddress,
          port: saved.serverPort,
          queryPort: proto === "ts6" ? 10080 : 10011,
          nickname: saved.nickname,
          // Reuse the stored identity so server groups assigned to this bot
          // survive restarts — without this the TS server sees a new UID
          // each connect and strips all previously granted groups.
          identity: saved.identity || undefined,
          defaultChannel: saved.defaultChannel || undefined,
          channelId: saved.channelId || undefined,
          channelPassword: saved.channelPassword || undefined,
          serverPassword: saved.serverPassword || undefined,
          serverProtocol: proto === "ts3" || proto === "ts6" ? proto : undefined,
          ts6ApiKey: saved.ts6ApiKey || undefined,
        },
        neteaseProvider: this.neteaseProvider,
        qqProvider: this.qqProvider,
        bilibiliProvider: this.bilibiliProvider,
        youtubeProvider: this.youtubeProvider,
        localProvider: this.localProvider,
        kugouProvider: this.kugouProvider,
        spotifyProvider: this.spotifyProvider,
        jellyfinProvider: this.jellyfinProvider,
        database: this.database,
        config: this.config,
        logger: this.logger,
        avatarStore: this.avatarStore,
        managedVoiceClients: this.managedVoiceClients,
        spotifyDataDir: this.spotifyDataDir,
        spotifyOAuth: this.spotifyOAuth,
      });
      this.bots.set(id, bot);
      this.rewireMirror();
      this.emit("botInstance", bot);
      await connectWithTimeout(bot, 15_000, this.logger);
      // Mark as autoStart so it reconnects on Docker restart, and persist identity
      this.database.saveBotInstance({ ...saved, autoStart: true });
      this.persistBotIdentity(saved, bot);
    } else {
      await connectWithTimeout(oldBot, 15_000, this.logger);
    }
  }

  stopBot(id: string): void {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    bot.disconnect();

    // Mark as not autoStart so it stays stopped on Docker restart
    const saved = this.database.getBotInstances().find((i) => i.id === id);
    if (saved) {
      this.database.saveBotInstance({ ...saved, autoStart: false });
    }
  }

  async loadSavedBots(): Promise<void> {
    const savedInstances = this.database.getBotInstances();
    this.validateMirrorBots(savedInstances);
    for (const saved of savedInstances) {
      const proto = saved.serverProtocol as "ts3" | "ts6" | "" | undefined;
      const bot = new BotInstance({
        id: saved.id,
        name: saved.name,
        tsOptions: {
          host: saved.serverAddress,
          port: saved.serverPort,
          queryPort: proto === "ts6" ? 10080 : 10011,
          nickname: saved.nickname,
          identity: saved.identity || undefined,
          defaultChannel: saved.defaultChannel || undefined,
          channelId: saved.channelId || undefined,
          channelPassword: saved.channelPassword || undefined,
          serverPassword: saved.serverPassword || undefined,
          serverProtocol: proto === "ts3" || proto === "ts6" ? proto : undefined,
          ts6ApiKey: saved.ts6ApiKey || undefined,
        },
        neteaseProvider: this.neteaseProvider,
        qqProvider: this.qqProvider,
        bilibiliProvider: this.bilibiliProvider,
        youtubeProvider: this.youtubeProvider,
        localProvider: this.localProvider,
        kugouProvider: this.kugouProvider,
        spotifyProvider: this.spotifyProvider,
        jellyfinProvider: this.jellyfinProvider,
        database: this.database,
        config: this.config,
        logger: this.logger,
        avatarStore: this.avatarStore,
        managedVoiceClients: this.managedVoiceClients,
        spotifyDataDir: this.spotifyDataDir,
        spotifyOAuth: this.spotifyOAuth,
      });

      this.bots.set(saved.id, bot);
    }
    this.rewireMirror();
    for (const saved of savedInstances) {
      const bot = this.bots.get(saved.id)!;
      this.emit("botInstance", bot);
      // Only auto-connect bots that have autoStart enabled
      if (saved.autoStart) {
        bot.connect().then(() => {
          // Persist identity after successful connection for future restarts
          this.persistBotIdentity(saved, bot);
          this.logger.info(
            { botId: saved.id, name: saved.name },
            "Auto-connected saved bot"
          );
        }).catch((err) => {
          this.logger.error(
            { err, botId: saved.id, name: saved.name },
            "Failed to auto-connect bot (start manually from Settings)"
          );
        });

        // Stagger connections to avoid overwhelming the TS server
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        this.logger.info(
          { botId: saved.id, name: saved.name },
          "Loaded bot (autoStart disabled, not connecting)"
        );
      }
    }

    this.logger.info(
      { count: savedInstances.length },
      "Loaded saved bot instances"
    );
  }

  private persistBotIdentity(saved: import("../data/database.js").BotInstance, bot: BotInstance): void {
    const identity = bot.getIdentityExport();
    if (identity && identity !== saved.identity) {
      this.database.saveBotInstance({ ...saved, identity });
    }
  }

  private sourceId(bot: SavedBot): string {
    return bot.id === this.mirror?.targetBotId ? this.mirror.sourceBotId : bot.mirrorSourceBotId?.trim() ?? "";
  }

  private validateMirrorBots(bots: SavedBot[]): void {
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    if (this.mirror && (!byId.has(this.mirror.sourceBotId) || !byId.has(this.mirror.targetBotId))) {
      throw new MirrorConfigurationError("Mirror configuration requires existing source and output bots");
    }
    for (const target of bots) {
      const sourceId = this.sourceId(target);
      if (!sourceId) continue;
      if (sourceId === target.id) throw new MirrorConfigurationError("A bot cannot mirror itself");
      const source = byId.get(sourceId);
      if (!source) throw new MirrorConfigurationError(`Mirror source bot ${sourceId} does not exist`);
      if (this.sourceId(source)) throw new MirrorConfigurationError("Mirror chains and cycles are not allowed; choose an independent music bot as source");
      if (!/^[1-9]\d*$/.test(target.channelId)) throw new MirrorConfigurationError("Mirror output requires a fixed positive channelId");
      if (normalizeManagedVoiceHost(source.serverAddress) !== normalizeManagedVoiceHost(target.serverAddress) || source.serverPort !== target.serverPort) {
        throw new MirrorConfigurationError("Mirror source and output must use the same TeamSpeak server address and voice port");
      }
    }
  }

  private rewireMirror(): void {
    for (const relay of this.mirrorRelays.values()) relay.dispose();
    this.mirrorRelays.clear();
    const saved = this.database.getBotInstances();
    const byId = new Map(saved.map((bot) => [bot.id, bot]));
    const outputs = new Map<string, BotInstance[]>();
    for (const [id, bot] of this.bots) {
      bot.setMirrorAudience(null);
      const config = byId.get(id);
      if (!config || !this.sourceId(config)) bot.setMirrorSource(null);
    }
    for (const config of saved) {
      const sourceId = this.sourceId(config);
      if (!sourceId) continue;
      const target = this.bots.get(config.id);
      const source = this.bots.get(sourceId);
      const relay = new MirrorRelay(false);
      relay.bind(source, target);
      this.mirrorRelays.set(config.id, relay);
      if (target) outputs.set(sourceId, [...outputs.get(sourceId) ?? [], target]);
    }
    for (const [sourceId, targets] of outputs) {
      this.bots.get(sourceId)?.setMirrorAudience(async () => {
        const audiences = await Promise.all(targets.map((target) => target.getMirrorAudienceIds()));
        if (audiences.some((audience) => audience === null)) return null;
        return new Set(audiences.flatMap((audience) => [...audience!]));
      });
    }
  }

  shutdown(): void {
    for (const relay of this.mirrorRelays.values()) relay.dispose();
    this.mirrorRelays.clear();
    for (const bot of this.bots.values()) {
      bot.disconnect();
    }
    this.bots.clear();
  }
}
