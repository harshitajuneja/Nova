/* Avatar — real-time photorealistic talking head.
   Renders a portrait photo through a WebGL fragment shader that applies a set
   of gaussian "muscle" displacement fields (jaw, lips, mouth corners, brows,
   eyelids) plus a whole-head sway transform, and paints an inner-mouth cavity
   with teeth when the jaw opens. Everything runs locally at 60fps — zero
   video-generation latency.

   Coordinates are normalized (0..1, y down). The layout (eye centers, mouth,
   chin) defaults to the canonical alignment of thispersondoesnotexist.com
   portraits (FFHQ) and can be calibrated for uploaded photos. */
(function () {
  "use strict";

  const NF = 12; // gaussian fields (6 floats each: cx, cy, sx, sy, dx, dy)

  const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uF[${NF * 6}];
uniform vec4 uHead;    // rot, tx, ty, scale
uniform vec4 uMouth;   // mx, my, jaw, wide
uniform vec3 uMouth2;  // round, lipDrop, interocular

void main() {
  // undo head sway (rotate/translate/zoom around a pivot between the eyes)
  vec2 pivot = vec2(0.5, 0.52);
  float c = cos(-uHead.x), s = sin(-uHead.x);
  vec2 ph = vUv - pivot - uHead.yz;
  ph = vec2(c * ph.x - s * ph.y, s * ph.x + c * ph.y) / uHead.w + pivot;

  // inverse-warp through the muscle fields
  vec2 p = ph;
  for (int i = 0; i < ${NF}; i++) {
    vec2 cn = vec2(uF[i * 6], uF[i * 6 + 1]);
    vec2 sg = vec2(uF[i * 6 + 2], uF[i * 6 + 3]);
    vec2 d  = vec2(uF[i * 6 + 4], uF[i * 6 + 5]);
    vec2 q = (ph - cn) / max(sg, vec2(1e-4));
    p -= d * exp(-dot(q, q));
  }
  vec3 col = texture2D(uTex, clamp(p, 0.001, 0.999)).rgb;

  // inner mouth: dark cavity + upper teeth, sized by jaw opening
  float jaw = uMouth.z;
  if (jaw > 0.03) {
    float u = uMouth2.z;                       // interocular distance
    float drop = uMouth2.y;
    vec2 mc = vec2(uMouth.x, uMouth.y + drop * 0.50);
    float rx = u * (0.175 + 0.10 * uMouth.w - 0.075 * uMouth2.x);
    float ry = drop * 0.62 + 0.003;
    vec2 dp = (ph - mc) / vec2(rx, ry);
    float e2 = dot(dp, dp);
    float hole = (1.0 - smoothstep(0.45, 1.0, e2)) * smoothstep(0.03, 0.22, jaw);
    vec3 cavity = vec3(0.13, 0.05, 0.055) * (0.85 + 0.25 * (1.0 - min(e2, 1.0)));
    col = mix(col, cavity, hole * 0.92);
    float teeth = hole
      * smoothstep(-0.10, -0.52, dp.y)
      * (1.0 - smoothstep(0.55, 0.95, abs(dp.x)))
      * (1.0 - 0.6 * smoothstep(0.55, 0.95, jaw));
    vec3 teethCol = vec3(0.88, 0.845, 0.80) * (0.95 - 0.22 * abs(dp.x));
    col = mix(col, teethCol, teeth * 0.9);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

  class Avatar {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: true })
        || canvas.getContext("experimental-webgl", { alpha: false, preserveDrawingBuffer: true });
      this.ready = false;
      this.mood = "idle";
      this.debug = false;
      this.debugParams = { jaw: 0, wide: 0, round: 0, press: 0, brow: 0, blink: 0 };
      // animated params (springs toward targets)
      this.p = { jaw: 0, wide: 0, round: 0, press: 0, brow: 0, smile: 0.1 };
      this.t = { jaw: 0, wide: 0, round: 0, press: 0, brow: 0, smile: 0.1 };
      this.blink = 0;
      this.nextBlink = performance.now() + 1500;
      this.blinkStart = -1;
      this.tl = null; this.tlStart = 0; this.tlIdx = 0;
      this.onSpeakEnd = null;
      this.layout = Avatar.defaultLayout();
      this.fields = new Float32Array(NF * 6);
      if (this.gl) this._initGL();
      this._last = performance.now();
      const loop = (now) => { this._tick(now); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      // rAF stalls in throttled/background/embedded tabs — keep the face alive
      setInterval(() => {
        const now = performance.now();
        if (now - this._last > 45) this._tick(now);
      }, 33);
    }

    static defaultLayout() {
      // canonical FFHQ-aligned portrait (thispersondoesnotexist.com)
      return {
        eyeL: [0.375, 0.465], eyeR: [0.625, 0.465],
        mouth: [0.500, 0.742], chin: [0.500, 0.850],
      };
    }

    _initGL() {
      const gl = this.gl;
      const mk = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          console.error(gl.getShaderInfoLog(sh));
          throw new Error("shader compile failed");
        }
        return sh;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(prog));
        this.gl = null; return;
      }
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = {
        F: gl.getUniformLocation(prog, "uF"),
        head: gl.getUniformLocation(prog, "uHead"),
        mouth: gl.getUniformLocation(prog, "uMouth"),
        mouth2: gl.getUniformLocation(prog, "uMouth2"),
      };
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
                            [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) {
        gl.texParameteri(gl.TEXTURE_2D, k, v);
      }
    }

    load(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const max = 1024;
          const sc = Math.min(1, max / Math.max(img.width, img.height));
          this.canvas.width = Math.round(img.width * sc);
          this.canvas.height = Math.round(img.height * sc);
          this.img = img;
          if (this.gl) {
            const gl = this.gl;
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            gl.bindTexture(gl.TEXTURE_2D, this.tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
          } else {
            this.ctx2d = this.canvas.getContext("2d");
          }
          this.ready = true;
          resolve();
        };
        img.onerror = () => reject(new Error("could not load avatar image: " + url));
        img.src = url;
      });
    }

    setLayout(layout) { this.layout = layout; }

    /** Start playing a viseme timeline (from Visemes.build). */
    speak(timeline) {
      this.tl = timeline; this.tlStart = performance.now(); this.tlIdx = 0;
      this.mood = "speaking";
    }
    /** Re-anchor timeline to a word boundary (charIndex from onboundary). */
    anchor(charIndex) {
      if (!this.tl) return;
      const e = this.tl.entries.find((en) => en.charIndex >= charIndex);
      if (!e) return;
      const want = performance.now() - e.t;
      if (Math.abs(want - this.tlStart) > 60) { this.tlStart = want; this.tlIdx = 0; }
    }
    stopSpeaking() {
      this.tl = null;
      for (const k of ["jaw", "wide", "round", "press"]) this.t[k] = 0;
      if (this.mood === "speaking") this.mood = "idle";
    }
    setMood(m) { this.mood = m; }

    _tick(now) {
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      if (!this.ready) return;

      // ---- blinking ----
      if (this.blinkStart < 0 && now >= this.nextBlink) {
        this.blinkStart = now;
        this.nextBlink = now + 2200 + Math.random() * 3600 + (Math.random() < 0.18 ? -1900 : 0);
      }
      if (this.blinkStart >= 0) {
        const bt = now - this.blinkStart;
        if (bt < 80) this.blink = bt / 80;
        else if (bt < 115) this.blink = 1;
        else if (bt < 235) this.blink = 1 - (bt - 115) / 120;
        else { this.blink = 0; this.blinkStart = -1; }
      }

      // ---- viseme timeline ----
      if (this.tl) {
        const ct = now - this.tlStart;
        const ent = this.tl.entries;
        while (this.tlIdx < ent.length - 1 && ent[this.tlIdx + 1].t <= ct) this.tlIdx++;
        const e = ent[this.tlIdx];
        if (ct > this.tl.total) {
          this.tl = null;
          for (const k of ["jaw", "wide", "round", "press"]) this.t[k] = 0;
          if (this.onSpeakEnd) this.onSpeakEnd();
        } else if (e && ct >= e.t && ct < e.t + e.dur + 30) {
          const amp = 0.92 + Math.sin(ct * 0.013) * 0.08;
          this.t.jaw = e.jaw * amp; this.t.wide = e.wide;
          this.t.round = e.round; this.t.press = e.press;
        } else {
          this.t.jaw *= 0.4; this.t.press = 0;
        }
      }

      // ---- mood layer ----
      const ts = now / 1000;
      if (!this.tl && !this.debug) {
        this.t.jaw = 0; this.t.wide = 0; this.t.round = 0; this.t.press = 0;
      }
      if (this.mood === "thinking") this.t.brow = 0.28 + 0.14 * Math.sin(ts * 2.1);
      else if (this.mood === "listening") this.t.brow = 0.18;
      else this.t.brow = 0.04 + 0.05 * Math.sin(ts * 0.35);
      this.t.smile = this.mood === "speaking" ? 0.16 : this.mood === "listening" ? 0.22 : 0.13;

      if (this.debug) Object.assign(this.t, {
        jaw: this.debugParams.jaw, wide: this.debugParams.wide, round: this.debugParams.round,
        press: this.debugParams.press, brow: this.debugParams.brow,
      });

      // ---- springs ----
      const k = 1 - Math.exp(-dt * 24);
      for (const key of Object.keys(this.p)) this.p[key] += (this.t[key] - this.p[key]) * k;
      const blink = this.debug && this.debugParams.blink > 0 ? this.debugParams.blink : this.blink;

      // ---- head sway / breathing ----
      const swayAmp = this.mood === "thinking" ? 1.5 : this.mood === "speaking" ? 1.15 : 1;
      const rot = (Math.sin(ts * 0.32) * 0.6 + Math.sin(ts * 0.71 + 1.4) * 0.4) * 0.011 * swayAmp
        + (this.mood === "listening" ? 0.008 : 0);
      const tx = Math.sin(ts * 0.24 + 0.6) * 0.0035 * swayAmp;
      const ty = Math.sin(ts * 0.43 + 2.1) * 0.0028 + Math.sin(ts * 1.15) * 0.0016;
      const scale = 1 + Math.sin(ts * 1.15) * 0.003;

      this._render(rot, tx, ty, scale, blink);
    }

    _render(rot, tx, ty, scale, blink) {
      const L = this.layout, P = this.p;
      const u = Math.max(0.12, L.eyeR[0] - L.eyeL[0]); // interocular distance
      const M = L.mouth, C = L.chin, eL = L.eyeL, eR = L.eyeR;
      const drop = P.jaw * 0.088 * u;

      if (!this.gl) return this._render2d(blink, drop);

      const F = this.fields;
      let i = 0;
      const set = (cx, cy, sx, sy, dx, dy) => { F[i++] = cx; F[i++] = cy; F[i++] = sx; F[i++] = sy; F[i++] = dx; F[i++] = dy; };
      // jaw + lips
      set(C[0], C[1], 0.62 * u, 0.36 * u, 0, P.jaw * 0.080 * u);
      set(M[0], M[1] + 0.05 * u, 0.24 * u, 0.13 * u, 0, drop - P.press * 0.012 * u);
      set(M[0], M[1] - 0.045 * u, 0.24 * u, 0.10 * u, 0, -P.jaw * 0.022 * u + P.press * 0.014 * u);
      // mouth corners (wide pulls out, round pulls in, smile lifts)
      const cdx = P.wide * 0.045 * u - P.round * 0.055 * u;
      const cdy = -P.smile * 0.035 * u;
      set(M[0] - 0.19 * u, M[1], 0.12 * u, 0.10 * u, -cdx, cdy);
      set(M[0] + 0.19 * u, M[1], 0.12 * u, 0.10 * u, cdx, cdy);
      // brows
      set(eL[0], eL[1] - 0.18 * u, 0.20 * u, 0.09 * u, 0, -P.brow * 0.045 * u);
      set(eR[0], eR[1] - 0.18 * u, 0.20 * u, 0.09 * u, 0, -P.brow * 0.045 * u);
      // eyelids (upper lid sweeps down, lower lid rises slightly)
      set(eL[0], eL[1] - 0.01 * u, 0.16 * u, 0.095 * u, 0, blink * 0.098 * u);
      set(eR[0], eR[1] - 0.01 * u, 0.16 * u, 0.095 * u, 0, blink * 0.098 * u);
      set(eL[0], eL[1] + 0.05 * u, 0.14 * u, 0.06 * u, 0, -blink * 0.020 * u);
      set(eR[0], eR[1] + 0.05 * u, 0.14 * u, 0.06 * u, 0, -blink * 0.020 * u);
      set(0, 0, 1, 1, 0, 0); // spare

      const gl = this.gl;
      gl.uniform1fv(this.u.F, F);
      gl.uniform4f(this.u.head, rot, tx, ty, scale);
      gl.uniform4f(this.u.mouth, M[0], M[1], P.jaw, P.wide);
      gl.uniform3f(this.u.mouth2, P.round, drop, u);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _render2d(blink, drop) { // graceful fallback when WebGL is unavailable
      const ctx = this.ctx2d, w = this.canvas.width, h = this.canvas.height;
      ctx.drawImage(this.img, 0, 0, w, h);
      const M = this.layout.mouth, u = this.layout.eyeR[0] - this.layout.eyeL[0];
      if (this.p.jaw > 0.05) {
        ctx.fillStyle = "rgba(28,10,12,0.85)";
        ctx.beginPath();
        ctx.ellipse(M[0] * w, (M[1] + drop * 0.4) * h, u * 0.17 * w, (drop * 0.5 + 0.004) * h, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (blink > 0.5) {
        ctx.fillStyle = "rgba(120,90,75,0.55)";
        for (const e of [this.layout.eyeL, this.layout.eyeR]) {
          ctx.beginPath();
          ctx.ellipse(e[0] * w, e[1] * h, u * 0.14 * w, u * 0.05 * h, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  window.Avatar = Avatar;
})();
