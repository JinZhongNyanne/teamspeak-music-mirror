import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createBotRouter } from "./bot.js";
import { getDefaultConfig } from "../../data/config.js";

const user = (scope: "all" | string[] = "all") => ({
  id: "member", username: "member", role: "member", capabilities: new Set(["bot.manage"]),
  bots: scope === "all" ? "all" : new Set(scope),
});
function fixture(scope: "all" | string[] = "all") {
  const source = { id: "source", getStatus: () => ({ id: "source", name: "Private source" }), isMirrorTarget: () => false };
  const target = { id: "target", getStatus: () => ({ id: "target", name: "Mirror" }), isMirrorTarget: () => true };
  const info = { mode: "mirror", mirrorSourceBotId: "source", mirrorSourceName: "Private source", mirrorState: "idle", mirrorConfigLocked: false, fixedChannelId: "19" };
  const manager = {
    getAllBots: () => [source, target], getBot: (id: string) => id === "target" ? target : id === "source" ? source : undefined,
    getBotMirrorInfo: (id: string) => id === "target" ? info : { mode: "music", mirrorSourceBotId: "" },
    getBotConfig: () => ({ ...info, identity: "private-identity", ts6ApiKey: "private-key" }),
    createBot: vi.fn(async () => target), updateBot: vi.fn(), removeBot: vi.fn(async () => {}),
  };
  const avatars = { write: vi.fn(), remove: vi.fn(), read: vi.fn() };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = user(scope) as any; next(); });
  app.use("/api/bot", createBotRouter(manager as any, getDefaultConfig(), "/unused/config.json", pino({ level: "silent" }), {} as any, avatars as any));
  return { app, manager, avatars };
}

describe("bot mirror API", () => {
  it("returns mode and relation metadata without TS identity or API keys", async () => {
    const { app } = fixture();
    expect((await request(app).get("/api/bot/target")).body).toMatchObject({ mode: "mirror", mirrorSourceBotId: "source", mirrorSourceAccessible: true });
    const saved = await request(app).get("/api/bot/target/config");
    expect(saved.body).not.toHaveProperty("identity"); expect(saved.body).not.toHaveProperty("ts6ApiKey");
  });
  it("redacts inaccessible sources from list, status and editable config", async () => {
    const { app } = fixture(["target"]);
    for (const route of ["/api/bot/target", "/api/bot/target/config"]) {
      const result = await request(app).get(route);
      expect(result.status).toBe(200); expect(result.body.mirrorSourceAccessible).toBe(false);
      expect(result.body).not.toHaveProperty("mirrorSourceBotId");
      // Config does not contain display names, but mock metadata can: avoid leaks there too.
      expect(result.body.mirrorSourceName).not.toBe("Private source");
    }
    const list = await request(app).get("/api/bot");
    expect(list.body.bots).toHaveLength(1);
    expect(list.body.bots[0]).toMatchObject({ mode: "mirror", mirrorSourceAccessible: false });
  });
  it("rejects selecting an inaccessible source before manager mutation", async () => {
    const { app, manager } = fixture(["target"]);
    const create = await request(app).post("/api/bot").send({ name: "Mirror", nickname: "Mirror", serverAddress: "ts.example", mirrorSourceBotId: "source" });
    const edit = await request(app).put("/api/bot/target").send({ mirrorSourceBotId: "source" });
    expect(create.status).toBe(403); expect(edit.status).toBe(403);
    expect(manager.createBot).not.toHaveBeenCalled(); expect(manager.updateBot).not.toHaveBeenCalled();
  });
  it("validates source types and forwards valid create/edit selections", async () => {
    const { app, manager } = fixture();
    expect((await request(app).put("/api/bot/target").send({ mirrorSourceBotId: [] })).status).toBe(400);
    const created = await request(app).post("/api/bot").send({ name: "Mirror", nickname: "Mirror", serverAddress: "ts.example", mirrorSourceBotId: "source", channelId: "19", autoStart: true });
    expect(created.status).toBe(201);
    expect(manager.createBot).toHaveBeenCalledWith(expect.objectContaining({ mirrorSourceBotId: "source", autoStart: true }));
    expect((await request(app).put("/api/bot/target").send({ mirrorSourceBotId: "" })).status).toBe(200);
    expect(manager.updateBot).toHaveBeenCalledWith("target", expect.objectContaining({ mirrorSourceBotId: "" }));
  });
  it("blocks mirror avatar writes and preserves access checks", async () => {
    const { app, avatars } = fixture(["target"]);
    expect((await request(app).put("/api/bot/target/avatar").send({ dataUrl: "x" })).status).toBe(409);
    expect((await request(app).delete("/api/bot/target/avatar")).status).toBe(409);
    expect((await request(app).delete("/api/bot/source/avatar")).status).toBe(403);
    expect(avatars.write).not.toHaveBeenCalled(); expect(avatars.remove).not.toHaveBeenCalled();
  });
  it("returns safe configuration conflict errors instead of server errors", async () => {
    const { app, manager } = fixture();
    manager.updateBot.mockImplementation(() => { throw Object.assign(new Error("请先停止机器人"), { statusCode: 409 }); });
    const result = await request(app).put("/api/bot/target").send({ channelId: "20" });
    expect(result.status).toBe(409); expect(result.body.error).toBe("请先停止机器人");
  });
});
