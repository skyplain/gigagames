// GigaGames i SkyPlain Avanture u browseru: mikser zvuka u AudioWorklet-u (posebna audio nit browsera).
// Rust (src/sound.rs, modul web_out) jednom posalje uzorke svakog zvuka i pozadinske petlje, a posle samo
// kratke komande (pusti zvuk, jacina pozadine, motor). Mesanje radi ovde, nezavisno od crtanja igre na
// glavnoj niti, pa zvuk ne secka i ne koci kad je frejm spor. Isto mesanje kao Mixer::fill u sound.rs.

const MASTER = 0.8;

class GigaMixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.src = 44100; // frekvencija uzoraka koje salje Rust (RATE)
    this.snd = new Map(); // id zvuka -> Float32Array
    this.ambData = new Map(); // id pozadine -> Float32Array (petlja)
    this.voices = []; // { d, pos, step, vol }
    this.ambs = new Map(); // id -> { d, pos, vol, volT, seen }
    this.engines = new Map(); // slot -> { rpm, rpmT, vol, volT, ph, lp, seen }
    this.rng = 12345;
    this.port.onmessage = (e) => this.cmd(e.data);
  }

  cmd(m) {
    switch (m.t) {
      case 'rate':
        this.src = m.rate;
        break;
      case 'snd':
        this.snd.set(m.id, m.data);
        break;
      case 'ambd':
        this.ambData.set(m.id, m.data);
        break;
      case 'play': {
        const d = this.snd.get(m.id);
        if (!d) return;
        // isti zvuk mnogo puta odjednom (rafal): najstariji se gasi
        let same = 0;
        for (const v of this.voices) if (v.d === d) same++;
        if (same >= 4) this.voices.splice(this.voices.findIndex((v) => v.d === d), 1);
        if (this.voices.length >= 24) this.voices.shift();
        this.voices.push({ d, pos: 0, step: m.pitch * this.src / sampleRate, vol: m.vol });
        break;
      }
      case 'amb': {
        const d = this.ambData.get(m.id);
        if (!d) return;
        let a = this.ambs.get(m.id);
        if (!a) {
          a = { d, pos: 0, vol: 0, volT: m.vol, seen: currentTime };
          this.ambs.set(m.id, a);
        }
        a.volT = m.vol;
        a.seen = currentTime;
        break;
      }
      case 'eng': {
        let e = this.engines.get(m.slot);
        if (!e) {
          e = { rpm: m.rpm, rpmT: m.rpm, vol: 0, volT: m.vol, ph: 0, lp: 0, seen: currentTime };
          this.engines.set(m.slot, e);
        }
        e.rpmT = m.rpm;
        e.volT = m.vol;
        e.seen = currentTime;
        break;
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    const n = ch0.length;
    ch0.fill(0);
    // kratki zvuci
    for (const v of this.voices) {
      const d = v.d;
      for (let i = 0; i < n; i++) {
        const k = v.pos | 0;
        if (k + 1 >= d.length) { v.pos = d.length; break; }
        const f = v.pos - k;
        ch0[i] += (d[k] * (1 - f) + d[k + 1] * f) * v.vol;
        v.pos += v.step;
      }
    }
    this.voices = this.voices.filter((v) => (v.pos | 0) + 1 < v.d.length);
    // motor (isto kao Mixer::fill)
    const kk = 22050 / sampleRate;
    const dt = 1 / sampleRate;
    for (const [slot, e] of this.engines) {
      if (currentTime - e.seen > 0.2) e.volT = 0;
      for (let i = 0; i < n; i++) {
        e.rpm += (e.rpmT - e.rpm) * 0.0015 * kk;
        e.vol += (e.volT - e.vol) * 0.002 * kk;
        const f = 38 + 120 * e.rpm;
        e.ph = (e.ph + f * dt) % 1;
        this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
        const noise = (this.rng >>> 9) / (1 << 23) - 0.5;
        const raw = (e.ph * 2 - 1) * 0.6 + Math.sin(e.ph * Math.PI) * 0.5 + noise * 0.25;
        e.lp += (raw - e.lp) * (0.08 + 0.12 * e.rpm) * kk;
        ch0[i] += e.lp * e.vol * 0.22;
      }
      if (e.volT <= 0 && e.vol <= 0.001) this.engines.delete(slot);
    }
    // pozadinske petlje
    const step = this.src / sampleRate;
    for (const [id, a] of this.ambs) {
      if (currentTime - a.seen > 0.3) a.volT = 0;
      const d = a.d;
      const len = d.length;
      for (let i = 0; i < n; i++) {
        a.vol += (a.volT - a.vol) * 0.00025 * kk;
        const k = a.pos | 0;
        const f = a.pos - k;
        ch0[i] += (d[k] * (1 - f) + d[(k + 1) % len] * f) * a.vol;
        a.pos += step;
        if (a.pos >= len) a.pos -= len;
      }
      if (a.volT <= 0 && a.vol <= 0.0005) this.ambs.delete(id);
    }
    for (let i = 0; i < n; i++) ch0[i] = Math.tanh(ch0[i] * MASTER);
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    return true;
  }
}

registerProcessor('giga-mixer', GigaMixer);
