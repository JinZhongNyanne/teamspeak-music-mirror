import { readFileSync } from "node:fs";

try {
  // webPort is configured through the persisted settings, not a container env var.
  const { webPort = 3000 } = JSON.parse(readFileSync("/app/data/config.json", "utf8"));
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) process.exit(1);
  const response = await fetch(`http://127.0.0.1:${webPort}/api/health`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
