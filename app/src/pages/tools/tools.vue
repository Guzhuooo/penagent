<template>
  <div class="page">
    <div class="head">
      <text class="title">工具</text>
      <div class="workspace" @click="openWorkspace"><text class="workspace-label">文件工作区</text></div>
      <div class="back" @click="back"><text class="back-label">返回对话</text></div>
    </div>
    <div class="search-row">
      <div class="search" @click="startSearch"><text class="search-label">识别工具</text></div>
      <text class="query">{{ queryLine }}</text>
    </div>
    <scroller class="body" scroll-direction="vertical">
      <text v-if="status === 'loading'" class="state">正在读取工具目录...</text>
      <text v-else-if="status === 'error'" class="state-error">{{ notice || '工具目录读取失败' }}</text>
      <div v-else class="sections">
        <text class="heading">内置工具 {{ builtinTools.length }} 个</text>
        <div v-for="tool in builtinTools" :key="tool.name" class="row">
          <text class="name">{{ tool.name }}</text>
          <text class="detail">{{ tool.description }}</text>
        </div>
        <text class="heading">工具管理 {{ metaTools.length }} 个</text>
        <div v-for="tool in metaTools" :key="tool.name" class="row">
          <text class="name">{{ tool.name }}</text>
          <text class="detail">{{ tool.description }}</text>
        </div>
        <text class="heading">自定义工具 {{ customTools.length }} 个</text>
        <text v-if="!customTools.length" class="state">还没有自定义工具。可在对话中让模型用 define_tool 创建。</text>
        <div v-for="tool in customTools" :key="tool.name" class="row">
          <text class="name">{{ tool.name }}</text>
          <text class="kind">类型 {{ tool.kind }}</text>
          <text class="detail">{{ tool.description }}</text>
          <div class="delete" @click="removeCustom(tool.name)"><text class="delete-label">{{ pendingDelete === tool.name ? '再次点击确认删除' : '删除' }}</text></div>
        </div>
        <text class="heading">识别工具</text>
        <text v-if="!query" class="state">点“识别工具”，用系统输入法输入用途，例如单位换算或计算。</text>
        <div v-for="item in recognized" :key="item.name" class="row">
          <text class="name">{{ item.name }}</text>
          <text class="detail">{{ item.description }}</text>
          <text class="score">相关度 {{ item.score }} 依据 {{ item.reason }}</text>
        </div>
        <text v-if="query && searched && !recognized.length" class="state">没有匹配的工具，可换一个说法。</text>
        <text v-if="notice && status !== 'error'" class="notice">{{ notice }}</text>
      </div>
    </scroller>
  </div>
</template>
<script>
import { getApplication, errorLabel } from '../../services/application.js';
import * as input from '../../services/input/index.js';
import { leaveTools, navigate } from '../../services/navigation.js';

export default {
  name: 'ToolsPage',
  data() {
    return { catalog: [], recognized: [], query: '', searched: false, status: 'loading', notice: '', pendingDelete: '' };
  },
  computed: {
    queryLine() { return this.query || '点“识别工具”输入用途，例如：单位换算 或 计算'; },
    builtinTools() { return this.catalog.filter((tool) => tool.origin === 'builtin'); },
    metaTools() { return this.catalog.filter((tool) => tool.origin === 'meta'); },
    customTools() { return this.catalog.filter((tool) => tool.origin === 'custom'); },
  },
  mounted() {
    this.ownerActive = true; this.destroyed = false; this.generation = 0; this.editing = null;
    this.application = getApplication();
    this.attachInput();
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
          this.query = result.text.slice(0, 64);
          this.search();
        };
        input.attach(this.inputHandler);
      } catch (error) { this.notice = errorLabel(error); }
    },
    onShow() { if (!this.application || this.destroyed) return; this.ownerActive = true; this.attachInput(); if (this.status !== 'loading') this.load(); },
    onHide() { if (input.isInputSessionActive()) return; this.ownerActive = false; ++this.generation; this.editing = null; this.pendingDelete = ''; input.detach(this.inputHandler); },
    onUnload() { if (this.destroyed) return; this.destroyed = true; this.ownerActive = false; ++this.generation; this.editing = null; this.pendingDelete = ''; input.detach(this.inputHandler); },
    async load() {
      if (this.destroyed || !this.application) return;
      const generation = ++this.generation;
      this.status = 'loading';
      try {
        const catalog = await this.application.listTools();
        if (!this.valid(generation)) return;
        this.catalog = Array.isArray(catalog) ? catalog : [];
        this.status = 'ready';
      } catch (error) {
        if (!this.valid(generation)) return;
        this.status = 'error';
        this.notice = errorLabel(error);
      }
    },
    async startSearch() {
      if (this.destroyed || !this.ownerActive) return;
      const generation = this.generation;
      this.editing = { generation };
      try { await input.open({ text: this.query, placeholder: '输入要用的工具用途', maxlength: 64, enterButtonText: '识别' }); }
      catch (error) { if (this.valid(generation)) { this.editing = null; this.notice = errorLabel(error); } }
    },
    async search() {
      const text = this.query.trim();
      this.searched = true;
      if (!text || typeof this.application.findTools !== 'function') { this.recognized = []; return; }
      const generation = ++this.generation;
      try {
        const matches = await this.application.findTools(text);
        if (!this.valid(generation)) return;
        this.recognized = Array.isArray(matches) ? matches : [];
      } catch (error) { if (this.valid(generation)) { this.recognized = []; this.notice = errorLabel(error); } }
    },
    async removeCustom(name) {
      if (this.destroyed || !this.ownerActive || this.status === 'loading') return;
      if (this.pendingDelete !== name) {
        this.pendingDelete = name;
        this.notice = '再次点击“删除”确认移除 ' + name;
        return;
      }
      this.pendingDelete = '';
      const generation = ++this.generation;
      try {
        await this.application.deleteCustomTool(name);
        if (!this.valid(generation)) return;
        this.notice = '已删除 ' + name;
        await this.load();
      } catch (error) { if (this.valid(generation)) this.notice = errorLabel(error); }
    },
    back() {
      if (this.destroyed) return;
      try { leaveTools(); } catch (error) { this.notice = errorLabel(error); }
    },
    openWorkspace() {
      if (this.destroyed) return;
      try { navigate('workspace'); } catch (error) { this.notice = errorLabel(error); }
    },
  },
};
</script>
<style lang="less" scoped>
@import "base.less";
.page { width: 100vw; height: 100vh; flex-direction: column; background-color: @bg-base; }
.head { width: 100vw; height: 18vh; flex-direction: row; align-items: center; background-color: @bg-elevated; }
.title { width: 40vw; margin-left: 3vw; font-size: @font-md; color: @accent; }
.workspace { width: 26vw; height: @touch-min; margin-left: 1vw; flex-direction: row; align-items: center; justify-content: center; background-color: @brand; border-radius: @radius-sm; }
.workspace-label { font-size: @font-sm; color: @text-primary; lines: 1; }
.back { width: 24vw; height: @touch-min; margin-left: 1vw; flex-direction: row; align-items: center; justify-content: center; background-color: @bg-muted; border-radius: @radius-sm; }
.back-label { font-size: @font-sm; color: @text-primary; lines: 1; }
.search-row { width: 100vw; height: 22vh; flex-direction: row; align-items: center; }
.search { width: 22vw; height: @touch-min; margin-left: 3vw; flex-direction: row; align-items: center; justify-content: center; background-color: @brand; border-radius: @radius-md; }
.search-label { font-size: @font-sm; color: @text-primary; lines: 1; }
.query { width: 71vw; margin-left: 3vw; font-size: @font-xs; color: @text-secondary; lines: 2; }
.body { width: 100vw; height: 60vh; flex-direction: column; }
.sections { width: 100vw; flex-direction: column; }
.heading { width: 94vw; margin-left: 3vw; margin-top: 3vh; margin-bottom: 1vh; font-size: @font-sm; color: @accent; }
.row { width: 94vw; min-height: 20vh; margin-left: 3vw; margin-top: 1vh; margin-bottom: 1vh; padding-top: 1vh; padding-bottom: 1vh; flex-direction: column; background-color: @bg-muted; border-radius: @radius-sm; }
.name { width: 88vw; margin-left: 3vw; font-size: @font-sm; color: @text-primary; lines: 1; }
.kind { width: 88vw; margin-left: 3vw; margin-top: 1vh; font-size: @font-xs; color: @text-secondary; lines: 1; }
.detail { width: 88vw; margin-left: 3vw; margin-top: 1vh; font-size: @font-xs; color: @text-secondary; }
.score { width: 88vw; margin-left: 3vw; margin-top: 1vh; font-size: @font-xs; color: @accent; }
.delete { width: 26vw; height: @touch-min; margin-left: 3vw; margin-top: 1vh; flex-direction: row; align-items: center; justify-content: center; background-color: @bg-elevated; border-radius: @radius-sm; }
.delete-label { font-size: @font-xs; color: @danger; lines: 1; }
.state { width: 94vw; margin-left: 3vw; margin-top: 3vh; font-size: @font-sm; color: @text-secondary; }
.state-error { width: 94vw; margin-left: 3vw; margin-top: 3vh; font-size: @font-sm; color: @danger; }
.notice { width: 94vw; margin-left: 3vw; margin-top: 2vh; margin-bottom: 4vh; font-size: @font-xs; color: @accent; }
</style>
