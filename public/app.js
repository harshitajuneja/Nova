/* Nova — main app: speech-in → internet search → speech-out, driving the avatar. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $("avatar-canvas");
  const avatar = new Avatar(canvas);
  const synth = window.speechSynthesis || null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  let voices = [], listening = false, speaking = false, rec = null;
  let sttT0 = 0;

  const state = {
    set(mode, label) {
      document.body.dataset.state = mode;
      $("status-text").textContent = label;
      avatar.setMood(mode === "listening" ? "listening" : mode === "thinking" ? "thinking"
        : mode === "speaking" ? "speaking" : "idle");
    },
  };

  // ------------------------------------------------------------------ face
  const savedLayout = localStorage.getItem("nova-layout");
  if (savedLayout) { try { avatar.setLayout(JSON.parse(savedLayout)); } catch (e) {} }

  function builtinFace() { // offline fallback: stylized portrait drawn on a canvas
    const c = document.createElement("canvas");
    c.width = c.height = 768;
    const x = c.getContext("2d"), L = Avatar.defaultLayout(), W = 768;
    const g = x.createLinearGradient(0, 0, 0, W);
    g.addColorStop(0, "#2a3548"); g.addColorStop(1, "#151b28");
    x.fillStyle = g; x.fillRect(0, 0, W, W);
    x.fillStyle = "#caa285"; // neck + face
    x.fillRect(W * 0.42, W * 0.72, W * 0.16, W * 0.2);
    x.beginPath(); x.ellipse(W * 0.5, W * 0.55, W * 0.21, W * 0.28, 0, 0, 7); x.fill();
    x.fillStyle = "#3d2f28"; // hair
    x.beginPath(); x.ellipse(W * 0.5, W * 0.36, W * 0.23, W * 0.17, 0, Math.PI, 0); x.fill();
    x.fillStyle = "#f2ece4";
    for (const e of [L.eyeL, L.eyeR]) { x.beginPath(); x.ellipse(e[0] * W, e[1] * W, W * 0.045, W * 0.022, 0, 0, 7); x.fill(); }
    x.fillStyle = "#4a3524";
    for (const e of [L.eyeL, L.eyeR]) { x.beginPath(); x.arc(e[0] * W, e[1] * W, W * 0.016, 0, 7); x.fill(); }
    x.strokeStyle = "#4a3a30"; x.lineWidth = W * 0.012; x.lineCap = "round";
    for (const e of [L.eyeL, L.eyeR]) { x.beginPath(); x.moveTo((e[0] - 0.055) * W, (e[1] - 0.055) * W); x.lineTo((e[0] + 0.055) * W, (e[1] - 0.06) * W); x.stroke(); }
    x.strokeStyle = "#b98a6d"; x.beginPath(); x.moveTo(W * 0.5, W * 0.58); x.lineTo(W * 0.485, W * 0.64); x.stroke();
    x.fillStyle = "#a96a5c"; // lips
    x.beginPath(); x.ellipse(L.mouth[0] * W, L.mouth[1] * W, W * 0.055, W * 0.016, 0, 0, 7); x.fill();
    return c.toDataURL("image/png");
  }

  async function loadFace(fresh) {
    $("face-note").textContent = "fetching a generated face…";
    try {
      const r = await fetch("/api/face" + (fresh ? "?new=1" : ""));
      const j = await r.json();
      if (j.ok) {
        await avatar.load(j.url);
        $("face-note").textContent = "AI-generated face — no real person";
        return;
      }
      throw new Error("no face");
    } catch (e) {
      await avatar.load(builtinFace());
      $("face-note").textContent = "offline — using built-in avatar";
    }
  }

  // ------------------------------------------------------------------ TTS
  function pickDefaultVoice() {
    const score = (v) => (/en[-_]/i.test(v.lang) ? 2 : 0)
      + (/natural|neural|online|premium/i.test(v.name) ? 4 : 0)
      + (/google|samantha|microsoft/i.test(v.name) ? 1 : 0);
    return voices.slice().sort((a, b) => score(b) - score(a))[0];
  }

  function refreshVoices() {
    if (!synth) return;
    voices = synth.getVoices();
    const sel = $("voice-select");
    if (!voices.length || sel.options.length === voices.length) return;
    sel.innerHTML = "";
    const saved = localStorage.getItem("nova-voice");
    const def = pickDefaultVoice();
    voices.forEach((v, idx) => {
      const o = document.createElement("option");
      o.value = idx; o.textContent = `${v.name} (${v.lang})`;
      if (saved ? v.name === saved : v === def) o.selected = true;
      sel.appendChild(o);
    });
  }
  if (synth) { refreshVoices(); synth.onvoiceschanged = refreshVoices; }

  function speak(text, onAllDone) {
    const rate = parseFloat($("rate-slider").value);
    const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const speakT0 = performance.now();
    let started = false, remaining = sentences.length;
    speaking = true;
    state.set("speaking", "Speaking…");

    const finish = () => {
      speaking = false;
      avatar.stopSpeaking();
      state.set("idle", "Ready");
      if (onAllDone) onAllDone();
    };

    if (!synth || !voices.length) {
      // no TTS available: still animate the avatar from the timelines
      let delay = 0;
      sentences.forEach((s, i) => {
        const tl = Visemes.build(s, rate);
        setTimeout(() => {
          avatar.speak(tl);
          if (i === sentences.length - 1) avatar.onSpeakEnd = finish;
        }, delay);
        delay += tl.total + 120;
      });
      setChip("tts", "muted");
      return;
    }

    synth.cancel();
    sentences.forEach((s, i) => {
      const u = new SpeechSynthesisUtterance(s);
      const v = voices[$("voice-select").value];
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = rate; u.pitch = 1;
      const tl = Visemes.build(s, rate);
      u.onstart = () => {
        if (!started) { started = true; setChip("tts", Math.round(performance.now() - speakT0) + " ms"); }
        avatar.speak(tl);
      };
      u.onboundary = (e) => { if (e.name === "word") avatar.anchor(e.charIndex); };
      u.onend = () => { remaining -= 1; if (remaining === 0) finish(); };
      u.onerror = () => { remaining -= 1; if (remaining === 0) finish(); };
      synth.speak(u);
    });
    // watchdog: some engines drop utterances silently
    setTimeout(() => { if (speaking && !started) { avatar.speak(Visemes.build(text, rate)); } }, 1500);
  }

  function stopSpeaking() {
    if (synth) synth.cancel();
    speaking = false;
    avatar.stopSpeaking();
  }

  // ------------------------------------------------------------------ ask
  function setChip(kind, val) { $("chip-" + kind).querySelector("b").textContent = val; }

  async function ask(q) {
    q = (q || "").trim();
    if (!q) return;
    stopSpeaking();
    $("transcript").textContent = q;
    $("answer").textContent = "…";
    $("sources").innerHTML = "";
    state.set("thinking", "Searching the web…");
    const t0 = performance.now();
    let j;
    try {
      const r = await fetch("/api/answer?q=" + encodeURIComponent(q));
      j = await r.json();
    } catch (e) {
      j = { answer: "I couldn't reach my own server — is it still running?", sources: [], intent: "error" };
    }
    const ms = Math.round(performance.now() - t0);
    setChip("answer", ms + " ms");
    $("answer").textContent = j.answer;
    $("answer").classList.toggle("refused", !!j.refused);
    $("intent-badge").textContent = j.intent || "";
    (j.sources || []).forEach((s) => {
      const a = document.createElement("a");
      a.href = s.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "via " + s.label;
      $("sources").appendChild(a);
    });
    speak(j.answer, () => {
      if ($("handsfree").checked && SR) setTimeout(startListening, 400);
    });
  }

  // ------------------------------------------------------------------ STT
  function startListening() {
    if (!SR || listening) return;
    stopSpeaking();
    rec = new SR();
    rec.lang = $("lang-select").value;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    listening = true;
    state.set("listening", "Listening…");
    $("transcript").textContent = "";
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      $("transcript").textContent = finalText || interim || "…";
    };
    rec.onspeechend = () => { sttT0 = performance.now(); };
    rec.onend = () => {
      listening = false;
      if (finalText.trim()) {
        if (sttT0) setChip("stt", Math.round(performance.now() - sttT0) + " ms");
        ask(finalText);
      } else if (!speaking) {
        state.set("idle", "Ready");
      }
    };
    rec.onerror = (e) => {
      listening = false;
      state.set("idle", ["not-allowed", "audio-capture", "service-not-allowed"].includes(e.error)
        ? "Microphone unavailable — allow mic access, or type below" : "Ready");
    };
    try { rec.start(); } catch (e) { listening = false; }
  }

  function stopListening() { if (rec && listening) rec.stop(); }

  // ------------------------------------------------------------------ calibration
  const dots = { eyeL: $("dot-eyeL"), eyeR: $("dot-eyeR"), mouth: $("dot-mouth"), chin: $("dot-chin") };

  function placeDots() {
    const L = avatar.layout, box = $("avatar-box").getBoundingClientRect(),
      cb = canvas.getBoundingClientRect();
    for (const k of Object.keys(dots)) {
      dots[k].style.left = (cb.left - box.left + L[k][0] * cb.width) + "px";
      dots[k].style.top = (cb.top - box.top + L[k][1] * cb.height) + "px";
    }
  }

  for (const k of Object.keys(dots)) {
    const el = dots[k];
    const move = (ev) => {
      const cb = canvas.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, ((ev.touches ? ev.touches[0] : ev).clientX - cb.left) / cb.width));
      const y = Math.min(1, Math.max(0, ((ev.touches ? ev.touches[0] : ev).clientY - cb.top) / cb.height));
      avatar.layout[k] = [x, y];
      localStorage.setItem("nova-layout", JSON.stringify(avatar.layout));
      placeDots();
      ev.preventDefault();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    el.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  $("calibrate-btn").addEventListener("click", () => {
    const panel = $("calibrate-panel");
    const on = panel.classList.toggle("open");
    document.body.classList.toggle("calibrating", on);
    avatar.debug = on;
    if (on) placeDots();
  });
  window.addEventListener("resize", () => { if (document.body.classList.contains("calibrating")) placeDots(); });

  for (const p of ["jaw", "wide", "round", "press", "brow", "blink"]) {
    const el = $("dbg-" + p);
    if (el) el.addEventListener("input", () => { avatar.debugParams[p] = parseFloat(el.value); });
  }
  $("reset-layout").addEventListener("click", () => {
    avatar.setLayout(Avatar.defaultLayout());
    localStorage.removeItem("nova-layout");
    placeDots();
  });
  $("new-face").addEventListener("click", () => loadFace(true));
  $("upload-face").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) avatar.load(URL.createObjectURL(f)).then(() => {
      $("face-note").textContent = "custom photo — drag the dots to fit";
    });
  });

  // ------------------------------------------------------------------ wiring
  $("mic-btn").addEventListener("click", () => (listening ? stopListening() : startListening()));
  $("stop-btn").addEventListener("click", () => { stopSpeaking(); state.set("idle", "Ready"); });
  $("ask-form").addEventListener("submit", (e) => {
    e.preventDefault();
    ask($("ask-input").value);
    $("ask-input").value = "";
  });
  document.querySelectorAll(".example").forEach((b) =>
    b.addEventListener("click", () => ask(b.textContent)));
  $("rate-slider").addEventListener("input", () =>
    $("rate-val").textContent = parseFloat($("rate-slider").value).toFixed(1) + "×");
  $("voice-select").addEventListener("change", () => {
    const v = voices[$("voice-select").value];
    if (v) localStorage.setItem("nova-voice", v.name);
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && document.activeElement.tagName !== "INPUT") {
      e.preventDefault();
      listening ? stopListening() : startListening();
    }
  });

  if (!SR) {
    $("mic-btn").classList.add("disabled");
    $("mic-note").textContent = "Voice input needs Chrome or Edge — you can type below.";
  }

  // ------------------------------------------------------------------ boot
  window.__nova = { avatar, ask, speak };  // console/debug handle
  state.set("idle", "Waking up…");
  loadFace(false).then(() => {
    state.set("idle", "Ready — tap the mic or type a question");
    // greet silently after voices settle (unlocks TTS on some browsers only after a user gesture)
  });
})();
