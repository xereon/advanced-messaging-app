// mailer.js — a small SMTP client (node:net / node:tls, no dependencies).
//
// Supports STARTTLS and implicit TLS, AUTH PLAIN and AUTH LOGIN. When no host
// is configured the transport reports itself as unavailable and the caller
// falls back to showing the code on screen, so a fresh checkout still works.

import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomUUID } from 'node:crypto';

const CONFIG = () => ({
  host: process.env.RELAY_SMTP_HOST || '',
  port: Number(process.env.RELAY_SMTP_PORT || 587),
  user: process.env.RELAY_SMTP_USER || '',
  pass: process.env.RELAY_SMTP_PASS || '',
  from: process.env.RELAY_SMTP_FROM || 'Relay <no-reply@localhost>',
  secure: process.env.RELAY_SMTP_SECURE === '1',       // implicit TLS (usually 465)
  allowInsecure: process.env.RELAY_SMTP_INSECURE === '1',
  timeoutMs: Number(process.env.RELAY_SMTP_TIMEOUT || 15000),
});

export function isConfigured() { return !!CONFIG().host; }

export function transportName() {
  const c = CONFIG();
  return c.host ? `${c.host}:${c.port}` : 'none';
}

/* ---------- protocol plumbing ---------- */

class SmtpSession {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.buffer = '';
    this.pending = null;
    this.socket.setEncoding('utf8');
    this.socket.setTimeout(timeoutMs);
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('timeout', () => this.fail(new Error('SMTP timed out.')));
    this.socket.on('error', (err) => this.fail(err));
    this.socket.on('close', () => this.fail(new Error('SMTP connection closed early.')));
  }

  onData(chunk) {
    this.buffer += chunk;
    if (!this.pending) return;

    // A reply is one or more lines. Continuations are "NNN-text"; the final
    // line is "NNN text". Anything less means the reply is still arriving.
    const lines = this.buffer.split('\r\n');
    const complete = lines.filter((l) => l.length >= 4);
    const last = complete[complete.length - 1];
    if (!last || last[3] !== ' ') return;

    const code = Number(last.slice(0, 3));
    const text = this.buffer.trim();
    this.buffer = '';
    const { resolve, reject, expect } = this.pending;
    this.pending = null;
    if (expect && !expect.includes(code)) {
      reject(new Error(`SMTP refused the command — ${code}: ${text}`));
      return;
    }
    resolve({ code, text });
  }

  fail(err) {
    const p = this.pending;
    this.pending = null;
    if (p) p.reject(err);
  }

  read(expect) {
    return new Promise((resolve, reject) => { this.pending = { resolve, reject, expect }; });
  }

  send(line, expect) {
    const p = this.read(expect);
    this.socket.write(line + '\r\n');
    return p;
  }

  upgrade(host) {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('error');
      plain.removeAllListeners('close');
      plain.removeAllListeners('timeout');
      const secure = tlsConnect({ socket: plain, servername: host }, () => resolve(secure));
      secure.once('error', reject);
    });
  }
}

function dial({ host, port, secure, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tlsConnect({ host, port, servername: host }, () => resolve(socket))
      : createConnection({ host, port }, () => resolve(socket));
    socket.setTimeout(timeoutMs);
    socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject(new Error('SMTP connection timed out.')); });
  });
}

/* ---------- message building ---------- */

const encodeHeader = (value) => (
  // Non-ASCII header text must be encoded; RFC 2047 base64 is the simple route.
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
);

function buildMessage({ from, to, subject, text, html }) {
  const boundary = `relay-${randomUUID()}`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <${randomUUID()}@relay>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
    '',
  ];
  return [...headers, '', ...body].join('\r\n');
}

/** Lines beginning with a period must be escaped inside DATA. */
const dotStuff = (msg) => msg.replace(/\r\n\./g, '\r\n..');

/* ---------- public API ---------- */

export async function send({ to, subject, text, html }) {
  const cfg = CONFIG();
  if (!cfg.host) throw new Error('No SMTP transport is configured.');

  const socket = await dial(cfg);
  let session = new SmtpSession(socket, cfg.timeoutMs);
  try {
    await session.read([220]);
    let greeting = await session.send(`EHLO ${cfg.host}`, [250]);

    if (!cfg.secure) {
      if (/STARTTLS/i.test(greeting.text)) {
        await session.send('STARTTLS', [220]);
        const secureSocket = await session.upgrade(cfg.host);
        session = new SmtpSession(secureSocket, cfg.timeoutMs);
        greeting = await session.send(`EHLO ${cfg.host}`, [250]);
      } else if (cfg.user && !cfg.allowInsecure) {
        // Refuse to hand credentials to a server that will not encrypt.
        throw new Error('SMTP server does not offer STARTTLS; set RELAY_SMTP_INSECURE=1 to allow this.');
      }
    }

    if (cfg.user) {
      if (/AUTH[ =-][^\n]*PLAIN/i.test(greeting.text)) {
        const token = Buffer.from(`\0${cfg.user}\0${cfg.pass}`, 'utf8').toString('base64');
        await session.send(`AUTH PLAIN ${token}`, [235]);
      } else {
        await session.send('AUTH LOGIN', [334]);
        await session.send(Buffer.from(cfg.user, 'utf8').toString('base64'), [334]);
        await session.send(Buffer.from(cfg.pass, 'utf8').toString('base64'), [235]);
      }
    }

    const envelopeFrom = /<([^>]+)>/.exec(cfg.from)?.[1] || cfg.from;
    await session.send(`MAIL FROM:<${envelopeFrom}>`, [250]);
    await session.send(`RCPT TO:<${to}>`, [250, 251]);
    await session.send('DATA', [354]);
    const message = buildMessage({ from: cfg.from, to, subject, text, html });
    await session.send(`${dotStuff(message)}\r\n.`, [250]);
    await session.send('QUIT', [221]).catch(() => { /* some servers just close */ });
    return { delivered: true, transport: transportName() };
  } finally {
    session.socket.destroy();
  }
}

/* ---------- the one message Relay sends ---------- */

export function resetCodeEmail(name, code) {
  const safeName = String(name || 'there').replace(/[<>&]/g, '');
  return {
    subject: `${code} is your Relay password reset code`,
    text: [
      `Hello ${safeName},`, '',
      `Your Relay password reset code is ${code}`, '',
      'It expires in 10 minutes and can only be used once.',
      'If you did not ask to reset your password, ignore this message —',
      'your password has not changed.',
    ].join('\n'),
    html: [
      '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:32rem">',
      `<p>Hello ${safeName},</p>`,
      '<p>Your Relay password reset code is:</p>',
      `<p style="font-size:1.75rem;font-weight:700;letter-spacing:0.2em;margin:1.25rem 0">${code}</p>`,
      '<p>It expires in 10 minutes and can only be used once.</p>',
      '<p style="color:#4c5a72;font-size:0.875rem">If you did not ask for this, ignore the message — your password has not changed.</p>',
      '</div>',
    ].join(''),
  };
}

export function loginCodeEmail(name, code) {
  const safeName = String(name || 'there').replace(/[<>&]/g, '');
  return {
    subject: `${code} is your Relay sign-in code`,
    text: [
      `Hello ${safeName},`,
      '',
      `Your Relay sign-in code is ${code}`,
      '',
      'It expires in 10 minutes and can only be used once.',
      'If you did not try to sign in, you can ignore this message.',
    ].join('\n'),
    html: [
      '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:32rem">',
      `<p>Hello ${safeName},</p>`,
      '<p>Your Relay sign-in code is:</p>',
      `<p style="font-size:1.75rem;font-weight:700;letter-spacing:0.2em;margin:1.25rem 0">${code}</p>`,
      '<p>It expires in 10 minutes and can only be used once.</p>',
      '<p style="color:#4c5a72;font-size:0.875rem">If you did not try to sign in, you can ignore this message.</p>',
      '</div>',
    ].join(''),
  };
}
