<template>
  <div class="page">
    <div class="rail">
      <text class="brand">设置</text>
      <div class="action" @click="back"><text class="action-label">返回对话</text></div>
      <text class="rail-note">服务地址是 API 根路径，通常以 /v1 结尾。</text>
      <div class="action" @click="save"><text class="action-label">{{ saving ? '保存中…' : '保存设置' }}</text></div>
    </div>
    <scroller class="settings" scroll-direction="vertical">
      <text class="heading">模型连接</text>
      <text class="warning">已确认当前平台 HTTP 通道关闭证书验证并允许重定向，也不返回真实状态码；生产请求已禁用。可保存配置，但不会发送真实密钥。</text>
      <div v-if="!loaded" class="choice" @click="load"><text class="choice-label">{{ loading ? '正在读取配置…' : '重新读取配置（读取成功前不能修改）' }}</text></div>
      <setting-field label="服务地址" :value="form.baseUrl" placeholder="填写 HTTPS API 地址" @edit="edit('baseUrl')" />
      <setting-field label="密钥" :value="form.apiKey ? '••••••••（已设置）' : ''" placeholder="未设置" @edit="edit('apiKey')" />
      <text class="warning">密钥在此页遮罩；系统输入界面可能显示明文，请留意周围环境。</text>
      <setting-field label="模型" :value="form.model" placeholder="填写模型名称" @edit="edit('model')" />
      <div class="choice" @click="togglePersist"><text class="choice-label">{{ form.persistApiKey ? '☑' : '☐' }} 记住密钥（默认仅保留在内存）</text></div>
      <div v-if="confirmPersistence" class="confirmation">
        <text class="warning">设备本地以明文保存，能够读取设备数据的人可获取密钥。</text>
        <div class="choice" @click="confirmRemember"><text class="choice-label">我已了解，记住密钥</text></div>
        <div class="choice" @click="confirmPersistence = false"><text class="choice-label">取消</text></div>
      </div>
      <div class="choice" @click="clearKey"><text class="choice-label">清除密钥并保存</text></div>
      <text class="heading">工具权限</text>
      <div v-for="tool in toolOptions" :key="tool.id" class="choice" @click="toggleTool(tool.id)"><text class="choice-label">{{ form.tools[tool.id] ? '☑' : '☐' }} {{ tool.label }}</text></div>
      <setting-field label="探测域名" :value="form.allowedProbeHosts.join(', ')" placeholder="空：不允许网络探测" @edit="edit('allowedProbeHosts')" />
      <div class="choice" @click="toggleExec"><text class="choice-label">{{ form.execShellEnabled ? '☑' : '☐' }} 允许只读命令预设</text></div>
      <text class="warning">本固件的执行期限与停止能力未验证，预设当前不可执行，也不提供命令输出。</text>
      <text class="heading">开发测试</text>
      <div class="choice" @click="useMock"><text class="choice-label">使用本机 mock（替换为合成测试密钥）</text></div>
      <div class="choice" @click="useProduction"><text class="choice-label">重置为生产配置（地址和密钥留空）</text></div>
      <text v-if="form.developmentMode" class="warning">开发模式：仅用于合成内容；本机回环地址指运行本应用的设备。</text>
      <text v-if="notice" class="notice">{{ notice }}</text>
    </scroller>
  </div>
</template>
<script>
import SettingField from '../../components/setting-field.vue';
import { getApplication, developerMockSettings, errorLabel } from '../../services/application.js';
import * as input from '../../services/input/index.js';
import { leaveSettings } from '../../services/navigation.js';
const TOOL_OPTIONS = [
  { id: 'clock', label: '时间' }, { id: 'calculator', label: '计算器' },
  { id: 'note', label: '本地笔记' }, { id: 'device_info', label: '设备信息' }, { id: 'net_probe', label: '已允许域名的 HEAD 探测' },
];
function blankForm() {
  return { baseUrl: '', apiKey: '', model: '', temperature: 0.7, maxTokens: 1024,
    persistApiKey: false, execShellEnabled: false, developmentMode: false,
    tools: { clock: true, calculator: true, note: true, device_info: true, net_probe: true, execShell: false }, allowedProbeHosts: [] };
}
export default {
  name: 'SettingsPage', components: { SettingField },
  data() { return { form: blankForm(), toolOptions: TOOL_OPTIONS, notice: '', saving: false, loading: false, loaded: false, confirmPersistence: false }; },
  mounted() {
    this.ownerActive = true; this.destroyed = false; this.generation = 0; this.editing = null;
    this.application = getApplication(); this.attachInput();
    if (this.$page && this.$page.own) this.$page.own(() => this.onUnload());
    this.load();
  },
  beforeDestroy() { this.onUnload(); },
  methods: {
    valid(generation) { return this.ownerActive && !this.destroyed && this.generation === generation; },
    attachInput() {
      try {
        if (!this.inputHandler) this.inputHandler = (result) => {
          const editing = this.editing; this.editing = null;
          if (!editing || !this.valid(editing.generation) || !result.confirmed) return;
          const value = result.text.trim();
          if (editing.field === 'allowedProbeHosts') this.form.allowedProbeHosts = value ? value.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean) : [];
          else this.form[editing.field] = value;
          this.notice = '修改尚未保存';
        };
        input.attach(this.inputHandler);
      } catch (error) { this.notice = errorLabel(error); }
    },
    onShow() { if (!this.application || this.destroyed) return; this.ownerActive = true; this.attachInput(); if (!this.loaded) this.load(); },
    onHide() { if (input.isInputSessionActive()) return; this.ownerActive = false; ++this.generation; this.loading = false; this.editing = null; input.detach(this.inputHandler); },
    onUnload() { if (this.destroyed) return; this.destroyed = true; this.ownerActive = false; ++this.generation; this.editing = null; input.detach(this.inputHandler); },
    async load() {
      if (this.loading || this.loaded || !this.ownerActive || this.destroyed) return;
      const generation = ++this.generation;
      this.loading = true;
      try {
        const settings = await this.application.loadSettings();
        if (!this.valid(generation)) return;
        this.form = Object.assign(blankForm(), settings, { tools: Object.assign({}, settings.tools), allowedProbeHosts: (settings.allowedProbeHosts || []).slice() });
        this.loaded = true; this.notice = '';
      } catch (error) { if (this.valid(generation)) this.notice = errorLabel(error); }
      finally { if (this.valid(generation)) this.loading = false; }
    },
    canEdit() { return this.loaded && !this.loading && !this.saving && this.ownerActive && !this.destroyed; },
    async edit(field) {
      if (!this.canEdit()) return;
      const generation = this.generation;
      this.editing = { field, generation };
      const value = field === 'allowedProbeHosts' ? this.form.allowedProbeHosts.join(', ') : this.form[field];
      try { await input.open({ text: value, placeholder: field === 'apiKey' ? '输入密钥（系统界面可能显示明文）' : '输入配置', maxlength: field === 'model' ? 128 : 2048, enterButtonText: '确定' }); }
      catch (error) { if (this.valid(generation)) { this.editing = null; this.notice = errorLabel(error); } }
    },
    togglePersist() {
      if (!this.canEdit()) return;
      if (this.form.persistApiKey) { this.form.persistApiKey = false; this.confirmPersistence = false; this.notice = '保存后清除旧持久化密钥'; }
      else if (this.form.developmentMode) this.notice = '开发测试密钥不持久化';
      else this.confirmPersistence = true;
    },
    confirmRemember() { if (!this.canEdit()) return; this.form.persistApiKey = true; this.confirmPersistence = false; this.notice = '修改尚未保存'; },
    toggleTool(id) { if (!this.canEdit()) return; this.form.tools[id] = !this.form.tools[id]; this.notice = '修改尚未保存'; },
    toggleExec() { if (!this.canEdit()) return; this.form.execShellEnabled = !this.form.execShellEnabled; this.form.tools.execShell = this.form.execShellEnabled; this.notice = '修改尚未保存；设备执行能力仍不可用'; },
    useMock() { if (!this.canEdit()) return; this.form = developerMockSettings(this.form); this.confirmPersistence = false; this.notice = '已选择开发 mock，请保存；原密钥已替换为测试密钥'; },
    useProduction() { if (!this.canEdit()) return; this.form = blankForm(); this.confirmPersistence = false; this.notice = '请填写 HTTPS 服务地址和模型后保存'; },
    async clearKey() { if (!this.canEdit()) return; this.form.apiKey = ''; this.form.persistApiKey = false; this.confirmPersistence = false; await this.save(); },
    async save() {
      if (!this.canEdit() || this.confirmPersistence) return;
      const generation = this.generation;
      this.saving = true;
      const settings = Object.assign({}, this.form, { tools: Object.assign({}, this.form.tools), allowedProbeHosts: this.form.allowedProbeHosts.slice() });
      try { await this.application.saveSettings(settings); if (!this.valid(generation)) return; this.notice = '设置已保存'; }
      catch (error) { if (this.valid(generation)) this.notice = errorLabel(error); }
      finally { if (!this.destroyed) this.saving = false; }
    },
    back() { if (this.saving) return; try { leaveSettings(); } catch (error) { this.notice = errorLabel(error); } },
  },
};
</script>
<style lang="less" scoped>
@import "base.less";
.page { width: 100vw; height: 100vh; flex-direction: row; background-color: @bg-base; }
.rail { width: @sidebar-w; height: 100vh; flex-direction: column; background-color: @bg-elevated; }
.brand { width: @rail-inner; height: 18vh; margin-left: @rail-inset; font-size: @font-md; color: @accent; }
.action { width: @rail-inner; height: @touch-min; margin-left: @rail-inset; flex-direction: row; align-items: center; justify-content: center; background-color: @bg-muted; border-radius: @radius-sm; }
.action-label { font-size: @font-sm; color: @text-primary; lines: 1; }
.rail-note { width: @rail-inner; height: 40vh; margin-left: @rail-inset; margin-top: 4vh; font-size: @font-xs; color: @text-secondary; }
.settings { width: @content-w; height: 100vh; padding-left: 3vw; flex-direction: column; }
.heading { width: @message-inner; margin-top: 3vh; margin-bottom: 3vh; font-size: @font-md; color: @accent; }
.choice { width: @message-inner; min-height: 22vh; margin-top: 1vh; margin-bottom: 1vh; flex-direction: row; align-items: center; background-color: @bg-muted; border-radius: @radius-sm; }
.choice-label { width: 64vw; margin-left: 2vw; font-size: @font-sm; color: @text-primary; }
.warning { width: @message-inner; margin-top: 1vh; margin-bottom: 3vh; font-size: @font-xs; color: @text-secondary; }
.confirmation { width: @message-inner; flex-direction: column; }
.notice { width: @message-inner; margin-top: 3vh; margin-bottom: 5vh; font-size: @font-sm; color: @accent; }
</style>
