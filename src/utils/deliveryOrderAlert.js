/** Shared new-order alert for Delivery Entry (must unlock during a user tap). */

let sharedCtx = null;
let unlocked = false;
let htmlAudio = null;

function getAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AudioCtx();
  }
  return sharedCtx;
}

/** Tiny WAV beep data URL — works when Web Audio is suspended/blocked. */
function buildBeepDataUrl() {
  const sampleRate = 22050;
  const durationSec = 0.55;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
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

  for (let i = 0; i < numSamples; i += 1) {
    const t = i / sampleRate;
    let freq = 880;
    if (t >= 0.18 && t < 0.36) freq = 1175;
    else if (t >= 0.36) freq = 988;
    const envelope =
      t < 0.02 ? t / 0.02 : t > durationSec - 0.04 ? (durationSec - t) / 0.04 : 1;
    const gapMute =
      (t > 0.16 && t < 0.18) || (t > 0.34 && t < 0.36) ? 0 : 1;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.55 * envelope * gapMute;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function getHtmlAudio() {
  if (htmlAudio) return htmlAudio;
  try {
    htmlAudio = new Audio(buildBeepDataUrl());
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
      // Play muted briefly to satisfy autoplay policies, then reset.
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

function playWebAudioBeep() {
  const ctx = getAudioContext();
  if (!ctx) return false;

  const play = () => {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
    master.connect(ctx.destination);

    const tones = [
      { freq: 932, start: 0, dur: 0.18 },
      { freq: 1245, start: 0.2, dur: 0.28 },
      { freq: 932, start: 0.42, dur: 0.18 },
    ];
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = tone.freq;
      gain.gain.setValueAtTime(0.0001, now + tone.start);
      gain.gain.exponentialRampToValueAtTime(1, now + tone.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        now + tone.start + tone.dur
      );
      osc.connect(gain);
      gain.connect(master);
      osc.start(now + tone.start);
      osc.stop(now + tone.start + tone.dur + 0.03);
    }
  };

  if (ctx.state === "suspended") {
    void ctx.resume().then(play).catch(() => {});
    return false;
  }
  play();
  return true;
}

function playHtmlBeep() {
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
      silent: false,
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
 * Play alert sound (+ optional vibration / system notification).
 * @param {{ title?: string, body?: string }} [opts]
 */
export function playNewOrderAlert(opts = {}) {
  try {
    if (!unlocked) unlockDeliveryAlertAudio();
    const webOk = playWebAudioBeep();
    // Always also try HTML audio — more reliable on mobile Safari / Chrome.
    playHtmlBeep();
    if (!webOk) {
      window.setTimeout(() => {
        playWebAudioBeep();
        playHtmlBeep();
      }, 280);
    }

    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([120, 60, 120, 60, 200]);
    }
    showSystemNotification(opts.title, opts.body);
  } catch {
    // Ignore autoplay / audio failures.
  }
}
