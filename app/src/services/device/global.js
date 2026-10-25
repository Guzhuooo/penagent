import globalModule from 'global';

let manager = null;
export function getGlobalManager() {
  if (!manager) manager = new globalModule.Global();
  return manager;
}
