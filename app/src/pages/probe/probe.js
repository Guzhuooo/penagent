import ProbeComponent from './probe.vue';
import { BasePage } from '../../base-page.js';

class ProbePage extends BasePage {
  onLoad(options) {
    super.onLoad(options);
    this.setRootComponent(ProbeComponent);
  }
}
export default ProbePage;
