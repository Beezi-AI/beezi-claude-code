import { getToken } from '../lib/credentials.mjs';
import { whoami } from '../lib/whoami.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

function formatLastSeen(iso) {
  if (!iso) return 'no sessions yet';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleString();
}

async function main() {
  const token = await getToken().catch(() => null);
  if (!token) {
    console.log('Beezi: this machine is not linked. Run /beezi:login to link it.');
    return;
  }

  const who = await whoami(token);
  if (who === null) {
    console.log('Beezi: could not reach the server to check your link. Check your connection and try again.');
    return;
  }
  if (!who.valid) {
    console.log('Beezi: this machine’s link was revoked. Run /beezi:login to re-link.');
    return;
  }

  console.log('✓ Beezi: this machine is linked.');
  if (who.name) console.log(`  Account: ${who.name}${who.email ? ` <${who.email}>` : ''}`);
  else if (who.email) console.log(`  Account: ${who.email}`);
  if (who.deviceCount !== null) {
    console.log(`  Devices linked to your account: ${who.deviceCount}`);
  }
  console.log(`  Last session: ${formatLastSeen(who.lastSeenAt)}`);
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
