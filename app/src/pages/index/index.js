import ChatComponent from '../chat/chat.vue';
import { BasePage } from '../../base-page.js';

// Canonical application entry; M0 probes have their own registered route.
class IndexPage extends BasePage {
  constructor() {
    super();
  }

  onLoad(options) {
    super.onLoad(options);
    this.setRootComponent(ChatComponent);
  }
}

export default IndexPage;
