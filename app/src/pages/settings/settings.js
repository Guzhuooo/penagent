import SettingsComponent from './settings.vue';
import { BasePage } from '../../base-page.js';

class SettingsPage extends BasePage {
  onLoad(options) {
    super.onLoad(options);
    this.setRootComponent(SettingsComponent);
  }
}
export default SettingsPage;
