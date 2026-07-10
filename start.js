// Bootstrap required for Node 18 with modern undici/Baileys dependencies.
import { File, Blob } from 'buffer';
if (!globalThis.File) globalThis.File = File;
if (!globalThis.Blob) globalThis.Blob = Blob;
if (!globalThis.crypto) {
  const { webcrypto } = await import('crypto');
  globalThis.crypto = webcrypto;
}
await import('./src/index.js');
