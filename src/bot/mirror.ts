import { readFileSync } from "node:fs";
import type { BotInstance } from "./instance.js";

export interface MirrorConfig {
  sourceBotId: string;
  targetBotId: string;
}

function validateMirrorConfig(value: unknown, origin: string): MirrorConfig {
  const config = value as Partial<MirrorConfig> | null;
  const sourceBotId = typeof config?.sourceBotId === "string" ? config.sourceBotId.trim() : "";
  const targetBotId = typeof config?.targetBotId === "string" ? config.targetBotId.trim() : "";
  if (!sourceBotId || !targetBotId || sourceBotId === targetBotId) {
    throw new Error(`${origin} requires distinct, non-empty sourceBotId and targetBotId`);
  }
  return { sourceBotId, targetBotId };
}

/** Environment IDs override the optional persistent configuration next to
 * data/config.json. Invalid or incomplete settings fail closed instead of
 * starting the target as an independent music bot. */
export function loadMirrorConfig(
  filename: string,
  env: NodeJS.ProcessEnv = process.env,
): MirrorConfig | null {
  if (env.MIRROR_SOURCE_BOT_ID !== undefined || env.MIRROR_TARGET_BOT_ID !== undefined) {
    return validateMirrorConfig({
      sourceBotId: env.MIRROR_SOURCE_BOT_ID,
      targetBotId: env.MIRROR_TARGET_BOT_ID,
    }, "MIRROR_SOURCE_BOT_ID and MIRROR_TARGET_BOT_ID");
  }
  const configuredPath = env.MIRROR_CONFIG_PATH;
  if (configuredPath !== undefined) {
    if (!configuredPath.trim()) throw new Error("MIRROR_CONFIG_PATH must be non-empty");
    filename = configuredPath.trim();
  }
  let content: string;
  try {
    content = readFileSync(filename, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && configuredPath === undefined) return null;
    throw err;
  }
  return validateMirrorConfig(JSON.parse(content), "Mirror configuration file");
}

/** Forward encoded frames from one playback clock. A missing or broken
 * output must never interrupt source playback. Rebind on instance replacement. */
export class MirrorRelay {
  private unbind: (() => void) | null = null;

  constructor(private readonly manageAudience = true) {}

  bind(source: BotInstance | undefined, target: BotInstance | undefined): void {
    this.dispose();
    if (target) target.setMirrorSource(() => source?.getStatus(), () => source?.getQueue() ?? []);
    if (!source) return;
    if (this.manageAudience) source.setMirrorAudience(() => target?.getMirrorAudienceIds() ?? Promise.resolve(new Set<number>()));
    if (!target) {
      this.unbind = () => { if (this.manageAudience) source.setMirrorAudience(null); };
      return;
    }
    let active = true;
    const sourceProfile = source.getProfileManager();
    const targetProfile = target.getProfileManager();
    const avatar = (bytes: Buffer | null) => {
      try {
        if (!target.getStatus().connected) return;
        void targetProfile.mirrorAvatar(bytes, () => active && target.getStatus().connected)
          .catch(() => { /* avatar output isolation */ });
      } catch { /* avatar output isolation */ }
    };
    const replayAvatar = () => {
      const bytes = sourceProfile.getAppliedAvatar();
      if (bytes !== undefined) avatar(bytes);
    };
    const unsubscribeAvatar = sourceProfile.subscribeAvatar(avatar);
    target.on("connected", replayAvatar);
    replayAvatar();
    const frame = (opusFrame: Buffer) => {
      try { target.sendMirroredFrame(opusFrame); } catch { /* output isolation */ }
    };
    const audience = (returning = false) => source.notifyMirrorAudienceChanged(returning);
    const state = () => {
      try { target.emit("stateChange"); } catch { /* output isolation */ }
    };
    source.getPlayer().on("frame", frame);
    source.on("stateChange", state);
    source.on("connected", state);
    source.on("disconnected", state);
    target.on("mirrorAudienceChanged", audience);
    target.on("connected", audience);
    target.on("disconnected", audience);
    this.unbind = () => {
      active = false;
      unsubscribeAvatar();
      target.off("connected", replayAvatar);
      source.getPlayer().off("frame", frame);
      source.off("stateChange", state);
      source.off("connected", state);
      source.off("disconnected", state);
      target.off("mirrorAudienceChanged", audience);
      target.off("connected", audience);
      target.off("disconnected", audience);
      if (this.manageAudience) source.setMirrorAudience(null);
    };
  }

  dispose(): void {
    this.unbind?.();
    this.unbind = null;
  }
}
