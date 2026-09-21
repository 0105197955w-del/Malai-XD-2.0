import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import pino from 'pino';
import axios from 'axios';
import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import { buildCommands } from './commands.js';
import { unwrapMessage, extractText, normalizeNumber, isAdmin, mentionedJids, quotedParticipant, runtime } from './utils.js';
import { browserConfig, cleanPhoneNumber, createPairingManager, loginMethod, pairInstructions, promptForPairingNumber, validatePairingNumber } from './pairing.js';
import { BOT_NAME, OWNER_NUMBER, commandReaction, formatAutoBio, getDateTimeParts, isToggleEnabled, statusReaction } from './settings.js';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage
} = await import('@whiskeysockets/baileys');

// libsignal dumps full session state via console.info; hide only that noise (errors stay visible).
const _origInfo = console.info;
console.info = (...a) => {
  if (typeof a[0] === 'string' && /^(Closing session|Removing old closed session)/.test(a[0])) return;
  _origInfo(...a);
};

process.on('uncaughtException', (err) => console.error('Uncaught exception:', err?.message || err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message || err));

const { commands, registry, getConfig, getState, saveState } = buildCommands();

// ─── ADDED COMMANDS: kickall, promoteall, demoteall, clear, getpp ────────────
function addCmd(cmd) {
  cmd.aliases = cmd.aliases || [];
  cmd.category = cmd.category || 'group';
  cmd.desc = cmd.desc || 'No description';
  cmd.usage = cmd.usage || '';
  for (let i = commands.length - 1; i >= 0; i--) if (commands[i].name === cmd.name) commands.splice(i, 1);
  commands.push(cmd);
  registry.set(cmd.name, cmd);
  for (const alias of cmd.aliases) registry.set(alias, cmd);
}

const bareJid = (j) => String(j || '').split('@')[0].split(':')[0];
const idsOfP = (p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean);
const nameCache = new Map();      // number/LID -> WhatsApp (push) name
const usernameCache = new Map();  // number/LID -> WhatsApp username, when exposed
const rememberName = (jid, name) => { if (jid && name) nameCache.set(bareJid(jid), name); };

async function groupContext(sock, chatId, sender) {
  const meta = await sock.groupMetadata(chatId);
  const botBare = [sock.user?.id, sock.user?.lid].filter(Boolean).map(bareJid);
  const isBot = (p) => idsOfP(p).some(j => botBare.includes(bareJid(j)));
  const isOwner = (p) => idsOfP(p).some(j => isOwnerJid(j) || bareJid(j) === bareJid(sender));
  return { meta, isBot, isOwner, botP: meta.participants.find(isBot) };
}

async function bulkUpdate(sock, chatId, ids, action) {
  let ok = 0, fail = 0;
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    try {
      const res = await sock.groupParticipantsUpdate(chatId, chunk, action);
      if (Array.isArray(res)) for (const r of res) (String(r.status) === '200' ? ok++ : fail++);
      else ok += chunk.length;
    } catch (err) {
      fail += chunk.length;
      console.error(`${action} chunk failed:`, err?.message || err);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return { ok, fail };
}

addCmd({
  name: 'kickall', category: 'group', ownerOnly: true, groupOnly: true,
  desc: 'Remove all members except the owner and the bot',
  handler: async ({ sock, chatId, sender, message }) => {
    const { meta, isBot, isOwner, botP } = await groupContext(sock, chatId, sender);
    if (!botP?.admin) return void await sock.sendMessage(chatId, { text: 'I need to be a group admin to remove members.' }, { quoted: message });
    const targets = meta.participants.filter(p => !isBot(p) && !isOwner(p)).map(p => p.id);
    if (!targets.length) return void await sock.sendMessage(chatId, { text: 'No members to remove.' }, { quoted: message });
    const { ok, fail } = await bulkUpdate(sock, chatId, targets, 'remove');
    await sock.sendMessage(chatId, { text: `Kickall done. Removed: ${ok}${fail ? ` | Failed: ${fail} (group creator/super admins can't be removed)` : ''}` });
  }
});

addCmd({
  name: 'promoteall', category: 'group', ownerOnly: true, groupOnly: true,
  desc: 'Make every member a group admin',
  handler: async ({ sock, chatId, sender, message }) => {
    const { meta, botP } = await groupContext(sock, chatId, sender);
    if (!botP?.admin) return void await sock.sendMessage(chatId, { text: 'I need to be a group admin to promote members.' }, { quoted: message });
    const targets = meta.participants.filter(p => !p.admin).map(p => p.id);
    if (!targets.length) return void await sock.sendMessage(chatId, { text: 'Everyone is already an admin.' }, { quoted: message });
    const { ok, fail } = await bulkUpdate(sock, chatId, targets, 'promote');
    await sock.sendMessage(chatId, { text: `Promoteall done. Promoted: ${ok}${fail ? ` | Failed: ${fail}` : ''}` });
  }
});

addCmd({
  name: 'demoteall', category: 'group', ownerOnly: true, groupOnly: true,
  desc: 'Remove admin rights from every admin except the owner and the bot',
  handler: async ({ sock, chatId, sender, message }) => {
    const { meta, isBot, isOwner, botP } = await groupContext(sock, chatId, sender);
    if (!botP?.admin) return void await sock.sendMessage(chatId, { text: 'I need to be a group admin to demote members.' }, { quoted: message });
    const targets = meta.participants.filter(p => p.admin === 'admin' && !isBot(p) && !isOwner(p)).map(p => p.id);
    if (!targets.length) return void await sock.sendMessage(chatId, { text: 'No admins to demote.' }, { quoted: message });
    const { ok, fail } = await bulkUpdate(sock, chatId, targets, 'demote');
    await sock.sendMessage(chatId, { text: `Demoteall done. Demoted: ${ok}${fail ? ` | Failed: ${fail} (group creator can't be demoted)` : ''}` });
  }
});

addCmd({
  name: 'clear', aliases: ['clr'], category: 'owner', ownerOnly: true,
  desc: 'Clear all messages in this chat (group or DM)',
  handler: async ({ sock, chatId, message }) => {
    await sock.chatModify({
      clear: true,
      lastMessages: [{ key: message.key, messageTimestamp: message.messageTimestamp }]
    }, chatId);
  }
});

const COUNTRY_CODES = Object.fromEntries(('1 USA/Canada;7 Russia/Kazakhstan;20 Egypt;27 South Africa;30 Greece;31 Netherlands;32 Belgium;33 France;34 Spain;36 Hungary;39 Italy;40 Romania;41 Switzerland;43 Austria;44 United Kingdom;45 Denmark;46 Sweden;47 Norway;48 Poland;49 Germany;51 Peru;52 Mexico;53 Cuba;54 Argentina;55 Brazil;56 Chile;57 Colombia;58 Venezuela;60 Malaysia;61 Australia;62 Indonesia;63 Philippines;64 New Zealand;65 Singapore;66 Thailand;81 Japan;82 South Korea;84 Vietnam;86 China;90 Turkey;91 India;92 Pakistan;93 Afghanistan;94 Sri Lanka;95 Myanmar;98 Iran;211 South Sudan;212 Morocco;213 Algeria;216 Tunisia;218 Libya;220 Gambia;221 Senegal;222 Mauritania;223 Mali;224 Guinea;225 Ivory Coast;226 Burkina Faso;227 Niger;228 Togo;229 Benin;230 Mauritius;231 Liberia;232 Sierra Leone;233 Ghana;234 Nigeria;235 Chad;236 Central African Republic;237 Cameroon;238 Cape Verde;240 Equatorial Guinea;241 Gabon;242 Congo;243 DR Congo;244 Angola;245 Guinea-Bissau;248 Seychelles;249 Sudan;250 Rwanda;251 Ethiopia;252 Somalia;253 Djibouti;254 Kenya;255 Tanzania;256 Uganda;257 Burundi;258 Mozambique;260 Zambia;261 Madagascar;262 Reunion;263 Zimbabwe;264 Namibia;265 Malawi;266 Lesotho;267 Botswana;268 Eswatini;269 Comoros;351 Portugal;352 Luxembourg;353 Ireland;354 Iceland;355 Albania;356 Malta;357 Cyprus;358 Finland;359 Bulgaria;370 Lithuania;371 Latvia;372 Estonia;380 Ukraine;381 Serbia;385 Croatia;386 Slovenia;420 Czechia;421 Slovakia;502 Guatemala;503 El Salvador;504 Honduras;505 Nicaragua;506 Costa Rica;507 Panama;591 Bolivia;592 Guyana;593 Ecuador;595 Paraguay;598 Uruguay;880 Bangladesh;886 Taiwan;960 Maldives;961 Lebanon;962 Jordan;963 Syria;964 Iraq;965 Kuwait;966 Saudi Arabia;967 Yemen;968 Oman;971 United Arab Emirates;972 Israel;973 Bahrain;974 Qatar;975 Bhutan;976 Mongolia;977 Nepal;992 Tajikistan;993 Turkmenistan;994 Azerbaijan;995 Georgia;996 Kyrgyzstan;998 Uzbekistan')
  .split(';').map(x => { const i = x.indexOf(' '); return [x.slice(0, i), x.slice(i + 1)]; }));

function countryFromNumber(num) {
  const n = String(num || '').replace(/\D/g, '');
  for (const len of [3, 2, 1]) if (COUNTRY_CODES[n.slice(0, len)]) return COUNTRY_CODES[n.slice(0, len)];
  return null;
}

async function resolvePn(sock, jid) {
  if (!jid) return null;
  if (!jid.endsWith('@lid')) return bareJid(jid);
  const hit = lidToPn.get(jid);
  if (hit) return bareJid(hit);
  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
    if (pn) return bareJid(pn);
  } catch {}
  return null;
}

addCmd({
  name: 'getpp', aliases: ['dp', 'profile', 'whois', 'userinfo', 'about'], category: 'utility',
  desc: 'Get a user\'s profile picture, name, country and about',
  usage: 'reply to a message | @user | +254700000000',
  handler: async ({ sock, chatId, sender, message, args, isGroup, mentions }) => {
    const ci = Object.values(message.message || {}).map(v => v?.contextInfo).find(Boolean);
    let target = ci?.participant || mentions?.[0];
    if (!target && args[0]) {
      const d = args[0].replace(/\D/g, '');
      if (d.length >= 9) target = `${d}@s.whatsapp.net`;
    }
    if (!target) target = isGroup ? sender : chatId;

    const pn = await resolvePn(sock, target);
    const jids = [target, pn && `${pn}@s.whatsapp.net`].filter((j, i, a) => j && a.indexOf(j) === i);
    const keys = [bareJid(target), pn].filter(Boolean);
    const waName = keys.map(k => nameCache.get(k)).find(Boolean);
    const username = keys.map(k => usernameCache.get(k)).find(Boolean);

    let ppUrl = null;
    for (const j of jids) { try { ppUrl = await sock.profilePictureUrl(j, 'image'); if (ppUrl) break; } catch {} }

    let about = null;
    for (const j of jids) {
      try {
        const r = await sock.fetchStatus(j);
        const st = Array.isArray(r) ? r[0]?.status : r?.status;
        about = typeof st === 'string' ? st : st?.status;
        if (about) break;
      } catch {}
    }

    const country = pn ? (countryFromNumber(pn) || 'Unknown') : 'Unknown (number hidden by WhatsApp)';
    const card = `╭━━━━━━━━━━━━━━━━━━╮
┃ 👤 *PROFILE*
┃ 🏷️ Name: ${waName || 'Not available'}${username ? `\n┃ 🔗 Username: @${username}` : ''}
┃ 📱 Number: ${pn ? `+${pn}` : 'Hidden'}
┃ 🌍 Country: ${country}
┃ 📝 About: ${about || 'Hidden or not set'}
╰━━━━━━━━━━━━━━━━━━╯`;

    if (ppUrl) await sock.sendMessage(chatId, { image: { url: ppUrl }, caption: card, mentions: [target] }, { quoted: message });
    else await sock.sendMessage(chatId, { text: `${card}\n\n🖼️ _No profile picture (hidden or not set)_`, mentions: [target] }, { quoted: message });
  }
});
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const sessionDir = process.env.SESSION_DIR || './session';
fs.mkdirSync(sessionDir, { recursive: true });

// ─── Message store for antidelete ─────────────────────────────────────────────
const messageStore = new Map();
const ANTIDELETE_TMP_DIR = path.join(process.cwd(), 'data', 'antidelete_tmp');
fs.mkdirSync(ANTIDELETE_TMP_DIR, { recursive: true });

// Periodic cleanup of antidelete tmp dir (>200MB or files >1hr)
setInterval(() => {
  try {
    const files = fs.readdirSync(ANTIDELETE_TMP_DIR);
    let total = 0;
    for (const f of files) {
      try { total += fs.statSync(path.join(ANTIDELETE_TMP_DIR, f)).size; } catch {}
    }
    if (total > 200 * 1024 * 1024) {
      for (const f of files) {
        try { fs.unlinkSync(path.join(ANTIDELETE_TMP_DIR, f)); } catch {}
      }
    }
  } catch {}
}, 60 * 1000);

const rawStore = new Map(); // raw messages for Baileys getMessage (retry/decrypt recovery)
let activePairingManager = null;
let flushCreds = async () => {};
let reconnectTimer = null;
const pendingGreetTimers = new Map();
let statusReactionCount = 0;
let lastConnectedNoticeAt = 0;
let autoBioTimer = null;
let lastAutoBioText = '';
const presenceTimers = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
}

function startWeb() {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (url.pathname === '/code' || url.pathname === '/pair') {
      if (String(process.env.PAIRING_WEB_ENABLED || 'true').toLowerCase() === 'false') {
        sendJson(res, 403, { ok: false, error: 'Web pairing is disabled by PAIRING_WEB_ENABLED=false.' });
        return;
      }
      try {
        const requiredToken = process.env.PAIRING_AUTH_TOKEN || '';
        const suppliedToken = url.searchParams.get('token') || req.headers['x-pairing-token'] || '';
        if (requiredToken && suppliedToken !== requiredToken) {
          sendJson(res, 401, { ok: false, error: 'Missing or invalid pairing token.' });
          return;
        }
        const number = validatePairingNumber(url.searchParams.get('number') || url.searchParams.get('phone') || '');
        if (!activePairingManager) throw new Error('Pairing manager is not ready yet. Start the bot and try again.');
        const result = await activePairingManager.requestPairing(number, 'web');
        sendJson(res, 200, {
          ok: true,
          number: result.number,
          code: result.code,
          instructions: pairInstructions(result.code)
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message || String(err) });
      }
      return;
    }

    sendJson(res, 200, {
      ok: true,
      bot: getConfig().botName,
      commands: commands.length,
      uptime: process.uptime(),
      pairing: {
        loginMethod: loginMethod(),
        endpoint: '/code?number=254105197055',
        webEnabled: String(process.env.PAIRING_WEB_ENABLED || 'true').toLowerCase() !== 'false'
      }
    });
  });
  server.listen(port, () => console.log(`Health and pairing server running on port ${port}`));
}

// WhatsApp now addresses many users by LID (e.g. 1014...@lid) instead of phone number.
// Learn LID -> phone-number mappings from incoming keys so owner checks still work.
const lidToPn = new Map();
function learnLidMapping(msg) {
  const k = msg?.key || {};
  const pairs = [
    [k.remoteJid, k.senderPn || k.remoteJidAlt],
    [k.participant, k.participantPn || k.participantAlt]
  ];
  for (const [a, b] of pairs) {
    if (!a || !b) continue;
    if (a.endsWith('@lid') && b.endsWith('@s.whatsapp.net')) lidToPn.set(a, b);
    else if (b.endsWith('@lid') && a.endsWith('@s.whatsapp.net')) lidToPn.set(b, a);
  }
}

function isOwnerJid(jid) {
  const cfg = getConfig();
  const owner = normalizeNumber(cfg.ownerNumber);
  if (!owner || !jid) return false;
  const sender = normalizeNumber(lidToPn.get(jid) || jid);
  if (sender === owner) return true;
  const list = (name) => (process.env[name] || '').split(',').map(normalizeNumber).filter(Boolean);
  if (list('OWNER_LID').includes(normalizeNumber(jid))) return true; // set OWNER_LID=your LID number
  return list('SUDO_USERS').includes(sender);
}

function chatIsPrivate(chatId = '') {
  return chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@lid');
}

async function safeReact(sock, message, emoji) {
  if (!emoji || !message?.key) return;
  try {
    await sock.sendMessage(message.key.remoteJid, { react: { text: emoji, key: message.key } });
  } catch (err) {
    console.warn(`Reaction failed: ${err.message || err}`);
  }
}

async function reactToCommand(sock, message, commandName) {
  const state = getState();
  if (!isToggleEnabled(state, 'commandreact')) return;
  await safeReact(sock, message, commandReaction(commandName));
}

async function handleStatusMessage(sock, rawMessage) {
  const message = unwrapMessage(rawMessage);
  if (message?.key?.remoteJid !== 'status@broadcast' || message.key?.fromMe) return;
  const state = getState();
  if (!isToggleEnabled(state, 'autostatus')) return;
  const participant = message.key.participant;
  const emoji = statusReaction(`${message.key.id || ''}:${participant || ''}:${statusReactionCount++}`);
  try {
    await sock.sendMessage('status@broadcast', {
      react: { text: emoji, key: message.key }
    }, participant ? { statusJidList: [participant] } : undefined);
  } catch (err) {
    console.warn(`Status reaction failed: ${err.message || err}`);
  }
}

async function sendAutoPresence(sock, chatId, state = getState()) {
  if (!chatId || chatId === 'status@broadcast') return;
  const record = isToggleEnabled(state, 'autorecord');
  const typing = isToggleEnabled(state, 'autotyping');
  if (!record && !typing) return;

  const presenceType = record ? 'recording' : 'composing';
  const durationMs = Math.max(2000, Number(process.env.AUTO_PRESENCE_DURATION_MS || 12000));

  try {
    if (typeof sock.presenceSubscribe === 'function') await sock.presenceSubscribe(chatId).catch(() => {});
    await sock.sendPresenceUpdate(presenceType, chatId);
  } catch (err) {
    console.warn(`Auto presence failed: ${err.message || err}`);
    return;
  }

  const oldTimer = presenceTimers.get(chatId);
  if (oldTimer) clearTimeout(oldTimer);
  presenceTimers.set(chatId, setTimeout(async () => {
    presenceTimers.delete(chatId);
    try {
      await sock.sendPresenceUpdate('paused', chatId);
    } catch {}
  }, durationMs));
}

function cancelPrivateGreet(chatId) {
  const timer = pendingGreetTimers.get(chatId);
  if (timer) clearTimeout(timer);
  pendingGreetTimers.delete(chatId);
}

function schedulePrivateGreet(sock, message, chatId, sender, fromMe) {
  const state = getState();
  if (!isToggleEnabled(state, 'greet')) return;
  if (!chatIsPrivate(chatId) || chatId === 'status@broadcast') return;

  if (fromMe || isOwnerJid(sender)) {
    cancelPrivateGreet(chatId);
    return;
  }

  cancelPrivateGreet(chatId);
  const delayMs = Math.max(1000, Number(process.env.GREET_DELAY_MS || 20 * 60 * 1000));
  const cfg = getConfig();
  const timer = setTimeout(async () => {
    pendingGreetTimers.delete(chatId);
    try {
      await sock.sendMessage(chatId, {
        text: `👋 Hello, this is ${cfg.botName}.\n\nThe owner has not replied for about 20 minutes. Please leave your message and they will get back to you soon.\n\nOwner contact: +${normalizeNumber(cfg.ownerNumber || OWNER_NUMBER)}`
      }, { quoted: message });
    } catch (err) {
      console.warn(`Private greet failed: ${err.message || err}`);
    }
  }, delayMs);
  pendingGreetTimers.set(chatId, timer);
}

async function sendConnectedNotice(sock) {
  if (String(process.env.CONNECT_NOTIFY || 'true').toLowerCase() === 'false') return;
  const now = Date.now();
  if (now - lastConnectedNoticeAt < 120000) return;
  lastConnectedNoticeAt = now;

  const cfg = getConfig();
  const ownerNumber = normalizeNumber(cfg.ownerNumber || OWNER_NUMBER);
  if (!ownerNumber) return; // No owner configured, skip

  const ownerJid = `${ownerNumber}@s.whatsapp.net`;
  const { date, time } = getDateTimeParts();
  const text = `*『 CONNECTION ESTABLISHED 』*\n🤖 *Bot:* ${cfg.botName || BOT_NAME}\n⚡ *Status:* Online\n⏱️ *Runtime:* ${runtime()}\n👑 *Owner:* +${ownerNumber}\n📅 *Date:* ${date}, ${time}`;
  try {
    await sock.sendMessage(ownerJid, { text });
  } catch (err) {
    console.warn(`Connected notice failed for owner ${ownerJid}: ${err.message || err}`);
  }
}

async function updateAutoBio(sock, force = false) {
  const state = getState();
  if (!isToggleEnabled(state, 'autobio')) return;
  const cfg = getConfig();
  const bio = formatAutoBio(cfg.botName || BOT_NAME, cfg.timeZone);
  if (!force && bio === lastAutoBioText) return;
  if (typeof sock.updateProfileStatus !== 'function') {
    console.warn('Autobio is enabled, but updateProfileStatus is not available on this Baileys socket.');
    return;
  }
  try {
    await sock.updateProfileStatus(bio);
    lastAutoBioText = bio;
    console.log(`Autobio updated: ${bio}`);
  } catch (err) {
    console.warn(`Autobio update failed: ${err.message || err}`);
  }
}

function startAutoBio(sock) {
  if (autoBioTimer) clearInterval(autoBioTimer);
  const intervalMs = Math.max(60000, Number(process.env.AUTOBIO_INTERVAL_MS || 60 * 1000));
  updateAutoBio(sock, true).catch(err => console.warn(`Autobio startup failed: ${err.message || err}`));
  autoBioTimer = setInterval(() => {
    updateAutoBio(sock).catch(err => console.warn(`Autobio timer failed: ${err.message || err}`));
  }, intervalMs);
}

async function sendError(sock, chatId, message, err) {
  console.error('Command error:', err);
  await sock.sendMessage(chatId, { text: `Command failed: ${err.message || err}` }, { quoted: message }).catch(() => {});
}

// ─── ANTILINK: Detect and handle links (delete or kick mode) ─────────────────
async function handleLinkDetection(sock, message, chatId, sender, text, state) {
  if (!chatId.endsWith('@g.us')) return;
  if (isOwnerJid(sender)) return;

  // Read per-group config first, fall back to global toggle
  const grpCfg = state.groupSettings?.[chatId]?.antilink;
  const globalOn = isToggleEnabled(state, 'antilink');
  const antilinkEnabled = grpCfg?.enabled ?? globalOn;
  if (!antilinkEnabled) return;

  const antilinkAction = grpCfg?.action || 'delete'; // 'delete' or 'kick'

  // Admins are exempt
  try {
    const adminCheck = await isAdmin(sock, chatId, sender);
    if (adminCheck) return;
  } catch {}

  const linkPatterns = [
    /chat\.whatsapp\.com\/[A-Za-z0-9]{10,}/i,
    /wa\.me\/[A-Za-z0-9+]+/i,
    /t\.me\/[A-Za-z0-9_]+/i,
    /https?:\/\/\S+/i,
    /www\.\S+\.[a-z]{2,}/i
  ];

  const hasLink = linkPatterns.some(p => p.test(text));
  if (!hasLink) return;

  try {
    // Always delete the message first
    await sock.sendMessage(chatId, {
      delete: { remoteJid: chatId, fromMe: false, id: message.key.id, participant: sender }
    }).catch(() => {});

    if (antilinkAction === 'kick') {
      // Kick mode: remove the sender
      await sock.groupParticipantsUpdate(chatId, [sender], 'remove').catch(() => {});
      const { date, time } = getDateTimeParts();
      await sock.sendMessage(chatId, {
        text: `*『 ANTILINK KICK 』*\n\n🚫 *Removed User:* @${normalizeNumber(sender)}\n📝 *Reason:* Posted a group link\n📅 *Date:* ${date}, ${time}`,
        mentions: [sender]
      });
    } else {
      // Delete mode: warn only
      const { date, time } = getDateTimeParts();
      await sock.sendMessage(chatId, {
        text: `*『 ANTILINK 』*\n\n⚠️ *User:* @${normalizeNumber(sender)}\n📝 *Notice:* Links are not allowed in this group! Next time you will be removed.\n📅 *Date:* ${date}, ${time}`,
        mentions: [sender]
      });
    }
  } catch (err) {
    console.warn('Antilink action failed:', err.message || err);
  }
}

// ─── ANTITAG / ANTIGROUPMENTION: Detect mass tagall ──────────────────────────
async function handleTagDetection(sock, message, chatId, sender, state) {
  if (!chatId.endsWith('@g.us')) return;
  const antitagOn = isToggleEnabled(state, 'antitag');
  const antigroupmentionOn = isToggleEnabled(state, 'antigroupmention');
  if (!antitagOn && !antigroupmentionOn) return;
  if (isOwnerJid(sender)) return;
  try {
    const adminCheck = await isAdmin(sock, chatId, sender);
    if (adminCheck) return;
  } catch {}

  const msg = message.message || {};
  const mentionedJidsArr = (
    msg.extendedTextMessage?.contextInfo?.mentionedJid ||
    msg.imageMessage?.contextInfo?.mentionedJid ||
    msg.videoMessage?.contextInfo?.mentionedJid || []
  );
  const msgText = (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption || ''
  );
  const numericMentions = (msgText.match(/@\d{8,}/g) || []).length;
  const totalMentions = Math.max(mentionedJidsArr.length, numericMentions);

  if (totalMentions < 3) return;

  try {
    const meta = await sock.groupMetadata(chatId);
    const threshold = Math.ceil((meta.participants?.length || 10) * 0.5);
    if (totalMentions < threshold && numericMentions < 10) return;

    // Delete the message
    await sock.sendMessage(chatId, {
      delete: { remoteJid: chatId, fromMe: false, id: message.key.id, participant: sender }
    });
    await sock.sendMessage(chatId, {
      text: `⚠️ @${normalizeNumber(sender)}, mass tagging is not allowed!`,
      mentions: [sender]
    });
  } catch (err) {
    console.warn('Antitag action failed:', err.message || err);
  }
}

// ─── ANTIDELETE: Store messages for recovery ──────────────────────────────────
async function storeMessageForAntidelete(sock, message, state) {
  if (!isToggleEnabled(state, 'antidelete')) return;
  if (!message.key?.id) return;
  const fromMe = Boolean(message.key.fromMe);
  if (fromMe) return; // don't store own messages

  const messageId = message.key.id;
  const sender = message.key.participant || message.key.remoteJid;
  let content = '';
  let mediaType = '';
  let mediaPath = '';

  try {
    const msg = message.message || {};
    if (msg.conversation) {
      content = msg.conversation;
    } else if (msg.extendedTextMessage?.text) {
      content = msg.extendedTextMessage.text;
    } else if (msg.imageMessage) {
      mediaType = 'image';
      content = msg.imageMessage.caption || '';
      try {
        const stream = await downloadContentFromMessage(msg.imageMessage, 'image');
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        mediaPath = path.join(ANTIDELETE_TMP_DIR, `${messageId}.jpg`);
        fs.writeFileSync(mediaPath, buf);
      } catch {}
    } else if (msg.videoMessage) {
      mediaType = 'video';
      content = msg.videoMessage.caption || '';
      try {
        const stream = await downloadContentFromMessage(msg.videoMessage, 'video');
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        mediaPath = path.join(ANTIDELETE_TMP_DIR, `${messageId}.mp4`);
        fs.writeFileSync(mediaPath, buf);
      } catch {}
    } else if (msg.audioMessage) {
      mediaType = 'audio';
      try {
        const stream = await downloadContentFromMessage(msg.audioMessage, 'audio');
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        mediaPath = path.join(ANTIDELETE_TMP_DIR, `${messageId}.mp3`);
        fs.writeFileSync(mediaPath, buf);
      } catch {}
    } else if (msg.stickerMessage) {
      mediaType = 'sticker';
      try {
        const stream = await downloadContentFromMessage(msg.stickerMessage, 'sticker');
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        mediaPath = path.join(ANTIDELETE_TMP_DIR, `${messageId}.webp`);
        fs.writeFileSync(mediaPath, buf);
      } catch {}
    }

    messageStore.set(messageId, {
      messageId,
      content, mediaType, mediaPath, sender,
      chatId: message.key.remoteJid,
      timestamp: Date.now()
    });

    // Prune old entries (keep last 500)
    if (messageStore.size > 500) {
      const oldest = [...messageStore.keys()].slice(0, messageStore.size - 500);
      for (const k of oldest) messageStore.delete(k);
    }
  } catch (err) {
    console.warn('storeMessageForAntidelete error:', err.message || err);
  }
}

// ─── ANTIDELETE: Handle deleted messages ──────────────────────────────────────
async function handleAntidelete(sock, deletionMessage, state) {
  if (!isToggleEnabled(state, 'antidelete')) return;

  let messageId, deletedBy;
  try {
    // protocolMessage type 0 = message revocation
    messageId = deletionMessage.message?.protocolMessage?.key?.id;
    deletedBy = deletionMessage.key?.participant || deletionMessage.key?.remoteJid;
  } catch {
    return;
  }
  if (!messageId) return;

  const cfg = getConfig();
  const ownerJid = `${normalizeNumber(cfg.ownerNumber || OWNER_NUMBER)}@s.whatsapp.net`;
  const botNumber = normalizeNumber(sock.user?.id || sock.user?.jid || '');

  // Don't report if owner/bot deleted their own message
  if (deletedBy && (normalizeNumber(deletedBy) === botNumber)) return;

  const original = messageStore.get(messageId);
  if (!original) return;

  const sender = original.sender;
  const time = new Date().toLocaleString('en-US', {
    timeZone: cfg.timeZone || 'Africa/Nairobi',
    hour12: true, hour: '2-digit', minute: '2-digit',
    day: '2-digit', month: '2-digit', year: 'numeric'
  });

  let groupName = '';
  if (original.chatId?.endsWith('@g.us')) {
    try {
      const meta = await sock.groupMetadata(original.chatId);
      groupName = meta.subject || '';
    } catch {}
  }

  let reportText = `*🔰 ANTIDELETE REPORT 🔰*\n\n` +
    `*🗑️ Deleted By:* @${normalizeNumber(deletedBy || sender)}\n` +
    `*👤 Sender:* @${normalizeNumber(sender)}\n` +
    `*🕒 Time:* ${time}\n`;
  if (groupName) reportText += `*👥 Group:* ${groupName}\n`;
  if (original.content) reportText += `\n*💬 Deleted Message:*\n${original.content}`;

  try {
    await sock.sendMessage(ownerJid, {
      text: reportText,
      mentions: [deletedBy, sender].filter(Boolean)
    });

    if (original.mediaType && original.mediaPath && fs.existsSync(original.mediaPath)) {
      const caption = `*Deleted ${original.mediaType}*\nFrom: @${normalizeNumber(sender)}`;
      const opts = { caption, mentions: [sender] };
      switch (original.mediaType) {
        case 'image':
          await sock.sendMessage(ownerJid, { image: { url: original.mediaPath }, ...opts });
          break;
        case 'video':
          await sock.sendMessage(ownerJid, { video: { url: original.mediaPath }, ...opts });
          break;
        case 'audio':
          await sock.sendMessage(ownerJid, { audio: { url: original.mediaPath }, mimetype: 'audio/mpeg', ptt: false });
          break;
        case 'sticker':
          await sock.sendMessage(ownerJid, { sticker: { url: original.mediaPath } });
          break;
      }
      try { fs.unlinkSync(original.mediaPath); } catch {}
    }
    messageStore.delete(messageId);
  } catch (err) {
    console.warn('Antidelete report failed:', err.message || err);
  }
}

// ─── ANTIDELETE STATUS: Detect deleted status updates ────────────────────────
async function handleAntideleteStatus(sock, message, state) {
  if (!isToggleEnabled(state, 'antidelete_status')) return;
  const chatId = message.key?.remoteJid;
  if (chatId !== 'status@broadcast') return;
  const isProtocol = message.message?.protocolMessage?.type === 0;
  if (!isProtocol) return;

  const cfg = getConfig();
  const ownerJid = `${normalizeNumber(cfg.ownerNumber || OWNER_NUMBER)}@s.whatsapp.net`;
  const deletedBy = message.key?.participant || message.key?.remoteJid;

  try {
    await sock.sendMessage(ownerJid, {
      text: `*🗑️ Status Deleted*\nSomeone (@${normalizeNumber(deletedBy)}) deleted their status.`,
      mentions: [deletedBy].filter(Boolean)
    });
  } catch {}
}

// ─── VIEW-ONCE AUTO-FORWARD ─────────────────────────────────────────────────
async function handleViewOnceAutoForward(sock, rawMessage) {
  try {
    const st = getState();
    if (st.groupSettings?._vv2 === false) return;
    const message = unwrapMessage(rawMessage);
    if (!message?.message) return;
    const chatId = message.key.remoteJid;
    const fromMe = Boolean(message.key.fromMe);
    if (fromMe) return;
    const sender = message.key.participant || message.key.remoteJid;
    const msg = message.message;
    const viewOnceMsg = msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg.viewOnceMessageV2Extension?.message;
    if (!viewOnceMsg) return;
    const imgMsg = viewOnceMsg.imageMessage;
    const vidMsg = viewOnceMsg.videoMessage;
    if (!imgMsg && !vidMsg) return;

    const cfg = getConfig();
    const ownerJid = `${normalizeNumber(cfg.ownerNumber || OWNER_NUMBER)}@s.whatsapp.net`;
    const selfJid = sock.user?.id || sock.user?.jid || ownerJid;

    const senderNumber = `+${normalizeNumber(sender)}`;
    const senderName = message.pushName || senderNumber;
    const isGroup = chatId.endsWith('@g.us');
    let source = 'Private DM';
    if (isGroup) {
      try {
        const meta = await sock.groupMetadata(chatId);
        source = `Group: ${meta.subject}`;
      } catch { source = `Group: ${chatId}`; }
    }
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { timeZone: cfg.timeZone || 'Africa/Nairobi', day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-GB', { timeZone: cfg.timeZone || 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const caption = `📸 *View-Once Received*\n\n👤 *Sender:* ${senderName}\n📞 *Number:* ${senderNumber}\n📍 *From:* ${source}\n📅 *Date:* ${dateStr}\n⏰ *Time:* ${timeStr}`;

    if (imgMsg) {
      const stream = await downloadContentFromMessage(imgMsg, 'image');
      let buf = Buffer.from([]);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      await sock.sendMessage(selfJid, { image: buf, caption });
    } else if (vidMsg) {
      const stream = await downloadContentFromMessage(vidMsg, 'video');
      let buf = Buffer.from([]);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      await sock.sendMessage(selfJid, { video: buf, caption });
    }
  } catch {}
}

// ─── WELCOME / GOODBYE ───────────────────────────────────────────────────────
// Group picture first, then group name and the member count with an arrow:
//   welcome: "123 ⟸ 120"   goodbye: "120 ⟹ 117"   (arrow always points old → new)
async function sendGroupGreeting(sock, groupId, participants, kind) {
  let meta;
  try { meta = await sock.groupMetadata(groupId); } catch { return; }
  const ids = participants.map(p => typeof p === 'string' ? p : (p.id || String(p)));
  const idSet = new Set(ids.map(bareJid));
  const present = meta.participants.filter(p => idsOfP(p).some(j => idSet.has(bareJid(j)))).length;
  const n = ids.length;
  const listed = meta.participants.length;
  const isWelcome = kind === 'welcome';
  const newCount = isWelcome ? listed + (n - present) : listed - present;
  const oldCount = isWelcome ? newCount - n : newCount + n;
  const counts = isWelcome ? `${newCount} ⟸ ${oldCount}` : `${oldCount} ⟹ ${newCount}`;
  const who = ids.map(j => `@${bareJid(j)}`).join(' ');

  const caption = isWelcome
    ? `╭╼━≪• 🎉 *WELCOME* •≫━╾╮\n┃ 🏡 *${meta.subject}*\n┃ 👋 ${who}\n┃ 👥 Members: *${counts}*\n╰━━━━━━━━━━━━━━━━╯\n\n*Made by Kimani Samuel*`
    : `╭╼━≪• 👋 *GOODBYE* •≫━╾╮\n┃ 🏡 *${meta.subject}*\n┃ 😢 ${who} left\n┃ 👥 Members: *${counts}*\n╰━━━━━━━━━━━━━━━━╯\n\n*Made by Kimani Samuel*`;

  let ppBuffer = null;
  try {
    const ppUrl = await sock.profilePictureUrl(groupId, 'image');
    if (ppUrl) {
      const { data } = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 10000 });
      ppBuffer = Buffer.from(data);
    }
  } catch {}

  try {
    if (ppBuffer) await sock.sendMessage(groupId, { image: ppBuffer, caption, mentions: ids });
    else await sock.sendMessage(groupId, { text: caption, mentions: ids });
  } catch (err) {
    console.warn(`${kind} send error:`, err.message);
  }
}

async function handleGroupWelcome(sock, groupId, participants) {
  return sendGroupGreeting(sock, groupId, participants, 'welcome');
}

async function handleGroupGoodbye(sock, groupId, participants) {
  return sendGroupGreeting(sock, groupId, participants, 'goodbye');
}

async function handleMessage(sock, rawMessage) {
  const message = unwrapMessage(rawMessage);
  if (!message?.message || message.key?.remoteJid === 'status@broadcast') return;
  const chatId = message.key.remoteJid;
  const sender = message.key.participant || message.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  const fromMe = Boolean(message.key.fromMe);
  const rawText = extractText(message).trim();
  const state = getState();
  if (!fromMe) await sendAutoPresence(sock, chatId, state);
  schedulePrivateGreet(sock, message, chatId, sender, fromMe);

  // ─── Run anti-moderation on all group messages (even non-command) ─────────
  if (isGroup && !fromMe) {
    if (rawText) await handleLinkDetection(sock, message, chatId, sender, rawText, state);
    await handleTagDetection(sock, message, chatId, sender, state);
  }

  // ─── AFK: clear on return, notify if the AFK user is mentioned/replied to ──
  if (!fromMe && state.afk) {
    if (state.afk[sender]) {
      const info = state.afk[sender];
      delete state.afk[sender];
      saveState(state);
      const mins = Math.max(1, Math.round((Date.now() - info.since) / 60000));
      await sock.sendMessage(chatId, { text: `👋 @${normalizeNumber(sender)} is back (was AFK ${mins}m: ${info.reason})`, mentions: [sender] }).catch(() => {});
    } else {
      const targets = new Set([...mentionedJids(message), quotedParticipant(message)].filter(Boolean));
      for (const jid of targets) {
        const info = state.afk[jid];
        if (info) {
          const mins = Math.max(1, Math.round((Date.now() - info.since) / 60000));
          await sock.sendMessage(chatId, { text: `💤 @${normalizeNumber(jid)} is AFK (${mins}m): ${info.reason}`, mentions: [jid] }).catch(() => {});
        }
      }
    }
  }

  if (!rawText) return;

  const cfg = getConfig();
  const prefix = cfg.prefix || '.';
  if (state.banned?.includes(sender) && !isOwnerJid(sender)) return;

  // ─── BOT PREFIX-FREE TRIGGER ────────────────────────────────────────
  // Allow "bot <command>" to trigger commands without the prefix
  let isBotTrigger = false;
  let commandText = rawText;
  
  if (rawText.toLowerCase().includes('bot')) {
    const words = rawText.split(/\s+/);
    const botIndex = words.findIndex(w => w.toLowerCase() === 'bot');
    if (botIndex !== -1) {
      // "bot hello world" or "hey bot hello world" or "hello bot world" → all trigger
      isBotTrigger = true;
      // Reconstruct as ".hello world" (everything after "bot")
      commandText = prefix + words.slice(botIndex + 1).join(' ');
    }
  }

  if (!rawText.startsWith(prefix) && !isBotTrigger) {
    // ── Pmblocker: auto-reply and block non-owner DMs ─────────────────────
    if (!isGroup && !fromMe && !isOwnerJid(sender)) {
      const pmCfg = state.pmblocker;
      if (pmCfg?.enabled) {
        await sock.sendMessage(chatId, { text: pmCfg.message || '⚠️ DMs are blocked. Contact the owner in a group.' }).catch(() => {});
        return;
      }
    }

    // ── Autoread: mark message as read + humanize if enabled ───────────────
    if (isToggleEnabled(state, 'autoread') && !fromMe) {
      const cfg = state.autoreadConfig || {};
      
      // Show typing indicator if humanized
      if (cfg.humanize && !isGroup) {
        try {
          await sock.sendTyping(chatId, true); // Start typing
          // Random typing duration
          await new Promise(r => setTimeout(r, cfg.typingDelay || (1500 + Math.random() * 1500)));
          await sock.sendTyping(chatId, false); // Stop typing
        } catch { /* ignore typing errors */ }
      }
      
      // Add natural delay before marking as read
      if (cfg.humanize) {
        await new Promise(r => setTimeout(r, cfg.replyDelay || (2000 + Math.random() * 3000)));
      }
      
      // Mark as read (shows blue ticks)
      await sock.readMessages([message.key]).catch(() => {});
    }

    // ── Autoreact: react to every non-command message ─────────────────────
    if (isToggleEnabled(state, 'autoreact') && !fromMe) {
      const reacts = ['❤️','😂','🔥','👍','😎','💯','🎉','✨','💪','😍'];
      await safeReact(sock, message, reacts[Math.floor(Math.random() * reacts.length)]).catch(() => {});
    }

    // ── Antibadword: check message text ──────────────────────────────────
    if (isGroup && !fromMe && !isOwnerJid(sender) && rawText) {
      const grpBadword = state.groupSettings?.[chatId]?.antibadword;
      if (grpBadword?.enabled && grpBadword.words?.length) {
        const lower = rawText.toLowerCase();
        const hasBad = grpBadword.words.some(w => lower.includes(w.toLowerCase()));
        if (hasBad) {
          try {
            const adminCheck = await isAdmin(sock, chatId, sender);
            if (!adminCheck) {
              await sock.sendMessage(chatId, {
                delete: { remoteJid: chatId, fromMe: false, id: message.key.id, participant: sender }
              }).catch(() => {});
              await sock.sendMessage(chatId, {
                text: `⚠️ @${normalizeNumber(sender)}, watch your language! Bad words are not allowed here.`,
                mentions: [sender]
              });
            }
          } catch {}
        }
      }
    }

    // ── Message count for topmembers ──────────────────────────────────────
    if (isGroup && !fromMe && rawText) {
      try {
        if (!state.msgCounts) state.msgCounts = {};
        if (!state.msgCounts[chatId]) state.msgCounts[chatId] = {};
        state.msgCounts[chatId][sender] = (state.msgCounts[chatId][sender] || 0) + 1;
        saveState(state);
      } catch {}
    }

    // ── Learned replies ───────────────────────────────────────────────────
    const learned = state.learned?.[rawText.toLowerCase()];
    if (learned && (cfg.publicMode || isOwnerJid(sender) || fromMe)) {
      await sock.sendMessage(chatId, { text: learned }, { quoted: message });
    }
    return;
  }

  if (!cfg.publicMode && !isOwnerJid(sender) && !fromMe) {
    console.log(`Ignored command from non-owner ${sender} (public mode off). If this is you, set OWNER_LID=${normalizeNumber(sender)}`);
    return;
  }

  // Use commandText (has correct prefix) when bot trigger fired, else rawText
  const parseFrom = isBotTrigger ? commandText : rawText;
  const body = parseFrom.slice(prefix.length).trim();
  // If "bot" typed alone with nothing after → show menu
  if (!body) {
    const menuCmd = registry.get('menu');
    if (menuCmd) await menuCmd.handler({ sock, chatId, sender, message, args: [], isGroup, fromMe, pushName: message?.pushName || '' });
    return;
  }
  let [cmdNameRaw, ...args] = body.split(/\s+/);
  let cmdName = cmdNameRaw.toLowerCase();
  let command = registry.get(cmdName);

  if (!command) {
    const compactPrefixChange = body.match(/^(setprefix|prefixset|newprefix)(.+)$/i);
    if (compactPrefixChange) {
      cmdName = 'setprefix';
      args = [compactPrefixChange[2]];
      command = registry.get(cmdName);
    }
  }

  if (!command) {
    await sock.sendMessage(chatId, { text: `Unknown command: ${prefix}${cmdName}\nUse ${prefix}menu.` }, { quoted: message });
    return;
  }

  const owner = isOwnerJid(sender) || fromMe;
  if (command.ownerOnly && !owner) {
    await sock.sendMessage(chatId, { text: 'This command is owner-only.' }, { quoted: message });
    return;
  }
  if (command.groupOnly && !isGroup) {
    await sock.sendMessage(chatId, { text: 'This command only works in groups.' }, { quoted: message });
    return;
  }
  if (command.adminOnly && isGroup && !owner) {
    const admin = await isAdmin(sock, chatId, sender);
    if (!admin) {
      await sock.sendMessage(chatId, { text: 'This command requires group admin permission.' }, { quoted: message });
      return;
    }
  }

  const ctx = {
    sock, message, chatId, sender, isGroup, args,
    rawText, body, commandName: cmdName, prefix, pushName: message.pushName || '',
    owner, mentions: mentionedJids(message),
    messageStore  // expose store to commands like del
  };
  try {
    await reactToCommand(sock, message, cmdName);
    await sendAutoPresence(sock, chatId, state);
    await command.handler(ctx);
    await sock.sendPresenceUpdate('paused', chatId).catch(() => {});
  } catch (err) {
    await sendError(sock, chatId, message, err);
  }
}

async function fetchVersionSafe(timeoutMs = 8000) {
  const fallback = [2, 3000, 1015901307];
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('fetchLatestBaileysVersion timeout')), timeoutMs)
      )
    ]);
    return result;
  } catch (e) {
    console.warn(`⚠️  Could not fetch latest Baileys version (${e.message}). Using fallback version.`);
    return { version: fallback, isLatest: false };
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchVersionSafe();
  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: browserConfig(),
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    getMessage: async (key) => rawStore.get(key?.id)?.message || undefined,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    }
  });

  // ─── DEBOUNCED creds.update ───────────────────────────────────────────────
  // Baileys fires creds.update on EVERY message/key exchange which causes
  // thousands of file writes per minute → KataBump "High file creation rate"
  // warning and eventual session corruption.
  // Fix: batch all updates into a single write every 2 seconds.
  let _saveCredsTimer = null;
  const debouncedSaveCreds = () => {
    if (_saveCredsTimer) return; // already scheduled
    _saveCredsTimer = setTimeout(async () => {
      _saveCredsTimer = null;
      try { await saveCreds(); } catch { /* ignore transient write errors */ }
    }, 2000);
  };
  flushCreds = async () => {
    if (_saveCredsTimer) { clearTimeout(_saveCredsTimer); _saveCredsTimer = null; }
    try { await saveCreds(); } catch {}
  };
  sock.ev.on('creds.update', debouncedSaveCreds);
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && loginMethod() === 'qr') {
      console.log('Scan this QR in WhatsApp > Linked devices:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log(`${getConfig().botName} connected with ${commands.length} commands.`);
      await sendConnectedNotice(sock);
      startAutoBio(sock);
    }
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const replaced = statusCode === DisconnectReason.connectionReplaced; // 440: same session open elsewhere
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !replaced;
      console.log(`Connection closed. code=${statusCode} reconnect=${shouldReconnect}`);
      await flushCreds();
      if (shouldReconnect) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { reconnectTimer = null; startBot().catch(e => console.error('Reconnect failed:', e)); }, 3000);
      } else if (replaced) {
        console.log('Session replaced: another instance is using this session. Stop the other instance, then restart this one.');
      } else console.log('Logged out. Delete the session folder and start again to relink.');
    }
  });

  activePairingManager = createPairingManager(sock, { logger: console });

  if (!sock.authState.creds.registered && loginMethod() !== 'qr') {
    const envNumber = process.env.PAIRING_NUMBER || process.env.OWNER_NUMBER || process.argv.find(arg => /^--number=/.test(arg))?.split('=')[1] || '';
    const number = await promptForPairingNumber(envNumber).catch(err => {
      console.error(`Pairing number error: ${err.message || err}`);
      return '';
    });

    if (cleanPhoneNumber(number)) {
      setTimeout(async () => {
        try {
          await activePairingManager.requestPairing(number, 'startup');
        } catch (err) {
          console.error('Pairing code failed. Check the number, delete any broken session, or try LOGIN_METHOD=qr.', err.message || err);
        }
      }, 3000);
    } else {
      console.log('Pairing mode is active, but no number was set.');
      console.log('Set PAIRING_NUMBER or OWNER_NUMBER, start with --number=15551234567, or visit /code?number=15551234567 on the hosted app.');
    }
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (msg?.key?.id && msg.message) {
        rawStore.set(msg.key.id, msg);
        if (rawStore.size > 1000) rawStore.delete(rawStore.keys().next().value);
      }
      if (msg?.pushName && !msg.key?.fromMe) {
        for (const j of [msg.key.participant, msg.key.remoteJid, msg.key.participantPn, msg.key.senderPn, msg.key.participantAlt, msg.key.remoteJidAlt]) {
          if (j && /@(s\.whatsapp\.net|lid)$/.test(j)) rememberName(j, msg.pushName);
        }
      }
    }
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        learnLidMapping(msg);
        const st = getState();
        const bg = (p) => Promise.resolve(p).catch(e => console.error('Background task error:', e?.message || e));

        // Status updates: react/log in the background, never block commands
        if (msg.key?.remoteJid === 'status@broadcast') {
          bg(handleStatusMessage(sock, msg));
          bg(handleAntideleteStatus(sock, msg, st));
          continue;
        }

        // Antidelete: detect protocol revocation messages
        if (msg.message?.protocolMessage?.type === 0) {
          bg(handleAntidelete(sock, msg, st));
          continue;
        }

        // Heavy media work runs in the background so commands reply immediately
        bg(storeMessageForAntidelete(sock, msg, st));
        bg(handleViewOnceAutoForward(sock, msg));

        await handleMessage(sock, msg);
      } catch (err) {
        console.error('Message handler error:', err?.message || err);
      }
    }
  });

  // ─── ANTICALL: Auto-reject incoming calls ────────────────────────────────
  sock.ev.on('call', async (calls) => {
    const state = getState();
    if (!isToggleEnabled(state, 'anticall')) return;
    for (const call of calls) {
      if (call.status === 'offer') {
        try {
          await sock.rejectCall(call.id, call.from);
          const cfg = getConfig();
          const ownerJid = `${normalizeNumber(cfg.ownerNumber || OWNER_NUMBER)}@s.whatsapp.net`;
          if (call.from !== ownerJid) {
            await sock.sendMessage(call.from, {
              text: '⛔ Sorry, calls are disabled on this bot. Please send a message instead.'
            }).catch(() => {});
          }
        } catch { /* ignore */ }
      }
    }
  });

  // ─── CONTACT NAMES (for getpp) ────────────────────────────────────────────
  const rememberContact = (c) => {
    const name = c?.name || c?.notify || c?.verifiedName;
    for (const j of [c?.id, c?.lid, c?.phoneNumber]) {
      if (!j) continue;
      if (name) rememberName(j, name);
      if (c?.username) usernameCache.set(bareJid(j), c.username);
    }
  };
  sock.ev.on('contacts.upsert', (cs) => (cs || []).forEach(rememberContact));
  sock.ev.on('contacts.update', (cs) => (cs || []).forEach(rememberContact));

  // ─── GROUP EVENTS ─────────────────────────────────────────────────────────
  sock.ev.on('group-participants.update', async ({ id, participants, action, author }) => {
    try {
      const st = getState();
      const groupSettings = st.groupSettings || {};
      const grpCfg = groupSettings[id] || {};

      // Run greetings in background - don't block event handler
      if (action === 'add' && grpCfg.welcome) {
        setImmediate(() => handleGroupWelcome(sock, id, participants));
      }
      if ((action === 'remove' || action === 'leave') && grpCfg.goodbye) {
        setImmediate(() => handleGroupGoodbye(sock, id, participants));
      }

      // ─── PROMOTE announcement ─────────────────────────────────────────
      if (action === 'promote' && participants.length) {
        try {
          const pList = participants.map(j => typeof j === 'string' ? j : j.id || j.toString());
          const userLines = pList.map(j => `• @${j.split('@')[0]}`).join('\n');
          const authorJid = author ? (typeof author === 'string' ? author : author.id || author.toString()) : null;
          const authorNum = authorJid ? authorJid.split('@')[0] : null;
          const mentionList = [...pList, ...(authorJid ? [authorJid] : [])];
          const msg =
            `*『 GROUP PROMOTION 』*\n\n` +
            `👥 *Promoted User${pList.length > 1 ? 's' : ''}:*\n${userLines}\n\n` +
            `👑 *Promoted By:* ${authorNum ? `@${authorNum}` : 'System'}\n` +
            `📅 *Date:* ${new Date().toLocaleString()}`;
          await sock.sendMessage(id, { text: msg, mentions: mentionList });
        } catch { /* ignore */ }
      }

      // ─── DEMOTE announcement ──────────────────────────────────────────
      if (action === 'demote' && participants.length) {
        try {
          await new Promise(r => setTimeout(r, 800));
          const pList = participants.map(j => typeof j === 'string' ? j : j.id || j.toString());
          const userLines = pList.map(j => `• @${j.split('@')[0]}`).join('\n');
          const authorJid = author ? (typeof author === 'string' ? author : author.id || author.toString()) : null;
          const authorNum = authorJid ? authorJid.split('@')[0] : null;
          const mentionList = [...pList, ...(authorJid ? [authorJid] : [])];
          const msg =
            `*『 GROUP DEMOTION 』*\n\n` +
            `👤 *Demoted User${pList.length > 1 ? 's' : ''}:*\n${userLines}\n\n` +
            `👑 *Demoted By:* ${authorNum ? `@${authorNum}` : 'System'}\n` +
            `📅 *Date:* ${new Date().toLocaleString()}`;
          await sock.sendMessage(id, { text: msg, mentions: mentionList });
        } catch { /* ignore */ }
      }

    } catch (err) {
      console.warn('Group participant event error:', err.message || err);
    }
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await flushCreds(); process.exit(0); });
}

startWeb();
startBot().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
