# Nova — voice-in, voice-out web assistant with a photorealistic talking avatar

Ask a question with your voice (e.g. *“What is the weather in Hyderabad?”*).
Nova transcribes it, searches the live internet for the answer, speaks the
answer back, and a **photorealistic human avatar lip-syncs the reply in real
time** — rendered locally at ~60 fps with **zero video-generation latency**.

## Run it

```bash
python3 server.py
# then open http://localhost:8765 in Chrome or Edge
```

That's it — **no dependencies, no API keys, no build step** (Python 3.9+
standard library only; tested on 3.13).

Optional — smarter free-form answers composed by Claude from the web snippets:

```bash
export ANTHROPIC_API_KEY=sk-ant-…      # optional
export NOVA_MODEL=claude-opus-4-8      # optional override (this is the default)
python3 server.py
```

## What it does

| Stage | How | Typical latency |
|---|---|---|
| **Speech → text** | Browser `SpeechRecognition` (Chrome/Edge; en-US, en-IN, en-GB, hi-IN) | live, interim results |
| **Find the answer** | Server searches the internet — see routing below | 5 ms – 0.7 s |
| **Text → speech** | Browser `speechSynthesis`, sentence-pipelined so audio starts on the first sentence | 20 – 150 ms to first audio |
| **Talking face** | WebGL muscle-warp of a real photo + painted inner mouth, driven by a viseme timeline re-anchored on TTS word boundaries | rendered live, 0 generation delay |

**Answer routing** (server, `/api/answer`): greetings/identity → canned;
arithmetic → safe AST evaluator; *time in X* → Open-Meteo geocoding + zoneinfo;
*weather/forecast* → Open-Meteo (current + tomorrow); *news/headlines* →
Google News RSS (top 3); everything else → DuckDuckGo Instant Answers +
Wikipedia in parallel (composed by Claude when a key is present). All free,
key-less public APIs; geocoding/weather/news responses are TTL-cached.

**Safety**: every question and every outgoing answer passes a profanity filter
(with leet-speak normalization) and a harmful-request pattern check. Offensive
input gets a polite refusal; profanity in fetched content is masked before it
is displayed or spoken.

## The avatar

- The portrait is an **AI-generated face** fetched at runtime from
  thispersondoesnotexist.com (StyleGAN — no real person) and cached in
  `avatar_cache/`. Click ⚙ → *🎲 new face* for another, or *📷 upload photo*
  to use your own picture.
- `public/avatar.js` renders the photo through a fragment shader with 12
  gaussian displacement fields (jaw, lips, mouth corners, brows, eyelids),
  paints a dark mouth cavity + teeth when the jaw opens, and layers idle life:
  blinking, head sway, breathing, mood-based brows (listening / thinking /
  speaking).
- `public/visemes.js` converts each sentence into a timed mouth-shape sequence;
  playback starts on the utterance's `onstart` and is re-synchronized by
  word-boundary events, so lips track the actual voice.
- Because the “video” is rendered locally per-frame, there is **no
  video-generation round trip** — the face reacts the instant audio starts
  (compare with cloud avatar-video APIs that add seconds per reply).
- Generated faces are pre-aligned; for uploaded photos use ⚙ calibration
  (drag the four dots onto eyes / mouth / chin — saved in localStorage).

## Using it

- 🎙 tap the mic (or press **Space**) and ask; tap again to stop early.
- Type in the box instead if you don't have a mic (or aren't on Chrome/Edge).
- **hands-free** checkbox: Nova re-opens the mic after each spoken answer.
- Speaking while Nova talks? Press the mic — speech is cancelled instantly
  (barge-in) and it listens.
- Latency chips at the bottom show speech→text, web-answer, and voice-start
  times for every question.

## Files

```
server.py            zero-dependency HTTP server + internet answer engine + safety filter
public/index.html    UI
public/style.css     styling
public/app.js        speech recognition, TTS pipeline, UI state, calibration
public/avatar.js     WebGL talking-head engine (photo warp + inner mouth + idle life)
public/visemes.js    text → viseme timeline
avatar_cache/        cached generated portrait (created at runtime)
```

## Notes & troubleshooting

- **Mic needs Chrome or Edge** (Web Speech API); the page must be on
  `localhost` or HTTPS for mic permission. Typing works everywhere.
- **No voices / silent replies**: the voice list loads asynchronously — pick a
  voice in the dropdown; the avatar still animates the reply.
- **Offline**: the app falls back to a built-in stylized avatar and answers
  that don't need the network (math, greetings) still work.
- The server binds to `127.0.0.1:8765` (set `PORT` to change) and keeps no
  logs beyond `/api/` request lines.
