<template>
  <div class="page">
    <div class="head">
      <text class="title">文件工作区</text>
      <div class="back" @click="back"><text class="back-label">返回工具</text></div>
    </div>
    <div class="bar">
      <div class="action" @click="refresh"><text class="action-label">{{ status === 'loading' ? '读取中' : '刷新' }}</text></div>
      <div class="action" @click="runSelftest"><text class="action-label">{{ testing ? '自检中' : '运行自检' }}</text></div>
      <div v-if="devMode" class="action" @click="runAiTest"><text class="action-label">{{ aiTesting ? 'AI 测试中' : 'AI 文件测试' }}</text></div>
    </div>
    <text class="root">根目录：{{ root || '读取中...' }}</text>
    <scroller class="body" scroll-direction="vertical">
      <text v-if="status === 'loading'" class="state">正在读取工作区...</text>
      <text v-else-if="status === 'error'" class="state-error">{{ notice || '工作区不可用' }}</text>
      <text v-else-if="!entries.length" class="state">工作区为空。启用文件工具后，AI 可用 file_write 创建文件。</text>
      <div v-for="entry in entries" :key="entry.name" class="row">
        <text class="entry-name">{{ entry.name }}</text>
        <text class="entry-meta">{{ entry.type }} · {{ entry.size }} B</text>
      </div>
      <text v-if="notice && status !== 'error'" class="notice">{{ notice }}</text>
      <text v-if="selftestLines.length" class="heading">自检结果</text>
      <text v-for="(line, index) in selftestLines" :key="'selftest-' + index" class="selftest-line">{{ line }}</text>
      <text v-if="aiLines.length" class="heading">AI 文件工具测试（开发模式）</text>
      <text v-for="(line, index) in aiLines" :key="'ai-' + index" class="selftest-line">{{ line }}</text>
    </scroller>
  </div>
</template>
<script>
import { getWorkspaceAdapter } from '../../services/device/workspace.js';
import { getApplication, errorLabel } from '../../services/application.js';
import { leaveWorkspace } from '../../services/navigation.js';
import { log } from '../../services/log/index.js';

export default {
  name: 'WorkspacePage',
  data() {
    return { root: '', entries: [], status: 'loading', notice: '', testing: false, selftestLines: [],
      devMode: false, aiTesting: false, aiLines: [] };
  },
  mounted() {
    this.active = true;
    this.destroyed = false;
    this.generation = 0;
    this.workspace = getWorkspaceAdapter();
    this.application = getApplication();
    if (this.$page && this.$page.own) this.$page.own(() => this.onUnload());
    this.loadSettingsState();
    this.refresh();
  },
  beforeDestroy() { this.onUnload(); },
  methods: {
    valid(generation) { return this.active && !this.destroyed && this.generation === generation; },
    onShow() { if (!this.destroyed) { this.active = true; } },
    onHide() { this.active = false; ++this.generation; },
    onUnload() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.active = false;
      ++this.generation;
    },
    async refresh() {
      if (this.destroyed) return;
      const generation = ++this.generation;
      this.status = 'loading';
      try {
        const root = await this.workspace.ensureRoot();
        if (!this.valid(generation)) return;
        this.root = root;
        const result = await this.workspace.list('');
        if (!this.valid(generation)) return;
        this.entries = result.entries || [];
        this.status = 'ready';
        this.notice = '';
      } catch (error) {
        if (!this.valid(generation)) return;
        this.status = 'error';
        this.notice = errorLabel(error);
      }
    },
    async runSelftest() {
      if (this.testing || this.destroyed) return;
      const generation = ++this.generation;
      this.testing = true;
      this.selftestLines = [];
      this.notice = '';
      try {
        const result = await this.workspace.selftest();
        if (!this.valid(generation)) return;
        this.selftestLines = result.steps.map((step) => (step.ok ? '通过 ' : '失败 ') + step.step + (step.code ? ' · ' + step.code : '') + (step.root ? ' · ' + step.root : step.path ? ' · ' + step.path : ''));
        this.notice = result.ok ? '自检通过：写入、读取、追加、执行、退出码与删除均成功' : '自检失败，请查看步骤';
        try { log.warn('[pa:workspace] selftest', { ok: result.ok, steps: result.steps.length }); } catch (error) { /* logging is best effort */ }
        await this.refresh();
      } catch (error) {
        if (!this.valid(generation)) return;
        this.notice = errorLabel(error);
      } finally {
        if (!this.destroyed) this.testing = false;
      }
    },
    async loadSettingsState() {
      try {
        const settings = await this.application.loadSettings();
        if (!this.destroyed) this.devMode = settings.developmentMode === true;
      } catch (error) { if (!this.destroyed) this.devMode = false; }
    },
    async runAiTest() {
      if (this.aiTesting || this.destroyed || !this.devMode) return;
      const generation = ++this.generation;
      this.aiTesting = true;
      this.aiLines = [];
      this.notice = 'AI 文件工具测试进行中...';
      try {
        const settings = await this.application.loadSettings();
        if (!this.valid(generation)) return;
        const result = await this.application.run([{ role: 'user', content: 'synthetic-files' }], settings, {
          onEvent: (event) => {
            if (event && event.type === 'tool_started' && this.valid(generation)) this.aiLines = this.aiLines.concat(['启动工具 ' + String(event.name)]).slice(-14);
          },
        });
        if (!this.valid(generation)) return;
        const toolLines = result.messages.filter((message) => message.role === 'tool').map((message) => {
          try {
            const parsed = JSON.parse(message.content);
            if (parsed && parsed.ok && parsed.data) {
              const data = parsed.data;
              if (data.path && data.removed) return '删除 ' + data.path;
              if (data.path && data.content != null) return '读取 ' + data.path;
              if (data.path && data.bytes != null) return (data.append ? '追加 ' : '写入 ') + data.path + ' ' + data.bytes + ' B';
              if (data.code != null) return '执行 code=' + data.code + ' stdout=' + String(data.stdout || '').slice(0, 60);
            }
          } catch (error) { /* plain text tool result */ }
          return '工具结果';
        });
        this.aiLines = this.aiLines.concat([result.status === 'completed' ? 'AI 测试完成' : 'AI 测试状态 ' + String(result.status) + (result.error ? ' ' + String(result.error.code) + ' ' + String(result.error.message || '') : '')], toolLines).slice(-14);
        this.notice = result.status === 'completed' ? 'AI 已通过工具写入、读取、执行并删除工作区文件' : 'AI 测试未完成，请查看状态';
        try { log.warn('[pa:workspace] ai-file-test', { status: result.status, toolCalls: result.toolCalls }); } catch (error) { /* logging is best effort */ }
        await this.refresh();
      } catch (error) {
        if (!this.valid(generation)) return;
        this.aiLines = this.aiLines.concat(['失败 ' + String(error && error.code) + ' ' + String(error && error.message)]).slice(-14);
        this.notice = errorLabel(error);
      } finally {
        if (!this.destroyed) this.aiTesting = false;
      }
    },
    back() {
      if (this.destroyed) return;
      try { leaveWorkspace(); } catch (error) { this.notice = errorLabel(error); }
    },
  },
};
</script>
<style lang="less" scoped>
@import "base.less";
.page { width: 100vw; height: 100vh; flex-direction: column; background-color: @bg-base; }
.head { width: 100vw; height: 16vh; flex-direction: row; align-items: center; background-color: @bg-elevated; }
.title { width: 70vw; margin-left: 3vw; font-size: @font-md; color: @accent; lines: 1; }
.back { width: 24vw; height: @touch-min; flex-direction: row; align-items: center; justify-content: center; background-color: @bg-muted; border-radius: @radius-sm; }
.back-label { font-size: @font-sm; color: @text-primary; lines: 1; }
.bar { width: 100vw; height: 16vh; flex-direction: row; align-items: center; background-color: @bg-base; }
.action { width: 22vw; height: @touch-min; margin-left: 3vw; flex-direction: row; align-items: center; justify-content: center; background-color: @brand; border-radius: @radius-md; }
.action-label { font-size: @font-sm; color: @text-primary; lines: 1; }
.root { width: 94vw; margin-left: 3vw; margin-top: 1vh; font-size: @font-xs; color: @text-secondary; lines: 2; }
.body { width: 100vw; height: 66vh; flex-direction: column; margin-top: 1vh; }
.row { width: 94vw; min-height: 14vh; margin-left: 3vw; margin-top: 1vh; flex-direction: row; align-items: center; background-color: @bg-muted; border-radius: @radius-sm; }
.entry-name { width: 58vw; margin-left: 3vw; font-size: @font-sm; color: @text-primary; lines: 1; text-overflow: ellipsis; }
.entry-meta { width: 30vw; font-size: @font-xs; color: @text-secondary; lines: 1; text-align: right; }
.state { width: 94vw; margin-left: 3vw; margin-top: 3vh; font-size: @font-sm; color: @text-secondary; }
.state-error { width: 94vw; margin-left: 3vw; margin-top: 3vh; font-size: @font-sm; color: @danger; }
.notice { width: 94vw; margin-left: 3vw; margin-top: 2vh; font-size: @font-xs; color: @accent; }
.heading { width: 94vw; margin-left: 3vw; margin-top: 3vh; font-size: @font-sm; color: @accent; }
.selftest-line { width: 94vw; margin-left: 3vw; margin-top: 1vh; font-size: @font-xs; color: @text-primary; lines: 2; }
</style>
