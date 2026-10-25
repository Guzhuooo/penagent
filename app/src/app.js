import { BasePage } from './base-page.js';

import { profile } from './services/device/profile.js';

class App extends $falcon.App {
  constructor() {
    super();
  }

  onLaunch(options) {
    super.onLaunch(options);
    this.setViewPort(profile.screen.logicalWidth);
    $falcon.useDefaultBasePageClass(BasePage);
    console.log('[pa:app] launched');
  }

  onShow() { super.onShow(); }
  onHide() { super.onHide(); }
  onDestroy() { super.onDestroy(); }
}

export default App;
