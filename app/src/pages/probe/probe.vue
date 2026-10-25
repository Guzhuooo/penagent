<template>
  <div class="page">
    <div class="head"><text class="title">M0 能力探针</text><div class="back" @click="back"><text class="label">返回对话</text></div></div>
    <scroller class="body" scroll-direction="vertical">
      <text class="note">网络仅访问本机 mock，使用合成测试密钥。状态未知与能力不可用均不会报告为通过。</text>
      <div class="row"><div class="button" @click="runGet"><text class="label">GET</text></div><text class="result">{{ getResult }}</text></div>
      <div class="row"><div class="button" @click="runPost"><text class="label">POST</text></div><text class="result">{{ postResult }}</text></div>
      <div class="row"><div class="button" @click="runStorage"><text class="label">存储</text></div><text class="result">{{ storageResult }}</text></div>
      <div class="row"><div class="button" @click="runInput"><text class="label">输入法</text></div><text class="result">{{ inputResult }}</text></div>
      <div class="row"><div class="button" @click="runExec"><text class="label">预设状态</text></div><text class="result">{{ execResult }}</text></div>
      <div class="units"><div class="u10"></div><div class="u20"></div><div class="u30"></div><text class="units-label">10 / 20 / 30vw，10 / 15 / 25vh</text></div>
    </scroller>
  </div>
</template>
<script>
import { probeContract } from '../../services/net/index.js';
import { getJson, setJson } from '../../services/storage/index.js';
import * as input from '../../services/input/index.js';
import { execPreset } from '../../services/device/index.js';
import { navigate } from '../../services/navigation.js';
import { errorLabel } from '../../services/application.js';
import { log } from '../../services/log/index.js';
import { MOCK_ORIGIN } from '../../services/device/development.js';
const MOCK_BASE = MOCK_ORIGIN;
export default {
  name: 'ProbePage',
  data() { return { getResult: '待测', postResult: '待测', storageResult: '待测', inputResult: '待测', execResult: '待测' }; },
  mounted() {
    this.active = true; this.generation = 0; this.destroyed = false;
    this.attachInput();
    if (this.$page && this.$page.own) this.$page.own(() => this.onUnload());
  },
  beforeDestroy() { this.onUnload(); },
  methods: {
    valid(generation) { return this.active && !this.destroyed && generation === this.generation; },
    attachInput() {
      try {
        if (!this.inputHandler) this.inputHandler = (result) => { if (!this.active || this.destroyed) return; this.inputResult = result.confirmed ? '已确认（内容不回显）' : result.cancelled ? '已取消（未写回）' : '回调异常'; };
        input.attach(this.inputHandler);
      }
      catch (error) { this.inputResult = errorLabel(error); }
    },
    onShow() { if (this.destroyed) return; this.active = true; this.attachInput(); },
    onHide() { if (input.isInputSessionActive()) return; this.active = false; ++this.generation; input.detach(this.inputHandler); },
    onUnload() { if (this.destroyed) return; this.destroyed = true; this.active = false; ++this.generation; input.detach(this.inputHandler); },
    back() { try { navigate('chat'); } catch (error) { this.getResult = errorLabel(error); } },
    async request(method, field) {
      const generation = this.generation; this[field] = '请求中…'; const started = Date.now();
      try {
        const result = await probeContract({ url: MOCK_BASE + (method === 'POST' ? '/v1/echo' : '/v1/models'), method,
          developmentMode: true, headers: { Authorization: 'Bearer test-synthetic-key', 'Content-Type': 'application/json' },
          body: method === 'POST' ? JSON.stringify({ model: 'mock-gpt', messages: [{ role: 'user', content: 'synthetic-probe' }] }) : undefined, timeout: 8000 });
        if (!this.valid(generation)) return;
        const contract = result.contract;
        this[field] = '状态 ' + (result.status || 'unknown') + ' · ' + (Date.now() - started) + ' ms' + (method === 'POST' ? (contract ? '；JSON 对象+鉴权合同通过' : '；合同未通过') : '；收到回调');
        log.warn('[pa:probe] request', { method, status: result.status, contract, elapsedMs: Date.now() - started });
      } catch (error) { if (this.valid(generation)) this[field] = errorLabel(error); }
    },
    runGet() { return this.request('GET', 'getResult'); },
    runPost() { return this.request('POST', 'postResult'); },
    async runStorage() {
      const generation = this.generation; this.storageResult = '读写中…'; const stamp = { at: Date.now(), note: 'synthetic-probe' };
      try {
        const ok = await setJson('pa.probe', stamp); if (!this.valid(generation)) return;
        if (!ok) { this.storageResult = '写入失败'; return; }
        const back = await getJson('pa.probe', null); if (!this.valid(generation)) return;
        this.storageResult = back && back.at === stamp.at ? '本次读回一致；重启恢复待验证' : '读回不一致';
      } catch (error) { if (this.valid(generation)) this.storageResult = errorLabel(error); }
    },
    async runInput() {
      const generation = this.generation; this.inputResult = '输入会话中…';
      try { await input.open({ placeholder: '输入合成测试文本', enterButtonText: '确定' }); }
      catch (error) { if (this.valid(generation)) this.inputResult = errorLabel(error); }
    },
    async runExec() {
      const generation = this.generation;
      try { const result = await execPreset({ commandId: 'system_arch', params: {} }); if (this.valid(generation)) this.execResult = result.status + '；无 stdout'; }
      catch (error) { if (this.valid(generation)) this.execResult = '不可用：执行期限与停止能力未验证'; }
    },
  },
};
</script>
<style lang="less" scoped>
@import "base.less";
.page { width: 100vw; height: 100vh; flex-direction: column; background-color: @bg-base; }
.head { width: 100vw; height: 20vh; flex-direction: row; align-items: center; background-color: @bg-elevated; }
.title { width: 72vw; margin-left: 3vw; font-size: @font-md; color: @accent; }
.back { width: 22vw; height: @touch-min; flex-direction: row; align-items: center; justify-content: center; background-color: @bg-muted; border-radius: @radius-sm; }
.body { width: 100vw; height: 80vh; flex-direction: column; }
.note { width: 94vw; margin-left: 3vw; margin-top: 2vh; font-size: @font-xs; color: @text-secondary; }
.row { width: 94vw; min-height: 22vh; margin-left: 3vw; margin-top: 2vh; flex-direction: row; align-items: center; }
.button { width: 20vw; height: 20vh; flex-direction: row; align-items: center; justify-content: center; background-color: @bg-muted; border-radius: @radius-md; }
.label { font-size: @font-sm; color: @text-primary; lines: 1; }
.result { width: 71vw; margin-left: 3vw; font-size: @font-xs; color: @text-primary; }
.units { width: 100vw; height: 28vh; flex-direction: row; align-items: center; }
.u10 { width: 10vw; height: 10vh; background-color: @brand; margin-left: 2vw; }
.u20 { width: 20vw; height: 15vh; background-color: @accent; margin-left: 2vw; }
.u30 { width: 30vw; height: 25vh; background-color: @success; margin-left: 2vw; }
.units-label { width: 30vw; font-size: @font-xs; color: @text-secondary; }
</style>
