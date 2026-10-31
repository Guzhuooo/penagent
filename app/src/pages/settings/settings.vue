<template>
  <div class="page">
    <div class="rail">
      <text class="brand">设置</text>
      <div class="action" @click="back"><text class="action-label">返回对话</text></div>
      <text class="rail-note">服务地址是 API 根路径，通常以 /v1 结尾。</text>
      <div class="action" @click="save"><text class="action-label">{{ saving ? '保存中…' : '保存设置' }}</text></div>
    </div>
    <scroller class="settings" scroll-direction="vertical">
      <div class="choice import-choice" @click="importFromFile"><text class="choice-label">从文件导入配置/密钥</text></div>
      <text class="heading">模型连接</text>
      <text class="warning">生产请求经 native httpx：TLS peer/hostname 校验、禁止重定向、真实状态码；密钥只发送到所填服务。</text>
      <div v-if="!loaded" class="choice" @click="load"><text class="choice-label">{{ loading ? '正在读取配置…' : '重新读取配置（读取成功前不能修改）' }}</text></div>
      <setting-field label="服务地址" :value="form.baseUrl" placeholder="填写 HTTPS API 地址" @edit="edit('baseUrl')" />
      <setting-field label="密钥" :value="form.apiKey ? '••••••••（已设置）' : ''" placeholder="未设置" @edit="edit('apiKey')" />
      <text class="warning">密钥在此页遮罩；系统输入界面可能显示明文，请留意周围环境。</text>
      <text class="warning">也可用 adb push 到 /tmp/penagent-config.json 或工作区 import/config.json 后点顶部“从文件导入配置/密钥”。</text>
      <setting-field label="模型" :value="form.model" placeholder="填写模型名称" @edit="edit('model')" />
      <div class="choice" @click="toggleFormat"><text class="choice-label">接口格式</text><text class="toggle-state">{{ formatLabel }}</text></div>
      <text v-if="form.apiFormat === 'anthropic'" class="warning">Anthropic Messages：地址填根地址或 /v1，请求发往 /v1/messages；密钥以 x-api-key 发送。</text>
      <setting-field label="系统提示词" :value="promptPreview" placeholder="注入每轮请求的系统提示词" @edit="edit('systemPrompt')" />
      <text class="warning">密钥每次输入后自动保存在本机（明文）。更新设置时也会保留已保存的密钥；清除密钥按钮才会删除。</text>
      <div class="choice" @click="clearKey"><text class="choice-label">清除密钥并保存</text></div>
      <text class="heading">工具权限</text>
      <text class="warning">文件工具只能访问应用私有工作区；工作区路径由运行时推导，不能访问系统其他目录。执行命令默认关闭。</text>
      <div v-for="tool in toolOptions" :key="tool.id" class="choice" @click="toggleTool(tool.id)"><image class="toggle-icon" :src="toolIcons[tool.id]" mode="aspectFit"></image><text class="choice-label">{{ tool.label }}</text><text class="toggle-state">{{ form.tools[tool.id] ? '已开启' : '已关闭' }}</text></div>
      <setting-field label="探测域名" :value="form.allowedProbeHosts.join(', ')" placeholder="空：不允许网络探测" @edit="edit('allowedProbeHosts')" />
      <div class="choice" @click="toggleExec"><image class="toggle-icon" :src="execIcon" mode="aspectFit"></image><text class="choice-label">允许只读命令预设</text><text class="toggle-state">{{ form.execShellEnabled ? '已开启' : '已关闭' }}</text></div>
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
import { icon } from '../../assets/icons.js';
import { getApplication, developerMockSettings, errorLabel } from '../../services/application.js';
import * as input from '../../services/input/index.js';
import { importConfigFromFile } from '../../services/device/import.js';
import { leaveSettings } from '../../services/navigation.js';
const TOOL_OPTIONS = [
  { id: 'clock', label: '时间' }, { id: 'calculator', label: '计算器' },
  { id: 'note', label: '本地笔记' }, { id: 'device_info', label: '设备信息' }, { id: 'net_probe', label: '已允许域名的 HEAD 探测' },
  { id: 'file_list', label: '查看工作区文件' }, { id: 'file_read', label: '读取工作区文本' },
  { id: 'file_write', label: '创建或修改工作区文件' }, { id: 'file_delete', label: '删除工作区文件' },
  { id: 'file_exec', label: '执行工作区命令或文件（高风险，默认关闭）' },
];
function blankForm() {
  return { baseUrl: '', apiKey: '', model: '', temperature: 0.7, maxTokens: 1024, apiFormat: 'openai',
    systemPrompt: '',
    persistApiKey: true, execShellEnabled: false, developmentMode: false,
    tools: { clock: true, calculator: true, note: true, device_info: true, net_probe: true, execShell: false,
      file_list: true, file_read: true, file_write: true, file_delete: true, file_exec: false }, allowedProbeHosts: [] };
}
export default {
  name: 'SettingsPage', components: { SettingField },
  data() { return { form: blankForm(), toolOptions: TOOL_OPTIONS, notice: '', saving: false, loading: false, loaded: false }; },
  computed: {
    // Inline PNG data URIs (assets/icons.js); device fonts cannot render glyph toggles.
    execIcon() { return icon(this.form.execShellEnabled ? 'check-on' : 'check-off'); },
    promptPreview() { return this.form.systemPrompt ? this.form.systemPrompt.slice(0, 40) : ''; },
    execIcon() { return icon(this.form.execShellEnabled ? 'check-on' : 'check-off'); },
    formatLabel() { return this.form.apiFormat === 'anthropic' ? 'Anthropic' : 'OpenAI'; },
    toolIcons() {
      const icons = {};
      for (const tool of this.toolOptions) icons[tool.id] = icon(this.form.tools[tool.id] ? 'check-on' : 'check-off');
      return icons;
    },
  },
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
          if (editing.field === 'apiKey' && value) {
            this.form.apiKey = value;
            this.notice = '正在保存密钥…';
            Promise.resolve().then(() => this.save());
          }
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
      if (this.valid(generation)) Promise.resolve().then(() => this.autoImportIfEmpty());
    },
    canEdit() { return this.loaded && !this.loading && !this.saving && this.ownerActive && !this.destroyed; },
    async edit(field) {
      if (!this.canEdit()) return;
      const generation = this.generation;
      this.editing = { field, generation };
      const value = field === 'allowedProbeHosts' ? this.form.allowedProbeHosts.join(', ') : this.form[field];
      const maxlength = field === 'model' ? 128 : field === 'apiKey' ? 4096 : field === 'systemPrompt' ? 8192 : 2048;
      try { await input.open({ text: value, placeholder: field === 'apiKey' ? '输入密钥（系统界面可能显示明文）' : field === 'systemPrompt' ? '输入系统提示词' : '输入配置', maxlength, enterButtonText: '确定' }); }
      catch (error) { if (this.valid(generation)) { this.editing = null; this.notice = errorLabel(error); } }
    },
    toggleFormat() { if (!this.canEdit()) return; this.form.apiFormat = this.form.apiFormat === 'anthropic' ? 'openai' : 'anthropic'; this.notice = '修改尚未保存'; },
    async importFromFile() {
      if (!this.canEdit()) return;
      const generation = this.generation;
      this.notice = '正在读取导入文件…';
      try {
        const result = await importConfigFromFile();
        if (!this.valid(generation)) return;
        if (!result.found) { this.notice = '未找到 /tmp/penagent-config.json（或 .txt）；请用 adb push 后再试'; return; }
        await this.applyImported(result, generation);
      } catch (error) {
        if (this.valid(generation)) this.notice = errorLabel(error) + '（请检查文件格式）';
      }
    },
    async applyImported(result, generation) {
      const settings = result.settings || {};
      ['baseUrl', 'apiKey', 'model', 'temperature', 'maxTokens', 'apiFormat', 'systemPrompt',
        'persistApiKey', 'execShellEnabled', 'developmentMode', 'allowedProbeHosts'].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(settings, key)) this.form[key] = settings[key];
      });
      if (settings.tools && typeof settings.tools === 'object') this.form.tools = Object.assign({}, this.form.tools, settings.tools);
      this.notice = '已从 ' + result.path + ' 导入（' + result.fields.join(', ') + '），正在保存';
      await this.save();
      if (this.valid(generation)) this.notice = '已导入并保存：' + result.fields.join(', ');
    },
    async autoImportIfEmpty() {
      if (!this.canEdit() || this.form.baseUrl || this.form.apiKey) return;
      const generation = this.generation;
      try {
        const result = await importConfigFromFile();
        if (!this.valid(generation) || !result.found) return;
        await this.applyImported(result, generation);
      } catch (error) { /* missing/broken import file must not disturb normal settings */ }
    },
    toggleTool(id) { if (!this.canEdit()) return; this.form.tools[id] = !this.form.tools[id]; this.notice = '修改尚未保存'; },
    toggleExec() { if (!this.canEdit()) return; this.form.execShellEnabled = !this.form.execShellEnabled; this.form.tools.execShell = this.form.execShellEnabled; this.notice = '修改尚未保存；设备执行能力仍不可用'; },
    useMock() { if (!this.canEdit()) return; this.form = developerMockSettings(this.form); this.notice = '已选择开发 mock，请保存；原密钥已替换为测试密钥'; },
    useProduction() { if (!this.canEdit()) return; this.form = blankForm(); this.notice = '请填写 HTTPS 服务地址和模型后保存'; },
    async clearKey() { if (!this.canEdit()) return; this.form.apiKey = ''; await this.save(); },
    async save() {
      if (!this.canEdit()) return;
      const generation = this.generation;
      this.saving = true;
      const settings = Object.assign({}, this.form, { persistApiKey: true, tools: Object.assign({}, this.form.tools), allowedProbeHosts: this.form.allowedProbeHosts.slice() });
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
.import-choice { width: 70vw; min-height: 10vh; margin-left: 3vw; margin-top: 2vh; flex-direction: row; align-items: center; justify-content: center; background-color: @brand; border-radius: @radius-sm; }
.rail { width: @sidebar-w; height: 100vh; flex-direction: column; background-color: @bg-elevated; }
.brand { width: @rail-inner; height: 18vh; margin-left: @rail-inset; font-size: @font-md; color: @accent; }
.action { width: @rail-inner; height: @touch-min; margin-left: @rail-inset; flex-direction: row; align-items: center; justify-content: center; background-color: @bg-muted; border-radius: @radius-sm; }
.action-label { font-size: @font-sm; color: @text-primary; lines: 1; }
.rail-note { width: @rail-inner; height: 40vh; margin-left: @rail-inset; margin-top: 4vh; font-size: @font-xs; color: @text-secondary; }
.settings { width: @content-w; height: 100vh; padding-left: 3vw; flex-direction: column; }
.heading { width: @message-inner; margin-top: 3vh; margin-bottom: 3vh; font-size: @font-md; color: @accent; }
.choice { width: @message-inner; min-height: 22vh; margin-top: 1vh; margin-bottom: 1vh; flex-direction: row; align-items: center; background-color: @bg-muted; border-radius: @radius-sm; }
.choice-label { width: 48vw; margin-left: 1.5vw; font-size: @font-sm; color: @text-primary; }
.toggle-icon { width: 2.4vw; height: 8vh; margin-left: 1.5vw; }
.toggle-state { width: 9vw; font-size: @font-xs; color: @text-secondary; lines: 1; text-align: center; }
.warning { width: @message-inner; margin-top: 1vh; margin-bottom: 3vh; font-size: @font-xs; color: @text-secondary; }
.confirmation { width: @message-inner; flex-direction: column; }
.notice { width: @message-inner; margin-top: 3vh; margin-bottom: 5vh; font-size: @font-sm; color: @accent; }
</style>
