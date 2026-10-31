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
      <div class="row"><div class="button" @click="runNative"><text class="label">原生 HTTPS</text></div><text class="result">{{ nativeResult }}</text></div>
      <div class="row"><div class="button" @click="runNativeTls"><text class="label">原生 TLS 拒绝</text></div><text class="result">{{ nativeTlsResult }}</text></div>
      <div class="row"><div class="button" @click="runReal"><text class="label">真实对话</text></div><text class="result">{{ realResult }}</text></div>
      <div class="row"><div class="button" @click="importConfig"><text class="label">导入配置</text></div><text class="result">{{ importResult }}</text></div>
      <div class="units"><div class="u10"></div><div class="u20"></div><div class="u30"></div><text class="units-label">10 / 20 / 30vw，10 / 15 / 25vh</text></div>
    </scroller>
  </div>
</template>
<script>
import { probeContract } from '../../services/net/index.js';
import { getJson, setJson } from '../../services/storage/index.js';
import * as input from '../../services/input/index.js';
import { execPreset } from '../../services/device/index.js';
import { nativeProbe } from '../../services/net/native.js';
import { importConfigFromFile } from '../../services/device/import.js';
import { navigate } from '../../services/navigation.js';
import { errorLabel, getApplication } from '../../services/application.js';
import { log } from '../../services/log/index.js';
import { MOCK_ORIGIN } from '../../services/device/development.js';
const MOCK_BASE = MOCK_ORIGIN;
export default {
  name: 'ProbePage',
  data() { return { getResult: '待测', postResult: '待测', storageResult: '待测', inputResult: '待测', execResult: '待测', nativeResult: '待测', nativeTlsResult: '待测', realResult: '待测', importResult: '待测' }; },
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
    async runNative() {
      const generation = this.generation;
      this.nativeResult = '请求中…';
      const started = Date.now();
      try {
        const result = await nativeProbe({
          url: 'https://httpbin.org/post', method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ probe: 'native-httpx', value: 42 }), timeout: 12000,
        });
        if (!this.valid(generation)) return;
        this.nativeResult = '原生状态 ' + result.status + ' · ' + result.bytes + ' B · ' + (Date.now() - started) + ' ms';
        log.warn('[pa:probe] native', { status: result.status, bytes: result.bytes, elapsedMs: Date.now() - started, method: 'POST' });
      } catch (error) { if (this.valid(generation)) { this.nativeResult = errorLabel(error) + '（原生模块或 TLS 不可用）'; log.warn('[pa:probe] native unavailable', { code: error && error.code }); } }
    },
    async runNativeTls() {
      const generation = this.generation;
      this.nativeTlsResult = '请求中…';
      try {
        const result = await nativeProbe({ url: 'https://expired.badssl.com/', method: 'GET', timeout: 12000 });
        if (!this.valid(generation)) return;
        this.nativeTlsResult = '意外通过：状态 ' + result.status;
        log.warn('[pa:probe] native tls unexpected', { status: result.status });
      } catch (error) {
        if (!this.valid(generation)) return;
        const code = (error && error.code) || 'unknown';
        this.nativeTlsResult = '预期拒绝：' + code;
        log.warn('[pa:probe] native tls rejected', { code: code });
      }
    },
    async importConfig() {
      this.importResult = '读取中…';
      try {
        const result = await importConfigFromFile();
        if (!result.found) { this.importResult = '未找到：/tmp/penagent-config.json 或工作区 import/config.json'; return; }
        const application = getApplication();
        const current = await application.loadSettings();
        const merged = Object.assign({}, current, result.settings, { persistApiKey: true });
        await application.saveSettings(merged);
        this.importResult = '已导入并保存 · ' + result.path + ' · ' + result.fields.join(', ');
        log.warn('[pa:probe] config imported', { path: result.path, fields: result.fields });
      } catch (error) {
        this.importResult = '导入失败：' + ((error && error.code) || 'unknown');
        log.warn('[pa:probe] config import failed', { code: error && error.code });
      }
    },
    async runReal() {      const generation = this.generation;
      this.realResult = '请求中…';
      const started = Date.now();
      try {
        const application = getApplication();
        const settings = await application.loadSettings();
        const result = await application.run([{ role: 'user', content: '请调用 clock 工具，然后只回复一句当前 UTC 时间。' }], settings);
        if (!this.valid(generation)) return;
        const messages = result.messages || [];
        let answer = '';
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const message = messages[i];
          if (message.role === 'assistant' && typeof message.content === 'string' && message.content) { answer = message.content; break; }
        }
        this.realResult = (result.status === 'completed' ? '完成' : '状态 ' + String(result.status) + (result.error ? ' · ' + String(result.error.code) : '')) +
          ' · 工具 ' + String(result.toolCalls || 0) + ' · ' + (answer ? answer.slice(0, 80) : '无文本') +
          ' · ' + (Date.now() - started) + ' ms';
        log.warn('[pa:probe] real chat', { status: result.status, toolCalls: result.toolCalls, elapsedMs: Date.now() - started });
      } catch (error) {
        if (!this.valid(generation)) return;
        this.realResult = errorLabel(error) + '（配置/网络/协议）';
        log.warn('[pa:probe] real chat failed', { code: error && error.code });
      }
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
