import os from 'node:os';
import path from 'node:path';

export function beeziHome() {
  return process.env.BEEZI_HOME ?? path.join(os.homedir(), '.beezi');
}

export function queueDir() {
  return path.join(beeziHome(), 'queue');
}

export function stateDir() {
  return path.join(beeziHome(), 'state');
}

export function credentialsFile() {
  return path.join(beeziHome(), 'credentials.json');
}

export function billingConfigFile() {
  return path.join(beeziHome(), 'billing.json');
}
