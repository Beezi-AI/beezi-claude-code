import { readHookInput } from '../lib/hook-input.mjs';
import { reportSessionError } from '../lib/stop-failure.mjs';

const input = readHookInput();
if (!input) process.exit(0);
reportSessionError(input).catch(() => {}).finally(() => process.exit(0));
