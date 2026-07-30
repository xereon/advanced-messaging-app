// files.js — attachment storage on disk with metadata in SQLite.
//
// Uploads are streamed to a content-addressed path, never served from a
// client-supplied name, and only handed back to members of the conversation
// they belong to.

import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, unlink, readFile, writeFile, open as openFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import { handle } from './db.js';
import * as crypt from './crypt.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB
export const MAX_FILES_PER_MESSAGE = 4;

// An allow-list, not a block-list: anything not named here is stored and served
// as a plain download, never as something the browser will execute.
const INLINE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
]);

export const isInlineImage = (mime) => INLINE_TYPES.has(mime);

/**
 * Audio containers a voice note can arrive in, and the only non-image types
 * served inline rather than as a download.
 *
 * A voice note has to be playable where it sits — handing someone a file to
 * download and open elsewhere is not a voice message. Serving these inline is
 * the same bet already taken on images: the browser decodes the bytes with its
 * media decoder and never executes them, and the response still carries
 * `default-src 'none'; sandbox` and `nosniff`, so a file renamed to look like
 * audio cannot become script.
 *
 * MediaRecorder produces webm/opus on Chrome and Firefox and mp4/aac on Safari,
 * so both have to be accepted for the feature to work at all.
 */
const PLAYABLE_AUDIO = new Set(['audio/webm', 'audio/ogg', 'audio/mp4']);

export const isPlayableAudio = (mime) => PLAYABLE_AUDIO.has(mime);

/** Anything the browser may render in place rather than hand over as a file. */
export const isServedInline = (mime) => INLINE_TYPES.has(mime) || PLAYABLE_AUDIO.has(mime);

/** A recording longer than this is a phone left in a pocket, not a message. */
export const MAX_VOICE_MS = 5 * 60 * 1000;

let uploadRoot = null;

export async function init(root) {
  uploadRoot = resolve(root);
  await mkdir(uploadRoot, { recursive: true });
}

export function rootDir() { return uploadRoot; }

/** Sniff the real type from magic bytes; the client's Content-Type is a hint. */
export function sniffMime(head) {
  const b = Buffer.from(head);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && b.subarray(8, 12).toString('latin1').startsWith('avif')) return 'image/avif';
  return null;
}

/**
 * The container a recording arrived in, or null if it is not one we play.
 *
 * Deliberately separate from sniffMime: that one governs every upload, and
 * widening it would mean ordinary attachments start being served inline. These
 * magic numbers are shared with the video forms of the same containers — no
 * cheap header read distinguishes a webm holding one Opus track from one holding
 * video — so this answers "is this a media container we are willing to play",
 * and the voice flag on the row is what says a human recorded it. The worst case
 * is somebody routing a video file through the recorder and hearing its
 * soundtrack, which costs nothing; a file that is not a media container at all
 * is refused outright.
 */
export function sniffAudioContainer(head) {
  const b = Buffer.from(head);
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  if (b.length >= 4 && b.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  // Safari's MediaRecorder emits mp4; the brand varies by version, so any ISO
  // base-media brand is accepted here where it would not be for an attachment.
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  return null;
}

/** Dimensions for the formats we render inline, so the UI can reserve space. */
export function imageSize(buf, mime) {
  const b = Buffer.from(buf);
  try {
    if (mime === 'image/png' && b.length >= 24) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && b.length >= 10) {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry dimensions.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* unreadable header; dimensions are optional */ }
  return { width: null, height: null };
}

/**
 * Consume a request stream into a stored file. The caller has already proven
 * the uploader is a member of the conversation.
 */
export async function store(req, { userId, convoId, name, declaredMime, voice = false, durationMs = 0 }) {
  const id = `f-${randomUUID()}`;
  const dir = join(uploadRoot, convoId.replace(/[^a-zA-Z0-9:_~-]/g, '_'));
  await mkdir(dir, { recursive: true });
  const path = join(dir, id);

  // Keep enough of the head in memory to sniff the type and read dimensions,
  // so the file never has to be read back off disk.
  const HEAD_BYTES = 65536;
  let size = 0;
  let head = Buffer.alloc(0);
  let tooBig = false;

  const sink = createWriteStream(path);
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > MAX_FILE_BYTES) { tooBig = true; throw new Error('too-large'); }
          if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)]);
          yield chunk;
        }
      },
      sink,
    );
  } catch (err) {
    await unlink(path).catch(() => {});
    if (tooBig || err.message === 'too-large') {
      const e = new Error(`Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      e.status = 413;
      throw e;
    }
    throw err;
  }

  if (size === 0) {
    await unlink(path).catch(() => {});
    const e = new Error('The file was empty.');
    e.status = 400;
    throw e;
  }

  // No virus scanner ships with Relay, and pretending otherwise would be worse
  // than saying so. RELAY_SCAN_COMMAND lets a deployment point at one (clamscan,
  // for instance); a non-zero exit rejects the upload.
  if (process.env.RELAY_SCAN_COMMAND) {
    const clean = await scanFile(path);
    if (!clean) {
      await unlink(path).catch(() => {});
      const e = new Error('That file was rejected by the virus scanner.');
      e.status = 422;
      throw e;
    }
  }

  // Encrypted only now: the sniffer and the virus scanner above both have to see
  // the real bytes, and a scanner handed ciphertext would pass everything.
  await sealFileInPlace(path);

  // Trust the sniffed type over the client's claim; fall back to a download.
  let mime;
  if (voice) {
    // A recording that is not a container we can play is not a recording. Better
    // to refuse it than to store something nobody will ever be able to hear.
    const container = sniffAudioContainer(head);
    if (!container) {
      await unlink(path).catch(() => {});
      const e = new Error('That recording was not in a format we can play.');
      e.status = 415;
      throw e;
    }
    mime = container;
  } else {
    const sniffed = sniffMime(head);
    mime = sniffed || (INLINE_TYPES.has(declaredMime) ? null : 'application/octet-stream') || 'application/octet-stream';
  }
  const dims = isInlineImage(mime) ? imageSize(head, mime) : { width: null, height: null };
  // Clamped, not trusted: the figure comes from the recorder in the browser.
  const duration = voice ? Math.min(MAX_VOICE_MS, Math.max(0, Math.round(Number(durationMs) || 0))) : null;

  handle().prepare(
    `INSERT INTO attachments (id, msg_id, convo_id, user_id, name, mime, size, width, height, path, created_at, voice, duration_ms)
     VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, convoId, userId, safeName(name), mime, size, dims.width, dims.height, path, Date.now(),
    voice ? 1 : 0, duration);

  return shape(handle().prepare('SELECT * FROM attachments WHERE id = ?').get(id));
}

/**
 * Hand the stored file to an external scanner, if one is configured.
 * The command receives the path as its only argument; exit code 0 means clean.
 */
async function scanFile(path) {
  const { execFile } = await import('node:child_process');
  const command = process.env.RELAY_SCAN_COMMAND;
  return new Promise((resolve) => {
    execFile(command, [path], { timeout: 30_000 }, (err) => resolve(!err));
  });
}

/** Keep something human-readable, but nothing that can steer a filesystem.
    The stored path never uses this - it is display metadata only. */
export function safeName(name) {
  const base = String(name || 'file').split(/[/\\]/).pop();
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').trim();
  return cleaned.slice(0, 120) || 'file';
}

export function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    isImage: isInlineImage(row.mime),
    isVoice: !!row.voice,
    durationMs: row.duration_ms || null,
    url: `/api/attachments/${row.id}`,
  };
}

export function attach(ids, msgId, convoId, userId) {
  const db = handle();
  const claim = db.prepare(
    `UPDATE attachments SET msg_id = ? WHERE id = ? AND convo_id = ? AND user_id = ? AND msg_id IS NULL`,
  );
  const out = [];
  for (const id of ids.slice(0, MAX_FILES_PER_MESSAGE)) {
    const res = claim.run(msgId, id, convoId, userId);
    if (res.changes) out.push(shape(db.prepare('SELECT * FROM attachments WHERE id = ?').get(id)));
  }
  return out;
}

export function forMessages(msgIds) {
  if (!msgIds.length) return {};
  const marks = msgIds.map(() => '?').join(',');
  const rows = handle().prepare(`SELECT * FROM attachments WHERE msg_id IN (${marks})`).all(...msgIds);
  const out = {};
  for (const r of rows) (out[r.msg_id] ??= []).push(shape(r));
  return out;
}

export function find(id) {
  return handle().prepare('SELECT * FROM attachments WHERE id = ?').get(String(id || '')) || null;
}

/** Uploads that were never attached to a message are dead weight. */
export async function sweepOrphans(olderThanMs = 60 * 60 * 1000) {
  const cutoff = Date.now() - olderThanMs;
  const rows = handle().prepare('SELECT * FROM attachments WHERE msg_id IS NULL AND created_at < ?').all(cutoff);
  for (const row of rows) {
    await unlink(row.path).catch(() => {});
    handle().prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  }
  return rows.length;
}

/** Remove the stored blobs behind a set of messages (used when a message with
    attachments is deleted). */
export async function removeForMessage(msgId) {
  const rows = handle().prepare('SELECT * FROM attachments WHERE msg_id = ?').all(msgId);
  for (const row of rows) await unlink(row.path).catch(() => {});
  handle().prepare('DELETE FROM attachments WHERE msg_id = ?').run(msgId);
}

/* ---------- profile photos ---------- */

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;   // 2 MB after the client's resize

// Narrower than the attachment list on purpose. An avatar is rendered inline
// everywhere, in a hundred places, so the type has to be one a browser will
// only ever paint. No SVG in particular: it is a document that can carry script.
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Store a profile photo, replacing whatever was there.
 *
 * The type is sniffed from the bytes rather than trusted from the request: the
 * whole point of an allow-list is defeated if the client picks which entry it
 * matches. Written to a fresh id each time, so a browser holding the old URL
 * cannot be served the new image with stale dimensions.
 */
export async function storeAvatar(req, { userId }) {
  const dir = join(uploadRoot, 'avatars');
  await mkdir(dir, { recursive: true });
  const id = `a-${randomUUID()}`;
  const path = join(dir, id);

  let size = 0;
  let head = Buffer.alloc(0);
  let tooBig = false;
  const sink = createWriteStream(path);
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > MAX_AVATAR_BYTES) { tooBig = true; break; }
          if (head.length < 4096) head = Buffer.concat([head, chunk]).subarray(0, 4096);
          yield chunk;
        }
      },
      sink,
    );
  } catch (err) {
    await unlink(path).catch(() => {});
    throw err;
  }

  const fail = async (status, message) => {
    await unlink(path).catch(() => {});
    const e = new Error(message);
    e.status = status;
    throw e;
  };

  if (tooBig) await fail(413, 'That image is larger than 2 MB, even after resizing.');
  if (!size) await fail(400, 'No image was received.');

  const mime = sniffMime(head);
  if (!mime || !AVATAR_TYPES.has(mime)) {
    await fail(415, 'Profile photos must be a PNG, JPEG or WebP image.');
  }
  if (process.env.RELAY_SCAN_COMMAND && !(await scanFile(path))) {
    await fail(422, 'That file was rejected by the virus scanner.');
  }

  await sealFileInPlace(path);

  const previous = handle().prepare('SELECT avatar_path FROM users WHERE id = ?').get(userId)?.avatar_path;
  handle().prepare(
    'UPDATE users SET avatar_path = ?, avatar_mime = ?, avatar_updated_at = ? WHERE id = ?',
  ).run(path, mime, Date.now(), userId);

  // Only after the row points at the new file, so a crash in between leaves an
  // orphan rather than a profile pointing at nothing.
  if (previous && previous !== path) await unlink(previous).catch(() => {});
  return { mime, size };
}

export async function removeAvatar(userId) {
  const row = handle().prepare('SELECT avatar_path FROM users WHERE id = ?').get(userId);
  handle().prepare(
    'UPDATE users SET avatar_path = NULL, avatar_mime = NULL, avatar_updated_at = ? WHERE id = ?',
  ).run(Date.now(), userId);
  if (row?.avatar_path) await unlink(row.avatar_path).catch(() => {});
}

export function findAvatar(userId) {
  const row = handle().prepare(
    'SELECT avatar_path, avatar_mime, avatar_updated_at FROM users WHERE id = ?',
  ).get(userId);
  if (!row?.avatar_path) return null;
  return { path: row.avatar_path, mime: row.avatar_mime, updatedAt: row.avatar_updated_at };
}


/* ---------- encrypting what is on disk ---------- */

/**
 * Rewrite a stored file encrypted, if a key is configured.
 *
 * A no-op otherwise, so an existing deployment keeps plain files and nothing
 * about its behaviour changes. Called after validation on purpose: the type
 * sniffer and the virus scanner both have to see the real bytes, and a scanner
 * handed ciphertext would wave everything through.
 */
export async function sealFileInPlace(path) {
  if (!crypt.isEnabled()) return false;
  const plain = await readFile(path);
  if (crypt.isSealedFile(plain)) return false;
  await writeFile(path, crypt.sealBytes(plain));
  return true;
}

/**
 * Hand back a stored file for serving, decrypting it if it needs it.
 *
 * Returns either a stream (for a plain file — no reason to buffer megabytes that
 * need nothing done to them) or a Buffer (for an encrypted one, so GCM's tag is
 * checked before a byte reaches the client). Both forms coexist, so a database
 * part-way through the migration serves either.
 */
export async function openForServe(path) {
  if (!crypt.isEnabled()) return { stream: createReadStream(path) };

  // One small read to decide, rather than buffering every file on the chance it
  // might be encrypted.
  const fh = await openFile(path, 'r');
  try {
    const head = Buffer.alloc(crypt.FILE_HEADER_BYTES);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    if (!crypt.isSealedFile(head.subarray(0, bytesRead))) {
      return { stream: createReadStream(path) };
    }
  } finally {
    await fh.close();
  }
  return { buffer: crypt.openBytes(await readFile(path)) };
}
