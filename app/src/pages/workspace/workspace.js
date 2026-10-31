import WorkspaceComponent from './workspace.vue';
import { BasePage } from '../../base-page.js';

class WorkspacePage extends BasePage {
  onLoad(options) {
    super.onLoad(options);
    this.setRootComponent(WorkspaceComponent);
  }
}
export default WorkspacePage;
