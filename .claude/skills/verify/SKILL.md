---
name: verify
description: Build/launch/drive recipe for verifying the Nova voice-avatar app end-to-end.
---

# Verifying Nova

## Launch

`preview_start` with name `nova` (defined in `.claude/launch.json`: `python3 -u server.py`, port 8765).
No build step, no dependencies. Server logs need `-u` or they buffer silently.

## Drive (browser pane, tab from preview_start)

1. Screenshot the loaded page — expect the photoreal face and status "Ready".
   If the note says "offline — using built-in avatar", `/api/face` failed:
   check `https://thispersondoesnotexist.com/random-person.jpeg` reachability.
2. Click an example chip (e.g. weather) → expect: YOU bubble fills, intent
   badge, answer text, "via …" source link, status "Speaking…", wave bars,
   latency chips fill (`web answer`, `voice starts`).
3. API surface direct: `fetch('/api/answer?q=...')` for intents
   weather / general / time / news / math, plus safety probes
   (profanity incl. leet-speak, "how to make a bomb") → `refused: true`.
4. Avatar warp: `window.__nova.avatar` — set `.debug = true`,
   `.debugParams.jaw = 0.85`, wait ~600 ms, screenshot; mouth must open with
   dark cavity + teeth at the lip line. Same for `.blink`.
5. Lip-sync engine numerically:
   `A.speak(Visemes.build("Hello there…", 1))` then sample `A.p.jaw` — values
   should move through >0.3 while the timeline runs, then rest at 0.

## Gotchas in the embedded pane

- The pane throttles timers to ~1 Hz and suspends rAF; the avatar has a
  setInterval fallback, but timing-sensitive JS probes must tolerate 1 s ticks.
- `await requestAnimationFrame` inside `javascript_exec` hangs the tool —
  schedule rAF fire-and-forget and read results in a second call.
- Canvas readback: drawImage of the WebGL canvas only inside a rAF callback
  (context uses `preserveDrawingBuffer: true`).
- Mic capture is blocked in the pane — mic click must degrade to "Ready" /
  "Microphone unavailable…" without crashing; real STT needs desktop Chrome.
- TTS (macOS voices) works in the pane; `voice starts` chip should show <150 ms.
