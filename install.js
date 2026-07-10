// install.js — uploads to root of your bot folder, change start command to: node install.js
import { execSync } from 'child_process';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

console.log('===========================================');
console.log('  Malai-XD-2.0 — Dependency Installer');
console.log('===========================================\n');

const packages = [
  { name: '@hapi/boom',              version: '^10.0.1' },
  { name: '@whiskeysockets/baileys', version: '^7.0.0-rc.9' },
  { name: 'axios',                   version: '^1.8.4' },
  { name: 'dotenv',                  version: '^16.4.5' },
  { name: 'file-type',               version: '^16.5.4' },
  { name: 'pino',                    version: '^9.6.0' },
  { name: 'qrcode-terminal',         version: '^0.12.0' },
  { name: 'yt-search',               version: '^2.13.1' },
  { name: 'mumaker',                 version: '^2.0.0'  }, // 1.0.4 does not exist on npm
];

// Check which are missing
const missing = [];
for (const pkg of packages) {
  try { _require.resolve(pkg.name); }
  catch { missing.push(pkg); }
}

if (missing.length === 0) {
  console.log('✅ All packages already installed!\n');
} else {
  console.log(`📦 Missing ${missing.length} package(s): ${missing.map(p => p.name).join(', ')}\n`);

  let failed = [];

  // Try installing all at once first
  const allSpec = missing.map(p => `${p.name}@${p.version}`).join(' ');
  console.log('⏳ Installing all packages...\n');
  try {
    execSync(`npm install ${allSpec} --legacy-peer-deps --save`, {
      stdio: 'inherit', cwd: process.cwd(), timeout: 300000
    });
    console.log('\n✅ All packages installed!\n');
  } catch {
    console.log('\n⚠️  Bulk install failed — trying one by one...\n');
    for (const pkg of missing) {
      try {
        process.stdout.write(`  Installing ${pkg.name}... `);
        execSync(`npm install ${pkg.name}@${pkg.version} --legacy-peer-deps --save`, {
          stdio: 'pipe', cwd: process.cwd(), timeout: 120000
        });
        console.log('✅');
      } catch (err) {
        // Try without version pin if exact version fails
        try {
          execSync(`npm install ${pkg.name} --legacy-peer-deps --save`, {
            stdio: 'pipe', cwd: process.cwd(), timeout: 120000
          });
          console.log('✅ (latest)');
        } catch {
          console.log('❌ skipped (optional)');
          failed.push(pkg.name);
        }
      }
    }

    if (failed.length > 0) {
      console.log(`\n⚠️  Skipped optional packages: ${failed.join(', ')}`);
      console.log('   Bot will still run — these are used for image effects only.\n');
    } else {
      console.log('\n✅ All packages installed!\n');
    }
  }
}

console.log('🚀 Starting Malai-XD-2.0...\n');
console.log('===========================================\n');
await import('./start.js');
