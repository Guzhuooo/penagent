import { profile, getDeviceInfo } from './profile.js';
import { getGlobalManager } from './global.js';
import * as net from '../net/index.js';

function unavailable(message) {
  const error = new Error(message);
  error.code = 'CAPABILITY_UNAVAILABLE';
  return error;
}

// No dynamic command, executable, argv, headers or shell fragments are accepted.
const PRESETS = {
  system_arch: 'uname -m',
  device_time: "date '+%Y-%m-%dT%H:%M:%S%z'",
};

export async function execPreset(preset, cancellation) {
  const commandId = preset && preset.commandId;
  const params = preset && preset.params;
  if (!Object.prototype.hasOwnProperty.call(PRESETS, commandId) ||
      !params || Object.keys(params).length) {
    const error = new Error('Unsupported preset or parameters');
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  if (cancellation && cancellation.isCancelled()) {
    const error = new Error('Preset cancelled'); error.code = 'CANCELLED'; throw error;
  }
  // A synchronous execShell cannot currently meet the run deadline/stop contract.
  if (!profile.capabilities.execDeadlineAndCancellation) {
    throw unavailable('Read-only presets are disabled until execution deadlines and cancellation are verified');
  }
  const manager = getGlobalManager();
  if (typeof manager.execShell !== 'function') throw unavailable('Preset execution is unavailable');
  const started = Date.now();
  const result = manager.execShell(PRESETS[commandId]);
  if (cancellation && cancellation.isCancelled()) {
    const error = new Error('Preset cancelled'); error.code = 'CANCELLED'; throw error;
  }
  return { commandId, status: result === true ? 'completed' : 'unknown', elapsedMs: Date.now() - started, stdoutAvailable: false };
}

execPreset.supportsCancellation = false;
execPreset.supportsTimeout = false;

export async function headProbe(url, options) {
  if (typeof net.headProbe !== 'function') {
    throw unavailable('HEAD probing is unavailable on this network adapter');
  }
  return net.headProbe(url, options);
}

export { profile, getDeviceInfo };
