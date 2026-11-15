/** Shared new-order alert for Delivery Entry (must unlock during a user tap). */

const SOUND_PREF_KEY = "gtct.delivery.orderAlertSound";

let sharedCtx = null;
let unlocked = false;
let htmlAudio = null;
let cachedWavUrl = null;

function readSoundPref() {
  try {
    const raw = localStorage.getItem(SOUND_PREF_KEY);
    if (raw === "0" || raw === "false" || raw === "off") return false;
    if (raw === "1" || raw === "true" || raw === "on") return true;
  } catch {
    // ignore
  }
  return true; // default on
}

let soundEnabled = typeof window !== "undefined" ? readSoundPref() : true;

export function isDeliveryAlertSoundEnabled() {
  return soundEnabled;
}

export function setDeliveryAlertSoundEnabled(enabled) {
  soundEnabled = Boolean(enabled);
  try {
    localStorage.setItem(SOUND_PREF_KEY, soundEnabled ? "1" : "0");
  } catch {
    // ignore
  }
  return soundEnabled;
}

function getAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AudioCtx();
  }
  return sharedCtx;
}

/**
 * Soft doorbell-style chime (3 rising notes + echo).
 * Designed to cut through shop noise without a harsh buzzer.
 */
function synthesizeChimeSamples(sampleRate) {
  // Phrase: G5 → C6 → E6 with harmonic stack, then a soft repeat.
  const melody = [
    { freq: 784, start: 0.0, dur: 0.28 },
    { freq: 1046.5, start: 0.26, dur: 0.32 },
    { freq: 1318.5, start: 0.54, dur: 0.42 },
    { freq: 1046.5, start: 1.05, dur: 0.22 },
    { freq: 1318.5, start: 1.28, dur: 0.38 },
  ];
  const durationSec = 1.85;
  const numSamples = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(numSamples);

  const addTone = (freq, start, dur, amp) => {
    const startI = Math.floor(start * sampleRate);
    const endI = Math.min(numSamples, Math.floor((start + dur) * sampleRate));
    const attack = Math.max(1, Math.floor(0.012 * sampleRate));
    const release = Math.max(1, Math.floor(0.14 * sampleRate));
    for (let i = startI; i < endI; i += 1) {
      const local = i - startI;
      const len = endI - startI;
      let env = 1;
      if (local < attack) env = local / attack;
      else if (local > len - release) env = Math.max(0, (len - local) / release);
      // Soft sine + gentle 2nd harmonic (bell-like), not square/buzzer.
      const t = i / sampleRate;
      const wave =
        Math.sin(2 * Math.PI * freq * t) * 0.72 +
        Math.sin(2 * Math.PI * freq * 2 * t) * 0.18 +
        Math.sin(2 * Math.PI * freq * 3 * t) * 0.06;
      samples[i] += wave * amp * env;
    }
  };

  for (const note of melody) {
    addTone(note.freq, note.start, note.dur, 0.42);
    // Quiet octave below for body.
    addTone(note.freq / 2, note.start + 0.01, note.dur * 0.9, 0.14);
  }

  // Soft peak normalize.
  let peak = 0.0001;
  for (let i = 0; i < samples.length; i += 1) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  const scale = 0.9 / peak;
  for (let i = 0; i < samples.length; i += 1) samples[i] *= scale;
  return samples;
}

function buildChimeDataUrl() {
  if (cachedWavUrl) return cachedWavUrl;
  const sampleRate = 44100;
  const samples = synthesizeChimeSamples(sampleRate);
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  cachedWavUrl = `data:audio/wav;base64,${btoa(binary)}`;
  return cachedWavUrl;
}

function getHtmlAudio() {
  if (htmlAudio) return htmlAudio;
  try {
    htmlAudio = new Audio(buildChimeDataUrl());
    htmlAudio.preload = "auto";
    htmlAudio.volume = 1;
  } catch {
    htmlAudio = null;
  }
  return htmlAudio;
}

/** Call during login / first tap so browsers allow playback. */
export function unlockDeliveryAlertAudio() {
  unlocked = true;
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    const audio = getHtmlAudio();
    if (audio) {
      const prev = audio.volume;
      audio.volume = 0.001;
      const p = audio.play();
      if (p && typeof p.then === "function") {
        void p
          .then(() => {
            audio.pause();
            audio.currentTime = 0;
            audio.volume = prev || 1;
          })
          .catch(() => {
            audio.volume = prev || 1;
          });
      }
    }
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  } catch {
    // ignore
  }
}

function playWebAudioChime() {
  const ctx = getAudioContext();
  if (!ctx) return false;

  const play = () => {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.85, now);
    master.connect(ctx.destination);

    const notes = [
      { freq: 784, start: 0.0, dur: 0.28 },
      { freq: 1046.5, start: 0.26, dur: 0.32 },
      { freq: 1318.5, start: 0.54, dur: 0.42 },
      { freq: 1046.5, start: 1.05, dur: 0.22 },
      { freq: 1318.5, start: 1.28, dur: 0.38 },
    ];

    for (const note of notes) {
      const harmonics = [
        { mult: 1, amp: 0.55 },
        { mult: 2, amp: 0.16 },
        { mult: 3, amp: 0.05 },
        { mult: 0.5, amp: 0.12 },
      ];
      for (const h of harmonics) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = note.freq * h.mult;
        const t0 = now + note.start;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(h.amp, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur);
        osc.connect(gain);
        gain.connect(master);
        osc.start(t0);
        osc.stop(t0 + note.dur + 0.05);
      }
    }
  };

  if (ctx.state === "suspended") {
    void ctx.resume().then(play).catch(() => {});
    return false;
  }
  play();
  return true;
}

function playHtmlChime() {
  const audio = getHtmlAudio();
  if (!audio) return false;
  try {
    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      void p.catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

function showSystemNotification(title, body) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const n = new Notification(title || "New shop order", {
      body: body || "A new order is waiting in Shop orders.",
      silent: !soundEnabled,
      tag: "gtct-shop-order",
      renotify: true,
    });
    window.setTimeout(() => {
      try {
        n.close();
      } catch {
        // ignore
      }
    }, 10000);
  } catch {
    // ignore
  }
}

/**
 * Play alert sound (+ vibration / system notification).
 * @param {{ title?: string, body?: string, forceSound?: boolean, skipSound?: boolean }} [opts]
 */
export function playNewOrderAlert(opts = {}) {
  try {
    if (!unlocked) unlockDeliveryAlertAudio();

    const wantSound =
      opts.forceSound === true ||
      (opts.skipSound !== true && soundEnabled);

    if (wantSound) {
      const webOk = playWebAudioChime();
      playHtmlChime();
      if (!webOk) {
        window.setTimeout(() => {
          playWebAudioChime();
          playHtmlChime();
        }, 320);
      }
    }

    if (
      wantSound &&
      typeof navigator !== "undefined" &&
      typeof navigator.vibrate === "function"
    ) {
      navigator.vibrate([140, 70, 140, 70, 220]);
    }
    showSystemNotification(opts.title, opts.body);
  } catch {
    // Ignore autoplay / audio failures.
  }
}
