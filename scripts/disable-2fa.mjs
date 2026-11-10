// Emergency 2FA reset for the administrator (run ON THE SERVER, in the app folder, by someone with shell access):
//   node scripts/disable-2fa.mjs
// Removes the TOTP enrollment and recovery codes from data/auth.json. The password and username are kept.
// A backup copy data/auth.json.bak-<time> is written first (mode 0600). Nothing else is touched.
import fs from 'node:fs';
import path from 'node:path';
const file = path.resolve(process.cwd(), 'data', 'auth.json');
if (!fs.existsSync(file)) { console.error('data/auth.json not found — run this in the tradebot-phase6.2 folder.'); process.exit(1); }
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!rec.totp && !rec.pendingTotp) { console.log('2FA is not enabled; nothing changed.'); process.exit(0); }
const backup = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '');
fs.writeFileSync(backup, JSON.stringify(rec), { mode: 0o600 });
delete rec.totp; delete rec.pendingTotp; delete rec.recovery;
fs.writeFileSync(file + '.tmp', JSON.stringify(rec), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
fs.appendFileSync(path.join(path.dirname(file), 'security-audit.log'), JSON.stringify({ at: new Date().toISOString(), event: '2fa.disable', ok: true, detail: 'server-side reset script' }) + '\n', { mode: 0o600 });
console.log('2FA removed. Backup: ' + backup + '. Restart is not required. Sign in with the password and enable 2FA again.');
