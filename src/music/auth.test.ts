import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCookieStore } from "./auth.js";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookie-store-"));
  dirs.push(dir);
  return { dir, store: createCookieStore(dir) };
};
describe("atomic credential persistence", () => {
  it("survives provider reconstruction with private files and no temporary leftovers", () => {
    const { dir, store } = setup();
    store.save("qq", "old=fixture");
    store.save("qq", "new=fixture");
    expect(createCookieStore(dir).load("qq")).toBe("new=fixture");
    expect(fs.statSync(path.join(dir, "qq.json")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["qq.json"]);
  });
  it("keeps previous credential intact if atomic rename fails", () => {
    const { dir, store } = setup();
    store.save("qq", "old=fixture");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Error("fixture rename failure");
    });
    expect(() => store.save("qq", "new=fixture")).toThrow();
    expect(store.load("qq")).toBe("old=fixture");
    expect(fs.readdirSync(dir)).toEqual(["qq.json"]);
  });
});
