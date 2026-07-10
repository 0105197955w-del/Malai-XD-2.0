import os from 'os';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const MIN_PAIRING_DIGITS = 7;
const MAX_PAIRING_DIGITS = 15;

export function cleanPhoneNumber(value = '') {
  return String(value).replace(/[^0-9]/g, '');
}

export function isValidPairingNumber(number = '') {
  const cleaned = cleanPhoneNumber(number);
  return cleaned.length >= MIN_PAIRING_DIGITS && cleaned.length <= MAX_PAIRING_DIGITS;
}

export function validatePairingNumber(number = '') {
  const cleaned = cleanPhoneNumber(number);
  if (!cleaned) {
    throw new Error('Phone number is required. Use full international format, for example 15551234567.');
  }
  if (!isValidPairingNumber(cleaned)) {
    throw new Error(`Invalid phone number: ${number}. Use 7-15 digits in international format without +, spaces, or leading zero.`);
  }
  return cleaned;
}

export function formatPairingCode(code = '') {
  const raw = String(code || '').replace(/[^A-Za-z0-9]/g, '');
  return raw.match(/.{1,4}/g)?.join('-') || String(code || '');
}

export function loginMethod() {
  if (process.argv.includes('--qr')) return 'qr';
  if (process.argv.includes('--pair') || process.argv.includes('--pairing-code')) return 'pair';
  return String(process.env.LOGIN_METHOD || 'pair').trim().toLowerCase();
}

export function browserConfig() {
  if (process.env.BROWSER) {
    const parts = process.env.BROWSER.split(',').map(v => v.trim()).filter(Boolean);
    if (parts.length >= 3) return parts.slice(0, 3);
  }

  // Knightbot-MD style browser tuple, with sane defaults for common hosts.
  switch (os.platform()) {
    case 'win32':
      return ['Windows', 'Chrome', '20.0.04'];
    case 'darwin':
      return ['Mac OS', 'Safari', '16.0'];
    case 'android':
      return ['Android', 'Chrome', '20.0.04'];
    default:
      return ['Ubuntu', 'Chrome', '20.0.04'];
  }
}

export async function promptForPairingNumber(fallback = '') {
  const cleanedFallback = cleanPhoneNumber(fallback);
  if (cleanedFallback) return validatePairingNumber(cleanedFallback);
  if (!process.stdin.isTTY) return '';

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('Enter WhatsApp number in international format, without + or spaces: ');
    return validatePairingNumber(answer);
  } finally {
    rl.close();
  }
}

export function pairInstructions(code) {
  return [
    `Your Pairing Code: ${formatPairingCode(code)}`,
    '',
    'Open WhatsApp on your phone:',
    '1. Settings > Linked devices',
    '2. Link a device',
    '3. Link with phone number instead',
    '4. Enter the code shown above'
  ].join('\n');
}

export function createPairingManager(sock, options = {}) {
  const logger = options.logger || console;
  let inFlight = null;

  async function requestPairing(number, source = 'startup') {
    if (!sock?.requestPairingCode) throw new Error('Pairing is not supported by this Baileys version.');
    if (sock.authState?.creds?.registered) throw new Error('This bot is already linked. Delete the session folder to pair a new account.');

    const cleanNumber = validatePairingNumber(number);
    if (inFlight) await inFlight.catch(() => {});

    inFlight = (async () => {
      const rawCode = await sock.requestPairingCode(cleanNumber);
      const code = formatPairingCode(rawCode);
      logger.log(`[pairing:${source}] Pairing code for ${cleanNumber}: ${code}`);
      logger.log(pairInstructions(code));
      return { ok: true, number: cleanNumber, code, rawCode: String(rawCode || '') };
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return { requestPairing };
}
