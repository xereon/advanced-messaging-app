// recorder.js — microphone capture for voice notes.
//
// Kept apart from the UI because the awkward parts are all about the platform,
// not about layout: which container the browser is willing to produce, the fact
// that a permission prompt is asynchronous and can be dismissed rather than
// answered, and that a stream left open keeps the recording indicator lit in the
// tab strip long after the recording has finished.

/**
 * Containers in preference order.
 *
 * Opus in WebM is the smallest and is what Chrome and Firefox produce. Safari
 * offers none of them and produces mp4/aac from an empty string, which is why
 * the last resort is to pass nothing at all and let the browser choose.
 */
const PREFERRED = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

/** Whether recording is possible at all, so the button can be hidden if not. */
export function isSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

function pickMimeType() {
  if (!window.MediaRecorder?.isTypeSupported) return '';
  for (const type of PREFERRED) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/**
 * Start recording. Resolves with a handle, or rejects with a message written for
 * a person rather than a log.
 *
 * `onTick` receives elapsed milliseconds about ten times a second, which is
 * often enough for a counter to look live without being a rendering cost.
 */
export async function start({ maxMs = 5 * 60 * 1000, onTick, onLimit } = {}) {
  if (!isSupported()) throw new Error('This browser cannot record audio.');

  let stream;
  try {
    // Echo cancellation and noise suppression are the difference between a
    // usable voice note and a room recording. They are hints, not guarantees.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    // The distinction the user needs is "you said no" versus "there is nothing
    // to record with" — everything else is the same dead end.
    if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
      throw new Error('Microphone access was refused. You can allow it in your browser\'s site settings.');
    }
    if (err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError') {
      throw new Error('No microphone was found.');
    }
    throw new Error('The microphone could not be opened.');
  }

  const mimeType = pickMimeType();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    stopTracks(stream);
    throw new Error('This browser cannot record audio.');
  }

  const chunks = [];
  recorder.addEventListener('dataavailable', (e) => { if (e.data?.size) chunks.push(e.data); });

  const startedAt = performance.now();
  let stoppedAt = null;
  const elapsed = () => Math.round((stoppedAt ?? performance.now()) - startedAt);

  const ticker = onTick ? setInterval(() => onTick(elapsed()), 100) : null;

  // A recording nobody stops is a phone in a pocket. Stopping at the cap keeps
  // what was said rather than throwing it away, which is what a hard failure
  // would do.
  const limitTimer = setTimeout(() => {
    if (recorder.state === 'recording') {
      onLimit?.();
      recorder.stop();
    }
  }, maxMs);

  const finished = new Promise((resolve) => {
    recorder.addEventListener('stop', () => {
      stoppedAt = performance.now();
      if (ticker) clearInterval(ticker);
      clearTimeout(limitTimer);
      // Releasing the tracks is what turns off the browser's recording
      // indicator. Skipping it leaves every tab looking like it is listening.
      stopTracks(stream);
      resolve();
    }, { once: true });
  });

  // A timeslice makes dataavailable fire periodically rather than only at the
  // end, so a tab discarded mid-recording still leaves usable audio behind.
  recorder.start(1000);

  return {
    get state() { return recorder.state; },
    elapsed,

    /** Stop and return the recording, or null if nothing was captured. */
    async stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      await finished;
      if (!chunks.length) return null;
      const type = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type });
      if (!blob.size) return null;
      return { blob, durationMs: elapsed(), mimeType: type };
    },

    /** Stop and throw the audio away. */
    async cancel() {
      if (recorder.state !== 'inactive') recorder.stop();
      await finished;
      chunks.length = 0;
    },
  };
}

function stopTracks(stream) {
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* already ended */ }
  }
}

/** mm:ss, the only format short enough to sit inside a bubble. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
