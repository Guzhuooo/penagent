// Hardware values belong here only. Evidence: DEVICE_PROFILE.md §2–3,
// STANDARDS.md §1; input confirmation evidence is narrower than full IME validation.
export const profile = {
  id: 'y02-4.9.7',
  model: 'Y02-3562',
  firmware: '4.9.7',
  architecture: 'aarch64',
  runtime: { falcon: '0.0.32', vue: '2.6.12', quickjs: '20200705' },
  screen: {
    logicalWidth: 936, logicalHeight: 280,
    physicalWidth: 280, physicalHeight: 936,
    direction: 270, xoffset: 0, yoffset: 0,
  },
  touch: { direction: 270, xoffset: 0, yoffset: 0 },
  capabilities: {
    viewportUnits: true,
    inputConfirmation: true,
    execDeadlineAndCancellation: false,
    execStdout: false,
  },
};

export function getDeviceInfo() {
  return {
    profile_id: profile.id, model: profile.model, firmware: profile.firmware,
    abi: { machine: profile.architecture, bits: 64, libc: 'glibc' },
    runtime: Object.assign({}, profile.runtime),
    screen: { logical: { width: profile.screen.logicalWidth, height: profile.screen.logicalHeight } },
    execShell: 'unavailable: deadline and cancellation not verified; no stdout contract',
  };
}
