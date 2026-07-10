import { File, Blob } from 'buffer';
import { webcrypto } from 'crypto';
if (!globalThis.File) globalThis.File = File;
if (!globalThis.Blob) globalThis.Blob = Blob;
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { buildCommands } = await import('../src/commands.js');
const { commands, registry } = buildCommands();
const names = new Set(commands.map(c => c.name));
if (commands.length < 200) throw new Error(`Expected 200+ commands, found ${commands.length}`);
for (const c of commands) {
  if (!c.name || typeof c.handler !== 'function') throw new Error(`Invalid command: ${c.name}`);
}
console.log(`OK: ${commands.length} primary commands, ${registry.size} triggers including aliases.`);
console.log(`Sample: ${[...names].slice(0, 25).join(', ')}`);
