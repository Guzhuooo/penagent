// ============================================================
// BasePage —— 统一资源跟踪与释放
// 事实来源：docs/STANDARDS.md §6
// 所有 timer / 订阅都由页面基类跟踪，onUnload 时统一释放。
// ============================================================

class ResourcePage extends $falcon.Page {
  constructor() {
    super();
    this.falconOnTokens = [];
    this.timeoutTokens = new Set();
    this.intervalTokens = new Set();
    this.released = false;
    this.disposers = [];
  }

  own(dispose) {
    if (this.released) dispose();
    else this.disposers.push(dispose);
    return dispose;
  }

  on(name, callback) {
    const token = $falcon.on(name, callback);
    this.falconOnTokens.push([token, name]);
    return token;
  }

  off(name, callbackOrToken) {
    $falcon.off(name, callbackOrToken);
    this.falconOnTokens = this.falconOnTokens.filter((item) => item[0] !== callbackOrToken);
  }

  setTimeout(callback, delay) {
    const token = setTimeout(() => {
      this.timeoutTokens.delete(token);
      callback();
    }, delay);
    this.timeoutTokens.add(token);
    return token;
  }

  clearTimeout(token) {
    clearTimeout(token);
    this.timeoutTokens.delete(token);
  }

  setInterval(callback, delay) {
    const token = setInterval(callback, delay);
    this.intervalTokens.add(token);
    return token;
  }

  clearInterval(token) {
    clearInterval(token);
    this.intervalTokens.delete(token);
  }

  sleep(delay) {
    return new Promise((resolve) => this.setTimeout(resolve, delay));
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.disposers.splice(0).forEach((dispose) => {
      try {
        const result = dispose();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (error) { /* Continue releasing the remaining owners. */ }
    });
    this.falconOnTokens.forEach((item) => {
      try { $falcon.off(item[1], item[0]); } catch (error) { /* Continue cleanup. */ }
    });
    this.falconOnTokens = [];
    this.timeoutTokens.forEach((token) => clearTimeout(token));
    this.intervalTokens.forEach((token) => clearInterval(token));
    this.timeoutTokens.clear();
    this.intervalTokens.clear();
  }
}

export class BasePage extends ResourcePage {
  onLoad(options) {
    super.onLoad(options);
    this.options = options || {};
    this.released = false;
  }

  onNewOptions(options) {
    super.onNewOptions(options);
    this.options = options || {};
  }

  onShow() {
    super.onShow();
    if (this.$root && this.$root.onShow) this.$root.onShow();
  }

  onHide() {
    super.onHide();
    if (this.$root && this.$root.onHide) this.$root.onHide();
  }

  onUnload() {
    try {
      if (this.$root && this.$root.onUnload) this.$root.onUnload();
      super.onUnload();
    } finally {
      this.release();
    }
  }

  beforeVueInstantiate(Vue) {
    if (super.beforeVueInstantiate) super.beforeVueInstantiate(Vue);
    Vue.prototype.$workspace = globalThis.$workspace;
    Vue.prototype.$appid = globalThis.$appid;
  }
}
