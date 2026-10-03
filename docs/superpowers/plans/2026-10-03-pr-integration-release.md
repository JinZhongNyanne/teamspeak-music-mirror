# PR integration and v1.15.0 implementation plan

> For agentic workers: use the parallel implementation and independent review tools. Steps use checkbox syntax.

**Goal:** Fix the reviewed defects in PRs #170, #173, #174 and #175, merge the tested result into main, and publish the next release.

**Architecture:** Retain each original PR head in merge history. Fix independent modules in parallel with exclusive file ownership. Push the final integration only after source tests, builds and independent review pass.

**Tech Stack:** Node.js, TypeScript, Vitest, Express, Vue, TeamSpeak client SDK, GitHub Actions.

**Spec:** User requests in this chat: review every open PR, merge safe fixes/enhancements into main and test; then merge and publish a new version; then explicitly fix the reported defects.

## Global constraints

- Preserve inherited work; checkout is clean at 87fca6d8b7b770e1e01f8891059c99d53705cc08.
- Do not introduce new dependencies or change music-provider authorization.
- Preserve API key role/capability inheritance. Password rotation must revoke the user's keys.
- Match repository release convention: application package version remains 0.1.0; release tags identify shipped versions.
- Source tests exclude generated dist/** and web/dist/**.
- Do not force-push or rewrite original contributor history.

## Review focus

- A pending new playback request must survive an older EOF continuation.
- Artist playback and single-song playback must serialize their queue mutations.
- Transient QQ singer/album failures must not poison successful catalog caching.
- Channel movement and reconnect must use the correct session and clear through the same permission path.
- Credential revocation must audit the actual key owner and ordinary password changes must revoke keys.

### Task 1: Integrate original PR history

Files: src/bot/instance.test.ts (resolve #170 overlap by preserving both test suites).

- [ ] Verify open PR heads remain the audited SHAs.
- [ ] Create a release integration branch from origin/main.
- [ ] Merge #173, #174, #175 and #170 with merge commits; resolve the instance test conflict by retaining both independent additions.

### Task 2: Correct artist playback and QQ catalogs

Owner files: src/music/qq.ts, src/music/qq.test.ts, src/web/api/player.ts, src/web/api/play-artist.test.ts.

- [ ] Port the four review probes from ../.pr-review-20261003/175/review/review-artist-regressions.test.ts into repository tests.
- [ ] Run npm test -- src/music/qq.test.ts src/web/api/play-artist.test.ts and observe the known failures.
- [ ] Use bot.runExclusive for the stop/queue mutation/play sequence. Preserve permission middleware.
- [ ] Return a failure sentinel for failed singer lookup or malformed/nonzero album-search results; do not cache degradation.
- [ ] Scan albums until the 500-song ceiling or complete catalog; preserve hasMore/total correctness, avoid the silent 50-album limit.
- [ ] Re-run focused tests and report changed files and result.

### Task 3: Correct TS6 profile lifecycle

Owner files: src/bot/profile.ts, src/bot/profile.test.ts, src/ts-protocol/http-query.ts, optionally src/ts-protocol/client.ts and a related focused protocol test if checked self updates need it.

- [ ] Port the three reviewer probes from ../.pr-review-20261003/174/src/bot/review-174.test.ts into profile tests.
- [ ] Confirm they fail before production changes.
- [ ] Clear old channel descriptions through checked HTTP channelEdit for TS6 and preserve TS3's working behavior.
- [ ] Fence client-list resolution and post-write remembered-channel state by generation/connection identity.
- [ ] Use a checked full-client self clientupdate that reports permission failures; never update HTTP ServerQuery self.
- [ ] Update old channel-description mocks to reflect checked TS3 writes without weakening assertions.
- [ ] Run profile/protocol tests and typecheck; report changes.

### Task 4: Correct API-key lifecycle and documentation

Owner files: src/data/api-keys.ts, src/data/api-keys.test.ts, src/web/api/api-keys.ts, src/web/api/api-keys.test.ts, src/web/api/session.ts, src/web/api/session.test.ts, src/web/server.ts, docs/API.md.

- [ ] Test administrator revocation auditing the member owner and ordinary password changes invalidating old keys.
- [ ] Run the tests and observe the failures.
- [ ] Snapshot the key owner before deletion and use that owner in the audit target fields.
- [ ] Thread the API key store into the browser session router and revoke all keys after a successful self-service password change; preserve the active browser session convention.
- [ ] Keep documented administrator REST authority. Qualify the no-self-replication claim to direct /api/keys management; do not remove administrator /api/users functionality silently.
- [ ] Add Content-Type: application/octet-stream to the curl upload example.
- [ ] Run the focused auth/session/key suites; report changes.

### Task 5: Correct EOF/recovery ordering

Owner files: src/bot/instance.ts, src/bot/instance.test.ts. Do not change the artist route owned by Task 2.

- [ ] Turn the independent actual-handler probe into repository tests using the existing setupPlayerEvents fixture; avoid runtime source transpilation.
- [ ] Confirm normal NetEase/Bilibili EOF can currently advance a pending replacement.
- [ ] Fence every delayed fallback by the ending song and playback session, including failed recovery; preserve immediate ordinary EOF ordering where practical.
- [ ] Verify stop, skip, restart of the same queue song, pause, null URL and failed lookup do not clobber a newer playback session.
- [ ] Run instance/player/Bilibili tests and report results.

### Task 6: Review, verify and release

Owner files: README.md changelog; release notes kept outside the repository for gh --notes-file.

- [ ] Independently review every correction and the integrated changes; resolve substantive findings.
- [ ] Run npm test -- --exclude 'dist/**' --exclude 'web/dist/**' and npm run build sequentially.
- [ ] Update the README changelog and prepare release notes with contributor credits, changes, migration notes and verified test results.
- [ ] Confirm main has not moved, integrate the tested branch and push main without force.
- [ ] Verify all four GitHub PRs show merged and point at the integrated history.
- [ ] Create and push v1.15.0 (or the user's chosen version), create the GitHub release, and inspect the Docker publish workflow to completion.
- [ ] Report the release URL, test totals and Docker publishing result. State that live TeamSpeak/music-provider integration was not exercised.
