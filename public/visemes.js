/* Visemes — turns a sentence into a timed sequence of mouth shapes.
   Each entry: { t (ms from utterance start), dur, jaw, wide, round, press, charIndex }
   charIndex = offset of the containing word in the original text, so the
   timeline can be re-anchored from SpeechSynthesis word-boundary events. */
(function () {
  "use strict";

  const V = {
    A:  { jaw: 0.80, wide: 0.35, round: 0.00, press: 0 },   // father, cat
    E:  { jaw: 0.48, wide: 0.62, round: 0.00, press: 0 },   // bed, air
    I:  { jaw: 0.30, wide: 0.85, round: 0.00, press: 0 },   // see, it
    O:  { jaw: 0.62, wide: 0.05, round: 0.75, press: 0 },   // go, law
    U:  { jaw: 0.28, wide: 0.00, round: 0.92, press: 0 },   // you, food
    M:  { jaw: 0.02, wide: 0.10, round: 0.00, press: 0.85 },// m b p — lips closed
    F:  { jaw: 0.14, wide: 0.30, round: 0.00, press: 0.40 },// f v — lip on teeth
    W:  { jaw: 0.25, wide: 0.00, round: 0.72, press: 0 },   // w qu
    L:  { jaw: 0.40, wide: 0.30, round: 0.00, press: 0 },   // l
    C:  { jaw: 0.22, wide: 0.45, round: 0.00, press: 0 },   // t d s z n k g...
    SH: { jaw: 0.24, wide: 0.10, round: 0.48, press: 0 },   // sh ch j
    TH: { jaw: 0.28, wide: 0.42, round: 0.00, press: 0 },   // th
    REST: { jaw: 0, wide: 0, round: 0, press: 0 },
  };

  const DIGRAPHS = {
    th: "TH", sh: "SH", ch: "SH", ph: "F", wh: "W", qu: "W",
    oo: "U", ou: "O", ow: "O", oy: "O", oi: "O",
    ee: "I", ea: "I", ie: "I", ai: "E", ay: "E", ei: "E", ey: "E",
    au: "O", aw: "O",
  };
  const SINGLES = {
    a: "A", e: "E", i: "I", o: "O", u: "U", y: "I",
    m: "M", b: "M", p: "M", f: "F", v: "F", w: "W", l: "L",
    j: "SH", r: "C", s: "C", z: "C", t: "C", d: "C", n: "C",
    k: "C", g: "C", c: "C", h: "C", x: "C",
  };
  const VOWELS = new Set(["A", "E", "I", "O", "U", "W"]);

  function wordToVisemes(word) {
    const seq = [];
    const w = word.toLowerCase().replace(/[^a-z']/g, "");
    let i = 0;
    while (i < w.length) {
      const pair = w.slice(i, i + 2);
      if (DIGRAPHS[pair]) { seq.push(DIGRAPHS[pair]); i += 2; continue; }
      const one = SINGLES[w[i]];
      if (one) {
        // collapse repeated identical visemes (e.g. "ll", "ss")
        if (seq[seq.length - 1] !== one) seq.push(one);
        else if (VOWELS.has(one)) seq.push(one);
      }
      i += 1;
    }
    return seq;
  }

  /** Build a timeline for `text`, scaled by speech `rate` (1 = normal). */
  function build(text, rate) {
    rate = Math.max(0.5, Math.min(2, rate || 1));
    const scale = 1 / rate;
    const DUR = { vowel: 112 * scale, cons: 58 * scale, M: 78 * scale };
    const GAP_WORD = 65 * scale, GAP_COMMA = 210 * scale, GAP_END = 330 * scale;

    const entries = [];
    let t = 30; // small lead-in
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const word = m[0];
      const charIndex = m.index;
      for (const v of wordToVisemes(word)) {
        const dur = v === "M" ? DUR.M : VOWELS.has(v) ? DUR.vowel : DUR.cons;
        const p = V[v];
        entries.push({ t, dur, jaw: p.jaw, wide: p.wide, round: p.round, press: p.press, charIndex });
        t += dur;
      }
      if (/[.!?]$/.test(word)) t += GAP_END;
      else if (/[,;:]$/.test(word)) t += GAP_COMMA;
      else t += GAP_WORD;
    }
    return { entries, total: t + 120 };
  }

  window.Visemes = { build };
})();
