/* sonar-scroll.js
 *
 * Touchless scrolling via near-ultrasonic Doppler sensing.
 * Emits a ~20 kHz carrier through the speakers, watches the microphone
 * spectrum around that bin, and reads the asymmetry: a hand moving toward
 * the mic shifts reflected energy higher, moving away shifts it lower.
 *
 * Method from SoundWave (Gupta, Morris, Patel, Tan; CHI 2012), by way of
 * Daniel Rapp's doppler.js. Double air-tap to invert direction is from
 * Emanuel Perez's sonar.cool.
 *
 * Requires a secure context (https) and explicit mic permission.
 * 18-20 kHz is NOT reliably inaudible. Younger listeners and animals often
 * hear it. Always warn before starting.
 *
 * Usage:  SonarScroll.mount(document.querySelector('#sonar'));
 */
(function (global) {
  'use strict';

  const CARRIER_PREFERRED = 20000;
  const CARRIER_FLOOR     = 18000;
  const FFT_SIZE          = 8192;   // ~5.4 Hz bins at 44.1 kHz
  const REL_THRESHOLD_DB  = 50;     // bandwidth cutoff below the peak
  const MAX_BIN_WALK      = 40;     // don't scan the whole spectrum
  const SMOOTHING         = 0.82;   // EMA on the asymmetry signal
  const CALIBRATION_MS    = 1800;
  const DEADZONE          = 1.15;   // multiples of calibrated noise
  const SCROLL_GAIN       = 5.5;    // px per unit asymmetry per frame
  const TAP_WINDOW_MS     = 600;    // for double air-tap
  const TAP_THRESHOLD     = 4.0;
  const TAP_COOLDOWN_MS   = 900;

  class SonarScroll {
    constructor() {
      this.running = false;
      this.inverted = false;
      this.ctx = null;
      this.stream = null;
      this.osc = null;
      this.analyser = null;
      this.raf = null;
      this.onState = () => {};
      this.onSignal = () => {};
    }

    async start() {
      if (this.running) return;
      if (!global.isSecureContext) {
        throw new Error('Needs https. Microphone access is blocked on insecure origins.');
      }
      const AudioCtx = global.AudioContext || global.webkitAudioContext;
      if (!AudioCtx) throw new Error('This browser has no Web Audio API.');

      this.ctx = new AudioCtx();
      if (this.ctx.state === 'suspended') await this.ctx.resume();

      // Carrier has to sit below Nyquist with room to see the sidebands.
      const nyquist = this.ctx.sampleRate / 2;
      this.carrier = Math.min(CARRIER_PREFERRED, nyquist - 1500);
      if (this.carrier < CARRIER_FLOOR) {
        this.ctx.close();
        throw new Error(
          `Sample rate ${this.ctx.sampleRate} Hz is too low to carry an inaudible tone.`
        );
      }

      // The three defaults below will each destroy the carrier if left on:
      // echo cancellation exists specifically to remove what the speaker just
      // played, which here is the entire signal.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      this.osc = this.ctx.createOscillator();
      this.osc.frequency.value = this.carrier;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.12;
      this.osc.connect(gain).connect(this.ctx.destination);
      this.osc.start();

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0;
      this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);

      this.bins = new Float32Array(this.analyser.frequencyBinCount);
      this.binHz = this.ctx.sampleRate / FFT_SIZE;
      this.carrierBin = Math.round(this.carrier / this.binHz);

      this.smoothed = 0;
      this.noiseFloor = 0.6;
      this.samples = [];
      this.calibratedAt = performance.now() + CALIBRATION_MS;
      this.lastTap = 0;
      this.pendingTap = 0;

      this.running = true;
      this.onState('calibrating');
      this._loop();
    }

    stop() {
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      if (this.osc) { try { this.osc.stop(); } catch (_) {} }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.ctx) this.ctx.close();
      this.ctx = this.stream = this.osc = this.analyser = this.raf = null;
      this.onState('off');
      this.onSignal(0);
    }

    /* Walk outward from the carrier bin until energy drops below a relative
     * threshold. Wider on the high side means reflections shifted up, which
     * means something approached. This is Rapp's bandwidth method rather than
     * a centroid, because it degrades more gracefully in a noisy room. */
    _asymmetry() {
      this.analyser.getFloatFrequencyData(this.bins);
      const peak = this.bins[this.carrierBin];
      if (!isFinite(peak) || peak < -90) return null; // carrier not audible to the mic
      const cutoff = peak - REL_THRESHOLD_DB;

      let up = 0;
      for (let i = 1; i < MAX_BIN_WALK; i++) {
        const v = this.bins[this.carrierBin + i];
        if (v === undefined || v < cutoff) break;
        up = i;
      }
      let down = 0;
      for (let i = 1; i < MAX_BIN_WALK; i++) {
        const v = this.bins[this.carrierBin - i];
        if (v === undefined || v < cutoff) break;
        down = i;
      }
      return up - down;
    }

    _loop() {
      if (!this.running) return;
      this.raf = requestAnimationFrame(() => this._loop());

      const raw = this._asymmetry();
      if (raw === null) {
        this.onState('no-signal');
        return;
      }

      this.smoothed = SMOOTHING * this.smoothed + (1 - SMOOTHING) * raw;
      const now = performance.now();

      if (now < this.calibratedAt) {
        this.samples.push(Math.abs(raw));
        return;
      }
      if (this.samples.length) {
        const mean = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
        this.noiseFloor = Math.max(0.6, mean * 1.6);
        this.samples = [];
        this.onState('active');
      }

      const signal = this.smoothed;
      this.onSignal(signal / (this.noiseFloor * 4));

      // Double air-tap: two sharp approach pulses inside one window.
      if (signal > TAP_THRESHOLD && now - this.lastTap > TAP_COOLDOWN_MS) {
        if (now - this.pendingTap < TAP_WINDOW_MS) {
          this.inverted = !this.inverted;
          this.lastTap = now;
          this.pendingTap = 0;
          this.onState(this.inverted ? 'inverted' : 'active');
          return;
        }
        this.pendingTap = now;
      }

      if (Math.abs(signal) < this.noiseFloor * DEADZONE) return;
      const dir = this.inverted ? -1 : 1;
      global.scrollBy({ top: -dir * signal * SCROLL_GAIN, behavior: 'instant' });
    }
  }

  /* ---------- minimal UI ---------- */

  SonarScroll.mount = function (root) {
    if (!root) return;
    const sonar = new SonarScroll();

    root.innerHTML = `
      <button type="button" class="sonar-btn" aria-pressed="false">
        <span class="sonar-dot" aria-hidden="true"></span>
        <span class="sonar-label">Scroll with your hand</span>
      </button>
      <p class="sonar-note" hidden></p>
      <div class="sonar-meter" hidden aria-hidden="true"><i></i></div>`;

    const btn = root.querySelector('.sonar-btn');
    const label = root.querySelector('.sonar-label');
    const note = root.querySelector('.sonar-note');
    const meter = root.querySelector('.sonar-meter');
    const bar = meter.querySelector('i');

    const say = (t) => { note.hidden = !t; note.textContent = t || ''; };

    sonar.onState = (s) => {
      root.dataset.state = s;
      if (s === 'calibrating') { label.textContent = 'Calibrating, hold still'; }
      if (s === 'active')      { label.textContent = 'Listening. Raise your palm'; }
      if (s === 'inverted')    { label.textContent = 'Listening, direction flipped'; }
      if (s === 'no-signal')   { label.textContent = 'Can\u2019t hear the tone'; }
      if (s === 'off')         { label.textContent = 'Scroll with your hand'; meter.hidden = true; }
    };
    sonar.onSignal = (v) => {
      const pct = Math.max(-1, Math.min(1, v));
      bar.style.transform = `translateX(${50 + pct * 50}%)`;
    };

    btn.addEventListener('click', async () => {
      if (sonar.running) {
        sonar.stop();
        btn.setAttribute('aria-pressed', 'false');
        say('');
        return;
      }
      if (!root.dataset.warned) {
        root.dataset.warned = '1';
        say('This plays a roughly 20 kHz tone through your speakers and listens '
          + 'on your microphone. Some people and most animals can hear it. Audio '
          + 'is analysed in the page and never leaves your device. Press again to start.');
        return;
      }
      try {
        say('');
        meter.hidden = false;
        await sonar.start();
        btn.setAttribute('aria-pressed', 'true');
      } catch (err) {
        meter.hidden = true;
        say(err.message || 'Could not start. Microphone permission is required.');
      }
    });

    global.addEventListener('pagehide', () => sonar.stop());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sonar.running) { sonar.stop(); btn.setAttribute('aria-pressed','false'); }
    });

    return sonar;
  };

  global.SonarScroll = SonarScroll;
})(window);
