import { readHookInput } from '../lib/hook-input.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';

const input = readHookInput();
if (!input) process.exit(0);
runCheckpoint(input).catch(() => {}).finally(() => process.exit(0));
