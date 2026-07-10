import { File, Blob } from 'buffer';
import { webcrypto } from 'crypto';
if (!globalThis.File) globalThis.File = File;
if (!globalThis.Blob) globalThis.Blob = Blob;
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const baileys = await import('@whiskeysockets/baileys');
const required = ['default','useMultiFileAuthState','DisconnectReason','fetchLatestBaileysVersion','makeCacheableSignalKeyStore','Browsers'];
for (const key of required) if (!baileys[key]) throw new Error(`Baileys missing export: ${key}`);
console.log('OK: Baileys ESM import compatible.');
