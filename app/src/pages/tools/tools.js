import ToolsComponent from './tools.vue';
import { BasePage } from '../../base-page.js';

class ToolsPage extends BasePage {
  onLoad(options) {
    super.onLoad(options);
    this.setRootComponent(ToolsComponent);
  }
}
export default ToolsPage;
