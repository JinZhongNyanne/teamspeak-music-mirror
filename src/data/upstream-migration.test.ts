import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDatabase, type BotDatabase } from "./database.js";
import { createUserStore, GUEST_USER_ID } from "./users.js";

it("upgrades pre-accent mirror data without losing relationships, paused queues, or account isolation", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsmb-upstream-migration-"));
  const path = join(dir, "legacy.db");
  let db: BotDatabase | undefined;
  const legacy = new Database(path);
  const songs = [{ id: "song-1", name: "Existing song", artist: "Artist", album: "Album", platform: "qq", coverUrl: "", duration: 120, requestedBy: "alice" }];
  try {
    // Build the old schema independently: users have no appearance column,
    // while this fork already persists mirror relationships and manual pause.
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        passwordHash TEXT NOT NULL, createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'admin'
      );
      CREATE TABLE bot_instances (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, serverAddress TEXT NOT NULL,
        serverPort INTEGER NOT NULL, nickname TEXT NOT NULL,
        defaultChannel TEXT NOT NULL, channelId TEXT NOT NULL DEFAULT '',
        channelPassword TEXT NOT NULL, autoStart INTEGER NOT NULL DEFAULT 0,
        serverProtocol TEXT NOT NULL DEFAULT '', ts6ApiKey TEXT NOT NULL DEFAULT '',
        serverPassword TEXT NOT NULL DEFAULT '', mirrorSourceBotId TEXT NOT NULL DEFAULT '',
        volume INTEGER NOT NULL DEFAULT 75, play_mode TEXT NOT NULL DEFAULT 'seq', identity TEXT
      );
      CREATE TABLE queue_state (
        botId TEXT PRIMARY KEY, songs TEXT NOT NULL, currentIndex INTEGER NOT NULL,
        mode TEXT NOT NULL, isFmMode INTEGER NOT NULL DEFAULT 0,
        fmPlatform TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users VALUES ('alice', 'alice', 'existing-hash-a', 10, 20, 'admin');
      INSERT INTO users VALUES ('bob', 'bob', 'existing-hash-b', 30, 40, 'member');
    `);
    const insertBot = legacy.prepare(`
      INSERT INTO bot_instances (id, name, serverAddress, serverPort, nickname, defaultChannel,
        channelId, channelPassword, autoStart, mirrorSourceBotId, identity)
      VALUES (?, ?, 'ts.example.test', 9987, ?, '', ?, '', 1, ?, ?)
    `);
    insertBot.run("source", "Original", "Original", "12", "", "source-identity");
    insertBot.run("mirror", "Mirror", "Mirror", "34", "source", "mirror-identity");
    legacy.prepare("INSERT INTO queue_state (botId, songs, currentIndex, mode, isFmMode, fmPlatform, paused) VALUES (?, ?, 0, 'loop', 0, '', 1)")
      .run("source", JSON.stringify(songs));
    expect(legacy.prepare("PRAGMA table_info(users)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "accentColor" })]));
    legacy.close();

    const assertPlaybackPreserved = (database: BotDatabase) => {
      expect(database.getBotInstances()).toHaveLength(2);
      expect(database.getBotInstances().find((bot) => bot.id === "mirror")).toMatchObject({
        mirrorSourceBotId: "source", channelId: "34", autoStart: true,
        serverAddress: "ts.example.test", serverPort: 9987, identity: "mirror-identity",
      });
      expect(database.getBotInstances().find((bot) => bot.id === "source")).toMatchObject({ mirrorSourceBotId: "", channelId: "12", identity: "source-identity" });
      expect(database.getQueueState("source")).toEqual({
        botId: "source", songs, currentIndex: 0, mode: "loop", isFmMode: false, fmPlatform: "", paused: true,
      });
    };

    db = createDatabase(path);
    assertPlaybackPreserved(db);
    let users = createUserStore(db.db);
    expect(users.findById("alice")).toMatchObject({ username: "alice", passwordHash: "existing-hash-a", createdAt: 10, updatedAt: 20, role: "admin" });
    expect(users.getAccentColor("alice")).toBe("#335eea");
    expect(users.getAccentColor("bob")).toBe("#335eea");
    expect(users.setAccentColor("alice", "#0891b2")).toBe(true);
    expect(users.getAccentColor("bob")).toBe("#335eea");
    expect(users.setAccentColor(GUEST_USER_ID, "#ea580c")).toBe(false);
    expect(users.getAccentColor(GUEST_USER_ID)).toBe("#335eea");

    // Multiple restarts exercise migration idempotence and actual disk persistence.
    for (let restart = 0; restart < 2; restart++) {
      db.close();
      db = createDatabase(path);
      users = createUserStore(db.db);
      assertPlaybackPreserved(db);
      expect(users.getAccentColor("alice")).toBe("#0891b2");
      expect(users.getAccentColor("bob")).toBe("#335eea");
      expect(users.findById("alice")?.passwordHash).toBe("existing-hash-a");
      expect(users.findById("bob")).toMatchObject({ passwordHash: "existing-hash-b", createdAt: 30, updatedAt: 40, role: "member" });
    }
  } finally {
    if (legacy.open) legacy.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
