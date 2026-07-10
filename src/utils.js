import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

export const DATA_DIR = path.join(process.cwd(), 'data');
export const TMP_DIR = path.join(process.cwd(), 'tmp');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

export function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function runtime(seconds = process.uptime()) {
  seconds = Math.floor(seconds);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

export function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function systemInfo() {
  const mem = process.memoryUsage();
  return {
    platform: `${os.platform()} ${os.arch()}`,
    node: process.version,
    uptime: runtime(),
    memory: `${bytes(mem.rss)} RSS / ${bytes(os.totalmem())} total`,
    cpu: os.cpus()?.[0]?.model || 'unknown'
  };
}

export function normalizeNumber(jid = '') {
  return String(jid).replace(/[^0-9]/g, '');
}

export function extractText(message) {
  const m = message?.message || {};
  return m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    '';
}

export function unwrapMessage(message) {
  if (!message?.message) return message;
  let m = message.message;
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  return { ...message, message: m };
}

export function quotedParticipant(message) {
  return message.message?.extendedTextMessage?.contextInfo?.participant || null;
}

export function mentionedJids(message) {
  return message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

export function pickTarget(message, sender) {
  return mentionedJids(message)[0] || quotedParticipant(message) || sender;
}

export function hashPercent(input, max = 100) {
  const h = crypto.createHash('md5').update(String(input)).digest();
  return h[0] % (max + 1);
}

export function safeEvalMath(expression) {
  const cleaned = expression.replace(/×/g, '*').replace(/÷/g, '/');
  if (!/^[0-9+\-*/().%\s]+$/.test(cleaned)) throw new Error('Only numbers and + - * / % ( ) are allowed.');
  // eslint-disable-next-line no-new-func
  const result = Function(`"use strict"; return (${cleaned});`)();
  if (!Number.isFinite(result)) throw new Error('Result is not finite.');
  return result;
}

export function toFancy(text, type = 'bold') {
  const maps = {
    bold: ['𝗮','𝗯','𝗰','𝗱','𝗲','𝗳','𝗴','𝗵','𝗶','𝗷','𝗸','𝗹','𝗺','𝗻','𝗼','𝗽','𝗾','𝗿','𝘀','𝘁','𝘂','𝘃','𝘄','𝘅','𝘆','𝘇'],
    italic: ['𝘢','𝘣','𝘤','𝘥','𝘦','𝘧','𝘨','𝘩','𝘪','𝘫','𝘬','𝘭','𝘮','𝘯','𝘰','𝘱','𝘲','𝘳','𝘴','𝘵','𝘶','𝘷','𝘸','𝘹','𝘺','𝘻'],
    mono: ['𝚊','𝚋','𝚌','𝚍','𝚎','𝚏','𝚐','𝚑','𝚒','𝚓','𝚔','𝚕','𝚖','𝚗','𝚘','𝚙','𝚚','𝚛','𝚜','𝚝','𝚞','𝚟','𝚠','𝚡','𝚢','𝚣'],
    double: ['𝕒','𝕓','𝕔','𝕕','𝕖','𝕗','𝕘','𝕙','𝕚','𝕛','𝕜','𝕝','𝕞','𝕟','𝕠','𝕡','𝕢','𝕣','𝕤','𝕥','𝕦','𝕧','𝕨','𝕩','𝕪','𝕫'],
    circle: ['ⓐ','ⓑ','ⓒ','ⓓ','ⓔ','ⓕ','ⓖ','ⓗ','ⓘ','ⓙ','ⓚ','ⓛ','ⓜ','ⓝ','ⓞ','ⓟ','ⓠ','ⓡ','ⓢ','ⓣ','ⓤ','ⓥ','ⓦ','ⓧ','ⓨ','ⓩ']
  };
  const map = maps[type] || maps.bold;
  return String(text).split('').map(ch => {
    const lower = ch.toLowerCase();
    const idx = lower.charCodeAt(0) - 97;
    if (idx >= 0 && idx < 26) return map[idx];
    return ch;
  }).join('');
}

export function randomChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export async function isAdmin(sock, chatId, jid) {
  try {
    const meta = await sock.groupMetadata(chatId);
    // Strip "@domain" and ":device" suffix
    const strip = (s = '') => String(s).split('@')[0].split(':')[0];
    const target = strip(jid);
    const p = meta.participants.find(x =>
      (x.id || x.jid) === jid ||
      (x.lid || '')   === jid ||
      strip(x.id || x.jid || '') === target ||
      strip(x.lid || '')         === target
    );
    return Boolean(p?.admin || p?.isAdmin);
  } catch { return false; }
}

export async function groupAdmins(sock, chatId) {
  const meta = await sock.groupMetadata(chatId);
  return meta.participants
    .filter(p => p.admin || p.isAdmin)
    .map(p => p.id || p.jid || p.lid)
    .filter(Boolean);
}
