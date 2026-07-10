import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import axios from 'axios';
import { createRequire } from 'module';
import { execSync, exec as execCb } from 'child_process';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { DATA_DIR, readJson, writeJson, runtime, systemInfo, normalizeNumber, mentionedJids, quotedParticipant, pickTarget, hashPercent, safeEvalMath, toFancy, randomChoice, groupAdmins } from './utils.js';
import { formatPairingCode, pairInstructions, validatePairingNumber } from './pairing.js';
import { BOT_NAME, OWNER_NAME, OWNER_NUMBER, TOGGLE_NAMES, commandReaction, formatAutoBio, formatSettings, getDateTimeParts, isToggleEnabled, setToggle } from './settings.js';
import path from 'path';

// yt-search — lazy top-level import so missing module never crashes startup
let yts;
try { yts = (await import('yt-search')).default; } catch { yts = null; }

// Sanitize a string for use as a file name
function sanitizeFileName(name = 'download') {
  return String(name)
    .replace(/[^\w\s\-().]/g, '')   // remove special chars
    .replace(/\s+/g, ' ')           // collapse whitespace
    .trim()
    .slice(0, 100)
    || 'download';
}

const configPath = path.join(DATA_DIR, 'bot-config.json');
const statePath = path.join(DATA_DIR, 'state.json');

const jokes = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'I told my bot a joke about UDP. It might get it, it might not.',
  'Why was the JavaScript developer sad? Because they did not know how to null their feelings.',
  'A SQL query walks into a bar, walks up to two tables and asks: can I join you?',
  'There are 10 kinds of people: those who understand binary and those who do not.'
];
const facts = [
  'Honey never spoils when stored properly.',
  'Bananas are berries, but strawberries are not botanical berries.',
  'Octopuses have three hearts.',
  'The first computer bug was an actual moth found in a relay.',
  'A day on Venus is longer than a year on Venus.'
];
const quotes = [
  'Stay hungry, stay foolish.',
  'Simplicity is the soul of efficiency.',
  'The best way to predict the future is to build it.',
  'Code is like humor. When you have to explain it, it is bad.',
  'Great things are done by a series of small things brought together.'
];
const truths = [
  'What is something you are secretly proud of?',
  'What was your most embarrassing chat mistake?',
  'Who was the last person you searched for online?',
  'What habit do you want to change?',
  'What is one thing you have never told the group?'
];
const dares = [
  'Send a voice note saying the alphabet backwards.',
  'Let the group choose your status for one hour.',
  'Send your most recent emoji five times.',
  'Talk like a robot for the next five messages.',
  'Compliment the last person who messaged.'
];
const compliments = ['legendary', 'brilliant', 'unstoppable', 'kind-hearted', 'iconic', 'creative', 'a real vibe'];
const insults = ['needs a software update', 'is buffering in real life', 'has low battery energy', 'forgot to compile today'];
const morseMap = { a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.' };
const reverseMorse = Object.fromEntries(Object.entries(morseMap).map(([k, v]) => [v, k]));

function getConfig() {
  const defaults = {
    prefix: process.env.PREFIX || '.',
    publicMode: String(process.env.PUBLIC_MODE || 'true').toLowerCase() !== 'false',
    botName: process.env.BOT_NAME || BOT_NAME,
    ownerName: process.env.OWNER_NAME || OWNER_NAME,
    ownerNumber: normalizeNumber(process.env.OWNER_NUMBER || OWNER_NUMBER),
    timeZone: process.env.TIME_ZONE || 'Africa/Nairobi',
    madeBy: process.env.MADE_BY || 'Kimani Samuel'
  };
  return { ...defaults, ...readJson(configPath, {}) };
}

function saveConfig(next) {
  const current = getConfig();
  writeJson(configPath, { ...current, ...next });
}

function getState() { return readJson(statePath, { banned: [], notes: {}, learned: {}, counters: {}, toggles: {} }); }
function saveState(next) { writeJson(statePath, next); }

function helpLine(cmd, prefix) {
  return `${prefix}${cmd.name}${cmd.usage ? ' ' + cmd.usage : ''} — ${cmd.desc}`;
}

function textArg(args, fallback = '') { return args.join(' ').trim() || fallback; }
async function reply(ctx, text, options = {}) { return ctx.sock.sendMessage(ctx.chatId, { text, ...options }, { quoted: ctx.message }); }
function requireText(ctx, example) {
  const text = textArg(ctx.args);
  if (!text) return null;
  return text;
}

function toUserJid(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@lid')) return raw;
  const number = normalizeNumber(raw);
  return number ? `${number}@s.whatsapp.net` : '';
}

function jidsFromArgs(ctx, { includeMentions = true, includeQuoted = true, fallbackToSender = false } = {}) {
  const out = [];
  const addJid = (value) => {
    const jid = toUserJid(value);
    if (jid && !out.includes(jid)) out.push(jid);
  };

  if (includeMentions) mentionedJids(ctx.message).forEach(addJid);
  if (includeQuoted) addJid(quotedParticipant(ctx.message));

  const text = textArg(ctx.args);
  for (const token of text.split(/[\s,;|]+/).filter(Boolean)) {
    if (/^[+0-9()\-.]{5,}$/.test(token)) addJid(token);
  }

  if (!out.length && fallbackToSender) addJid(ctx.sender);
  return out;
}

function formatTargetList(jids = []) {
  return jids.map(jid => `@${normalizeNumber(jid)}`).join(', ');
}

function collectStringsDeep(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectStringsDeep(item, out));
  else if (typeof value === 'object') Object.values(value).forEach(item => collectStringsDeep(item, out));
  return out;
}

async function ensureBotGroupAdmin(ctx, action = 'manage group members') {
  // Parse bot ID correctly — Baileys may return formats like:
  //   "254701234567:4@s.whatsapp.net"  (phone:device@domain)
  //   "30997433344120:4@lid"           (lid:device@lid)
  const rawBotId  = ctx.sock.user?.id  || ctx.sock.user?.jid || '';
  const rawBotLid = ctx.sock.user?.lid || '';

  // Strip "@domain" and ":device" suffix to get the base number/lid
  const stripSuffix = (jid = '') => jid.split('@')[0].split(':')[0];
  const botPhone  = stripSuffix(rawBotId);
  const botLid    = stripSuffix(rawBotLid);

  let meta;
  try { meta = await ctx.sock.groupMetadata(ctx.chatId); } catch {
    throw new Error(`I need to be a group admin to ${action}.`);
  }

  const isBotAdmin = (meta.participants || []).some(p => {
    const pId  = stripSuffix(p.id  || p.jid || '');
    const pLid = stripSuffix(p.lid || '');
    const isBot = (
      rawBotId  === (p.id  || p.jid || '') ||   // exact full match
      rawBotLid === (p.lid || '')           ||   // exact lid match
      botPhone  === pId                     ||   // phone-number match
      botPhone  === pLid                    ||   // phone vs lid
      (botLid && botLid === pLid)           ||   // lid numeric match
      (botLid && botLid === pId)                 // lid vs id
    );
    return isBot && (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin);
  });

  if (!isBotAdmin) throw new Error(`I need to be a group admin to ${action}.`);
}

async function resolveGroupTargets(ctx, targets = []) {
  if (!ctx.isGroup || !targets.length) return [...new Set(targets)];
  const meta = await ctx.sock.groupMetadata(ctx.chatId).catch(() => null);
  if (!meta?.participants?.length) return [...new Set(targets)];

  const participants = meta.participants.map(p => {
    const primary = p.id || p.jid || p.lid || p.phoneNumber || '';
    const strings = collectStringsDeep(p, []).filter(Boolean);
    return { primary, strings };
  });

  const resolved = [];
  for (const target of targets) {
    const number = normalizeNumber(target);
    const exact = participants.find(p => p.strings.some(x => String(x) === String(target)));
    const byNumber = number ? participants.find(p => p.strings.some(x => normalizeNumber(x) === number)) : null;
    const jid = (exact || byNumber)?.primary || target;
    if (jid && !resolved.includes(jid)) resolved.push(jid);
  }
  return resolved;
}

async function sendLongReply(ctx, text, options = {}) {
  const chunks = [];
  const max = 3500;
  let remaining = String(text || '');
  while (remaining.length > max) {
    let idx = remaining.lastIndexOf('\n', max);
    if (idx < 500) idx = max;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  for (const chunk of chunks) await reply(ctx, chunk, options);
}

function madeByFooter(cfg = getConfig()) {
  return `⭐ *Made by ${cfg.madeBy || 'Kimani Samuel'}* ⭐`;
}

function readMore() {
  return String.fromCharCode(8206).repeat(4001);
}

function getGreeting(timeZone = 'Africa/Nairobi') {
  let hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(new Date()));
  if (!Number.isFinite(hour)) hour = new Date().getHours();
  if (hour < 5) return '🌙 Good night.';
  if (hour < 12) return '🌅 Good morning.';
  if (hour < 17) return '☀️ Good afternoon.';
  if (hour < 21) return '🌆 Good evening.';
  return '🌙 Good night.';
}

function chunkMenuText(text, max = 3400) {
  const chunks = [];
  let remaining = String(text || '');
  while (remaining.length > max) {
    let idx = remaining.lastIndexOf('\n', max);
    if (idx < 800) idx = max;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendMenuWithImage(ctx, text, cfg = getConfig()) {
  const imagePath = path.join(process.cwd(), 'assets', 'bot_image.jpg');
  const headerCaption = `🤖 *${cfg.botName || BOT_NAME}*
${madeByFooter(cfg)}`;
  if (fs.existsSync(imagePath)) {
    await ctx.sock.sendMessage(ctx.chatId, { image: { url: imagePath }, caption: headerCaption }, { quoted: ctx.message });
  }
  await reply(ctx, text);
}

async function updateAutoBioFromCommand(ctx) {
  const cfg = getConfig();
  // Use the bot's configured timezone (defaults to Africa/Nairobi for Kenya)
  const tz = cfg.timeZone || process.env.TIME_ZONE || process.env.TZ || 'Africa/Nairobi';
  const bio = formatAutoBio(cfg.botName || BOT_NAME, tz);
  if (typeof ctx.sock.updateProfileStatus !== 'function') {
    return 'Autobio was enabled, but this Baileys socket does not expose updateProfileStatus on this host.';
  }
  try {
    await ctx.sock.updateProfileStatus(bio);
    return `Bio updated (${tz}): ${bio}`;
  } catch (err) {
    return `Autobio was enabled, but updating bio failed: ${err.message || err}`;
  }
}

function isHttpUrl(text = '') {
  try {
    const url = new URL(String(text).trim());
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

async function resolveYouTubeUrl(input) {
  const query = String(input || '').trim();
  if (!query) throw new Error('Give me a YouTube URL or search name.');
  if (isHttpUrl(query)) return { url: query, title: query };

  try {
    const mod = await import('yt-search');
    const search = mod.default || mod;
    const result = await search(query);
    const video = result?.videos?.find(v => v?.url) || result?.all?.find(v => v?.type === 'video' && v?.url);
    if (video?.url) return { url: video.url, title: video.title || query };
  } catch {
    // If yt-search is unavailable on the host, fall through to a useful error below.
  }

  throw new Error('Could not search YouTube. Install dependencies with npm install, or send a direct YouTube link.');
}

function collectStrings(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectStrings(item, out));
  else if (typeof value === 'object') Object.values(value).forEach(item => collectStrings(item, out));
  return out;
}

function findTitle(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.title === 'string') return value.title;
  for (const item of Object.values(value)) {
    const nested = findTitle(item);
    if (nested) return nested;
  }
  return '';
}

function pickMediaUrl(data, type) {
  const urls = collectStrings(data)
    .map(x => x.trim())
    .filter(x => /^https?:\/\//i.test(x))
    .filter(x => !/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(x))
    .filter(x => !/youtube\.com\/watch|youtu\.be\//i.test(x));

  const preferred = urls.find(x => type === 'audio'
    ? /\.mp3(\?|$)|audio|ytmp3|mp3|download/i.test(x)
    : /\.mp4(\?|$)|video|ytmp4|mp4|download/i.test(x));
  return preferred || urls[0] || '';
}

async function requestDownloadUrl(youtubeUrl, type) {
  const encoded = encodeURIComponent(youtubeUrl);
  const endpoints = type === 'audio' ? [
    `https://api.davidcyriltech.my.id/download/ytmp3?url=${encoded}`,
    `https://api.dreaded.site/api/ytdl/audio?url=${encoded}`,
    `https://bk9.fun/download/ytmp3?url=${encoded}`,
    `https://api.agatz.xyz/api/ytmp3?url=${encoded}`
  ] : [
    `https://api.davidcyriltech.my.id/download/ytmp4?url=${encoded}`,
    `https://api.dreaded.site/api/ytdl/video?url=${encoded}`,
    `https://bk9.fun/download/ytmp4?url=${encoded}`,
    `https://api.agatz.xyz/api/ytmp4?url=${encoded}`
  ];

  const failures = [];
  for (const endpoint of endpoints) {
    try {
      const { data } = await axios.get(endpoint, {
        timeout: 45000,
        headers: { 'user-agent': 'Mozilla/5.0 Malai-XD-2.0' }
      });
      const mediaUrl = pickMediaUrl(data, type);
      if (mediaUrl) return { url: mediaUrl, title: findTitle(data) };
      failures.push('no media url');
    } catch (err) {
      failures.push(err.message || String(err));
    }
  }
  throw new Error(`No downloader API returned a ${type} file. Last error: ${failures.at(-1) || 'unknown'}`);
}

async function sendYouTubeMedia(ctx, requestedType, rawInput) {
  let input = String(rawInput || '').trim();
  let type = requestedType;
  if (!type) type = /^video|mp4$/i.test(ctx.args[0] || '') ? 'video' : 'audio';
  if (/^(audio|mp3|video|mp4)$/i.test(ctx.args[0] || '')) input = ctx.args.slice(1).join(' ').trim();
  if (!input) return reply(ctx, `Usage:\n${getConfig().prefix}play <song name or youtube url>\n${getConfig().prefix}play video <song name or youtube url>\n${getConfig().prefix}video <song name or youtube url>`);

  await reply(ctx, `Downloading ${type === 'audio' ? 'audio' : 'video'} for: ${input}`);
  const found = await resolveYouTubeUrl(input);
  const media = await requestDownloadUrl(found.url, type);
  const title = sanitizeFileName(media.title || found.title || 'Malai-XD-2.0');
  const caption = `╭─〔 Malai-XD-2.0 Download 〕\n│ Title: ${title}\n│ Type: ${type}\n╰────────────`;

  if (type === 'audio') {
    await ctx.sock.sendMessage(ctx.chatId, {
      audio: { url: media.url },
      mimetype: 'audio/mpeg',
      fileName: `${title}.mp3`,
      ptt: false
    }, { quoted: ctx.message });
  } else {
    await ctx.sock.sendMessage(ctx.chatId, {
      video: { url: media.url },
      mimetype: 'video/mp4',
      fileName: `${title}.mp4`,
      caption
    }, { quoted: ctx.message });
  }
}

export function buildCommands() {
  const registry = new Map();
  const commands = [];
  const add = (cmd) => {
    if (!cmd.name || typeof cmd.handler !== 'function') throw new Error(`Invalid command ${cmd.name}`);
    cmd.aliases = cmd.aliases || [];
    cmd.category = cmd.category || 'misc';
    cmd.desc = cmd.desc || 'No description';
    cmd.usage = cmd.usage || '';
    commands.push(cmd);
    registry.set(cmd.name, cmd);
    for (const alias of cmd.aliases) registry.set(alias, cmd);
  };

  add({ name: 'menu', aliases: ['help', 'list'], category: 'core', desc: 'Show commands menu', handler: async (ctx) => {
    const cfg = getConfig();
    const total = commands.length;
    const displayName = ctx.pushName || normalizeNumber(ctx.sender) || 'there';
    const { date, time } = getDateTimeParts(cfg.timeZone);
    const mode = cfg.publicMode ? 'public' : 'private';
    const p = cfg.prefix;
    const helpMessage = `╔═══════════════════╗\n   *🤖 ${cfg.botName}*\n   by *${cfg.ownerName}*\n   📦 Commands: *${total}*\n╚═══════════════════╝\n\nHello 👋 *${displayName}*\n${getGreeting(cfg.timeZone)}\n📅 *${date}*  ⏰ *${time}*\n🔣 Prefix: *${p}*  🔐 Mode: *${mode}*\n\n╔═══════════════════╗\n💫 *General Commands*:\n║ ➤ ${p}menu / ${p}help\n║ ➤ ${p}ping\n║ ➤ ${p}ping2\n║ ➤ ${p}alive\n║ ➤ ${p}owner\n║ ➤ ${p}joke / ${p}fact / ${p}quote\n║ ➤ ${p}weather <city>\n║ ➤ ${p}jid\n╚═══════════════════╝\n\n╔═══════════════════╗\n👥 *Group Commands*:\n║ ➤ ${p}tagall\n║ ➤ ${p}hidetag <msg>\n║ ➤ ${p}groupinfo\n║ ➤ ${p}admins\n║ ➤ ${p}kick @user\n║ ➤ ${p}promote / ${p}demote @user\n║ ➤ ${p}open / ${p}close\n║ ➤ ${p}welcome on/off\n║ ➤ ${p}goodbye on/off\n║ ➤ ${p}vcf\n║ ➤ ${p}grouplink\n║ ➤ ${p}resetlink\n║ ➤ ${p}setgname / ${p}setgdesc\n╚═══════════════════╝\n\n╔═══════════════════╗\n👑 *Owner Commands*:\n║ ➤ ${p}mode <public/private>\n║ ➤ ${p}settings\n║ ➤ ${p}ban / ${p}unban\n║ ➤ ${p}block / ${p}unblock\n║ ➤ ${p}setprefix <prefix>\n║ ➤ ${p}restart\n║ ➤ ${p}pair <number>\n╚═══════════════════╝\n\n╔═══════════════════╗\n🎞️ *Media Commands*:\n║ ➤ ${p}vv  (reveal view-once)\n║ ➤ ${p}vv2 on/off (auto-forward VO)\n║ ➤ ${p}sticker\n║ ➤ ${p}toimg / ${p}removebg\n╚═══════════════════╝\n\n╔═══════════════════╗\n⬇️ *Downloader*:\n║ ➤ ${p}play <song name>\n║ ➤ ${p}video <song name>\n║ ➤ ${p}tiktok <link>\n║ ➤ ${p}instagram <link>\n║ ➤ ${p}facebook <link>\n╚═══════════════════╝\n\n╔═══════════════════╗\n😂 *Fun Commands*:\n║ ➤ ${p}truth / ${p}dare\n║ ➤ ${p}8ball <question>\n║ ➤ ${p}ship / ${p}flirt\n║ ➤ ${p}compliment / ${p}insult @user\n║ ➤ ${p}gayrate / ${p}smartcheck\n╚═══════════════════╝\n\n╔═══════════════════╗\n🤖 *AI Commands*:\n║ ➤ ${p}ai <question>\n║ ➤ ${p}imagine <prompt>\n║ ➤ ${p}story <topic>\n╚═══════════════════╝\n\nType *${p}allmenu* for the full command list.\nType *${p}ping2* for bot system status.\n\n*Made by Kimani Samuel*`;
    try {
      // Use Malai-XD avatar as menu image; fall back to bot_image.jpg then text
      const avatarPath = path.join(process.cwd(), 'assets', 'malai_avatar.jpg');
      const fallbackPath = path.join(process.cwd(), 'assets', 'bot_image.jpg');
      const imagePath = fs.existsSync(avatarPath) ? avatarPath : (fs.existsSync(fallbackPath) ? fallbackPath : null);
      if (imagePath) {
        await ctx.sock.sendMessage(ctx.chatId, {
          image: fs.readFileSync(imagePath),
          caption: helpMessage,
          contextInfo: { forwardingScore: 1, isForwarded: true }
        }, { quoted: ctx.message });
      } else {
        await reply(ctx, helpMessage);
      }
    } catch (e) {
      await reply(ctx, helpMessage);
    }
  }});

  add({ name: 'allmenu', aliases: ['fullmenu', 'commands', 'allcommand'], category: 'core', desc: 'Show every command by category', handler: async (ctx) => {
    const cfg = getConfig();
    const p = cfg.prefix;
    const grouped = {};
    for (const c of commands) (grouped[c.category] ||= []).push(c);

    const CATEGORY_ICONS = {
      core: '🌟', owner: '👑', group: '👥', downloads: '⬇️',
      converter: '🎞️', tools: '🔧', utility: '🛠️', fun: '😂',
      ai: '🤖', misc: '📦', informer: 'ℹ️', automation: '⚙️'
    };

    const header = `╔══════════════════════════════╗
║  🤖 *${cfg.botName}* — Full Commands
║  📦 Total: *${commands.length}*  |  🔣 Prefix: *${p}*
║  👑 Owner: *${cfg.ownerName}*
╚══════════════════════════════╝`;

    const parts = [header];
    for (const cat of Object.keys(grouped).sort()) {
      const icon = CATEGORY_ICONS[cat] || '📌';
      const cmds = grouped[cat];
      parts.push(`\n╭─── ${icon} *${cat.toUpperCase()}* (${cmds.length}) ───`);
      for (const c of cmds) {
        const usage = c.usage ? ` *${c.usage}*` : '';
        parts.push(`│ ➤ ${p}${c.name}${usage}`);
        if (c.aliases?.length) parts.push(`│    _aliases: ${c.aliases.map(a => p + a).join(', ')}_`);
      }
      parts.push(`╰${'─'.repeat(30)}`);
    }
    parts.push(`\n_Type *${p}menu* for a quick overview_\n${madeByFooter(cfg)}`);

    await sendLongReply(ctx, parts.join('\n'));
  }});

  add({ name: 'ownermenu', aliases: ['adminmenu', 'ownercommands'], category: 'owner', ownerOnly: true, desc: 'Show all owner-only commands in a stylistic list', handler: async (ctx) => {
    const cfg = getConfig();
    const p = cfg.prefix;
    const ownerCmds = commands.filter(c => c.ownerOnly);

    const menu = `╔══════════════════════════════╗
║  👑 *OWNER COMMANDS PANEL*
║  🤖 Bot: *${cfg.botName}*
║  📦 Commands: *${ownerCmds.length}*
╚══════════════════════════════╝

╭─── ⚙️ *BOT CONTROL* ───
│ ➤ ${p}mode <public|private>
│ ➤ ${p}setprefix <prefix>
│ ➤ ${p}setbotname <name>
│ ➤ ${p}setbotpp  _(reply to image)_
│ ➤ ${p}restart
│ ➤ ${p}update
╰──────────────────────────────

╭─── 🔧 *SETTINGS & TOGGLES* ───
│ ➤ ${p}settings
│ ➤ ${p}autobio on/off
│ ➤ ${p}autotyping on/off
│ ➤ ${p}autorecord on/off
│ ➤ ${p}autostatus on/off
│ ➤ ${p}antilink on/off
│ ➤ ${p}anticall on/off
│ ➤ ${p}pmblocker on/off
│ ➤ ${p}autoread on/off
│ ➤ ${p}welcome on/off
│ ➤ ${p}goodbye on/off
╰──────────────────────────────

╭─── 🚫 *USER MANAGEMENT* ───
│ ➤ ${p}ban / ${p}unban @user
│ ➤ ${p}block / ${p}unblock @user
│ ➤ ${p}sudo / ${p}addsudo / ${p}delsudo
│ ➤ ${p}broadcast <message>
╰──────────────────────────────

╭─── 🔗 *PAIRING & SESSION* ───
│ ➤ ${p}pair <number>
│ ➤ ${p}clearsession
╰──────────────────────────────

╭─── 📊 *INFO & STATS* ───
│ ➤ ${p}ping2 _(system status)_
│ ➤ ${p}system
│ ➤ ${p}runtime
│ ➤ ${p}owners
│ ➤ ${p}repo
╰──────────────────────────────

${madeByFooter(cfg)}`;

    await reply(ctx, menu);
  }});



  add({ name: 'ping', aliases: ['speed', 'latency'], category: 'core', desc: 'Check bot response speed', handler: async (ctx) => {
    const cfg = getConfig();
    const start = Date.now();
    await ctx.sock.sendMessage(ctx.chatId, { text: 'Pong! 🏓' }, { quoted: ctx.message });
    const ms = Math.round((Date.now() - start) / 2);
    const botInfo = `┏━━〔 🤖 *${cfg.botName}* 〕━━┓
┃ 🏓 Ping     : ${ms} ms
┃ ⏱️ Uptime   : ${runtime()}
┃ 👑 Owner    : ${cfg.ownerName}
┗━━━━━━━━━━━━━━━━━━━┛

*Made by Kimani Samuel*`;
    await reply(ctx, botInfo);
  }});

  add({ name: 'ping2', aliases: ['botstatus', 'status2'], category: 'core', desc: 'Show detailed bot system status', handler: async (ctx) => {
    const cfg = getConfig();
    const mem = process.memoryUsage();
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    const usedRam = totalRam - freeRam;
    const cpuModel = os.cpus()?.[0]?.model?.split(' ').slice(0, 3).join(' ') || 'Unknown';
    const start = Date.now();
    await ctx.sock.sendMessage(ctx.chatId, { text: '📡 Checking status...' }, { quoted: ctx.message });
    const ms = Math.round((Date.now() - start) / 2);
    const statusMsg = `┏━━〔 🤖 *${cfg.botName} STATUS* 〕━━┓
┃ 🏓 Ping      : ${ms} ms
┃ 🧠 RAM Used  : ${(usedRam / 1024 / 1024).toFixed(1)} MB / ${(totalRam / 1024 / 1024).toFixed(0)} MB
┃ 📦 Heap Used : ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB
┃ 💾 Node      : ${process.version}
┃ 🖥️ Platform  : ${os.platform()} ${os.arch()}
┃ 🧩 CPU       : ${cpuModel}
┃ ⏱️ Uptime    : ${runtime()}
┃ 👑 Owner     : ${cfg.ownerName}
┃ 🤖 Bot Name  : ${cfg.botName}
┃ 🔣 Prefix    : ${cfg.prefix}
┃ 🔐 Mode      : ${cfg.publicMode ? 'Public' : 'Private'}
┗━━━━━━━━━━━━━━━━━━━━━━┛

*Made by Kimani Samuel*`;
    await reply(ctx, statusMsg);
  }});

  add({ name: 'alive', aliases: ['online'], category: 'core', desc: 'Show bot is online', handler: async (ctx) => {
    const cfg = getConfig();
    await reply(ctx, `╭─〔 ${cfg.botName} 〕\n│ ✅ Status: Online\n│ ⏱️ Runtime: ${runtime()}\n│ 👑 Owner: ${cfg.ownerName}\n╰────────────`);
  }});
  add({ name: 'runtime', aliases: ['uptime'], category: 'core', desc: 'Show uptime', handler: async (ctx) => reply(ctx, `Runtime: ${runtime()}`) });
  add({ name: 'system', aliases: ['sysinfo', 'server'], category: 'core', desc: 'Show host system info', handler: async (ctx) => {
    const s = systemInfo();
    await reply(ctx, `Platform: ${s.platform}\nNode: ${s.node}\nRuntime: ${s.uptime}\nMemory: ${s.memory}\nCPU: ${s.cpu}`);
  }});
  add({ name: 'owner', aliases: ['creator'], category: 'core', desc: 'Send owner contact', handler: async (ctx) => {
    const cfg = getConfig();
    const number = normalizeNumber(cfg.ownerNumber || OWNER_NUMBER);
    const waid = number || OWNER_NUMBER;
    const phone = waid.startsWith('254') ? `+${waid}` : waid;
    const displayName = cfg.ownerName || OWNER_NAME;
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${displayName}`,
      `ORG:${cfg.botName};`,
      `TEL;type=CELL;type=VOICE;waid=${waid}:${phone}`,
      'END:VCARD'
    ].join('\n');
    await ctx.sock.sendMessage(ctx.chatId, {
      contacts: {
        displayName,
        contacts: [{ displayName, vcard }]
      }
    }, { quoted: ctx.message });
    await reply(ctx, `👑 Owner: ${displayName}\n📞 Contact: ${phone}`);
  }});
  add({ name: 'prefix', category: 'core', desc: 'Show current prefix', handler: async (ctx) => reply(ctx, `Current prefix: ${getConfig().prefix}`) });
  add({ name: 'commandcount', aliases: ['cmdcount'], category: 'core', desc: 'Show command count', handler: async (ctx) => reply(ctx, `Loaded commands: ${commands.length}\nAliases included: ${registry.size}`) });
  add({ name: 'about', aliases: ['info'], category: 'core', desc: 'About this merge', handler: async (ctx) => reply(ctx, 'Merged command set inspired by KnightBot Mini, Knightbot MD, NOVA-XMD, and Malaitechx. Built with Baileys and supports QR/pairing login.') });

  add({ name: 'setprefix', aliases: ['prefixset','newprefix'], category: 'owner', ownerOnly: true, desc: 'Change command prefix. Supports .setprefix+ with no space.', usage: '<prefix>', handler: async (ctx) => {
    const p = String(ctx.args[0] || '').trim();
    if (!p) return reply(ctx, `Usage:
${ctx.prefix}setprefix +
${ctx.prefix}setprefix+`);
    if (/\s/.test(p) || p.length > 10) return reply(ctx, 'Prefix cannot contain spaces and must be 10 characters or fewer.');
    saveConfig({ prefix: p });
    await reply(ctx, `✅ Prefix updated to: ${p}
Now use commands like: ${p}menu`);
  }});
  add({ name: 'mode', category: 'owner', ownerOnly: true, desc: 'Set public/private mode', usage: '<public|private>', handler: async (ctx) => {
    const arg = (ctx.args[0] || '').toLowerCase();
    if (!['public','private'].includes(arg)) return reply(ctx, `Current mode: ${getConfig().publicMode ? 'public' : 'private'}\nUsage: mode public/private`);
    saveConfig({ publicMode: arg === 'public' });
    await reply(ctx, `Mode updated to ${arg}.`);
  }});
  add({ name: 'settings', aliases: ['setting', 'toggles', 'config'], category: 'owner', ownerOnly: true, desc: 'Show all on/off bot settings or change one', usage: '[name] [on|off]', handler: async (ctx) => {
    const cfg = getConfig();
    const st = getState();
    const key = (ctx.args[0] || '').toLowerCase();
    const action = (ctx.args[1] || '').toLowerCase();

    // Change a setting: .settings autorecord on
    if (key && ['on', 'off'].includes(action)) {
      const realName = setToggle(st, key, action === 'on');
      if (!realName) {
        return reply(ctx, `❌ Unknown setting: *${key}*\nType ${cfg.prefix}settings to see all available settings.`);
      }
      saveState(st);
      let extra = '';
      if (realName === 'autobio' && action === 'on') extra = `\n${await updateAutoBioFromCommand(ctx)}`;
      const newStatus = isToggleEnabled(st, realName);
      return reply(ctx, `⚙️ *Setting Updated*\n\n${newStatus ? '✅' : '❌'} *${realName}* → *${newStatus ? 'ON' : 'OFF'}*${extra}\n\nType ${cfg.prefix}settings to see all settings.\n\n*Made by Kimani Samuel*`);
    }

    // Check a single setting: .settings autorecord
    if (key && !action) {
      const enabled = isToggleEnabled(st, key);
      return reply(ctx, `⚙️ *${key}*: ${enabled ? '✅ ON' : '❌ OFF'}\n\nUsage: ${cfg.prefix}settings ${key} on/off\n\n*Made by Kimani Samuel*`);
    }

    // Show full settings board
    const TOGGLE_ICONS = {
      greet: '👋', commandreact: '⚡', autobio: '📝', autostatus: '❤️',
      autoreact: '😀', antilink: '🔗', antitag: '🏷️', antibadword: '🤬',
      antidelete: '🗑️', antidelete_status: '📊', antideleteviewonce: '👁️',
      antistatus: '🚫', anticall: '📵', pmblocker: '🔒', autoread: '👀',
      autotyping: '⌨️', autorecord: '🎙️', welcome: '🎉', goodbye: '👋',
      mention: '📣', antiword: '🚫', antigroupmention: '👥', autosticker: '🎨'
    };

    // Import TOGGLE_DEFINITIONS dynamically from settings
    const { TOGGLE_DEFINITIONS: defs } = await import('./settings.js');
    const toggles = defs.map((item, i) => {
      const on = isToggleEnabled(st, item.name);
      const icon = TOGGLE_ICONS[item.name] || '🔧';
      const status = on ? '✅ ON ' : '❌ OFF';
      return `┃ ${icon} ${status}  ${cfg.prefix}${item.name}`;
    });

    const board = `╔══════════════════════════╗
┃  ⚙️ *${cfg.botName} SETTINGS*  
╠══════════════════════════╣
┃ Usage: ${cfg.prefix}settings <name> on/off
┃ Example: ${cfg.prefix}settings autorecord on
╠══════════════════════════╣
${toggles.join('\n')}
╚══════════════════════════╝

*Made by Kimani Samuel*`;

    await reply(ctx, board);
  }});

  add({ name: 'ban', category: 'owner', ownerOnly: true, desc: 'Ban a user from commands', handler: async (ctx) => {
    const target = pickTarget(ctx.message, ctx.sender);
    const st = getState();
    if (!st.banned.includes(target)) st.banned.push(target);
    saveState(st);
    await reply(ctx, `Banned @${normalizeNumber(target)}`, { mentions: [target] });
  }});
  add({ name: 'unban', category: 'owner', ownerOnly: true, desc: 'Unban a user', handler: async (ctx) => {
    const target = pickTarget(ctx.message, ctx.sender);
    const st = getState();
    st.banned = st.banned.filter(x => x !== target);
    saveState(st);
    await reply(ctx, `Unbanned @${normalizeNumber(target)}`, { mentions: [target] });
  }});
  add({ name: 'clearsession', aliases: ['clearsess'], category: 'owner', ownerOnly: true, desc: 'Show session reset instructions', handler: async (ctx) => reply(ctx, 'To reset session safely: stop the bot, delete the session folder, then run npm start again.') });

  add({ name: 'pair', aliases: ['paircode', 'getpair'], category: 'owner', ownerOnly: true, desc: 'Generate a WhatsApp pairing code', usage: '<number>', handler: async (ctx) => {
    const input = textArg(ctx.args);
    if (!input) return reply(ctx, `Usage: ${getConfig().prefix}pair 15551234567`);

    let number;
    try {
      number = validatePairingNumber(input);
    } catch (err) {
      return reply(ctx, err.message || String(err));
    }

    // If this command ever runs before registration, use local Baileys pairing directly.
    if (!ctx.sock.authState?.creds?.registered && typeof ctx.sock.requestPairingCode === 'function') {
      try {
        const code = formatPairingCode(await ctx.sock.requestPairingCode(number));
        return reply(ctx, pairInstructions(code));
      } catch (err) {
        return reply(ctx, `Local pairing failed: ${err.message || err}`);
      }
    }

    const baseUrl = (process.env.PAIRING_API_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
      return reply(ctx, [
        'This running WhatsApp session is already linked, so Baileys cannot create a new local pair code from chat.',
        '',
        'To pair a fresh session:',
        '1. Stop the bot.',
        '2. Delete the session folder.',
        `3. Start with PAIRING_NUMBER=${number} npm start, or open your hosted /code?number=${number} endpoint.`,
        '',
        'Optional: set PAIRING_API_URL to an external pairing service if you want this .pair command to call that service.'
      ].join('\n'));
    }

    try {
      const { data } = await axios.get(`${baseUrl}/code?number=${encodeURIComponent(number)}`, { timeout: 20000 });
      const code = data?.code || data?.pairingCode || data?.pair || data?.message;
      if (!code) throw new Error('Pairing API returned no code.');
      return reply(ctx, pairInstructions(String(code)));
    } catch (err) {
      return reply(ctx, `Pairing API failed: ${err.message || err}`);
    }
  }});
  add({ name: 'restart', category: 'owner', ownerOnly: true, desc: 'Exit process so host restarts it', handler: async (ctx) => { await reply(ctx, 'Restarting process...'); setTimeout(() => process.exit(0), 500); } });

  add({ name: 'jid', aliases: ['groupjid'], category: 'utility', desc: 'Show current chat JID', handler: async (ctx) => reply(ctx, `Chat JID: ${ctx.chatId}\nSender: ${ctx.sender}`) });
  add({ name: 'userid', aliases: ['uid'], category: 'utility', desc: 'Show your WhatsApp ID', handler: async (ctx) => reply(ctx, `Your ID: ${ctx.sender}`) });
  add({ name: 'date', category: 'utility', desc: 'Show server date', handler: async (ctx) => reply(ctx, new Date().toDateString()) });
  add({ name: 'time', category: 'utility', desc: 'Show server time', handler: async (ctx) => reply(ctx, new Date().toLocaleString()) });
  add({ name: 'calc', aliases: ['calculate','math'], category: 'utility', desc: 'Calculate math', usage: '<expression>', handler: async (ctx) => {
    const expression = textArg(ctx.args);
    if (!expression) return reply(ctx, 'Usage: calc 12 * (4 + 3)');
    try { await reply(ctx, `${expression} = ${safeEvalMath(expression)}`); } catch (e) { await reply(ctx, `Math error: ${e.message}`); }
  }});
  add({ name: 'coinflip', aliases: ['coin'], category: 'utility', desc: 'Flip a coin', handler: async (ctx) => reply(ctx, randomChoice(['Heads','Tails'])) });
  add({ name: 'dice', aliases: ['roll'], category: 'utility', desc: 'Roll dice', handler: async (ctx) => reply(ctx, `Dice: ${1 + Math.floor(Math.random() * 6)}`) });
  add({ name: 'random', aliases: ['rand'], category: 'utility', desc: 'Random number', usage: '<min> <max>', handler: async (ctx) => {
    const min = Number(ctx.args[0] || 1), max = Number(ctx.args[1] || 100);
    const lo = Math.min(min, max), hi = Math.max(min, max);
    await reply(ctx, String(lo + Math.floor(Math.random() * (hi - lo + 1))));
  }});
  add({ name: 'choose', aliases: ['pick'], category: 'utility', desc: 'Choose from options split by |', usage: 'tea | coffee', handler: async (ctx) => {
    const opts = textArg(ctx.args).split('|').map(x => x.trim()).filter(Boolean);
    if (opts.length < 2) return reply(ctx, 'Usage: choose option 1 | option 2 | option 3');
    await reply(ctx, `I choose: ${randomChoice(opts)}`);
  }});
  add({ name: 'password', aliases: ['passgen'], category: 'utility', desc: 'Generate password', handler: async (ctx) => {
    const len = Math.min(Math.max(Number(ctx.args[0] || 16), 6), 64);
    const chars = 'ABCDEFGHJKLMN8SjFSqSJ6DYAcBJrNGN76hEhcij5vtyJK5G819CvV7Fm!@#$%';
    let out = ''; for (let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
    await reply(ctx, out);
  }});
  add({ name: 'uuid', category: 'utility', desc: 'Generate UUID', handler: async (ctx) => reply(ctx, crypto.randomUUID()) });
  add({ name: 'shortid', category: 'utility', desc: 'Generate short ID', handler: async (ctx) => reply(ctx, crypto.randomBytes(6).toString('hex')) });
  add({ name: 'qr', category: 'utility', desc: 'Create QR code link', usage: '<text>', handler: async (ctx) => {
    const t = encodeURIComponent(textArg(ctx.args));
    if (!t) return reply(ctx, 'Usage: qr hello world');
    await ctx.sock.sendMessage(ctx.chatId, { image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${t}` }, caption: 'QR generated' }, { quoted: ctx.message });
  }});

  // Group and admin commands
  add({ name: 'groupinfo', aliases: ['ginfo'], category: 'group', groupOnly: true, desc: 'Show group name, description, dp, admins, and members', handler: async (ctx) => {
    const meta = await ctx.sock.groupMetadata(ctx.chatId);
    const participants = meta.participants.map(p => p.id || p.jid).filter(Boolean);
    const admins = meta.participants.filter(p => p.admin || p.isAdmin).map(p => p.id || p.jid).filter(Boolean);
    const desc = meta.desc || meta.description || 'No description set.';
    const created = meta.creation ? new Date(Number(meta.creation) * 1000).toLocaleString() : 'Unknown';
    const summary = [
      `╭─〔 GROUP INFO 〕`,
      `│ Name: ${meta.subject || 'Unknown'}`,
      `│ Description: ${desc}`,
      `│ Members: ${participants.length}`,
      `│ Admins: ${admins.length}`,
      `│ Owner: ${meta.owner ? '@' + normalizeNumber(meta.owner) : 'unknown'}`,
      `│ Created: ${created}`,
      `│ ID: ${ctx.chatId}`,
      `╰────────────`
    ];
    const lines = [
      ...summary,
      '',
      'Admins:',
      ...(admins.length ? admins.map((j, i) => `${i + 1}. @${normalizeNumber(j)}`) : ['No admins found.']),
      '',
      'Members:',
      ...(participants.length ? participants.map((j, i) => `${i + 1}. @${normalizeNumber(j)}`) : ['No members found.'])
    ];
    const mentions = [...new Set([meta.owner, ...admins, ...participants].filter(Boolean))];
    const fullInfo = lines.join('\n');
    let sentDp = false;
    try {
      const pp = await ctx.sock.profilePictureUrl(ctx.chatId, 'image');
      await ctx.sock.sendMessage(ctx.chatId, { image: { url: pp }, caption: summary.join('\n'), mentions }, { quoted: ctx.message });
      sentDp = true;
    } catch {}
    await sendLongReply(ctx, sentDp ? fullInfo : `${fullInfo}\n\nGroup DP: not available.`, { mentions });
  }});
  add({ name: 'totalmembers', aliases: ['members'], category: 'group', groupOnly: true, desc: 'Count group members', handler: async (ctx) => {
    const meta = await ctx.sock.groupMetadata(ctx.chatId);
    await reply(ctx, `Total members: ${meta.participants.length}`);
  }});
  add({ name: 'admins', aliases: ['staff'], category: 'group', groupOnly: true, desc: 'List group admins', handler: async (ctx) => {
    const admins = await groupAdmins(ctx.sock, ctx.chatId);
    await reply(ctx, admins.map(j => `@${normalizeNumber(j)}`).join('\n') || 'No admins found', { mentions: admins });
  }});
  add({ name: 'tagall', aliases: ['everyone'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Mention every group member', handler: async (ctx) => {
    const meta = await ctx.sock.groupMetadata(ctx.chatId);
    const mentions = meta.participants.map(p => p.id || p.jid);
    await sendLongReply(ctx, mentions.map((j, i) => `${i + 1}. @${normalizeNumber(j)}`).join('\n'), { mentions });
  }});
  add({ name: 'hidetag', aliases: ['htag'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Send hidden-tag message', usage: '<message>', handler: async (ctx) => {
    const meta = await ctx.sock.groupMetadata(ctx.chatId);
    const mentions = meta.participants.map(p => p.id || p.jid);
    await reply(ctx, textArg(ctx.args, 'Hidden tag'), { mentions });
  }});
  add({ name: 'tagadmin', aliases: ['tagadmins'], category: 'group', groupOnly: true, desc: 'Mention admins', handler: async (ctx) => {
    const admins = await groupAdmins(ctx.sock, ctx.chatId);
    await reply(ctx, admins.map(j => `@${normalizeNumber(j)}`).join('\n') || 'No admins found', { mentions: admins });
  }});
  add({ name: 'kick', aliases: ['remove'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Remove mentioned/replied users or typed numbers from group', usage: '@user | +254...', handler: async (ctx) => {
    await ensureBotGroupAdmin(ctx, 'kick/remove members');
    const rawTargets = jidsFromArgs(ctx);
    if (!rawTargets.length) return reply(ctx, `Usage: ${getConfig().prefix}kick @user or ${getConfig().prefix}kick +254101223737`);
    const targets = await resolveGroupTargets(ctx, rawTargets);
    const botNumber = normalizeNumber(ctx.sock.user?.id || ctx.sock.user?.jid || '');
    const safeTargets = targets.filter(jid => normalizeNumber(jid) !== botNumber && normalizeNumber(jid) !== normalizeNumber(getConfig().ownerNumber));
    if (!safeTargets.length) return reply(ctx, 'I cannot remove myself or the bot owner.');
    try {
      await ctx.sock.groupParticipantsUpdate(ctx.chatId, safeTargets, 'remove');
      await reply(ctx, `✅ Removed ${formatTargetList(safeTargets)}`, { mentions: safeTargets });
    } catch (err) {
      await reply(ctx, `Kick failed: ${err.message || err}. Make sure I am admin and the target is still in this group.`);
    }
  }});
  add({ name: 'add', aliases: ['inviteuser','adduser'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Add one or many numbers to the group', usage: '+254101223737 +254...', handler: async (ctx) => {
    await ensureBotGroupAdmin(ctx, 'add members');

    // Parse numbers from all args — accept 2540700000000, +2540700000000, 0700000000, quoted, or mentioned
    const rawText = ctx.rawText || ctx.args.join(' ');
    const tokenSet = new Set();

    // From mentions/quoted
    jidsFromArgs(ctx, { includeQuoted: true, includeMentions: true }).forEach(j => tokenSet.add(j));

    // From raw text — match phone-like tokens
    for (const token of rawText.split(/[\s,;|]+/)) {
      const cleaned = token.replace(/[^\d+]/g, '');
      if (cleaned.length >= 5) {
        const jid = toUserJid(cleaned);
        if (jid) tokenSet.add(jid);
      }
    }

    const targets = [...tokenSet];
    if (!targets.length) return reply(ctx, `Usage: ${getConfig().prefix}add +254700000000 +254711000000\nYou can provide multiple numbers separated by spaces.`);

    const resultLines = [];
    for (const jid of targets) {
      const num = normalizeNumber(jid);
      try {
        const res = await ctx.sock.groupParticipantsUpdate(ctx.chatId, [jid], 'add');
        const status = Array.isArray(res) ? (res[0]?.status || 'unknown') : (res?.status || 'sent');
        if (status === '200' || status === 200 || status === 'added') {
          resultLines.push(`✅ @${num} added successfully`);
        } else if (status === '403' || status === 403) {
          resultLines.push(`⛔ @${num} has privacy settings that prevent adding. Send invite link instead.`);
        } else if (status === '408' || status === 408) {
          resultLines.push(`⏱️ @${num} timed out. They may not be on WhatsApp.`);
        } else if (status === '401' || status === 401) {
          resultLines.push(`❌ @${num} blocked the bot or is not on WhatsApp.`);
        } else {
          resultLines.push(`✅ @${num} add request sent (status: ${status})`);
        }
      } catch (err) {
        const msg = err.message || String(err);
        if (msg.includes('not-authorized') || msg.includes('403')) {
          resultLines.push(`⛔ @${num} — privacy settings block adding. Share the invite link instead.`);
        } else if (msg.includes('not on WhatsApp') || msg.includes('408')) {
          resultLines.push(`❓ @${num} — not found on WhatsApp.`);
        } else {
          resultLines.push(`❌ @${num} — failed: ${msg.slice(0, 80)}`);
        }
      }
      await new Promise(r => setTimeout(r, 400));
    }
    await reply(ctx, resultLines.join('\n'), { mentions: targets });
  }});
  add({ name: 'approve', aliases: ['accept','approveall'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Approve pending group join requests', usage: '[number/@user] or approveall', handler: async (ctx) => {
    await ensureBotGroupAdmin(ctx, 'approve join requests');
    let targets = jidsFromArgs(ctx);
    const wantsAll = ctx.commandName === 'approveall' || !targets.length || /^(all)$/i.test(ctx.args[0] || '');
    if (wantsAll && typeof ctx.sock.grKe9UDk2eYoMm9CAJhsv2CBGW7CUFSPNhu === 'function') {
      const pending = await ctx.sock.grKe9UDk2eYoMm9CAJhsv2CBGW7CUFSPNhu(ctx.chatId).catch(() => []);
      targets = (pending || []).map(p => p.jid || p.id).filter(Boolean);
    }
    if (!targets.length) return reply(ctx, 'No pending requests found. You can also mention a user or type their number.');
    if (typeof ctx.sock.grKe9UDk2eYoMm9CAJhsv2CBGW7CUFSPNhu !== 'function') {
      return reply(ctx, 'This Baileys version/WhatsApp account does not expose pending request approval on this host.');
    }
    const result = await ctx.sock.grKe9UDk2eYoMm9CAJhsv2CBGW7CUFSPNhu(ctx.chatId, targets, 'approve');
    await reply(ctx, `Approved ${formatTargetList(targets)}${result ? `\nResult: ${JSON.stringify(result).slice(0, 900)}` : ''}`, { mentions: targets });
  }});
  add({ name: 'block', category: 'owner', ownerOnly: true, desc: 'Block a WhatsApp user by reply, mention, or number', usage: '@user | +254...', handler: async (ctx) => {
    const targets = jidsFromArgs(ctx);
    if (!targets.length) return reply(ctx, `Usage: ${getConfig().prefix}block @user or ${getConfig().prefix}block +254101223737`);
    for (const target of targets) await ctx.sock.updateBlockStatus(target, 'block');
    await reply(ctx, `Blocked ${formatTargetList(targets)}`, { mentions: targets });
  }});
  add({ name: 'unblock', category: 'owner', ownerOnly: true, desc: 'Unblock a WhatsApp user by reply, mention, or number', usage: '@user | +254...', handler: async (ctx) => {
    const targets = jidsFromArgs(ctx);
    if (!targets.length) return reply(ctx, `Usage: ${getConfig().prefix}unblock @user or ${getConfig().prefix}unblock +254101223737`);
    for (const target of targets) await ctx.sock.updateBlockStatus(target, 'unblock');
    await reply(ctx, `Unblocked ${formatTargetList(targets)}`, { mentions: targets });
  }});
  add({ name: 'promote', category: 'group', groupOnly: true, adminOnly: true, desc: 'Promote user to admin', usage: '@user | +254...', handler: async (ctx) => {
    await ensureBotGroupAdmin(ctx, 'promote members');
    const rawTargets = jidsFromArgs(ctx);
    if (!rawTargets.length) return reply(ctx, 'Mention, reply, or type a number to promote.');
    const targets = await resolveGroupTargets(ctx, rawTargets);
    try {
      await ctx.sock.groupParticipantsUpdate(ctx.chatId, targets, 'promote');
      const promoterNum = normalizeNumber(ctx.sender);
      const userLines = targets.map(j => `• @${normalizeNumber(j)}`).join('\n');
      const msg =
        `*『 GROUP PROMOTION 』*\n\n` +
        `👥 *Promoted User${targets.length > 1 ? 's' : ''}:*\n${userLines}\n\n` +
        `👑 *Promoted By:* @${promoterNum}\n` +
        `📅 *Date:* ${new Date().toLocaleString()}`;
      await reply(ctx, msg, { mentions: [...targets, ctx.sender] });
    } catch (err) {
      await reply(ctx, `❌ Promote failed: ${err.message || err}`);
    }
  }});
  add({ name: 'demote', category: 'group', groupOnly: true, adminOnly: true, desc: 'Demote admin to member', usage: '@user | +254...', handler: async (ctx) => {
    await ensureBotGroupAdmin(ctx, 'demote admins');
    const rawTargets = jidsFromArgs(ctx);
    if (!rawTargets.length) return reply(ctx, 'Mention, reply, or type a number to demote.');
    const targets = await resolveGroupTargets(ctx, rawTargets);
    try {
      await new Promise(r => setTimeout(r, 800));
      await ctx.sock.groupParticipantsUpdate(ctx.chatId, targets, 'demote');
      const demoterNum = normalizeNumber(ctx.sender);
      const userLines = targets.map(j => `• @${normalizeNumber(j)}`).join('\n');
      const msg =
        `*『 GROUP DEMOTION 』*\n\n` +
        `👤 *Demoted User${targets.length > 1 ? 's' : ''}:*\n${userLines}\n\n` +
        `👑 *Demoted By:* @${demoterNum}\n` +
        `📅 *Date:* ${new Date().toLocaleString()}`;
      await reply(ctx, msg, { mentions: [...targets, ctx.sender] });
    } catch (err) {
      if (String(err?.data || err?.message || err).includes('429')) {
        await new Promise(r => setTimeout(r, 2000));
        await reply(ctx, '⚠️ Rate limit hit. Please try again in a few seconds.');
      } else {
        await reply(ctx, `❌ Demote failed: ${err.message || err}`);
      }
    }
  }});
  add({ name: 'open', aliases: ['unlock', 'unmute'], category: 'group',
    groupOnly: true, adminOnly: true,
    desc: 'Open group — everyone can send messages',
    handler: async (ctx) => {
      try {
        await ctx.sock.groupSettingUpdate(ctx.chatId, 'not_announcement');
        const meta = await ctx.sock.groupMetadata(ctx.chatId).catch(() => null);
        const name = meta?.subject || 'This group';
        await reply(ctx,
`🔓 *GROUP OPENED*

📢 *${name}*
✅ All members can now send messages
👑 Opened by: @${normalizeNumber(ctx.sender)}`,
          { mentions: [ctx.sender] }
        );
      } catch (err) {
        await reply(ctx, `❌ Failed to open group: ${err.message}`);
      }
    }
  });

  add({ name: 'lock', aliases: ['close', 'mute'], category: 'group',
    groupOnly: true, adminOnly: true,
    desc: 'Lock group — only admins can send messages',
    handler: async (ctx) => {
      try {
        await ctx.sock.groupSettingUpdate(ctx.chatId, 'announcement');
        const meta = await ctx.sock.groupMetadata(ctx.chatId).catch(() => null);
        const name = meta?.subject || 'This group';
        await reply(ctx,
`🔒 *GROUP LOCKED*

📢 *${name}*
🚫 Only admins can send messages now
👑 Locked by: @${normalizeNumber(ctx.sender)}`,
          { mentions: [ctx.sender] }
        );
      } catch (err) {
        await reply(ctx, `❌ Failed to lock group: ${err.message}`);
      }
    }
  });
  add({ name: 'grouplink', aliases: ['link'], category: 'group', groupOnly: true, desc: 'Get invite link', handler: async (ctx) => { const code = await ctx.sock.groupInviteCode(ctx.chatId); await reply(ctx, `https://chat.whatsapp.com/${code}`); } });
  add({ name: 'resetlink', aliases: ['revoke'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Reset group invite link', handler: async (ctx) => { const code = await ctx.sock.groupRevokeInvite(ctx.chatId); await reply(ctx, `New link: https://chat.whatsapp.com/${code}`); } });
  add({ name: 'setgname', aliases: ['setgroupname'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Set group name', usage: '<name>', handler: async (ctx) => { const t = textArg(ctx.args); if (!t) return reply(ctx, 'Usage: setgname New Name'); await ctx.sock.groupUpdateSubject(ctx.chatId, t); await reply(ctx, 'Group name updated.'); } });
  add({ name: 'setgdesc', aliases: ['setdesc'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Set group description', usage: '<desc>', handler: async (ctx) => { const t = textArg(ctx.args); if (!t) return reply(ctx, 'Usage: setgdesc New description'); await ctx.sock.groupUpdateDescription(ctx.chatId, t); await reply(ctx, 'Group description updated.'); } });

  // Text commands
  const addText = (name, desc, transform, aliases = []) => add({ name, aliases, category: 'text', desc, usage: '<text>', handler: async (ctx) => { const t = textArg(ctx.args); if (!t) return reply(ctx, `Usage: ${getConfig().prefix}${name} <text>`); await reply(ctx, transform(t)); } });
  addText('reverse', 'Reverse text', t => [...t].reverse().join(''));
  addText('upper', 'Uppercase text', t => t.toUpperCase(), ['uppercase']);
  addText('lower', 'Lowercase text', t => t.toLowerCase(), ['lowercase']);
  addText('capitalize', 'Capitalize text', t => t.charAt(0).toUpperCase() + t.slice(1));
  addText('titlecase', 'Title-case text', t => t.replace(/\w\S*/g, x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()));
  addText('mock', 'Mocking text', t => [...t].map((c,i)=> i%2?c.toLowerCase():c.toUpperCase()).join(''));
  addText('clap', 'Clap text', t => t.split(/\s+/).join(' 👏 '));
  addText('space', 'Space letters', t => [...t].join(' '));
  addText('vapor', 'Vaporwave text', t => [...t].map(c => c === ' ' ? '　' : String.fromCharCode(c.charCodeAt(0) + (c >= '!' && c <= '~' ? 65248 : 0))).join(''));
  addText('bold', 'Bold unicode text', t => toFancy(t, 'bold'));
  addText('italic', 'Italic unicode text', t => toFancy(t, 'italic'));
  addText('mono', 'Monospace unicode text', t => toFancy(t, 'mono'));
  addText('double', 'Double-struck unicode text', t => toFancy(t, 'double'));
  addText('circletext', 'Circle unicode text', t => toFancy(t, 'circle'), ['circlefont']);
  addText('binary', 'Text to binary', t => [...t].map(c => c.charCodeAt(0).toString(2).padStart(8,'0')).join(' '));
  addText('unbinary', 'Binary to text', t => t.split(/\s+/).map(b => String.fromCharCode(parseInt(b,2))).join(''));
  addText('base64', 'Encode base64', t => Buffer.from(t).toString('base64'), ['b64']);
  addText('unbase64', 'Decode base64', t => Buffer.from(t, 'base64').toString('utf8'), ['unb64']);
  addText('urlencode', 'URL encode', t => encodeURIComponent(t));
  addText('urldecode', 'URL decode', t => decodeURIComponent(t));
  addText('morse', 'Text to morse', t => t.toLowerCase().split('').map(c => c === ' ' ? '/' : morseMap[c] || c).join(' '));
  addText('unmorse', 'Morse to text', t => t.split(/\s+/).map(c => c === '/' ? ' ' : reverseMorse[c] || c).join(''));
  addText('charcount', 'Count characters', t => `Characters: ${[...t].length}`);
  addText('wordcount', 'Count words', t => `Words: ${t.trim().split(/\s+/).filter(Boolean).length}`);
  addText('emojify', 'Add emoji between words', t => t.split(/\s+/).join(' ✨ '));

  addText('spoiler', 'WhatsApp spoiler style', t => `||${t}||`);

  // ─── SPECIAL TEXT MAKERS (Working versions with styling) ───────────────
  add({ name: 'christmas', aliases: ['xmas', 'christmastext'], category: 'textmaker', 
    desc: 'Christmas styled text', usage: '<text>', 
    handler: async (ctx) => {
      const text = textArg(ctx.args);
      if (!text) return reply(ctx, `Usage: ${getConfig().prefix}christmas Your Text`);
      const fancy = toFancy(text, 'bold');
      const styled = `🎄🎅 ${fancy} 🎄🎅
╭─ ✨ MERRY CHRISTMAS ✨ ─╮
│  🎁 ${text.toUpperCase()} 🎁
│  ❄️  Happy Holidays!  ❄️
╰──────────────────────╯`;
      await reply(ctx, styled);
    }
  });

  add({ name: 'aesthetic', aliases: ['aes', 'vaporwave'], category: 'textmaker',
    desc: 'Aesthetic/vaporwave styled text', usage: '<text>',
    handler: async (ctx) => {
      const text = textArg(ctx.args);
      if (!text) return reply(ctx, `Usage: ${getConfig().prefix}aesthetic Your Text`);
      const fancy = [...text].map(c => c === ' ' ? '　' : String.fromCharCode(c.charCodeAt(0) + (c >= '!' && c <= '~' ? 65248 : 0))).join('');
      const styled = `╭─ ✨ 𝘈𝘌𝘚𝘛𝘏𝘌𝘛𝘐𝘊 ✨ ─╮
│  ${fancy}
│  🌸 ~ 𝘭𝘰 𝘧𝘪 𝘨𝘳𝘪 𝘢𝘴 ~ 🌸
╰──────────────────────╯`;
      await reply(ctx, styled);
    }
  });

  add({ name: 'gothic', aliases: ['goth', 'darktext'], category: 'textmaker',
    desc: 'Gothic/dark styled text', usage: '<text>',
    handler: async (ctx) => {
      const text = textArg(ctx.args);
      if (!text) return reply(ctx, `Usage: ${getConfig().prefix}gothic Your Text`);
      const fancy = toFancy(text, 'bold');
      const styled = `╭─ 🖤 GOTHIC 🖤 ─╮
│  ${fancy}
│  ⚰️  D̸̰͘a̸̜͋r̸̠̒k̸̝̈́n̸̰͝e̸̱͘s̸͎̊s̸̛̖  ⚰️
│  🦇 Embrace The Shadow 🦇
╰──────────────────────╯`;
      await reply(ctx, styled);
    }
  });

  add({ name: 'happy', aliases: ['birthday', 'celebrate'], category: 'textmaker',
    desc: 'Happy/party styled text', usage: '<text>',
    handler: async (ctx) => {
      const text = textArg(ctx.args);
      if (!text) return reply(ctx, `Usage: ${getConfig().prefix}happy Your Text`);
      const fancy = toFancy(text, 'bold');
      const styled = `🎉🎊🎈🎁🎀🎈🎊🎉
╭─ 🌈 HAPPY 🌈 ─╮
│  ${fancy}
│  🎂 Celebrate! 🎂
│  🎪 Let's Party! 🎪
╰──────────────────────╯
🎉🎊🎈🎁🎀🎈🎊🎉`;
      await reply(ctx, styled);
    }
  });

  // Fun and game commands
  add({ name: 'joke', category: 'fun', desc: 'Random joke', handler: async (ctx) => reply(ctx, randomChoice(jokes)) });
  add({ name: 'fact', category: 'fun', desc: 'Random fact', handler: async (ctx) => reply(ctx, randomChoice(facts)) });
  add({ name: 'quote', category: 'fun', desc: 'Random quote', handler: async (ctx) => reply(ctx, randomChoice(quotes)) });
  add({ name: 'truth', category: 'fun', desc: 'Truth question', handler: async (ctx) => reply(ctx, randomChoice(truths)) });
  add({ name: 'dare', category: 'fun', desc: 'Dare challenge', handler: async (ctx) => reply(ctx, randomChoice(dares)) });
  add({ name: 'compliment', aliases: ['complimentry'], category: 'fun', desc: 'Compliment a user', handler: async (ctx) => { const t = pickTarget(ctx.message, ctx.sender); await reply(ctx, `@${normalizeNumber(t)} is ${randomChoice(compliments)}.`, { mentions: [t] }); } });
  add({ name: 'insult', category: 'fun', desc: 'Playful roast', handler: async (ctx) => { const t = pickTarget(ctx.message, ctx.sender); await reply(ctx, `@${normalizeNumber(t)} ${randomChoice(insults)}.`, { mentions: [t] }); } });
  add({ name: 'flirt', category: 'fun', desc: 'Flirty line', handler: async (ctx) => reply(ctx, randomChoice(['Are you Wi-Fi? Because I feel connected.', 'You must be a keyboard, because you are just my type.', 'Are you a bug? Because I cannot stop debugging my feelings.'])) });
  add({ name: '8ball', aliases: ['eightball'], category: 'fun', desc: 'Ask magic 8 ball', handler: async (ctx) => reply(ctx, randomChoice(['Yes.', 'No.', 'Maybe.', 'Definitely.', 'Ask again later.', 'The bot says yes.'])) });
  add({ name: 'ship', category: 'fun', desc: 'Ship two users/names', handler: async (ctx) => { const names = textArg(ctx.args, 'you + bot'); await reply(ctx, `${names}: ${hashPercent(names)}% compatible`); } });
  add({ name: 'truthdetector', aliases: ['lie'], category: 'fun', desc: 'Fake truth detector', handler: async (ctx) => reply(ctx, randomChoice(['Truth detected.', 'Lie detected.', 'Unclear. Try again with more confidence.'])) });
  add({ name: 'rps', aliases: ['rockpaper'], category: 'games', desc: 'Rock paper scissors', usage: '<rock|paper|scissors>', handler: async (ctx) => { const user = (ctx.args[0]||'').toLowerCase(); const bot = randomChoice(['rock','paper','scissors']); if (!['rock','paper','scissors'].includes(user)) return reply(ctx, 'Usage: rps rock/paper/scissors'); await reply(ctx, `You: ${user}\nBot: ${bot}`); } });
  add({ name: 'hangman', category: 'games', desc: 'Mini hangman prompt', handler: async (ctx) => reply(ctx, 'Hangman word: _ _ _\nThis lightweight build supports prompt mode. Use tictactoe, rps, dice, or quiz for interactive games.') });
  add({ name: 'tictactoe', aliases: ['ttt'], category: 'games', desc: 'Tic-tac-toe info', handler: async (ctx) => reply(ctx, 'TicTacToe board:\n1 | 2 | 3\n4 | 5 | 6\n7 | 8 | 9\nPair with a friend and send move numbers manually.') });

  for (const metric of ['gayrate','simprate','stupidrate','lovelyrate','cuterate','luckrate','smartcheck','horny','handsome','beautiful','coolrate','evilrate','goodrate','badboy','queenrate','kingrate']) {
    add({ name: metric, category: 'fun', desc: `${metric} percentage`, handler: async (ctx) => { const target = pickTarget(ctx.message, ctx.sender); await reply(ctx, `@${normalizeNumber(target)} ${metric}: ${hashPercent(metric + target)}%`, { mentions: [target] }); } });
  }


  // ─── AI: Multi-backend with OpenAI → Gemini → free API fallback ────────────
  const AI_BACKENDS = {
    openai: async (prompt, sys = 'You are a helpful assistant.') => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY not set');
      const { data } = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
        max_tokens: 800, temperature: 0.7
      }, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 });
      return data.choices[0].message.content.trim();
    },
    gemini: async (prompt) => {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GEMINI_API_KEY not set');
      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { timeout: 10000 }
      );
      return data.candidates[0].content.parts[0].text.trim();
    },
    free: async (prompt) => {
      // Free fallback APIs (no key required) — tested working June 2026
      const encoded = encodeURIComponent(prompt);
      const apis = [
        // pollinations.ai — completely free, reliable, no key
        async () => {
          const { data } = await axios.get(`https://text.pollinations.ai/${encoded}`, {
            timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'text'
          });
          if (typeof data === 'string' && data.length > 2) return data.trim();
          throw new Error('empty');
        },
        // DuckDuckGo AI Chat — free, no key
        async () => {
          const { data } = await axios.post('https://duckduckgo.com/duckchat/v1/chat', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }]
          }, {
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json', 'x-vqd-4': '4' }
          });
          const ans = data?.message || data?.choices?.[0]?.message?.content;
          if (ans) return ans.trim();
          throw new Error('empty');
        },
        // Dreaded API
        async () => {
          const { data } = await axios.get(`https://api.dreaded.site/api/ai?text=${encoded}`, {
            timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          const ans = data?.result?.message || data?.result || data?.message;
          if (ans && typeof ans === 'string' && ans.length > 2) return ans.trim();
          throw new Error('empty');
        },
        // BK9 API
        async () => {
          const { data } = await axios.get(`https://bk9.fun/ai/gpt4?q=${encoded}`, {
            timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          const ans = data?.BK9 || data?.result || data?.response;
          if (ans && typeof ans === 'string' && ans.length > 2) return ans.trim();
          throw new Error('empty');
        },
        // Agatz API
        async () => {
          const { data } = await axios.get(`https://api.agatz.xyz/api/ai?message=${encoded}`, {
            timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          const ans = data?.data || data?.result;
          if (ans && typeof ans === 'string' && ans.length > 2) return ans.trim();
          throw new Error('empty');
        },
      ];

      for (const apiFn of apis) {
        try { return await apiFn(); } catch { /* try next */ }
      }
      throw new Error('All AI backends unavailable. Add OPENAI_API_KEY or GEMINI_API_KEY to .env for reliable AI responses.');
    }
  };

  async function getAIResponse(prompt, sys) {
    if (process.env.OPENAI_API_KEY) {
      try { return await AI_BACKENDS.openai(prompt, sys); } catch (e) { console.warn('[AI] OpenAI failed:', e.message); }
    }
    if (process.env.GEMINI_API_KEY) {
      try { return await AI_BACKENDS.gemini(prompt); } catch (e) { console.warn('[AI] Gemini failed:', e.message); }
    }
    return await AI_BACKENDS.free(prompt);
  }

  async function sendAIReply(ctx, response) {
    const chunks = response.match(/[\s\S]{1,3800}/g) || [response];
    for (let i = 0; i < chunks.length; i++) {
      await reply(ctx, chunks[i]);
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400));
    }
  }

  add({ name: 'ai', aliases: ['bot'], category: 'ai', desc: 'Ask AI anything', usage: '<question>',
    handler: async (ctx) => {
      const q = textArg(ctx.args);
      if (!q) return reply(ctx, `Usage: ${getConfig().prefix}ai <your question>\nExample: ${getConfig().prefix}ai explain gravity`);
      await reply(ctx, `🤖 *Thinking...*`);
      try { await sendAIReply(ctx, await getAIResponse(q)); }
      catch (e) { await reply(ctx, `❌ ${e.message}`); }
    }
  });

  add({ name: 'gpt', aliases: ['chatgpt', 'openai'], category: 'ai', desc: 'Ask ChatGPT (requires OPENAI_API_KEY)', usage: '<prompt>',
    handler: async (ctx) => {
      const q = textArg(ctx.args);
      if (!q) return reply(ctx, `Usage: ${getConfig().prefix}gpt <question>`);
      if (!process.env.OPENAI_API_KEY) return reply(ctx, '❌ OPENAI_API_KEY not set.\n\nAdd to .env:\nOPENAI_API_KEY=sk-...\n\nGet yours at: platform.openai.com');
      await reply(ctx, `🧠 *GPT Processing...*`);
      try { await sendAIReply(ctx, await AI_BACKENDS.openai(q)); }
      catch (e) { await reply(ctx, `❌ GPT Error: ${e.message}`); }
    }
  });

  add({ name: 'gemini', aliases: ['bard'], category: 'ai', desc: 'Ask Google Gemini (requires GEMINI_API_KEY)', usage: '<prompt>',
    handler: async (ctx) => {
      const q = textArg(ctx.args);
      if (!q) return reply(ctx, `Usage: ${getConfig().prefix}gemini <question>`);
      if (!process.env.GEMINI_API_KEY) return reply(ctx, '❌ GEMINI_API_KEY not set.\n\nGet yours at: ai.google.dev\nThen add to .env:\nGEMINI_API_KEY=your-key');
      await reply(ctx, `✨ *Gemini Processing...*`);
      try { await sendAIReply(ctx, await AI_BACKENDS.gemini(q)); }
      catch (e) { await reply(ctx, `❌ Gemini Error: ${e.message}`); }
    }
  });

  add({ name: 'explain', aliases: ['eli5', 'simplify'], category: 'ai', desc: 'Explain something in simple terms', usage: '<topic>',
    handler: async (ctx) => {
      const topic = textArg(ctx.args);
      if (!topic) return reply(ctx, `Usage: ${getConfig().prefix}explain quantum physics`);
      await reply(ctx, `📖 *Explaining:* ${topic}...`);
      try {
        const res = await getAIResponse(`Explain "${topic}" in simple terms a 10-year-old can understand. Use analogies and everyday examples.`);
        await sendAIReply(ctx, res);
      } catch (e) { await reply(ctx, `❌ ${e.message}`); }
    }
  });

  add({ name: 'translate', aliases: ['trans', 'trt'], category: 'ai', desc: 'Translate text to another language', usage: '<language>|<text>',
    handler: async (ctx) => {
      const raw = textArg(ctx.args);
      const [lang, ...rest] = raw.split('|');
      const text = rest.join('|').trim();
      if (!lang || !text) return reply(ctx, `Usage: ${getConfig().prefix}translate Spanish|Hello world\nOR: ${getConfig().prefix}translate French|Good morning`);
      await reply(ctx, `🌍 *Translating to ${lang.trim()}...*`);
      try {
        const res = await getAIResponse(`Translate the following to ${lang.trim()}. Reply with the translation only:\n\n"${text}"`);
        await reply(ctx, `✅ *${lang.trim()} Translation:*\n\n${res}`);
      } catch (e) { await reply(ctx, `❌ Translation failed: ${e.message}`); }
    }
  });

  add({ name: 'code', aliases: ['codegen', 'program'], category: 'ai', desc: 'Get coding help from AI', usage: '<language>|<question>',
    handler: async (ctx) => {
      const raw = textArg(ctx.args);
      const [lang, ...rest] = raw.split('|');
      const question = rest.join('|').trim();
      if (!lang || !question) return reply(ctx, `Usage: ${getConfig().prefix}code JavaScript|How to reverse an array?\nOR: ${getConfig().prefix}code Python|Read a file`);
      await reply(ctx, `💻 *${lang.trim()} Help...*`);
      try {
        const res = await getAIResponse(`You are a ${lang.trim()} expert. Answer this:\n\n${question}\n\nInclude code examples.`,
          `You are an expert ${lang.trim()} programmer. Give clear, concise, working code examples.`);
        await sendAIReply(ctx, res);
      } catch (e) { await reply(ctx, `❌ ${e.message}`); }
    }
  });

  add({ name: 'summarize', aliases: ['summary', 'tldr'], category: 'ai', desc: 'Summarize long text', usage: '<text>',
    handler: async (ctx) => {
      const text = textArg(ctx.args);
      if (!text || text.length < 20) return reply(ctx, `Usage: ${getConfig().prefix}summarize <paste long text here>`);
      await reply(ctx, `📋 *Summarizing...*`);
      try {
        const res = await getAIResponse(`Summarize in 3-5 bullet points:\n\n${text}`);
        await reply(ctx, `✅ *Summary:*\n\n${res}`);
      } catch (e) { await reply(ctx, `❌ ${e.message}`); }
    }
  });

  add({ name: 'story', aliases: ['creative', 'write'], category: 'ai', desc: 'Generate a short creative story', usage: '<topic>',
    handler: async (ctx) => {
      const topic = textArg(ctx.args);
      if (!topic) return reply(ctx, `Usage: ${getConfig().prefix}story a robot learning to paint`);
      await reply(ctx, `✍️ *Writing story about:* ${topic}...`);
      try {
        const res = await getAIResponse(`Write a creative short story (200-300 words) about: ${topic}`);
        await sendAIReply(ctx, res);
      } catch (e) { await reply(ctx, `❌ ${e.message}`); }
    }
  });

  add({ name: 'quiz', aliases: ['trivia', 'question'], category: 'ai', desc: 'Generate a quiz question on any topic', usage: '<topic>',
    handler: async (ctx) => {
      const topic = textArg(ctx.args);
      if (!topic) return reply(ctx, `Usage: ${getConfig().prefix}quiz history`);
      await reply(ctx, `❓ *Generating ${topic} quiz...*`);
      try {
        const res = await getAIResponse(`Create a multiple-choice quiz question about ${topic}.\n\nFormat:\nQuestion: ...\nA) ...\nB) ...\nC) ...\nD) ...\nAnswer: ...`);
        await reply(ctx, `📝 *${topic.toUpperCase()} Quiz:*\n\n${res}`);
      } catch (e) { await reply(ctx, `❌ ${e.message}`); }
    }
  });

  add({ name: 'advice', aliases: ['suggest', 'helpme'], category: 'ai', desc: 'Get AI advice on any situation', usage: '<situation>',
    handler: async (ctx) => {
      const situation = textArg(ctx.args);
      if (!situation) return reply(ctx, `Usage: ${getConfig().prefix}advice I can't decide between two jobs`);
      await reply(ctx, `💭 *Thinking about your situation...*`);
      try {
        const res = await getAIResponse(`Give thoughtful, balanced advice for:\n\n${situation}\n\nConsider multiple perspectives.`);
        await sendAIReply(ctx, res);
      } catch (e) { await reply(ctx, `❌ ${e.message}`); }
    }
  });

  add({ name: 'imagine', aliases: ['dalle', 'flux'], category: 'ai', desc: 'Refine a prompt for AI image generators', usage: '<description>',
    handler: async (ctx) => {
      const desc = textArg(ctx.args);
      if (!desc) return reply(ctx, `Usage: ${getConfig().prefix}imagine a sunset over Mount Kenya`);
      await reply(ctx, `🎨 *Refining image prompt...*`);
      try {
        const res = await getAIResponse(`Refine this into a detailed, artistic prompt for DALL-E or Midjourney:\n\n"${desc}"\n\nMake it vivid and specific.`);
        await reply(ctx, `🖼️ *Image Prompt Ready:*\n\n${res}\n\n_Use on DALL-E, Midjourney, or Stable Diffusion_`);
      } catch (e) { await reply(ctx, `❌ ${e.message}`); }
    }
  });

  add({ name: 'recipe', category: 'ai', desc: 'Get a recipe from AI', usage: '<ingredient or dish name>',
    handler: async (ctx) => {
      const item = textArg(ctx.args);
      if (!item) return reply(ctx, `Usage: ${getConfig().prefix}recipe ugali`);
      await reply(ctx, `🍳 *Fetching recipe for:* ${item}...`);
      try {
        const res = await getAIResponse(`Give a simple, easy-to-follow recipe for: ${item}. Include ingredients and steps.`);
        await sendAIReply(ctx, res);
      } catch (e) { await reply(ctx, `❌ ${e.message}`); }
    }
  });

  add({ name: 'teach', category: 'ai', desc: 'Teach the bot a custom reply', usage: '<keyword> = <response>',
    handler: async (ctx) => {
      const raw = textArg(ctx.args);
      const [key, ...rest] = raw.split('=');
      if (!key || !rest.length) return reply(ctx, `Usage: ${getConfig().prefix}teach hello = Hi there!`);
      const st = getState();
      st.learned[key.trim().toLowerCase()] = rest.join('=').trim();
      saveState(st);
      await reply(ctx, `✅ Learned: *${key.trim()}*`);
    }
  });

  add({ name: 'ask', category: 'ai', desc: 'Check a learned reply', usage: '<keyword>',
    handler: async (ctx) => {
      const key = textArg(ctx.args).toLowerCase();
      if (!key) return reply(ctx, `Usage: ${getConfig().prefix}ask hello`);
      const st = getState();
      await reply(ctx, st.learned[key] || `No learned reply for *${key}*. Use ${getConfig().prefix}teach ${key} = your reply`);
    }
  });



  // Search/download/media commands: reliable wrappers with graceful external failure.
  add({ name: 'github', aliases: ['gh'], category: 'search', desc: 'Search GitHub user', usage: '<username>', handler: async (ctx) => {
    const u = ctx.args[0]; if (!u) return reply(ctx, 'Usage: github torvalds');
    try { const { data } = await axios.get(`https://api.github.com/users/${encodeURIComponent(u)}`, { timeout: 10000 }); await reply(ctx, `GitHub: ${data.login}\nName: ${data.name || '-'}\nRepos: ${data.public_repos}\nFollowers: ${data.followers}\nURL: ${data.html_url}`); }
    catch (e) { await reply(ctx, `GitHub lookup failed: ${e.message}`); }
  }});
  add({ name: 'weather', category: 'search', desc: 'Weather via wttr.in', usage: '<city>', handler: async (ctx) => { const city = textArg(ctx.args); if (!city) return reply(ctx, 'Usage: weather London'); try { const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=3`, { timeout: 10000 }); await reply(ctx, String(data)); } catch (e) { await reply(ctx, `Weather failed: ${e.message}`); } } });
  add({ name: 'news', category: 'search', desc: 'News helper', handler: async (ctx) => reply(ctx, 'News command is ready. Add NEWS_API_KEY in .env for live headlines, or use .search <topic>.') });
  add({ name: 'search', aliases: ['google'], category: 'search', desc: 'Search helper', usage: '<query>', handler: async (ctx) => { const q = textArg(ctx.args); if (!q) return reply(ctx, 'Usage: search WhatsApp bot'); await reply(ctx, `Search URL: https://www.google.com/search?q=${encodeURIComponent(q)}`); } });
  add({ name: 'wiki', aliases: ['wikipedia'], category: 'search', desc: 'Wikipedia URL helper', usage: '<topic>', handler: async (ctx) => { const q = textArg(ctx.args); if (!q) return reply(ctx, 'Usage: wiki Node.js'); await reply(ctx, `Wikipedia: https://en.wikipedia.org/wiki/${encodeURIComponent(q.replace(/\s+/g, '_'))}`); } });

  // ─── VV: Reveal View-Once Media (KnightBot-MD style) ─────────────────────
  add({ name: 'vv', aliases: ['viewonce', 'vo'], category: 'converter', desc: 'Reveal view-once image or video', handler: async (ctx) => {
    const quoted = ctx.message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedImage = quoted?.imageMessage;
    const quotedVideo = quoted?.videoMessage;
    if (quotedImage?.viewOnce) {
      try {
        const stream = await downloadContentFromMessage(quotedImage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        await ctx.sock.sendMessage(ctx.chatId, {
          image: buffer,
          caption: `🔓 *View-Once Revealed*\n\n*Made by Kimani Samuel*`
        }, { quoted: ctx.message });
      } catch (e) { await reply(ctx, `❌ Failed to reveal: ${e.message}`); }
    } else if (quotedVideo?.viewOnce) {
      try {
        const stream = await downloadContentFromMessage(quotedVideo, 'video');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        await ctx.sock.sendMessage(ctx.chatId, {
          video: buffer,
          caption: `🔓 *View-Once Revealed*\n\n*Made by Kimani Samuel*`
        }, { quoted: ctx.message });
      } catch (e) { await reply(ctx, `❌ Failed to reveal: ${e.message}`); }
    } else {
      await reply(ctx, '❌ Please reply to a view-once image or video.');
    }
  }});

  // ─── VV2: Auto-forward view-once to owner's own chat (silent, no announcement) ─
  // This is handled as an auto-event in index.js. The vv2 command just explains usage.
  add({ name: 'vv2', aliases: ['autoviewonce'], category: 'converter', desc: 'Auto-forward view-once to owner saved messages (owner only)', handler: async (ctx) => {
    const cfg = getConfig();
    const st = getState();
    const action = (ctx.args[0] || 'status').toLowerCase();
    if (!ctx.owner) return reply(ctx, '❌ This command is owner-only.');
    if (['on','off'].includes(action)) {
      if (!st.groupSettings) st.groupSettings = {};
      st.groupSettings._vv2 = action === 'on';
      saveState(st);
      await reply(ctx, `✅ VV2 auto-forward *${action.toUpperCase()}*\n\n*Made by Kimani Samuel*`);
    } else {
      const isOn = st.groupSettings?._vv2 !== false;
      await reply(ctx, `🔍 *VV2 Status*: ${isOn ? 'ON' : 'OFF'}\nAll incoming view-once media is silently forwarded to your saved messages.\nUse ${cfg.prefix}vv2 on/off\n\n*Made by Kimani Samuel*`);
    }
  }});

  // ─── Other media command stubs ─────────────────────────────────────────────
  // Media converter commands — these need ffmpeg/sharp which isn't available on KataBump free tier
  // sticker/s: convert image to sticker
  if (!registry.has('sticker')) add({ name: 'sticker', aliases: ['s', 'take'], category: 'converter', desc: 'Convert image/video to sticker', usage: '(reply to image/video)', handler: async (ctx) => {
    const quoted = ctx.message?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted?.imageMessage && !quoted?.videoMessage) return reply(ctx, `Reply to an image or video with ${getConfig().prefix}sticker`);
    await reply(ctx, '❌ Sticker creation requires the *sharp* library which is not installed.\n\nInstall it:\n```npm install sharp```\nThen restart the bot.');
  }});

  // ─── PLAY / SONG: Download YouTube audio (Knightbot-MD style with multi-API fallback) ──
  add({
    name: 'play',
    aliases: ['song', 'music', 'ytmp3', 'song2'],
    category: 'downloads',
    desc: 'Download music from YouTube',
    usage: '<song name or YouTube URL>',
    handler: async (ctx) => {
      try {
        const query = textArg(ctx.args);
        if (!query) return await reply(ctx, `Usage: ${getConfig().prefix}play <song name>`);

        if (!yts) throw new Error('yt-search not installed. Run: npm install yt-search');
        await reply(ctx, '_Searching... your download is in progress_ ⏳');

        const search = await yts(query);
        const videos = search?.videos || [];
        if (!videos.length) return await reply(ctx, '❌ No songs found. Try different keywords.');

        const video = videos[0];
        const encoded = encodeURIComponent(video.url);

        const HEADERS = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, */*'
        };

        const apis = [
          `https://apis-keith.vercel.app/download/dlmp3?url=${encoded}`,
          `https://eliteprotech-apis.zone.id/ytdown?url=${encoded}&format=mp3`,
          `https://api.yupra.my.id/api/downloader/ytmp3?url=${encoded}`,
          `https://api.davidcyriltech.my.id/download/ytmp3?url=${encoded}`,
          `https://api.dreaded.site/api/ytdl/audio?url=${encoded}`,
          `https://bk9.fun/download/ytmp3?url=${encoded}`,
          `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encoded}`,
          `https://api.agatz.xyz/api/ytmp3?url=${encoded}`
        ];

        let audioUrl = '';
        let finalTitle = sanitizeFileName(video.title || 'song');

        // Parallelize all API calls - first to succeed wins (much faster than sequential)
        const apiPromises = apis.map(api =>
          axios.get(api, { timeout: 10000, headers: HEADERS })
            .then(res => {
              const url = res.data?.result?.downloadUrl || res.data?.result?.download_url || res.data?.result?.dl ||
                         res.data?.data?.download_url || res.data?.dl || res.data?.download || res.data?.url || res.data?.link;
              const t = res.data?.result?.title || res.data?.data?.title || res.data?.title;
              return { url: url && /^https?:\/\//i.test(url) ? url : null, title: t };
            })
            .catch(() => ({ url: null, title: null }))
        );

        const results = await Promise.all(apiPromises);
        for (const result of results) {
          if (result.url) {
            audioUrl = result.url;
            if (result.title) finalTitle = sanitizeFileName(result.title);
            break;
          }
        }

        // Old sequential code removed - was:
        for (const api of apis) {
          try {
            const { data } = await axios.get(api, { timeout: 10000, headers: HEADERS });
            const url =
              data?.result?.downloadUrl || data?.result?.download_url || data?.result?.dl ||
              data?.data?.download_url || data?.data?.dl ||
              data?.downloadURL || data?.dl || data?.download || data?.url || data?.link;
            if (url && /^https?:\/\//i.test(url)) {
              audioUrl = url;
              const t = data?.result?.title || data?.data?.title || data?.title;
              if (t) finalTitle = sanitizeFileName(t);
              break;
            }
          } catch { /* try next */ }
        }

        if (!audioUrl) throw new Error('All download APIs failed. Please try again later.');

        // Knightbot-MD approach: pass URL directly — no buffer download, no magic byte detection
        await ctx.sock.sendMessage(ctx.chatId, {
          audio: { url: audioUrl },
          mimetype: 'audio/mpeg',
          fileName: `${finalTitle.slice(0, 60)}.mp3`,
          ptt: false
        }, { quoted: ctx.message });

      } catch (err) {
        console.error('[play]', err.message);
        let msg = `❌ Download failed: ${err.message}`;
        if (/451|blocked|unavailable/i.test(err.message)) msg = '❌ Content blocked or unavailable. Try another song.';
        await reply(ctx, msg);
      }
    }
  });
  add({ name: 'video', aliases: ['ytmp4'], category: 'downloads', desc: 'Download YouTube video (MP4)', usage: '<song name or YouTube URL>', handler: async (ctx) => {
    try {
      const query = textArg(ctx.args);
      if (!query) return reply(ctx, `Usage: ${getConfig().prefix}video <song name or YouTube link>`);

      if (!yts) throw new Error('yt-search module not available. Try: npm install yt-search');
      const search = await yts(query);
      const videos = search?.videos || [];
      if (!videos.length) return reply(ctx, '❌ No videos found. Try different keywords.');

      const video = videos[0];

      // Send thumbnail immediately like Knightbot-MD
      try {
        if (video.thumbnail) {
          await ctx.sock.sendMessage(ctx.chatId, {
            image: { url: video.thumbnail },
            caption: `🎬 *${video.title}*\n⏱ *Duration:* ${video.timestamp || 'N/A'}\n⬇️ Downloading...`
          }, { quoted: ctx.message });
        }
      } catch { /* continue */ }

      const encoded = encodeURIComponent(video.url);
      const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json, */*' };

      const apiMethods = [
        { name: 'EliteProTech', url: `https://eliteprotech-apis.zone.id/ytdown?url=${encoded}&format=mp4` },
        { name: 'Yupra', url: `https://api.yupra.my.id/api/downloader/ytmp4?url=${encoded}` },
        { name: 'Okatsu', url: `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encoded}` },
        { name: 'davidcyril', url: `https://api.davidcyriltech.my.id/download/ytmp4?url=${encoded}` },
        { name: 'dreaded', url: `https://api.dreaded.site/api/ytdl/video?url=${encoded}` },
        { name: 'bk9', url: `https://bk9.fun/download/ytmp4?url=${encoded}` },
        { name: 'agatz', url: `https://api.agatz.xyz/api/ytmp4?url=${encoded}` }
      ];

      let videoUrl = '';
      let finalTitle = sanitizeFileName(video.title || 'video');

      for (const api of apiMethods) {
        try {
          const { data } = await axios.get(api.url, { timeout: 10000, headers: HEADERS });
          const url =
            data?.result?.mp4 || data?.result?.download_url || data?.result?.dl ||
            data?.data?.download_url || data?.data?.dl ||
            data?.downloadURL || data?.dl || data?.download || data?.url || data?.link;
          if (url && /^https?:\/\//i.test(url)) {
            videoUrl = url;
            const t = data?.result?.title || data?.data?.title || data?.title;
            if (t) finalTitle = sanitizeFileName(t);
            break;
          }
        } catch { /* try next */ }
      }

      if (!videoUrl) throw new Error('All download APIs failed. Please try again later or use a direct YouTube link.');

      await ctx.sock.sendMessage(ctx.chatId, {
        video: { url: videoUrl },
        mimetype: 'video/mp4',
        fileName: `${finalTitle.slice(0, 60)}.mp4`,
        caption: `╭─〔 🎬 *Video Download* 〕\n│ *${finalTitle.slice(0, 80)}*\n╰────────────\n\n_Powered by ${getConfig().botName}_`
      }, { quoted: ctx.message });

    } catch (err) {
      console.error('[video]', err);
      let msg = `❌ Video download failed: ${err.message}`;
      if (/451|blocked/i.test(err.message)) msg = '❌ Content blocked or unavailable. Try another video.';
      await reply(ctx, msg);
    }
  }});
  add({ name: 'youtube', aliases: ['yt'], category: 'downloads', desc: 'Download YouTube audio or video', usage: '<audio|video> <query/url>', handler: async (ctx) => {
    const first = (ctx.args[0] || '').toLowerCase();
    const type = ['video','mp4'].includes(first) ? 'video' : 'audio';
    try { await sendYouTubeMedia(ctx, type, textArg(ctx.args)); }
    catch (err) { await reply(ctx, `YouTube download failed: ${err.message || err}`); }
  }});

  // ─── TIKTOK DOWNLOADER ────────────────────────────────────────────────────
  add({ name: 'tiktok', aliases: ['tt'], category: 'downloads', desc: 'Download TikTok video (no watermark)', usage: '<TikTok URL>', handler: async (ctx) => {
    const url = textArg(ctx.args);
    if (!url) return reply(ctx, `Usage: ${getConfig().prefix}tiktok <TikTok URL>`);
    if (!/tiktok\.com|vm\.tiktok/i.test(url)) return reply(ctx, '❌ Please provide a valid TikTok URL.');
    await reply(ctx, '⏳ Downloading TikTok video...');
    const encoded = encodeURIComponent(url);
    const apis = [
      `https://api.tiklydown.eu.org/api/download?url=${encoded}`,
      `https://tikwm.com/api/?url=${encoded}&hd=1`,
      `https://api.davidcyriltech.my.id/tiktok?url=${encoded}`,
      `https://api.dreaded.site/api/tiktok?url=${encoded}`,
      `https://bk9.fun/download/tiktok?url=${encoded}`,
    ];
    let videoUrl = '', title = '';
    for (const api of apis) {
      try {
        const { data } = await axios.get(api, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const vUrl = data?.data?.play || data?.data?.video || data?.video?.noWatermark || data?.result?.video || data?.url || data?.download?.video || data?.nwm_video_url_HQ || data?.nwm_video_url;
        if (vUrl && /^https?:\/\//i.test(vUrl)) { videoUrl = vUrl; title = data?.data?.title || data?.result?.title || data?.title || ''; break; }
      } catch { /* try next */ }
    }
    if (!videoUrl) return reply(ctx, '❌ Could not download TikTok video. The link may be invalid or private.');
    try {
      await ctx.sock.sendMessage(ctx.chatId, {
        video: { url: videoUrl }, mimetype: 'video/mp4',
        caption: `🎵 ${title || 'TikTok Video'}\n\n_${getConfig().botName}_`
      }, { quoted: ctx.message });
    } catch { await reply(ctx, `✅ Download ready: ${videoUrl}`); }
  }});

  add({ name: 'tiktokaudio', aliases: ['ttaudio', 'ttsong'], category: 'downloads', desc: 'Download TikTok audio/sound', usage: '<TikTok URL>', handler: async (ctx) => {
    const url = textArg(ctx.args);
    if (!url) return reply(ctx, `Usage: ${getConfig().prefix}tiktokaudio <TikTok URL>`);
    await reply(ctx, '⏳ Extracting TikTok audio...');
    const encoded = encodeURIComponent(url);
    const apis = [
      `https://api.tiklydown.eu.org/api/download?url=${encoded}`,
      `https://tikwm.com/api/?url=${encoded}`,
      `https://api.davidcyriltech.my.id/tiktok?url=${encoded}`,
    ];
    let audioUrl = '', title = '';
    for (const api of apis) {
      try {
        const { data } = await axios.get(api, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const aUrl = data?.data?.music || data?.result?.music || data?.music || data?.audio;
        if (aUrl && /^https?:\/\//i.test(aUrl)) { audioUrl = aUrl; title = data?.data?.title || data?.result?.title || ''; break; }
      } catch { /* try next */ }
    }
    if (!audioUrl) return reply(ctx, '❌ Could not extract TikTok audio. Try a different link.');
    await ctx.sock.sendMessage(ctx.chatId, {
      audio: { url: audioUrl }, mimetype: 'audio/mpeg', fileName: `${(title || 'tiktok').slice(0,50)}.mp3`, ptt: false
    }, { quoted: ctx.message });
  }});

  // ─── INSTAGRAM DOWNLOADER ─────────────────────────────────────────────────
  add({ name: 'instagram', aliases: ['ig', 'insta'], category: 'downloads', desc: 'Download Instagram post/reel/story', usage: '<Instagram URL>', handler: async (ctx) => {
    const url = textArg(ctx.args);
    if (!url) return reply(ctx, `Usage: ${getConfig().prefix}ig <Instagram URL>`);
    if (!/instagram\.com/i.test(url)) return reply(ctx, '❌ Please provide a valid Instagram URL.');
    await reply(ctx, '⏳ Downloading Instagram content...');
    const encoded = encodeURIComponent(url);
    const apis = [
      `https://api.davidcyriltech.my.id/instagram?url=${encoded}`,
      `https://api.dreaded.site/api/igdl?url=${encoded}`,
      `https://bk9.fun/download/instagram?url=${encoded}`,
      `https://api.agatz.xyz/api/instagram?url=${encoded}`,
    ];
    let mediaUrl = '', isVideo = false;
    for (const api of apis) {
      try {
        const { data } = await axios.get(api, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const items = data?.result?.media || data?.data?.media || data?.result || (Array.isArray(data?.data) ? data.data : null);
        const first = Array.isArray(items) ? items[0] : items;
        const mUrl = first?.url || first?.link || data?.url || data?.link || data?.video || data?.image;
        if (mUrl && /^https?:\/\//i.test(mUrl)) {
          mediaUrl = mUrl;
          isVideo = /\.mp4/i.test(mUrl) || first?.type === 'video' || data?.type === 'video';
          break;
        }
      } catch { /* try next */ }
    }
    if (!mediaUrl) return reply(ctx, '❌ Could not download Instagram content. Make sure the account is public.');
    if (isVideo) {
      await ctx.sock.sendMessage(ctx.chatId, {
        video: { url: mediaUrl }, mimetype: 'video/mp4', caption: `📸 Instagram\n\n_${getConfig().botName}_`
      }, { quoted: ctx.message });
    } else {
      await ctx.sock.sendMessage(ctx.chatId, {
        image: { url: mediaUrl }, caption: `📸 Instagram\n\n_${getConfig().botName}_`
      }, { quoted: ctx.message });
    }
  }});

  add({ name: 'igs', aliases: ['igsc', 'igstory'], category: 'downloads', desc: 'Download Instagram story', usage: '<Instagram story URL>', handler: async (ctx) => {
    const url = textArg(ctx.args);
    if (!url) return reply(ctx, `Usage: ${getConfig().prefix}igs <Instagram story URL>`);
    await reply(ctx, '⏳ Downloading Instagram story...');
    const encoded = encodeURIComponent(url);
    try {
      const { data } = await axios.get(`https://api.davidcyriltech.my.id/instagram?url=${encoded}`, { timeout: 20000 });
      const mUrl = data?.result?.media?.[0]?.url || data?.data?.media?.[0]?.url || data?.url;
      if (!mUrl) return reply(ctx, '❌ Could not download story. Ensure it\'s a valid public story link.');
      await ctx.sock.sendMessage(ctx.chatId, {
        video: { url: mUrl }, mimetype: 'video/mp4', caption: `📸 Instagram Story\n\n_${getConfig().botName}_`
      }, { quoted: ctx.message });
    } catch (err) { await reply(ctx, `❌ Story download failed: ${err.message}`); }
  }});

  // ─── FACEBOOK DOWNLOADER ──────────────────────────────────────────────────
  add({ name: 'facebook', aliases: ['fb'], category: 'downloads', desc: 'Download Facebook video', usage: '<Facebook URL>', handler: async (ctx) => {
    const url = textArg(ctx.args);
    if (!url) return reply(ctx, `Usage: ${getConfig().prefix}facebook <Facebook video URL>`);
    if (!/facebook\.com|fb\.watch/i.test(url)) return reply(ctx, '❌ Please provide a valid Facebook URL.');
    await reply(ctx, '⏳ Downloading Facebook video...');
    const encoded = encodeURIComponent(url);
    const apis = [
      `https://api.davidcyriltech.my.id/facebook?url=${encoded}`,
      `https://api.dreaded.site/api/fbdl?url=${encoded}`,
      `https://bk9.fun/download/facebook?url=${encoded}`,
    ];
    let videoUrl = '', title = '';
    for (const api of apis) {
      try {
        const { data } = await axios.get(api, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const vUrl = data?.result?.hd || data?.result?.sd || data?.result?.url || data?.data?.hd || data?.data?.sd || data?.data?.url || data?.url || data?.hd || data?.sd;
        if (vUrl && /^https?:\/\//i.test(vUrl)) { videoUrl = vUrl; title = data?.result?.title || data?.data?.title || data?.title || ''; break; }
      } catch { /* try next */ }
    }
    if (!videoUrl) return reply(ctx, '❌ Could not download Facebook video. Ensure the video is public.');
    await ctx.sock.sendMessage(ctx.chatId, {
      video: { url: videoUrl }, mimetype: 'video/mp4',
      caption: `📘 ${title || 'Facebook Video'}\n\n_${getConfig().botName}_`
    }, { quoted: ctx.message });
  }});

  // ─── TWITTER/X DOWNLOADER ─────────────────────────────────────────────────
  add({ name: 'twitter', aliases: ['twdl', 'xdl'], category: 'downloads', desc: 'Download Twitter/X video', usage: '<Tweet URL>', handler: async (ctx) => {
    const url = textArg(ctx.args);
    if (!url) return reply(ctx, `Usage: ${getConfig().prefix}twitter <Tweet URL>`);
    if (!/twitter\.com|x\.com|t\.co/i.test(url)) return reply(ctx, '❌ Please provide a valid Twitter/X URL.');
    await reply(ctx, '⏳ Downloading Twitter/X video...');
    const encoded = encodeURIComponent(url);
    const apis = [
      `https://api.davidcyriltech.my.id/twitter?url=${encoded}`,
      `https://api.dreaded.site/api/twitter?url=${encoded}`,
      `https://bk9.fun/download/twitter?url=${encoded}`,
      `https://api.agatz.xyz/api/twitter?url=${encoded}`,
    ];
    let videoUrl = '';
    for (const api of apis) {
      try {
        const { data } = await axios.get(api, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const vUrl = data?.result?.hd || data?.result?.sd || data?.result?.url || data?.data?.hd || data?.data?.url || data?.url;
        if (vUrl && /^https?:\/\//i.test(vUrl)) { videoUrl = vUrl; break; }
      } catch { /* try next */ }
    }
    if (!videoUrl) return reply(ctx, '❌ Could not download Twitter/X video. The tweet may be private or have no video.');
    await ctx.sock.sendMessage(ctx.chatId, {
      video: { url: videoUrl }, mimetype: 'video/mp4',
      caption: `🐦 Twitter/X Video\n\n_${getConfig().botName}_`
    }, { quoted: ctx.message });
  }});

  // ─── SPOTIFY DOWNLOADER ───────────────────────────────────────────────────
  add({ name: 'spotify', aliases: ['sp', 'spotifydl'], category: 'downloads', desc: 'Download Spotify track as MP3', usage: '<Spotify URL or song name>', handler: async (ctx) => {
    const query = textArg(ctx.args);
    if (!query) return reply(ctx, `Usage: ${getConfig().prefix}spotify <Spotify link or song name>`);
    await reply(ctx, '⏳ Fetching Spotify track...');
    const encoded = encodeURIComponent(query);
    const apis = [
      `https://api.davidcyriltech.my.id/spotify?url=${encoded}`,
      `https://bk9.fun/download/spotify?url=${encoded}`,
      `https://api.dreaded.site/api/spotify?url=${encoded}`,
      `https://api.agatz.xyz/api/spotify?url=${encoded}`,
    ];
    let audioUrl = '', title = '', artist = '';
    for (const api of apis) {
      try {
        const { data } = await axios.get(api, { timeout: 25000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const aUrl = data?.result?.download || data?.result?.url || data?.data?.download || data?.data?.url || data?.url || data?.download;
        if (aUrl && /^https?:\/\//i.test(aUrl)) {
          audioUrl = aUrl;
          title = data?.result?.title || data?.data?.title || data?.title || query;
          artist = data?.result?.artist || data?.data?.artist || data?.artist || '';
          break;
        }
      } catch { /* try next */ }
    }
    if (!audioUrl) return reply(ctx, '❌ Could not download Spotify track. Try a direct Spotify link.');
    await ctx.sock.sendMessage(ctx.chatId, {
      audio: { url: audioUrl }, mimetype: 'audio/mpeg',
      fileName: `${(title || 'spotify').slice(0, 50)}.mp3`, ptt: false
    }, { quoted: ctx.message });
    if (title) await reply(ctx, `🎵 *${title}*${artist ? `\n👤 ${artist}` : ''}\n\n_${getConfig().botName}_`);
  }});

  // ─── PINTEREST DOWNLOADER ─────────────────────────────────────────────────
  add({ name: 'pinterest', aliases: ['pin', 'pindl'], category: 'downloads', desc: 'Download Pinterest image/video or search', usage: '<Pinterest URL or search query>', handler: async (ctx) => {
    const query = textArg(ctx.args);
    if (!query) return reply(ctx, `Usage: ${getConfig().prefix}pinterest <Pinterest URL or search term>`);
    await reply(ctx, '⏳ Fetching Pinterest content...');
    const encoded = encodeURIComponent(query);
    const isPinUrl = /pinterest\.com|pin\.it/i.test(query);
    try {
      let mediaUrl = '';
      if (isPinUrl) {
        const apis = [
          `https://api.davidcyriltech.my.id/pinterest?url=${encoded}`,
          `https://bk9.fun/download/pinterest?url=${encoded}`,
          `https://api.agatz.xyz/api/pinterest?url=${encoded}`,
        ];
        for (const api of apis) {
          try {
            const { data } = await axios.get(api, { timeout: 20000 });
            const mUrl = data?.result?.url || data?.result?.image || data?.data?.url || data?.url || data?.image;
            if (mUrl && /^https?:\/\//i.test(mUrl)) { mediaUrl = mUrl; break; }
          } catch { /* try next */ }
        }
      } else {
        // Search Pinterest
        const { data } = await axios.get(`https://api.agatz.xyz/api/pinterest?url=${encoded}`, { timeout: 20000 });
        mediaUrl = data?.result?.[0]?.url || data?.data?.[0]?.url || data?.url;
      }
      if (!mediaUrl) return reply(ctx, '❌ Could not fetch Pinterest content. Try a direct pin URL.');
      const isVideo = /\.mp4|\.mov/i.test(mediaUrl);
      if (isVideo) {
        await ctx.sock.sendMessage(ctx.chatId, { video: { url: mediaUrl }, mimetype: 'video/mp4', caption: `📌 Pinterest\n\n_${getConfig().botName}_` }, { quoted: ctx.message });
      } else {
        await ctx.sock.sendMessage(ctx.chatId, { image: { url: mediaUrl }, caption: `📌 Pinterest\n\n_${getConfig().botName}_` }, { quoted: ctx.message });
      }
    } catch (err) { await reply(ctx, `❌ Pinterest failed: ${err.message}`); }
  }});

  // ─── WALLPAPER & IMAGE SEARCH ─────────────────────────────────────────────
  add({ name: 'wallpaper', aliases: ['wall', 'wallpaper4k'], category: 'downloads', desc: 'Search and send a wallpaper', usage: '<search term>', handler: async (ctx) => {
    const query = textArg(ctx.args);
    if (!query) return reply(ctx, `Usage: ${getConfig().prefix}wallpaper <search term>`);
    await reply(ctx, '⏳ Searching wallpapers...');
    try {
      const { data } = await axios.get(`https://api.agatz.xyz/api/wallpaper?message=${encodeURIComponent(query)}`, { timeout: 15000 });
      const results = data?.data || data?.result || [];
      const img = Array.isArray(results) ? results[0]?.url || results[0] : data?.url;
      if (!img) return reply(ctx, '❌ No wallpapers found for that query.');
      await ctx.sock.sendMessage(ctx.chatId, { image: { url: img }, caption: `🖼️ Wallpaper: *${query}*\n\n_${getConfig().botName}_` }, { quoted: ctx.message });
    } catch (err) { await reply(ctx, `❌ Wallpaper search failed: ${err.message}`); }
  }});

  add({ name: 'img', aliases: ['image', 'imgsearch'], category: 'downloads', desc: 'Search and send an image', usage: '<search term>', handler: async (ctx) => {
    const query = textArg(ctx.args);
    if (!query) return reply(ctx, `Usage: ${getConfig().prefix}img <search term>`);
    await reply(ctx, `⏳ Searching images for *${query}*...`);
    try {
      const { data } = await axios.get(`https://api.dreaded.site/api/image?query=${encodeURIComponent(query)}`, { timeout: 15000 });
      const imgUrl = data?.result?.image || data?.data?.image || data?.image || data?.url;
      if (!imgUrl) return reply(ctx, '❌ No images found. Try different keywords.');
      await ctx.sock.sendMessage(ctx.chatId, { image: { url: imgUrl }, caption: `🔍 *${query}*\n\n_${getConfig().botName}_` }, { quoted: ctx.message });
    } catch (err) { await reply(ctx, `❌ Image search failed: ${err.message}`); }
  }});

  add({ name: 'gif', aliases: ['gifsearch'], category: 'downloads', desc: 'Search and send a GIF', usage: '<search term>', handler: async (ctx) => {
    const query = textArg(ctx.args);
    if (!query) return reply(ctx, `Usage: ${getConfig().prefix}gif <search term>`);
    await reply(ctx, `⏳ Searching GIFs for *${query}*...`);
    try {
      const { data } = await axios.get(`https://api.agatz.xyz/api/gif?message=${encodeURIComponent(query)}`, { timeout: 15000 });
      const gifUrl = data?.data?.[0]?.url || data?.result?.[0]?.url || data?.url;
      if (!gifUrl) return reply(ctx, '❌ No GIFs found. Try different keywords.');
      await ctx.sock.sendMessage(ctx.chatId, { video: { url: gifUrl }, mimetype: 'video/mp4', gifPlayback: true, caption: `🎬 *${query}*\n\n_${getConfig().botName}_` }, { quoted: ctx.message });
    } catch (err) { await reply(ctx, `❌ GIF search failed: ${err.message}`); }
  }});

  add({ name: 'lyrics', aliases: ['lyric', 'songlyrics'], category: 'downloads', desc: 'Get song lyrics', usage: '<song name>', handler: async (ctx) => {
    const query = textArg(ctx.args);
    if (!query) return reply(ctx, `Usage: ${getConfig().prefix}lyrics <song name>`);
    await reply(ctx, `⏳ Searching lyrics for *${query}*...`);
    try {
      const { data } = await axios.get(`https://api.dreaded.site/api/lyrics?query=${encodeURIComponent(query)}`, { timeout: 15000 });
      const title = data?.result?.title || data?.title || query;
      const artist = data?.result?.artist || data?.artist || '';
      const lyrics = data?.result?.lyrics || data?.lyrics || '';
      if (!lyrics) return reply(ctx, '❌ Lyrics not found for that song.');
      const msg = `🎵 *${title}*${artist ? `\n👤 ${artist}` : ''}\n\n${lyrics.slice(0, 3000)}${lyrics.length > 3000 ? '\n...' : ''}\n\n_${getConfig().botName}_`;
      await reply(ctx, msg);
    } catch (err) { await reply(ctx, `❌ Lyrics search failed: ${err.message}`); }
  }});

  add({ name: 'savestatus', aliases: ['statussave', 'dlstatus'], category: 'downloads', desc: 'Save a WhatsApp status — reply to it', handler: async (ctx) => {
    const quoted = ctx.message?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) return reply(ctx, `❌ Reply to a status/message with ${getConfig().prefix}savestatus to save it.`);
    const imgMsg = quoted?.imageMessage;
    const vidMsg = quoted?.videoMessage;
    try {
      if (imgMsg) {
        const stream = await downloadContentFromMessage(imgMsg, 'image');
        const chunks = []; for await (const c of stream) chunks.push(c);
        const buf = Buffer.concat(chunks);
        await ctx.sock.sendMessage(ctx.chatId, { image: buf, caption: `📥 Status saved!\n\n_${getConfig().botName}_` }, { quoted: ctx.message });
      } else if (vidMsg) {
        const stream = await downloadContentFromMessage(vidMsg, 'video');
        const chunks = []; for await (const c of stream) chunks.push(c);
        const buf = Buffer.concat(chunks);
        await ctx.sock.sendMessage(ctx.chatId, { video: buf, mimetype: 'video/mp4', caption: `📥 Status saved!\n\n_${getConfig().botName}_` }, { quoted: ctx.message });
      } else {
        await reply(ctx, '❌ Reply to an image or video status to save it.');
      }
    } catch (err) { await reply(ctx, `❌ Could not save status: ${err.message}`); }
  }});

  add({ name: 'xvideo', aliases: ['xvideo2'], category: 'downloads', desc: 'Search and download xvideos (18+, owner only)', ownerOnly: true, usage: '<search query>', handler: async (ctx) => {
    await reply(ctx, '❌ Adult content download is disabled on this bot.');
  }});



  // ─── VCF: Export Group Contacts ───────────────────────────────────────────
  add({ name: 'vcf', aliases: ['groupvcf', 'contacts', 'getcontacts'], category: 'group', groupOnly: true, desc: 'Export all group member contacts as a VCF file', handler: async (ctx) => {
    await reply(ctx, '📋 Collecting group contacts...');
    try {
      const meta = await ctx.sock.groupMetadata(ctx.chatId);
      const participants = meta.participants || [];
      let vcfContent = '';
      for (const p of participants) {
        const jidStr = typeof p === 'string' ? p : (p.id || p.jid || '');
        const number = normalizeNumber(jidStr);
        if (!number) continue;
        vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:+${number}\nTEL;TYPE=CELL:+${number}\nEND:VCARD\n`;
      }
      const tmpDir = path.join(process.cwd(), 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `vcf_${Date.now()}.vcf`);
      fs.writeFileSync(tmpFile, vcfContent, 'utf8');
      const safeGroupName = meta.subject.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'group';
      await ctx.sock.sendMessage(ctx.chatId, {
        document: fs.readFileSync(tmpFile),
        mimetype: 'text/vcard',
        fileName: `${safeGroupName}_contacts.vcf`,
        caption: `📋 *Group Contacts*\n\n👥 Group: *${meta.subject}*\n👤 Members: *${participants.length}*\n\n_Import this file into your contacts app_\n\n*Made by Kimani Samuel*`
      }, { quoted: ctx.message });
      setTimeout(() => fs.unlink(tmpFile, () => {}), 15000);
    } catch (err) {
      await reply(ctx, `❌ Failed to collect contacts: ${err.message}\n\n*Made by Kimani Samuel*`);
    }
  }});

  // ─── WELCOME: Toggle group welcome messages ────────────────────────────────
  add({ name: 'welcome', aliases: ['setwelcome'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Toggle welcome messages on/off for this group', usage: '<on|off>', handler: async (ctx) => {
    const action = (ctx.args[0] || 'status').toLowerCase();
    const st = getState();
    if (!st.groupSettings) st.groupSettings = {};
    if (!st.groupSettings[ctx.chatId]) st.groupSettings[ctx.chatId] = {};
    if (action === 'on' || action === 'off') {
      st.groupSettings[ctx.chatId].welcome = action === 'on';
      saveState(st);
      await reply(ctx, `✅ Welcome messages *${action.toUpperCase()}* for this group.\n\n*Made by Kimani Samuel*`);
    } else {
      const on = st.groupSettings[ctx.chatId].welcome;
      await reply(ctx, `ℹ️ Welcome messages: *${on ? 'ON' : 'OFF'}*\nUse ${getConfig().prefix}welcome on/off\n\n*Made by Kimani Samuel*`);
    }
  }});

  // ─── GOODBYE: Toggle group goodbye messages ────────────────────────────────
  add({ name: 'goodbye', aliases: ['setgoodbye', 'bye'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Toggle goodbye messages on/off for this group', usage: '<on|off>', handler: async (ctx) => {
    const action = (ctx.args[0] || 'status').toLowerCase();
    const st = getState();
    if (!st.groupSettings) st.groupSettings = {};
    if (!st.groupSettings[ctx.chatId]) st.groupSettings[ctx.chatId] = {};
    if (action === 'on' || action === 'off') {
      st.groupSettings[ctx.chatId].goodbye = action === 'on';
      saveState(st);
      await reply(ctx, `✅ Goodbye messages *${action.toUpperCase()}* for this group.\n\n*Made by Kimani Samuel*`);
    } else {
      const on = st.groupSettings[ctx.chatId].goodbye;
      await reply(ctx, `ℹ️ Goodbye messages: *${on ? 'ON' : 'OFF'}*\nUse ${getConfig().prefix}goodbye on/off\n\n*Made by Kimani Samuel*`);
    }
  }});

  // Menu aliases per category.
  for (const cat of ['core','ai','group','owner','media','textmaker','text','fun','games','utility','anime','downloads','converter','search','tools']) {
    const aliases = cat === 'core' ? ['generalmenu', 'basicmenu'] : [];
    add({ name: `${cat}menu`, aliases, category: 'core', desc: `Show ${cat === 'core' ? 'general' : cat} commands`, handler: async (ctx) => {
      const cfg = getConfig();
      const items = commands.filter(c => c.category === cat);
      await reply(ctx, `┌──『 ${(cat === 'core' ? 'general' : cat).toUpperCase()} 』\n${items.map(c => `│ ${helpLine(c, cfg.prefix)}`).join('\n')}\n└──────────────`);
    }});
  }

  // ─── TEXTMAKER: Real ephoto360 image generation (ported from Knightbot-MD) ─
  const EPHOTO_MAP = {
    metallic:   'https://en.ephoto360.com/impressive-decorative-3d-metal-text-effect-798.html',
    ice:        'https://en.ephoto360.com/ice-text-effect-online-101.html',
    snow:       'https://en.ephoto360.com/create-a-snow-3d-text-effect-free-online-621.html',
    impressive: 'https://en.ephoto360.com/create-3d-colorful-paint-text-effect-online-801.html',
    matrix:     'https://en.ephoto360.com/matrix-text-effect-154.html',
    light:      'https://en.ephoto360.com/light-text-effect-futuristic-technology-style-648.html',
    neon:       'https://en.ephoto360.com/create-colorful-neon-light-text-effects-online-797.html',
    devil:      'https://en.ephoto360.com/neon-devil-wings-text-effect-online-683.html',
    purple:     'https://en.ephoto360.com/purple-text-effect-online-100.html',
    thunder:    'https://en.ephoto360.com/thunder-text-effect-online-97.html',
    leaves:     'https://en.ephoto360.com/green-brush-text-effect-typography-maker-online-153.html',
    '1917':     'https://en.ephoto360.com/1917-style-text-effect-523.html',
    arena:      'https://en.ephoto360.com/create-cover-arena-of-valor-by-mastering-360.html',
    hacker:     'https://en.ephoto360.com/create-anonymous-hacker-avatars-cyan-neon-677.html',
    sand:       'https://en.ephoto360.com/write-names-and-messages-on-the-sand-online-582.html',
    blackpink:  'https://en.ephoto360.com/create-a-blackpink-style-logo-with-members-signatures-810.html',
    glitch:     'https://en.ephoto360.com/create-digital-glitch-text-effects-online-767.html',
    fire:       'https://en.ephoto360.com/flame-lettering-effect-372.html',
    gold:       'https://en.ephoto360.com/gold-text-effect-online-91.html',
    galaxy:     'https://en.ephoto360.com/galaxy-text-effect-online-399.html',
    graffiti:   'https://en.ephoto360.com/graffiti-text-effect-generator-online-free-150.html',
    rainbow:    'https://en.ephoto360.com/rainbow-text-effect-online-102.html',
    retro:      'https://en.ephoto360.com/retro-text-effect-online-141.html',
    vintage:    'https://en.ephoto360.com/vintage-text-effect-online-110.html',
    halloween:  'https://en.ephoto360.com/create-halloween-text-effects-online-661.html',
    christmas:  'https://en.ephoto360.com/merry-christmas-text-effect-online-generator-503.html',
    blood:      'https://en.ephoto360.com/blood-text-effect-online-107.html',
    wood:       'https://en.ephoto360.com/wood-text-effect-online-108.html',
    water:      'https://en.ephoto360.com/water-text-effect-online-105.html',
    smoke:      'https://en.ephoto360.com/smoke-text-effect-online-99.html',
    toxic:      'https://en.ephoto360.com/neon-text-effect-for-toxic-environment-online-803.html',
    summer:     'https://en.ephoto360.com/summer-text-effect-online-575.html',
    cyberpunk:  'https://en.ephoto360.com/cyberpunk-2077-text-effect-online-612.html',
    pixel:      'https://en.ephoto360.com/pixel-text-effect-online-generator-178.html',
  };

  // Load mumaker (CJS) via createRequire — Malai-XD is ESM
  const _require = createRequire(import.meta.url);
  let mumaker = null;
  try { mumaker = _require('mumaker'); } catch { mumaker = null; }

  async function generateEphotoImage(ephotoUrl, text) {
    if (mumaker) {
      const result = await mumaker.ephoto(ephotoUrl, text);
      if (!result?.image) throw new Error('mumaker returned no image URL');
      return result.image;
    }
    // Fallback scraper if mumaker unavailable
    const pageRes = await axios.get(ephotoUrl, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    });
    const html = String(pageRes.data || '');
    const baseOrigin = 'https://en.ephoto360.com';
    const tokenMatch = html.match(/name=["']_?token["'][^>]*value=["']([^"']{10,})["']/) ||
                       html.match(/value=["']([a-f0-9]{40,})["']/);
    const token = tokenMatch?.[1] || '';
    const actionMatch = html.match(/action=["']([^"']+)["']/) ||
                        html.match(/["'](\/api\/effect\/\d+[^"']*)["']/);
    let submitUrl = actionMatch?.[1] || '';
    if (!submitUrl) throw new Error('Could not find form action on ephoto360 page');
    if (submitUrl.startsWith('/')) submitUrl = baseOrigin + submitUrl;
    const fieldMatch = html.match(/name=["'](texts?\[\]|text)["']/i);
    const fieldName = fieldMatch?.[1] || 'texts[]';
    const formData = new URLSearchParams();
    if (token) formData.append('token', token);
    formData.append(fieldName, text);
    formData.append('submit', 'GO');
    const postRes = await axios.post(submitUrl, formData.toString(), {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': ephotoUrl, 'Origin': baseOrigin
      }
    });
    const body = typeof postRes.data === 'string' ? postRes.data : JSON.stringify(postRes.data);
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = postRes.data; }
    const imgUrl = parsed?.image || parsed?.url || parsed?.data?.image;
    if (imgUrl && /^https?:\/\//i.test(imgUrl)) return imgUrl;
    const urlMatch = body.match(/"(https?:\/\/[^"]+\.(?:jpg|png|webp)(?:\?[^"]*)?)"/i);
    if (urlMatch?.[1]) return urlMatch[1].replace(/\\\//g, '/');
    throw new Error('No image URL found in ephoto360 response');
  }


  for (const [name, ephotoUrl] of Object.entries(EPHOTO_MAP)) {
    if (registry.has(name)) continue;
    add({
      name,
      aliases: name === '1917' ? ['1917style'] : [],
      category: 'textmaker',
      desc: `Generate ${name} styled text image`,
      usage: '<your text>',
      handler: async (ctx) => {
        const text = textArg(ctx.args);
        if (!text) return reply(ctx, `Usage: ${getConfig().prefix}${name} Your Text\nExample: ${getConfig().prefix}${name} Malai Bot`);
        await reply(ctx, `⏳ Generating *${name}* text style...`);
        try {
          const imageUrl = await generateEphotoImage(ephotoUrl, text);
          await ctx.sock.sendMessage(ctx.chatId, {
            image: { url: imageUrl },
            caption: `✨ *${name.toUpperCase()}* style\n_"${text}"_\n\n_Powered by ${getConfig().botName}_`
          }, { quoted: ctx.message });
        } catch (err) {
          console.error(`[textmaker:${name}]`, err.message);
          await reply(ctx, `❌ Failed to generate *${name}* image. Try again.\n_${err.message.slice(0,100)}_`);
        }
      }
    });
  }


  // ─── ANIME: Real GIF fetching (ported from Knightbot-MD) ──────────────────
  const ANIMU_BASE_URL = 'https://api.some-random-api.com/animu';
  const ANIME_MESSAGES = {
    kiss:      (f,t) => `💋 *${f}* kisses *${t}*! 😘`,
    hug:       (f,t) => `🤗 *${f}* hugs *${t}* tightly! 💕`,
    pat:       (f,t) => `😊 *${f}* pats *${t}* on the head! 🥰`,
    poke:      (f,t) => `👉 *${f}* pokes *${t}*! 😄`,
    nom:       (f,t) => `😋 *${f}* noms *${t}*! 🍪`,
    cry:       (f,_) => `😭 *${f}* is crying! Someone comfort them!`,
    wink:      (f,t) => `😉 *${f}* winks at *${t}*~`,
    facepalm:  (f,_) => `🤦 *${f}* face-palms!`,
    'face-palm':(f,_) => `🤦 *${f}* face-palms!`,
    slap:      (f,t) => `👋 *${f}* slaps *${t}*! That had to hurt! 💥`,
    bite:      (f,t) => `😬 *${f}* bites *${t}*! 🦷`,
    cuddle:    (f,t) => `🥰 *${f}* cuddles with *${t}*!`,
    highfive:  (f,t) => `✋ *${f}* high-fives *${t}*!`,
    dance:     (f,_) => `💃 *${f}* is dancing! 🕺`,
    blush:     (f,t) => `😊 *${f}* blushes at *${t}*~`,
    wave:      (f,t) => `👋 *${f}* waves at *${t}*!`,
    kill:      (f,t) => `💀 *${f}* eliminated *${t}*!`,
    feed:      (f,t) => `🍜 *${f}* feeds *${t}*! 🥄`,
    yeet:      (f,t) => `🚀 *${f}* yeets *${t}* into the sky!`,
    happy:     (f,_) => `😄 *${f}* is feeling happy!`,
    sad:       (f,_) => `😢 *${f}* is feeling sad...`,
    angry:     (f,_) => `😠 *${f}* is angry! Watch out!`,
    sleep:     (f,_) => `😴 *${f}* is sleeping... shhh!`,
    run:       (f,_) => `🏃 *${f}* runs away!`,
    jump:      (f,_) => `🦘 *${f}* jumps!`,
  };

  async function fetchAnimuGif(type) {
    const apiTypeMap = { facepalm: 'face-palm' };
    const apiType = apiTypeMap[type] || type;
    const validTypes = ['nom','poke','cry','kiss','pat','hug','wink','face-palm','quote'];
    if (!validTypes.includes(apiType)) return null;
    const res = await axios.get(`${ANIMU_BASE_URL}/${apiType}`, { timeout: 15000 });
    return res.data?.link || res.data?.gif || res.data?.url || null;
  }

  async function fetchWaifuPicsGif(type) {
    const sfwTypes = ['wink','pat','hug','poke','slap','kiss','blush','smile','wave','highfive','happy','dance','run','bite','cuddle','feed','kill','cry','nom','yeet','jump'];
    if (!sfwTypes.includes(type)) return null;
    const res = await axios.get(`https://api.waifu.pics/sfw/${type}`, { timeout: 15000 });
    return res.data?.url || null;
  }

  const interactionCmds = ['kiss','hug','pat','poke','nom','cry','wink','facepalm','face-palm','slap','bite','cuddle','highfive','dance','blush','wave','kill','feed','yeet','happy','sad','angry','sleep','run','jump'];
  for (const name of interactionCmds) {
    if (registry.has(name)) continue;
    add({
      name,
      aliases: name === 'face-palm' ? ['facepalm'] : name === 'facepalm' ? ['face-palm'] : [],
      category: 'anime',
      desc: `Send a ${name} anime GIF`,
      usage: '[@user]',
      handler: async (ctx) => {
        const target = pickTarget(ctx.message, ctx.sender);
        const senderName = ctx.pushName || normalizeNumber(ctx.sender) || 'Someone';
        const targetName = target === ctx.sender ? 'themselves' : `@${normalizeNumber(target)}`;
        const caption = (ANIME_MESSAGES[name] || ((f,t) => `*${f}* → *${t}*`))(senderName, targetName);
        try {
          let gifUrl = null;
          try { gifUrl = await fetchAnimuGif(name); } catch {}
          if (!gifUrl) { try { gifUrl = await fetchWaifuPicsGif(name); } catch {} }
          if (gifUrl) {
            await ctx.sock.sendMessage(ctx.chatId, {
              video: { url: gifUrl }, mimetype: 'video/mp4', caption, gifPlayback: true
            }, { quoted: ctx.message, mentions: [target] });
          } else {
            await reply(ctx, caption, { mentions: [target] });
          }
        } catch (err) {
          console.error(`[anime:${name}]`, err.message);
          await reply(ctx, caption, { mentions: [target] });
        }
      }
    });
  }

  const imageAnimeCmds = ['waifu','neko','loli','megumin','konachan','animu','anime'];
  for (const name of imageAnimeCmds) {
    if (registry.has(name)) continue;
    add({
      name, category: 'anime', desc: `Random ${name} anime image`,
      handler: async (ctx) => {
        try {
          let url = null;
          try {
            const r = await axios.get(`https://api.waifu.pics/sfw/${name === 'animu' ? 'waifu' : name}`, { timeout: 15000 });
            url = r.data?.url;
          } catch {}
          if (!url) {
            const r2 = await axios.get(`${ANIMU_BASE_URL}/wink`, { timeout: 15000 });
            url = r2.data?.link;
          }
          if (url) {
            await ctx.sock.sendMessage(ctx.chatId, {
              image: { url }, caption: `🎌 *${name.toUpperCase()}*\n_Powered by ${getConfig().botName}_`
            }, { quoted: ctx.message });
          } else {
            await reply(ctx, `❌ Could not fetch ${name} image right now.`);
          }
        } catch (err) { await reply(ctx, `❌ Failed: ${err.message}`); }
      }
    });
  }

  if (!registry.has('animuquote')) {
    add({
      name: 'animuquote', aliases: ['animequote','aq'], category: 'anime', desc: 'Random anime quote',
      handler: async (ctx) => {
        try {
          const res = await axios.get(`${ANIMU_BASE_URL}/quote`, { timeout: 15000 });
          const q = res.data?.sentence || res.data?.quote || 'No quote found.';
          const char = res.data?.character || '';
          const anime = res.data?.anime || '';
          await reply(ctx, `💬 *"${q}"*${char ? `\n\n— _${char}_` : ''}${anime ? ` from *${anime}*` : ''}`);
        } catch { await reply(ctx, '❌ Could not fetch an anime quote right now.'); }
      }
    });
  }


  // ─── ANTILINK (delete/kick modes) ─────────────────────────────────────────
  add({ name: 'antilink', aliases: ['antilinkoff'], category: 'group', groupOnly: true, adminOnly: true,
    desc: 'Toggle link protection. Use "antilink delete" or "antilink kick"', usage: '<delete|kick|off|status>',
    handler: async (ctx) => {
      const st = getState();
      if (!st.groupSettings) st.groupSettings = {};
      if (!st.groupSettings[ctx.chatId]) st.groupSettings[ctx.chatId] = {};
      const grp = st.groupSettings[ctx.chatId];
      const sub = (ctx.args[0] || 'status').toLowerCase();
      const p = getConfig().prefix;

      if (sub === 'delete' || sub === 'del') {
        grp.antilink = { enabled: true, action: 'delete' };
        saveState(st);
        return reply(ctx, `🔗 *Antilink → DELETE mode ON*\n\nWhen a non-admin sends a link:\n• The message will be deleted\n• The sender gets a warning\n\nUse ${p}antilink kick to switch to kick mode.\nUse ${p}antilink off to disable.`);
      } else if (sub === 'kick') {
        grp.antilink = { enabled: true, action: 'kick' };
        saveState(st);
        return reply(ctx, `🔗 *Antilink → KICK mode ON*\n\nWhen a non-admin sends a link:\n• The message will be deleted\n• The sender will be removed from the group\n\nUse ${p}antilink delete to switch to delete-only mode.\nUse ${p}antilink off to disable.`);
      } else if (sub === 'on') {
        grp.antilink = { enabled: true, action: grp.antilink?.action || 'delete' };
        saveState(st);
        return reply(ctx, `✅ *Antilink ON* (mode: ${grp.antilink.action})\nUse ${p}antilink delete or ${p}antilink kick to change mode.`);
      } else if (sub === 'off') {
        grp.antilink = { enabled: false, action: grp.antilink?.action || 'delete' };
        saveState(st);
        return reply(ctx, '❌ *Antilink OFF* — links are now allowed in this group.');
      } else {
        const cfg = grp.antilink;
        const status = cfg?.enabled ? `✅ ON (mode: *${cfg.action || 'delete'}*)` : '❌ OFF';
        return reply(ctx, `*🔗 Antilink Status:* ${status}\n\n` +
          `${p}antilink delete — Delete link, warn sender\n` +
          `${p}antilink kick — Delete link + remove sender\n` +
          `${p}antilink off — Disable antilink`);
      }
    }
  });

  // ─── GROUPSTATUS: Post replied image/video to WhatsApp status ─────────────
  add({ name: 'groupstatus', aliases: ['poststatus','statuspost'], category: 'group', groupOnly: true, adminOnly: true,
    desc: 'Reply to an image or video with this command to post it to bot WhatsApp status',
    handler: async (ctx) => {
      const quoted = ctx.message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quoted) return reply(ctx, `❌ Reply to an image or video with ${getConfig().prefix}groupstatus to post it to status.`);

      const imgMsg = quoted.imageMessage;
      const vidMsg = quoted.videoMessage;

      if (!imgMsg && !vidMsg) return reply(ctx, '❌ Replied message must be an image or video.');

      try {
        await reply(ctx, '📤 Posting to status...');
        if (imgMsg) {
          const stream = await downloadContentFromMessage(imgMsg, 'image');
          const chunks = []; for await (const c of stream) chunks.push(c);
          const buffer = Buffer.concat(chunks);
          const caption = imgMsg.caption || '';
          await ctx.sock.sendMessage('status@broadcast', {
            image: buffer,
            caption: caption,
            backgroundColor: '#000000',
            font: 0
          });
          await reply(ctx, '✅ Image posted to status successfully!');
        } else if (vidMsg) {
          const stream = await downloadContentFromMessage(vidMsg, 'video');
          const chunks = []; for await (const c of stream) chunks.push(c);
          const buffer = Buffer.concat(chunks);
          const caption = vidMsg.caption || '';
          await ctx.sock.sendMessage('status@broadcast', {
            video: buffer,
            caption: caption,
            gifPlayback: false
          });
          await reply(ctx, '✅ Video posted to status successfully!');
        }
      } catch (err) {
        await reply(ctx, `❌ Failed to post status: ${err.message || err}`);
      }
    }
  });

  // ─── GETPP: Full profile card (dp, about, name, number, country) ───────────
  add({ name: 'getpp', aliases: ['dp','profile','whois','userinfo','about'], category: 'utility',
    desc: 'Get user profile picture (works for unsaved contacts too)',
    usage: '(no args = you) | @user | +254700000000 | reply',
    handler: async (ctx) => {
      try {
        // Get target JID - supports mentions, numbers, quoted messages
        let targetJid = '';
        const mentioned = mentionedJids(ctx.message);
        const quoted = ctx.message.message?.extendedTextMessage?.contextInfo?.participant;
        
        if (mentioned.length) {
          targetJid = mentioned[0];
        } else if (quoted) {
          targetJid = quoted;
        } else if (ctx.args[0]) {
          // Accept +254, 254, 0700000000 formats and convert to proper JID
          const input = ctx.args[0].replace(/[^\d]/g, '');
          if (input.length >= 9) {
            targetJid = toUserJid(input);
          }
        }
        
        // Default to sender if no target specified
        if (!targetJid) targetJid = ctx.sender;

        const num = normalizeNumber(targetJid);

        // Fast country lookup
        function detectCountry(number = '') {
          const n = String(number).replace(/\D/g, '');
          const countryMap = {
            '254':'Kenya 🇰🇪', '255':'Tanzania 🇹🇿', '256':'Uganda 🇺🇬', '250':'Rwanda 🇷🇼',
            '251':'Ethiopia 🇪🇹', '252':'Somalia 🇸🇴', '257':'Burundi 🇧🇮', '258':'Mozambique 🇲🇿',
            '260':'Zambia 🇿🇲', '263':'Zimbabwe 🇿🇼', '264':'Namibia 🇳🇦', '265':'Malawi 🇲🇼',
            '27':'South Africa 🇿🇦', '233':'Ghana 🇬🇭', '234':'Nigeria 🇳🇬', '237':'Cameroon 🇨🇲',
            '44':'UK 🇬🇧', '33':'France 🇫🇷', '49':'Germany 🇩🇪', '39':'Italy 🇮🇹',
            '91':'India 🇮🇳', '92':'Pakistan 🇵🇰', '86':'China 🇨🇳', '81':'Japan 🇯🇵',
            '1':'USA 🇺🇸', '55':'Brazil 🇧🇷', '52':'Mexico 🇲🇽',
          };
          // Check longest prefixes first
          for (const len of [4, 3, 2, 1]) {
            const prefix = n.substring(0, len);
            if (countryMap[prefix]) return countryMap[prefix];
          }
          return 'Unknown 🌍';
        }

        const country = detectCountry(num);
        const name = ctx.message?.pushName || `+${num}`;

        // Try to get profile picture URL (fastest way - no buffer download)
        let ppUrl = null;
        try {
          ppUrl = await ctx.sock.profilePictureUrl(targetJid, 'image').catch(() => null);
        } catch {
          // Contact may not exist or pic is private - that's OK
        }

        const card = `╭━━━━━━━━━━━━━━━━━━╮
┃ 👤 *PROFILE*
┃ 📱 +${num}
┃ 🏷️ ${name}
┃ 🌍 ${country}
╰━━━━━━━━━━━━━━━━━━╯`;

        if (ppUrl) {
          // Send image directly from URL - much faster than buffer download
          await ctx.sock.sendMessage(ctx.chatId, {
            image: { url: ppUrl },
            caption: card,
            mentions: [targetJid]
          }, { quoted: ctx.message });
        } else {
          // No picture available or contact is private
          await reply(ctx, card + '\n\n🖼️ _No profile picture (contact may be private)_', { mentions: [targetJid] });
        }
      } catch (err) {
        await reply(ctx, `❌ getpp failed: ${err.message}`);
      }
    }
  });

  // Admin/automation toggles from src/settings.js. Each can be turned on/off by owner.
  for (const name of TOGGLE_NAMES) {
    if (registry.has(name)) continue;
    add({ name, category: 'tools', ownerOnly: true, desc: `${name} on/off setting`, usage: '<on|off|status>', handler: async (ctx) => {
      const st = getState();
      const action = (ctx.args[0] || 'status').toLowerCase();
      let extra = '';
      if (['on','off'].includes(action)) {
        setToggle(st, name, action === 'on');
        saveState(st);
        if (name === 'autobio' && action === 'on') extra = `\n${await updateAutoBioFromCommand(ctx)}`;
      }
      await reply(ctx, `${name}: ${isToggleEnabled(st, name) ? 'ON' : 'OFF'}\nUsage: ${getConfig().prefix}${name} on/off${extra}`);
    } });
  }

  // ─── DEL / DELETE: Admin delete messages ────────────────────────────────────
  add({ name: 'delete', aliases: ['del'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Delete replied message or last N messages from a user', usage: '[number] [@user]', handler: async (ctx) => {
    const { sock, chatId, message, args } = ctx;
    try { await ensureBotGroupAdmin(ctx, 'delete messages'); } catch (err) { return reply(ctx, err.message); }

    const ctxInfo = message.message?.extendedTextMessage?.contextInfo || {};
    const repliedParticipant = ctxInfo.participant || null;
    const repliedMsgId = ctxInfo.stanzaId || null;
    const mentioned = Array.isArray(ctxInfo.mentionedJid) && ctxInfo.mentionedJid.length > 0 ? ctxInfo.mentionedJid[0] : null;

    let countArg = null;
    const firstArg = parseInt(args[0], 10);
    if (!isNaN(firstArg) && firstArg > 0) countArg = Math.min(firstArg, 50);

    if (countArg === null && repliedParticipant) countArg = 1;
    else if (countArg === null && !repliedParticipant && !mentioned) {
      return reply(ctx, `❌ Usage:\n${ctx.prefix}del 5 — delete last 5 messages\n${ctx.prefix}del @user — delete last message from user\n${ctx.prefix}del (reply) — delete replied message`);
    } else if (countArg === null && mentioned) countArg = 1;

    // Delete the replied message directly if replying
    if (repliedMsgId && repliedParticipant) {
      try {
        await sock.sendMessage(chatId, {
          delete: { remoteJid: chatId, fromMe: false, id: repliedMsgId, participant: repliedParticipant }
        });
        if (countArg <= 1) return;
        countArg = Math.max(0, countArg - 1);
      } catch {}
    }

    // Use message store from index.js for bulk delete
    const storeMap = ctx.messageStore;
    if (!storeMap || !(storeMap instanceof Map)) {
      return reply(ctx, '✅ Replied message deleted. For bulk delete, the message store is initializing.');
    }

    const chatMessages = [...storeMap.values()].filter(m => m.chatId === chatId);
    chatMessages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const targetUser = repliedParticipant || mentioned || null;
    const toDelete = [];
    for (const m of chatMessages) {
      if (toDelete.length >= countArg) break;
      if (targetUser && m.sender !== targetUser) continue;
      toDelete.push(m);
    }
    if (toDelete.length === 0) return reply(ctx, 'No recent messages found to delete.');
    for (const m of toDelete) {
      try {
        await sock.sendMessage(chatId, {
          delete: { remoteJid: chatId, fromMe: false, id: m.messageId || m.id || m.key?.id, participant: m.sender }
        });
        await new Promise(r => setTimeout(r, 300));
      } catch {}
    }
  }});

  // ─── PAY: Payment info command ────────────────────────────────────────────
  add({ name: 'pay', aliases: ['payment', 'sendmoney', 'mpesa'], category: 'utility', desc: 'Show payment / M-Pesa info or generate a payment request', usage: '[amount] [reason]', handler: async (ctx) => {
    const cfg = getConfig();
    const input = textArg(ctx.args);
    const ownerNumber = normalizeNumber(cfg.ownerNumber || OWNER_NUMBER);
    const phone = ownerNumber ? `+${ownerNumber}` : 'Not set';

    let amountLine = '';
    let reasonLine = '';
    if (input) {
      const parts = input.split(/\s+/);
      if (/^\d+(\.\d+)?$/.test(parts[0])) {
        amountLine = `│ 💰 *Amount:* KES ${parseFloat(parts[0]).toFixed(2)}\n`;
        reasonLine = parts.slice(1).join(' ') ? `│ 📝 *Reason:* ${parts.slice(1).join(' ')}\n` : '';
      } else {
        reasonLine = `│ 📝 *Reason:* ${input}\n`;
      }
    }

    await reply(ctx, `╭─〔 💳 *PAYMENT INFO* 〕
│
│ 👑 *Owner:* ${cfg.ownerName || OWNER_NAME}
│ 📞 *M-Pesa:* ${phone}
│
${amountLine}${reasonLine}│ _Send via M-Pesa then confirm with screenshot._
╰────────────

*Made by Kimani Samuel*`);
  }});


  // ─── REPO: Bot source code repository ────────────────────────────────────────
  add({ name: 'repo', aliases: ['source', 'sourcecode', 'github-repo'], category: 'owner', ownerOnly: true,
    desc: 'Show the bot GitHub repository link',
    handler: async (ctx) => {
      const cfg = getConfig();
      await reply(ctx,
        `╭━━━━━━━━━━━━━━━━━━╮\n` +
        `┃  🤖 *${cfg.botName || 'Malai-XD-2.0'} REPO*\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
        `📦 *GitHub Repository:*\n` +
        `https://github.com/Brokensmile47/Malai-XD-2.0--.git\n\n` +
        `🌐 *Browse online:*\n` +
        `https://github.com/Brokensmile47/Malai-XD-2.0--\n\n` +
        `📥 *Clone:*\n` +
        `\`git clone https://github.com/Brokensmile47/Malai-XD-2.0--.git\`\n\n` +
        `⭐ Star the repo if you find it useful!\n` +
        `_Made by Kimani Samuel_`
      );
    }
  });

  // ─── UPDATE: Pull latest code from GitHub and restart ─────────────────────
  add({ name: 'update', aliases: ['gitpull', 'pullupdate', 'fetchupdate'], category: 'owner', ownerOnly: true,
    desc: 'Pull latest updates from GitHub and restart the bot (auto on Render/Railway, manual on VPS/Linux)',
    usage: '[force]',
    handler: async (ctx) => {
      const REPO_URL = 'https://github.com/Brokensmile47/Malai-XD-2.0--.git';
      const cwd = process.cwd();
      const isForce = (ctx.args[0] || '').toLowerCase() === 'force';

      await reply(ctx, `🔄 *Checking for updates...*\n_Repo:_ ${REPO_URL}`);

      // ── Helper: run shell command synchronously and return output ──
      function run(cmd, options = {}) {
        try {
          return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', timeout: 15000, ...options }).trim() };
        } catch (e) {
          return { ok: false, out: (e.stdout || e.stderr || e.message || String(e)).trim().slice(0, 500) };
        }
      }

      // ── 1. Make sure this is a git repo, init remote if needed ──
      const isGit = run('git rev-parse --git-dir');
      if (!isGit.ok) {
        // Not a git repo — initialize and set origin
        run('git init');
        run(`git remote add origin ${REPO_URL}`);
        run('git fetch origin');
        const initResult = run('git checkout -b main origin/main');
        if (!initResult.ok) {
          const initResult2 = run('git checkout -b main origin/master');
          if (!initResult2.ok) {
            return reply(ctx, `❌ *Could not initialize repo*\n${initResult2.out}\n\nTry cloning manually:\n\`git clone ${REPO_URL}\``);
          }
        }
        return reply(ctx, `✅ *Repo initialized and bot updated from GitHub!*\nPlease restart the bot manually:\n\`npm start\``);
      }

      // ── 2. Check current remote ──
      const remoteCheck = run('git remote get-url origin');
      if (!remoteCheck.ok || !remoteCheck.out.includes('Brokensmile47')) {
        run('git remote remove origin');
        run(`git remote add origin ${REPO_URL}`);
      }

      // ── 3. Stash any local changes (protect session and .env) ──
      if (isForce) {
        run('git checkout -- .');
        run('git clean -fd --exclude=session --exclude=.env --exclude=data');
      } else {
        run('git stash');
      }

      // ── 4. Fetch latest commits ──
      const fetchResult = run('git fetch origin');
      if (!fetchResult.ok) {
        return reply(ctx, `❌ *Fetch failed — check internet connection*\n${fetchResult.out}`);
      }

      // ── 5. Get current vs remote commit ──
      const currentBranch = run('git rev-parse --abbrev-ref HEAD');
      const branch = currentBranch.out || 'main';
      const localCommit = run('git rev-parse HEAD');
      const remoteCommit = run(`git rev-parse origin/${branch}`);

      if (localCommit.ok && remoteCommit.ok && localCommit.out === remoteCommit.out) {
        // Restore stash if we stashed
        if (!isForce) run('git stash pop');
        return reply(ctx,
          `✅ *Bot is already up to date!*\n\n` +
          `📌 *Current commit:* \`${localCommit.out.slice(0, 8)}\`\n` +
          `🌐 *Branch:* ${branch}\n` +
          `🔗 Repo: ${REPO_URL}`
        );
      }

      // ── 6. Pull / reset to remote ──
      const pullResult = isForce
        ? run(`git reset --hard origin/${branch}`)
        : run(`git pull origin ${branch} --rebase`);

      if (!pullResult.ok) {
        if (!isForce) run('git stash pop');
        return reply(ctx,
          `❌ *Pull failed*\n${pullResult.out}\n\n` +
          `Try: *${getConfig().prefix}update force* to discard local changes and force-pull.`
        );
      }

      // ── 7. Get changelog (commits added) ──
      const changelog = run(`git log --oneline origin/${branch}...HEAD@{1} 2>/dev/null || git log --oneline -5`);
      const newCommit = run('git rev-parse HEAD');

      // ── 8. Install any new dependencies ──
      const hasPackageChange = run(`git diff HEAD@{1} HEAD -- package.json`);
      let depsMsg = '';
      if (hasPackageChange.out && hasPackageChange.out.length > 5) {
        const npmResult = run('npm install --legacy-peer-deps', { timeout: 30000 });
        depsMsg = npmResult.ok
          ? '\n📦 *Dependencies updated successfully*'
          : `\n⚠️ *Dependency install had issues:* ${npmResult.out.slice(0, 150)}`;
      }

      // ── 9. Build the response message ──
      const changelogText = changelog.out
        ? changelog.out.split('\n').slice(0, 8).map(l => `• ${l}`).join('\n')
        : '• (no changelog available)';

      // ── 10. Detect platform and decide restart method ──
      const isRender  = !!process.env.RENDER;
      const isRailway = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
      const isHeroku  = !!process.env.DYNO;
      const isPm2     = !!process.env.PM2_HOME || !!process.env.pm_id || !!process.env.PM2_USAGE;
      const isAutoHost = isRender || isRailway || isHeroku;

      let restartMsg = '';
      let willAutoRestart = false;

      if (isPm2) {
        // PM2 managed — restart via PM2
        restartMsg = '\n🔁 *Restarting via PM2...*';
        willAutoRestart = true;
      } else if (isAutoHost) {
        // Render/Railway/Heroku — process.exit triggers auto-restart by platform
        restartMsg = '\n🔁 *Restarting automatically (platform managed)...*';
        willAutoRestart = true;
      } else {
        // VPS/Termux/Linux — manual restart required
        restartMsg =
          '\n\n⚠️ *Manual restart required* (VPS/Linux/Termux detected)\n' +
          'Stop the bot then run:\n```\nnpm start\n```\nor with PM2:\n```\npm2 restart all\n```';
        willAutoRestart = false;
      }

      const successMsg =
        `✅ *Bot Updated Successfully!*${depsMsg}\n\n` +
        `📌 *New commit:* \`${(newCommit.out || '').slice(0, 8)}\`\n` +
        `🌿 *Branch:* ${branch}\n` +
        `🔗 *Repo:* ${REPO_URL}\n\n` +
        `📝 *Changes:*\n${changelogText}` +
        restartMsg;

      await reply(ctx, successMsg);

      // ── 11. Restart ──
      if (willAutoRestart) {
        await new Promise(r => setTimeout(r, 2000)); // give reply time to send
        if (isPm2) {
          execCb('pm2 restart all', () => {});
        } else {
          process.exit(0); // Render/Railway/Heroku auto-restarts
        }
      }
    }
  });

  // ─── PRESENCE: Show autorecord and autotyping status ──────────────────────
  add({ name: 'presence', aliases: ['presencestatus'], category: 'tools', ownerOnly: true, desc: 'Show or toggle presence settings (autotyping, autorecord)', usage: '[autotyping|autorecord] [on|off]', handler: async (ctx) => {
    const cfg = getConfig();
    const st = getState();
    const arg1 = (ctx.args[0] || '').toLowerCase();
    const arg2 = (ctx.args[1] || '').toLowerCase();

    // Toggle a specific presence setting
    if (['autotyping', 'autorecord'].includes(arg1) && ['on', 'off'].includes(arg2)) {
      setToggle(st, arg1, arg2 === 'on');
      saveState(st);
      return reply(ctx, `✅ *${arg1}* → *${arg2.toUpperCase()}*\n\nUse ${cfg.prefix}presence to see full status.`);
    }

    const typingOn = isToggleEnabled(st, 'autotyping');
    const recordOn = isToggleEnabled(st, 'autorecord');

    const board = `╔══════════════════════════════╗
║  📡 *PRESENCE STATUS*
╠══════════════════════════════╣
║
║  ⌨️  *Autotyping:*   ${typingOn  ? '✅ ENABLED ' : '❌ DISABLED'}
║  🎙️ *Autorecord:*   ${recordOn  ? '✅ ENABLED ' : '❌ DISABLED'}
║
╠══════════════════════════════╣
║ _Toggle with:_
║  ${cfg.prefix}presence autotyping on/off
║  ${cfg.prefix}autorecord on/off
║  ${cfg.prefix}autotyping on/off
╚══════════════════════════════╝

${madeByFooter(cfg)}`;
    await reply(ctx, board);
  }});

  // ─── SETBOTNAME: Change bot display name ──────────────────────────────────
  add({ name: 'setbotname', aliases: ['botname', 'changebotname'], category: 'owner', ownerOnly: true, desc: 'Change the bot display name', usage: '<new name>', handler: async (ctx) => {
    const newName = textArg(ctx.args).trim();
    if (!newName) return reply(ctx, `Usage: ${getConfig().prefix}setbotname <new name>\nExample: ${getConfig().prefix}setbotname Malai-Pro`);
    if (newName.length < 2 || newName.length > 50) return reply(ctx, '❌ Bot name must be between 2 and 50 characters.');
    saveConfig({ botName: newName });
    // Also try to update the WhatsApp profile name
    let profileMsg = '';
    try {
      if (typeof ctx.sock.updateProfileName === 'function') {
        await ctx.sock.updateProfileName(newName);
        profileMsg = '\n✅ WhatsApp profile name also updated.';
      }
    } catch (e) {
      profileMsg = `\n⚠️ Config saved but WhatsApp profile update failed: ${e.message}`;
    }
    await reply(ctx, `✅ *Bot name updated!*\n\n🤖 New name: *${newName}*${profileMsg}\n\n_Use ${getConfig().prefix}ping to confirm._`);
  }});

  // ─── SETBOTPP: Change bot profile picture ────────────────────────────────
  add({ name: 'setbotpp', aliases: ['setbotimage', 'botpp', 'changebotpp'], category: 'owner', ownerOnly: true, desc: 'Change the bot profile picture — reply to an image', handler: async (ctx) => {
    const quoted = ctx.message?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const imgMsg = ctx.message?.message?.imageMessage || quoted?.imageMessage;
    if (!imgMsg) return reply(ctx, `❌ Please reply to an image with ${getConfig().prefix}setbotpp to set the bot profile picture.`);
    try {
      const stream = await downloadContentFromMessage(imgMsg, 'image');
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (typeof ctx.sock.updateProfilePicture !== 'function') {
        return reply(ctx, '❌ This Baileys version does not support updateProfilePicture on this host.');
      }
      const botJid = ctx.sock.user?.id || ctx.sock.user?.jid;
      if (!botJid) return reply(ctx, '❌ Could not determine bot JID. Try again after the bot is fully connected.');
      await ctx.sock.updateProfilePicture(botJid, buffer);
      await reply(ctx, '✅ *Bot profile picture updated successfully!*');
    } catch (err) {
      await reply(ctx, `❌ Failed to update profile picture: ${err.message || err}`);
    }
  }});

  // ─── Remaining misc stubs — honest "not available" response ───────────────
  const unavailableCmds = ['attp','simage','setpp','setbotpp','crop','stickercrop','toimg','tomp3','toptt','tovideo','videodoc','volaudio','reverseaudio','bass','blown','deep','earrape','fast','fat','nightcore','robot','slow','smooth','tupai','removebg','remini','enhance','upscale','blur','img-blur','simpcard','tonikawa','its-so-stupid','namecard','oogway','oogway2','comrade','gay','glass','jail','passed','triggered','china','indonesia','japan','korea','india','malaysia','thailand','lolice','lgbt','lovenight','shayari','roseday','heart','circle','ytcomment','newsletter','setnewsletter','setmenuimage','bomb','pingspam','addsudo','delsudo','sudo'];
  for (const name of unavailableCmds) {
    if (registry.has(name)) continue;
    add({ name, category: 'tools', desc: `${name} command`, handler: async (ctx) => reply(ctx, `⚠️ *${name}* requires additional libraries (ffmpeg/sharp/canvas) not available on this host.\n\nTry: *${getConfig().prefix}menu* for available commands.`) });
  }

  // ─── CLEAR: Delete recent bot messages ────────────────────────────────────
  if (!registry.has('clear')) add({ name: 'clear', aliases: ['clr'], category: 'owner', ownerOnly: true, desc: 'Clear bot messages from this chat (last 5)', usage: '[count]', handler: async (ctx) => {
    const count = parseInt(ctx.args[0]) || 5;
    await reply(ctx, `🧹 Clearing last ${count} bot messages...`);
    // Baileys doesn't expose chat history — inform user
    await reply(ctx, `✅ To clear messages manually:\n• Long press a message → Delete for Everyone\n\nBot can only delete messages it sent via reply.`);
  }});

  // ─── TRANSLATE: Translate text ────────────────────────────────────────────
  if (!registry.has('translate')) add({ name: 'translate', aliases: ['trt', 'tr'], category: 'tools', desc: 'Translate text to English (or target language)', usage: '<text> | [lang:<code>]', handler: async (ctx) => {
    const text = textArg(ctx.args);
    if (!text) return reply(ctx, `Usage: ${getConfig().prefix}translate Hello world\nOptional: ${getConfig().prefix}translate lang:sw Hello world`);
    try {
      const target = ctx.args.find(a => a.startsWith('lang:'))?.split(':')[1] || 'en';
      const query = text.replace(/lang:\w+\s?/, '').trim();
      const { data } = await axios.get(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=auto|${target}`,
        { timeout: 10000 }
      );
      const result = data?.responseData?.translatedText;
      if (!result) throw new Error('No translation returned');
      await reply(ctx, `🌐 *Translation* (→ ${target.toUpperCase()})\n\n${result}`);
    } catch (e) {
      await reply(ctx, `❌ Translation failed: ${e.message}`);
    }
  }});

  // ─── TTS: Text to speech ──────────────────────────────────────────────────
  if (!registry.has('tts')) add({ name: 'tts', category: 'tools', desc: 'Convert text to speech (audio)', usage: '<text>', handler: async (ctx) => {
    const text = textArg(ctx.args);
    if (!text) return reply(ctx, `Usage: ${getConfig().prefix}tts Hello world`);
    try {
      const encoded = encodeURIComponent(text.slice(0, 200));
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en&client=tw-ob`;
      await ctx.sock.sendMessage(ctx.chatId, {
        audio: { url: ttsUrl },
        mimetype: 'audio/mpeg',
        ptt: true,
        fileName: 'tts.mp3'
      }, { quoted: ctx.message });
    } catch (e) {
      await reply(ctx, `❌ TTS failed: ${e.message}`);
    }
  }});

  // ─── SS / SCREENSHOT: Screenshot a webpage ────────────────────────────────
  if (!registry.has('ss')) add({ name: 'ss', aliases: ['screenshot', 'ssweb'], category: 'tools', desc: 'Screenshot a website', usage: '<URL>', handler: async (ctx) => {
    const url = ctx.args[0];
    if (!url || !url.startsWith('http')) return reply(ctx, `Usage: ${getConfig().prefix}ss https://google.com`);
    try {
      await reply(ctx, `📸 Taking screenshot of *${url}*...`);
      const encodedUrl = encodeURIComponent(url);
      const screenshotUrl = `https://image.thum.io/get/width/1280/crop/800/${encodedUrl}`;
      await ctx.sock.sendMessage(ctx.chatId, {
        image: { url: screenshotUrl },
        caption: `📸 Screenshot: ${url}`
      }, { quoted: ctx.message });
    } catch (e) {
      await reply(ctx, `❌ Screenshot failed: ${e.message}`);
    }
  }});

  // ─── TWEET: Generate Twitter-like card ────────────────────────────────────
  if (!registry.has('tweet')) add({ name: 'tweet', category: 'tools', desc: 'Generate a fake tweet card (text)', usage: '@user <text>', handler: async (ctx) => {
    const text = textArg(ctx.args);
    if (!text) return reply(ctx, `Usage: ${getConfig().prefix}tweet Hello world`);
    const name = ctx.message?.pushName || 'User';
    const num = normalizeNumber(ctx.sender);
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    await reply(ctx, `🐦 *Tweet Card*\n\n╭────────────────────╮\n│ 🐦 *${name}*\n│ @${num}\n│\n│ ${text}\n│\n│ 🕐 ${date}\n│ ❤️ 0  🔁 0  💬 0\n╰────────────────────╯\n\n_Powered by ${getConfig().botName || 'Malai-XD-2.0'}_`);
  }});

  // ─── WASTED: GTA wasted text ──────────────────────────────────────────────
  if (!registry.has('wasted')) add({ name: 'wasted', category: 'fun', desc: 'GTA Wasted text effect', usage: '[text]', handler: async (ctx) => {
    const name = textArg(ctx.args) || ctx.message?.pushName || 'You';
    await reply(ctx, `🎮 *G T A  V*\n\n━━━━━━━━━━━━━━━━━\n    W A S T E D\n━━━━━━━━━━━━━━━━━\n\n💀 *${name.toUpperCase()}* has been wasted!\n\n_Mission Failed. We'll get em next time..._`);
  }});

  // ─── MEME: Generate a text meme ───────────────────────────────────────────
  if (!registry.has('meme')) add({ name: 'meme', category: 'fun', desc: 'Get a random meme', handler: async (ctx) => {
    try {
      const { data } = await axios.get('https://meme-api.com/gimme', { timeout: 8000 });
      if (data?.url) {
        await ctx.sock.sendMessage(ctx.chatId, {
          image: { url: data.url },
          caption: `😂 *${data.title || 'Meme'}*\n👍 ${data.ups || 0} upvotes`
        }, { quoted: ctx.message });
      } else throw new Error('No meme returned');
    } catch (e) {
      await reply(ctx, `❌ Meme fetch failed: ${e.message}`);
    }
  }});

  // ─── BIO / AUTOBIO ────────────────────────────────────────────────────────
  if (!registry.has('bio')) add({ name: 'bio', aliases: ['autobio', 'setbio'], category: 'owner', ownerOnly: true, desc: 'Set bot WhatsApp status/bio', usage: '<text>', handler: async (ctx) => {
    const text = textArg(ctx.args);
    if (!text) return reply(ctx, `Usage: ${getConfig().prefix}bio Your new bio here`);
    try {
      await ctx.sock.updateProfileStatus(text);
      await reply(ctx, `✅ Bio updated: "${text}"`);
    } catch (e) {
      await reply(ctx, `❌ Failed to update bio: ${e.message}`);
    }
  }});

  // ─── BROADCAST: Send message to all groups ────────────────────────────────
  if (!registry.has('broadcast')) add({ name: 'broadcast', aliases: ['bc'], category: 'owner', ownerOnly: true, desc: 'Broadcast message to all groups', usage: '<message>', handler: async (ctx) => {
    const text = textArg(ctx.args);
    if (!text) return reply(ctx, `Usage: ${getConfig().prefix}broadcast Your message here`);
    try {
      const groups = await ctx.sock.groupFetchAllParticipating();
      const groupIds = Object.keys(groups);
      await reply(ctx, `📢 Broadcasting to *${groupIds.length}* groups...`);
      let sent = 0;
      for (const gid of groupIds) {
        try {
          await ctx.sock.sendMessage(gid, { text: `📢 *Broadcast*\n\n${text}` });
          sent++;
          await new Promise(r => setTimeout(r, 800)); // delay between sends
        } catch { /* ignore individual failures */ }
      }
      await reply(ctx, `✅ Broadcast sent to *${sent}/${groupIds.length}* groups.`);
    } catch (e) {
      await reply(ctx, `❌ Broadcast failed: ${e.message}`);
    }
  }});

  // ─── OWNERS / SUPPORT / CHANNEL ───────────────────────────────────────────
  if (!registry.has('owners')) add({ name: 'owners', aliases: ['support', 'channel', 'dev'], category: 'core', desc: 'Show bot owner and support info', handler: async (ctx) => {
    const cfg = getConfig();
    await reply(ctx, `╭━━━〔 🤖 *BOT INFO* 〕━━━╮\n┃ 👑 *Owner:* Kimani Samuel\n┃ 📱 *Number:* +${cfg.ownerNumber || '254XXXXXXXXX'}\n┃ 🔗 *GitHub:* github.com/Brokensmile47\n┃ 🤖 *Bot:* ${cfg.botName || 'Malai-XD-2.0'}\n╰━━━━━━━━━━━━━━━━━━━━━╯`);
  }});

  // ─── WARN / WARNINGS / RESETWARN ─────────────────────────────────────────
  add({ name: 'warn', category: 'group', groupOnly: true, adminOnly: true, desc: 'Warn a user (3 warns = kick)', usage: '@user [reason]', handler: async (ctx) => {
    const targets = jidsFromArgs(ctx, { fallbackToSender: false });
    if (!targets.length) return reply(ctx, `Usage: ${getConfig().prefix}warn @user [reason]`);
    const reason = ctx.args.filter(a => !a.startsWith('@') && !/^\d+$/.test(a)).join(' ') || 'No reason given';
    const st = getState();
    if (!st.warnings) st.warnings = {};
    const results = [];
    for (const jid of targets) {
      const key = `${ctx.chatId}:${jid}`;
      st.warnings[key] = (st.warnings[key] || 0) + 1;
      const count = st.warnings[key];
      results.push(`⚠️ @${normalizeNumber(jid)} warned (${count}/3). Reason: ${reason}`);
      if (count >= 3) {
        st.warnings[key] = 0;
        try { await ctx.sock.groupParticipantsUpdate(ctx.chatId, [jid], 'remove'); results.push(`🚫 @${normalizeNumber(jid)} kicked after 3 warnings.`); } catch {}
      }
    }
    saveState(st);
    await reply(ctx, results.join('\n'), { mentions: targets });
  }});
  add({ name: 'warnings', aliases: ['checkwarn', 'warncount'], category: 'group', groupOnly: true, desc: 'Check warnings for a user', usage: '@user', handler: async (ctx) => {
    const targets = jidsFromArgs(ctx, { fallbackToSender: true });
    const st = getState();
    const lines = targets.map(jid => `@${normalizeNumber(jid)}: ${st.warnings?.[ctx.chatId + ':' + jid] || 0}/3 warnings`);
    await reply(ctx, lines.join('\n') || 'No data.', { mentions: targets });
  }});
  add({ name: 'resetwarn', aliases: ['clearwarn'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Reset warnings for a user', usage: '@user', handler: async (ctx) => {
    const targets = jidsFromArgs(ctx, { fallbackToSender: false });
    if (!targets.length) return reply(ctx, `Usage: ${getConfig().prefix}resetwarn @user`);
    const st = getState();
    if (!st.warnings) st.warnings = {};
    targets.forEach(jid => { st.warnings[`${ctx.chatId}:${jid}`] = 0; });
    saveState(st);
    await reply(ctx, `✅ Warnings reset for: ${targets.map(j => '@' + normalizeNumber(j)).join(', ')}`, { mentions: targets });
  }});

  // ─── TOPMEMBERS ───────────────────────────────────────────────────────────
  add({ name: 'topmembers', aliases: ['leaderboard', 'topactive'], category: 'group', groupOnly: true, desc: 'Top 10 most active members by message count', handler: async (ctx) => {
    const st = getState();
    const groupCounts = st.msgCounts?.[ctx.chatId] || {};
    const sorted = Object.entries(groupCounts).sort(([, a], [, b]) => b - a).slice(0, 10);
    if (!sorted.length) return reply(ctx, '📊 No activity recorded yet. Activity is tracked from this point onward.');
    const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
    const lines = sorted.map(([jid, n], i) => `${medals[i]} @${normalizeNumber(jid)} — *${n}* msgs`);
    await reply(ctx, `🏆 *Top Active Members*\n\n${lines.join('\n')}`, { mentions: sorted.map(([j]) => j) });
  }});

  // ─── ANTICALL ─────────────────────────────────────────────────────────────
  add({ name: 'anticall', category: 'owner', ownerOnly: true, desc: 'Toggle auto-reject incoming WhatsApp calls', usage: '<on|off|status>', handler: async (ctx) => {
    const st = getState();
    const action = (ctx.args[0] || 'status').toLowerCase();
    if (action === 'on') { setToggle(st, 'anticall', true); saveState(st); return reply(ctx, '✅ *Anticall ON* — incoming calls will be auto-rejected.'); }
    if (action === 'off') { setToggle(st, 'anticall', false); saveState(st); return reply(ctx, '❌ *Anticall OFF*'); }
    const on = isToggleEnabled(st, 'anticall');
    return reply(ctx, `*Anticall:* ${on ? '✅ ON' : '❌ OFF'}\n\n${getConfig().prefix}anticall on/off`);
  }});

  // ─── PMBLOCKER ────────────────────────────────────────────────────────────
  add({ name: 'pmblocker', aliases: ['pmblock', 'blockpm'], category: 'owner', ownerOnly: true, desc: 'Block DM messages from non-owners with auto-reply', usage: '<on|off|setmsg <text>|status>', handler: async (ctx) => {
    const st = getState();
    if (!st.pmblocker) st.pmblocker = { enabled: false, message: '⚠️ DMs are blocked. Please contact the owner in a group.' };
    const action = (ctx.args[0] || 'status').toLowerCase();
    const customMsg = ctx.args.slice(1).join(' ').trim();
    if (action === 'on') { st.pmblocker.enabled = true; if (customMsg) st.pmblocker.message = customMsg; saveState(st); return reply(ctx, `✅ *PM Blocker ON*\nMessage: "${st.pmblocker.message}"`); }
    if (action === 'off') { st.pmblocker.enabled = false; saveState(st); return reply(ctx, '❌ *PM Blocker OFF*'); }
    if (action === 'setmsg' && customMsg) { st.pmblocker.message = customMsg; saveState(st); return reply(ctx, `✅ PM block message: "${customMsg}"`); }
    return reply(ctx, `*PM Blocker:* ${st.pmblocker.enabled ? '✅ ON' : '❌ OFF'}\nMessage: "${st.pmblocker.message}"\n\n${getConfig().prefix}pmblocker on/off\n${getConfig().prefix}pmblocker setmsg <custom>`);
  }});

  // ─── AUTOREAD ─────────────────────────────────────────────────────────────
  add({ name: 'autoread', category: 'owner', ownerOnly: true, desc: 'Auto-read messages + show typing/blue ticks like a real person', usage: '<on|off|humanize|status>', handler: async (ctx) => {
    const st = getState();
    const action = (ctx.args[0] || 'status').toLowerCase();
    
    if (action === 'on') { 
      setToggle(st, 'autoread', true);
      if (!st.autoreadConfig) st.autoreadConfig = { humanize: false, typingDelay: 1000, replyDelay: 2000 };
      saveState(st); 
      return reply(ctx, `✅ *Autoread ON*
• Auto-marks messages as read
• Shows blue ticks ✅✅
• Typing indicators enabled

Use ${getConfig().prefix}autoread humanize for AI-powered responses`); 
    }
    
    if (action === 'humanize') {
      setToggle(st, 'autoread', true);
      if (!st.autoreadConfig) st.autoreadConfig = {};
      st.autoreadConfig.humanize = true;
      st.autoreadConfig.typingDelay = 1500 + Math.random() * 1500; // random 1.5-3s
      st.autoreadConfig.replyDelay = 2000 + Math.random() * 3000; // random 2-5s
      saveState(st);
      return reply(ctx, `✅ *Humanized Autoread ENABLED*
• ✅✅ Blue ticks on messages
• 👁️ Typing indicators (like a real person)
• ⏱️ Random response delays
• 🤖 AI-powered replies (WIP)

Behaves like a real person reading your messages!`);
    }
    
    if (action === 'off') { 
      setToggle(st, 'autoread', false);
      saveState(st); 
      return reply(ctx, '❌ *Autoread OFF*'); 
    }
    
    const cfg = st.autoreadConfig || {};
    const status = isToggleEnabled(st, 'autoread') ? '✅ ON' : '❌ OFF';
    const humanize = cfg.humanize ? '✅ YES (Real person mode)' : '❌ NO (Fast mode)';
    return reply(ctx, `*Autoread Status:*
Status: ${status}
Humanized: ${humanize}
Typing Delay: ${cfg.typingDelay || 1000}ms
Reply Delay: ${cfg.replyDelay || 2000}ms

Commands:
${getConfig().prefix}autoread on → Fast auto-read
${getConfig().prefix}autoread humanize → Real person mode
${getConfig().prefix}autoread off → Disable`);
  }});

  // ─── AUTOREACT ────────────────────────────────────────────────────────────
  add({ name: 'autoreact', aliases: ['areact', 'autoreaction'], category: 'owner', ownerOnly: true, desc: 'Auto-react with emoji to every message', usage: '<on|off|status>', handler: async (ctx) => {
    const st = getState();
    const action = (ctx.args[0] || 'status').toLowerCase();
    if (action === 'on') { setToggle(st, 'autoreact', true); saveState(st); return reply(ctx, '✅ *Autoreact ON* — bot will react to every message.'); }
    if (action === 'off') { setToggle(st, 'autoreact', false); saveState(st); return reply(ctx, '❌ *Autoreact OFF*'); }
    return reply(ctx, `*Autoreact:* ${isToggleEnabled(st, 'autoreact') ? '✅ ON' : '❌ OFF'}\n\n${getConfig().prefix}autoreact on/off`);
  }});

  // ─── ANTIBADWORD ──────────────────────────────────────────────────────────
  const _defaultBadWords = ['fuck','shit','bitch','asshole','bastard','cunt','motherfucker','nigga','faggot','retard','whore','slut','cock','pussy','twat','wanker','dick'];
  add({ name: 'antibadword', aliases: ['antiswear', 'badwordfilter'], category: 'group', groupOnly: true, adminOnly: true, desc: 'Bad word filter for this group', usage: '<on|off|add word|remove word|list|status>', handler: async (ctx) => {
    const st = getState();
    if (!st.groupSettings) st.groupSettings = {};
    if (!st.groupSettings[ctx.chatId]) st.groupSettings[ctx.chatId] = {};
    const grp = st.groupSettings[ctx.chatId];
    const action = (ctx.args[0] || 'status').toLowerCase();
    const wordArg = ctx.args.slice(1).join(' ').toLowerCase().trim();
    const p = getConfig().prefix;
    if (action === 'on') {
      grp.antibadword = { enabled: true, words: grp.antibadword?.words || [..._defaultBadWords] };
      saveState(st);
      return reply(ctx, `✅ *Antibadword ON* — ${grp.antibadword.words.length} words filtered.\n${p}antibadword add <word> to add more.`);
    }
    if (action === 'off') { if (grp.antibadword) grp.antibadword.enabled = false; saveState(st); return reply(ctx, '❌ *Antibadword OFF*'); }
    if (action === 'add' && wordArg) {
      if (!grp.antibadword) grp.antibadword = { enabled: false, words: [..._defaultBadWords] };
      if (!grp.antibadword.words.includes(wordArg)) grp.antibadword.words.push(wordArg);
      saveState(st);
      return reply(ctx, `✅ Added *"${wordArg}"* to the word filter.`);
    }
    if (action === 'remove' && wordArg) {
      if (grp.antibadword?.words) grp.antibadword.words = grp.antibadword.words.filter(w => w !== wordArg);
      saveState(st);
      return reply(ctx, `✅ Removed *"${wordArg}"* from the word filter.`);
    }
    if (action === 'list') {
      const words = grp.antibadword?.words || _defaultBadWords;
      return reply(ctx, `*Bad Word List* (${words.length}):\n${words.join(', ')}`);
    }
    const status = grp.antibadword?.enabled ? `✅ ON (${grp.antibadword.words.length} words)` : '❌ OFF';
    return reply(ctx, `*Antibadword:* ${status}\n\n${p}antibadword on/off\n${p}antibadword add <word>\n${p}antibadword remove <word>\n${p}antibadword list`);
  }});

  // ─── ANTITAG (per-group config) ───────────────────────────────────────────
  add({ name: 'antitag', category: 'group', groupOnly: true, adminOnly: true, desc: 'Toggle mass-tag protection for this group', usage: '<on|off|set delete|kick|status>', handler: async (ctx) => {
    const st = getState();
    if (!st.groupSettings) st.groupSettings = {};
    if (!st.groupSettings[ctx.chatId]) st.groupSettings[ctx.chatId] = {};
    const grp = st.groupSettings[ctx.chatId];
    const action = (ctx.args[0] || 'status').toLowerCase();
    const setAction = (ctx.args[1] || '').toLowerCase();
    const p = getConfig().prefix;
    if (action === 'on') { grp.antitag = { enabled: true, action: grp.antitag?.action || 'delete' }; saveState(st); return reply(ctx, `✅ *Antitag ON* (action: ${grp.antitag.action})`); }
    if (action === 'off') { if (grp.antitag) grp.antitag.enabled = false; saveState(st); return reply(ctx, '❌ *Antitag OFF*'); }
    if (action === 'set' && ['delete','kick'].includes(setAction)) { if (!grp.antitag) grp.antitag = { enabled: false }; grp.antitag.action = setAction; saveState(st); return reply(ctx, `✅ Antitag action: *${setAction}*`); }
    const status = grp.antitag?.enabled ? `✅ ON (action: ${grp.antitag.action || 'delete'})` : '❌ OFF';
    return reply(ctx, `*Antitag:* ${status}\n\n${p}antitag on/off\n${p}antitag set delete|kick`);
  }});

  // ─── ANTIDELETE (global toggle command) ───────────────────────────────────
  add({ name: 'antidelete', aliases: ['antidel'], category: 'owner', ownerOnly: true, desc: 'Toggle antidelete — forwards deleted messages to owner', usage: '<on|off|status>', handler: async (ctx) => {
    const st = getState();
    const action = (ctx.args[0] || 'status').toLowerCase();
    if (action === 'on') { setToggle(st, 'antidelete', true); saveState(st); return reply(ctx, '✅ *Antidelete ON* — deleted messages forwarded to you.'); }
    if (action === 'off') { setToggle(st, 'antidelete', false); saveState(st); return reply(ctx, '❌ *Antidelete OFF*'); }
    return reply(ctx, `*Antidelete:* ${isToggleEnabled(st, 'antidelete') ? '✅ ON' : '❌ OFF'}\n\n${getConfig().prefix}antidelete on/off`);
  }});

  // ─── LEAVE: Bot leaves the group (owner only) ─────────────────────────────
  add({ name: 'leave', aliases: ['leavegroup', 'exitgrp'], category: 'owner',
    groupOnly: true, ownerOnly: true,
    desc: 'Remove owner from this group',
    handler: async (ctx) => {
      try {
        const cfg = getConfig();
        const ownerJid = `${String(cfg.ownerNumber || OWNER_NUMBER).replace(/\D/g, '')}@s.whatsapp.net`;
        await reply(ctx, '👋 *Owner leaving this group...*');
        await new Promise(r => setTimeout(r, 1000));
        await ctx.sock.groupParticipantsUpdate(ctx.chatId, [ownerJid], 'remove');
      } catch (err) {
        // If bot not admin, try making bot leave instead
        try {
          await reply(ctx, '⚠️ Bot needs admin rights to remove owner. Leaving as bot instead...');
          await new Promise(r => setTimeout(r, 1000));
          await ctx.sock.groupLeave(ctx.chatId);
        } catch (e2) {
          await reply(ctx, `❌ Failed to leave: ${e2.message}`);
        }
      }
    }
  });

  // ─── BOTLEAVE: Make the bot itself leave the group ─────────────────────────
  add({ name: 'botleave', aliases: ['kickbot', 'removebot'], category: 'owner',
    groupOnly: true, ownerOnly: true,
    desc: 'Make the bot leave this group',
    handler: async (ctx) => {
      try {
        await reply(ctx, '🤖 *Malai-XD-2.0 is leaving this group...*\n_Goodbye everyone! 👋_');
        await new Promise(r => setTimeout(r, 1500));
        await ctx.sock.groupLeave(ctx.chatId);
      } catch (err) {
        await reply(ctx, `❌ Failed: ${err.message}`);
      }
    }
  });

  // ─── KICKME: Remove owner from this group ─────────────────────────────────
  add({ name: 'kickme', aliases: ['removeme', 'exitgroup'], category: 'owner',
    groupOnly: true, ownerOnly: true,
    desc: 'Remove yourself (owner) from this group',
    handler: async (ctx) => {
      try {
        const cfg = getConfig();
        const ownerJid = `${normalizeNumber(cfg.ownerNumber || '')}@s.whatsapp.net`;
        await reply(ctx, '👋 *Removing you from this group...*');
        await new Promise(r => setTimeout(r, 1000));
        await ctx.sock.groupParticipantsUpdate(ctx.chatId, [ownerJid], 'remove');
      } catch (err) {
        await reply(ctx, `❌ Failed: ${err.message}\n\n_Note: Bot must be admin to remove members._`);
      }
    }
  });

  // ─── CLEARTMP ─────────────────────────────────────────────────────────────
  add({ name: 'cleartmp', aliases: ['clearcache', 'clean'], category: 'owner', ownerOnly: true, desc: 'Clear temporary/cache files', handler: async (ctx) => {
    const tmpDirs = ['./tmp', './temp', './data/antidelete_tmp'].filter(d => { try { return fs.existsSync(d); } catch { return false; } });
    let total = 0;
    for (const dir of tmpDirs) {
      try { for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); total++; } catch {} } } catch {}
    }
    await reply(ctx, `✅ Cleared *${total}* temporary files.`);
  }});


  return { commands, registry, getConfig, getState };
}
