const ROUTES = { chat: 'index', settings: 'settings', probe: 'probe', tools: 'tools', workspace: 'workspace' };

export function navigate(route) {
  const target = ROUTES[route];
  if (!target || typeof $falcon.navTo !== 'function') {
    const error = new Error('Navigation unavailable');
    error.code = 'CAPABILITY_UNAVAILABLE';
    throw error;
  }
  $falcon.navTo(target);
}

export function leaveSettings() {
  if (typeof $falcon.closePageByName === 'function') $falcon.closePageByName('settings');
  else navigate('chat');
}

export function leaveTools() {
  if (typeof $falcon.closePageByName === 'function') $falcon.closePageByName('tools');
  else navigate('chat');
}

export function leaveWorkspace() {
  if (typeof $falcon.closePageByName === 'function') $falcon.closePageByName('workspace');
  else navigate('tools');
}
