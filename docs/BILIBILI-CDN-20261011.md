# Bilibili tracks silent on newly selected CDN hosts

## Confirmed on 2026-10-11

The music panel delegates playback to the music bot; the web client does not
fetch or decode the Bilibili song itself. The deployed bot selected
`*.edge.mountaintoys.cn:4483` for several tracks. The URL picker did not
recognize that host family as PCDN, and the FFmpeg input classifier did not
send the Bilibili Referer and browser User-Agent for it.

An isolated diagnostic on the running bot reproduced the failure for
`BV1faak6AEzm` (雨爱), `BV1qYpN6vE7J` (反方向的钟), and
`BV1bzHL67E6u` (AIZO). For each exact freshly resolved URL, the original
arguments returned HTTP 403, FFmpeg exit 1 and zero PCM bytes. Adding the
Bilibili request headers produced exit 0 and 384000 PCM bytes for two seconds
of 48 kHz stereo s16le audio. Standard `upos-*.bilivideo.com` backups also
decoded successfully. These probes did not change the queue, connect another
TeamSpeak client or alter ongoing playback; audio was discarded in memory.

## Change and verification

- Prefer a valid standard `bilivideo.com` URL among the primary and backup
  addresses before choosing unknown host families.
- Recognize root/subdomains of `mountaintoys.cn` as PCDN, alongside existing
  PCDN families; preserve the original fallback if every candidate is PCDN.
- Send Bilibili Referer/User-Agent and use input-side seeking for this host
  family when no standard backup is available.
- Match hostname boundaries rather than URL text; unrelated suffixes,
  username fields and query strings must not inherit the custom headers.

The two targeted test files passed all 112 tests. Full regression/build and
new Docker CI results are recorded with the delivery commit. Production is
still the prior image until an explicitly reviewed NAS update is approved.
Decoded samples establish that the source can be read; they do not establish
that every upload is available or substitute for an in-channel listening test.

## Rollback

Keep the existing image and persistent data. If the image update fails its
health, queue/identity preservation or entrypoint checks, restore only the
previous image reference using its separately reviewed NAS update plan.
Do not restore an older data volume or reset the queue. A restart interrupts
playback and requires the applicable NAS approval.
