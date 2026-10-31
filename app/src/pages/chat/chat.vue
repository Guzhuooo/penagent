<template>
  <div class="page">
    <session-rail :sessions="sessions" :selected-id="selectedId" @new="newSession" @select="selectSession" @settings="openSettings" />
    <div class="conversation">
      <div class="header"><text class="title">{{ title }}</text><text class="status">{{ statusLabel }}</text></div>
      <scroller class="messages" scroll-direction="vertical">
        <div v-if="!messages.length" class="empty"><text class="empty-title">从一个问题开始</text><text class="empty-copy">点下方输入问题。首次使用请在设置中填写服务地址、密钥和模型。</text></div>
        <div v-for="(message, index) in messages" :key="message.localId || selectedId + '-' + index" class="message-row">
          <message-card v-if="message.role !== 'tool'" :message="message" />
        </div>
        <tool-card v-for="tool in visibleTools" :key="tool.id" :tool="tool" />
        <text v-if="notice" class="notice">{{ notice }}</text>
        <div v-if="dirty && !busy" class="retry" @click="retrySave"><text class="retry-label">重试保存会话</text></div>
      </scroller>
      <div class="composer">
        <div class="input" @click="editDraft"><text class="draft">{{ draft || '点此输入问题…' }}</text></div>
        <div class="tools" @click="openTools"><text class="tools-label">工具</text></div>
        <div class="send" :class="busy ? 'stop-color' : 'send-color'" @click="busy ? stopRun() : send()"><text class="send-label">{{ busy ? '停止' : '发送' }}</text></div>
      </div>
    </div>
  </div>
</template>
<script>
import SessionRail from '../../components/session-rail.vue';
import MessageCard from '../../components/message-card.vue';
import ToolCard from '../../components/tool-card.vue';
import { getApplication, errorLabel } from '../../services/application.js';
import * as input from '../../services/input/index.js';
import { navigate } from '../../services/navigation.js';

export default {
  name: 'ChatPage', components: { SessionRail, MessageCard, ToolCard },
  data() {
    return { sessions: [], selectedId: '', messages: [], tools: [], draft: '', settings: null,
      status: 'loading', busy: false, notice: '', dirty: false };
  },
  computed: {
    title() { const session = this.sessions.find((item) => item.id === this.selectedId); return session ? session.title || '新会话' : '对话'; },
    visibleTools() {
      const names = {};
      this.messages.forEach((message) => { (message.tool_calls || []).forEach((call) => { names[call.id] = call.function.name; }); });
      const cards = this.messages.filter((message) => message.role === 'tool').map((message) => {
        let failure = null;
        try { const parsed = JSON.parse(message.content); if (parsed && parsed.error) failure = parsed.error; } catch (error) { /* Plain text tool output. */ }
        return { id: message.tool_call_id, name: names[message.tool_call_id] || '工具', status: failure ? 'error' : 'completed', result: failure ? '' : message.content, error: failure ? errorLabel(failure) : '' };
      });
      const session = this.sessions.find((item) => item.id === this.selectedId);
      const audit = (session && session.toolAudit || []).filter((entry) => !cards.some((card) => card.id === entry.id))
        .map((entry) => ({ id: entry.id, name: entry.name, status: entry.status === 'completed' || entry.status === 'error' ? entry.status : 'cancelled', result: entry.result || '' }));
      return cards.concat(audit).filter((card) => !this.tools.some((tool) => tool.id === card.id)).concat(this.tools);
    },
    statusLabel() { return { idle: '就绪', loading: '读取中', running: '处理中', cancelled: '已停止', completed: '已完成', error: '请重试', limited: '达到限额' }[this.status] || '就绪'; },
  },
  mounted() {
    this.ownerActive = true; this.destroyed = false; this.generation = 0;
    this.pendingStop = Promise.resolve(); this.application = getApplication();
    this.attachInput();
    if (this.$page && this.$page.own) this.$page.own(() => this.onUnload());
    this.refresh();
  },
  beforeDestroy() { this.onUnload(); },
  methods: {
    valid(generation) { return !this.destroyed && this.ownerActive && this.generation === generation; },
    attachInput() {
      try {
        if (!this.inputHandler) this.inputHandler = (result) => {
          if (this.ownerActive && !this.destroyed && result.confirmed) this.draft = result.text;
        };
        input.attach(this.inputHandler);
      } catch (error) { this.notice = errorLabel(error); }
    },
    onShow() {
      if (!this.application || this.destroyed) return;
      this.ownerActive = true; this.attachInput();
      if (!this.busy) this.refresh();
    },
    onHide() {
      if (input.isInputSessionActive()) return;
      this.ownerActive = false; input.detach(this.inputHandler); this.stopRun();
    },
    onUnload() {
      if (this.destroyed) return;
      this.destroyed = true; this.ownerActive = false; input.detach(this.inputHandler);
      if (this.application) this.stopRun();
    },
    async refresh() {
      const generation = ++this.generation;
      try {
        await this.pendingStop;
        if (!this.valid(generation)) return;
        const settings = await this.application.loadSettings();
        if (!this.valid(generation)) return;
        this.settings = settings;
        const sessions = await this.application.loadSessions();
        if (!this.valid(generation)) return;
        // Preload persisted custom recipes so the next run advertises them.
        if (typeof this.application.loadCustomTools === 'function') {
          try { await this.application.loadCustomTools(); } catch (error) { if (this.valid(generation)) this.notice = errorLabel(error); }
          if (!this.valid(generation)) return;
        }
        // A dirty session is retained in memory until an explicit successful save.
        if (!this.dirty) {
          this.sessions = sessions;
          const selected = sessions.find((item) => item.id === this.selectedId) || sessions[0];
          if (selected) { this.selectedId = selected.id; this.messages = selected.messages || []; }
        }
        this.status = this.messages.length ? 'completed' : 'idle';
      } catch (error) { if (this.valid(generation)) { this.status = 'error'; this.notice = errorLabel(error); } }
    },
    async stopRun() {
      ++this.generation;
      if (!this.application) return;
      const wasBusy = this.busy;
      const sessionId = this.selectedId;
      this.busy = false;
      this.tools = this.tools.map((tool) => tool.status === 'running' || tool.status === 'pending' ? Object.assign({}, tool, { status: 'cancelled' }) : tool);
      if (wasBusy) {
        this.status = 'cancelled'; this.notice = '已停止本轮后续操作；已发请求可能仍在回收，结果未知。';
        const session = this.sessions.find((item) => item.id === sessionId);
        if (session) this.updateSession(sessionId, { messages: this.messages.slice(), toolAudit: (session.toolAudit || []).map((entry) =>
          entry.status === 'reserved' || entry.status === 'started' ? Object.assign({}, entry, { status: 'cancelled' }) : entry) });
      }
      const stop = wasBusy ? this.application.stop() : null;
      this.pendingStop = Promise.all([this.pendingStop, Promise.resolve(stop)]).then(async () => {
        if (this.dirty && sessionId) {
          try { await this.persistSession(sessionId); }
          catch (error) { if (!this.destroyed && this.selectedId === sessionId) this.notice = errorLabel(error); }
        }
      }, () => {});
      await this.pendingStop;
    },
    async newSession() {
      if (this.dirty) { this.notice = '请先重试保存当前会话'; return; }
      const stopped = this.stopRun();
      const generation = this.generation;
      await stopped;
      if (!this.valid(generation) || this.dirty) return;
      try {
        const session = await this.application.createSession('新会话');
        if (!this.valid(generation)) return;
        this.sessions = [session].concat(this.sessions.filter((item) => item.id !== session.id));
        this.selectedId = session.id; this.messages = session.messages || [];
        this.tools = []; this.draft = ''; this.notice = ''; this.status = 'idle';
        await this.persist(generation);
        if (!this.valid(generation)) return;
      } catch (error) { if (this.valid(generation)) this.notice = errorLabel(error); }
    },
    async selectSession(id) {
      if (id === this.selectedId) return;
      if (this.dirty) { this.notice = '请先重试保存当前会话'; return; }
      const stopped = this.stopRun();
      const generation = this.generation;
      await stopped;
      if (!this.valid(generation) || this.dirty) return;
      const session = this.sessions.find((item) => item.id === id);
      if (!session) return;
      this.selectedId = id; this.messages = session.messages || []; this.tools = []; this.draft = ''; this.notice = ''; this.status = 'idle';
    },
    async openSettings() {
      const stopped = this.stopRun();
      const generation = this.generation;
      await stopped;
      if (!this.valid(generation)) return;
      try { navigate('settings'); } catch (error) { this.notice = errorLabel(error); }
    },
    async openTools() {
      const stopped = this.stopRun();
      const generation = this.generation;
      await stopped;
      if (!this.valid(generation)) return;
      try { navigate('tools'); } catch (error) { this.notice = errorLabel(error); }
    },
    async editDraft() {
      if (this.busy) return;
      const generation = this.generation;
      try { await input.open({ text: this.draft, placeholder: '输入问题', maxlength: 4000, enterButtonText: '确定' }); }
      catch (error) { if (this.valid(generation)) this.notice = errorLabel(error); }
    },
    updateSession(id, changes) {
      this.sessions = this.sessions.map((item) => item.id === id ? Object.assign({}, item, changes, { updatedAt: Math.max(Date.now(), item.updatedAt || 0) }) : item);
      this.dirty = true;
    },
    async persistSession(id) {
      const session = this.sessions.find((item) => item.id === id);
      if (!session) return;
      // Serialize snapshots per page; an old reservation save must not overwrite later audit state.
      const save = (this.saveQueue || Promise.resolve()).then(() => this.application.saveSession(session));
      this.saveQueue = save.then(() => {}, () => {});
      await save;
      if (this.selectedId === id && this.sessions.find((item) => item.id === id) === session) this.dirty = false;
    },
    async persist(generation) {
      if (!this.valid(generation)) return;
      this.updateSession(this.selectedId, { messages: this.messages.slice() });
      await this.persistSession(this.selectedId);
    },
    async reserveTools(message, generation, sessionId) {
      if (!this.valid(generation)) throw { code: 'CANCELLED' };
      const session = this.sessions.find((item) => item.id === sessionId);
      if (!session) throw { code: 'STORAGE_ERROR' };
      const audit = (session.toolAudit || []).slice();
      message.tool_calls.forEach((call) => {
        if (audit.some((entry) => entry.id === call.id)) throw { code: 'PROTOCOL_ERROR' };
        audit.push({ id: call.id, name: call.function.name, status: 'reserved' });
      });
      this.updateSession(sessionId, { toolAudit: audit });
      await this.persistSession(sessionId);
      if (!this.valid(generation)) throw { code: 'CANCELLED' };
    },
    async retrySave() {
      const generation = this.generation;
      try { await this.persist(generation); if (this.valid(generation)) this.notice = '会话已保存'; }
      catch (error) { if (this.valid(generation)) this.notice = errorLabel(error); }
    },
    onRunEvent(event, generation) {
      if (!this.valid(generation) || !event) return;
      const type = event.type;
      if (this.coreRunId && event.runId !== this.coreRunId) return;
      if (event.runId) this.coreRunId = event.runId;
      if (type === 'message' && event.message) this.messages = this.messages.concat([event.message]);
      if (type === 'tool_group' && event.messages) this.messages = this.messages.concat(event.messages);
      if (type === 'message' || type === 'tool_group') this.updateSession(this.selectedId, { messages: this.messages.slice() });
      if (type === 'tool_started' || type === 'tool_result') {
        const id = event.id || (event.message && event.message.tool_call_id);
        if (!id) return;
        const previous = this.tools.find((item) => item.id === id) || { id, name: event.name, status: 'pending' };
        let failed = null;
        const content = event.message && event.message.content;
        if (type === 'tool_result' && typeof content === 'string') {
          try { const parsed = JSON.parse(content); if (parsed && parsed.error) failed = parsed.error; } catch (error) { /* Plain text is a valid tool result. */ }
        }
        const next = Object.assign({}, previous, { name: event.name || previous.name,
          status: type === 'tool_started' ? 'running' : failed ? 'error' : 'completed',
          result: failed ? '' : typeof content === 'string' ? content : previous.result,
          error: failed ? errorLabel(failed) : '', elapsedMs: event.elapsedMs,
          commandId: event.commandId || previous.commandId });
        this.tools = this.tools.filter((item) => item.id !== id).concat([next]);
        const session = this.sessions.find((item) => item.id === this.selectedId);
        if (session) this.updateSession(session.id, { toolAudit: (session.toolAudit || []).map((entry) => entry.id === id ? Object.assign({}, entry,
          type === 'tool_started' ? { status: 'started' } : { status: failed ? 'error' : 'completed', result: content }) : entry) });
      }
    },
    async send() {
      if (this.busy || !this.draft.trim() || !this.ownerActive || this.destroyed) return;
      if (this.dirty) { this.notice = '请先重试保存当前会话'; return; }
      if (!this.settings || !this.settings.baseUrl || !this.settings.model) { this.notice = '请先在设置中填写服务地址和模型'; return; }
      const text = this.draft.trim();
      const generation = ++this.generation;
      this.busy = true; this.status = 'running';
      try {
        await this.pendingStop;
        if (!this.valid(generation)) return;
        if (!this.selectedId) {
          const session = await this.application.createSession('新会话');
          if (!this.valid(generation)) return;
          this.sessions = [session].concat(this.sessions); this.selectedId = session.id; this.messages = session.messages || [];
        }
        const sessionId = this.selectedId;
        this.draft = ''; this.notice = ''; this.tools = []; this.coreRunId = null;
        this.messages = this.messages.concat([{ role: 'user', content: text }]);
        const session = this.sessions.find((item) => item.id === sessionId);
        this.updateSession(sessionId, { messages: this.messages.slice(), title: session.messages && session.messages.length ? session.title : text.slice(0, 28) });
        await this.persistSession(sessionId);
        if (!this.valid(generation)) return;
        const current = this.sessions.find((item) => item.id === sessionId);
        const result = await this.application.run(current.messages.slice(), this.settings, {
          usedToolIds: (current.toolAudit || []).map((entry) => entry.id),
          beforeToolBatch: (message) => this.reserveTools(message, generation, sessionId),
          onEvent: (event) => this.onRunEvent(event, generation),
        });
        if (!this.valid(generation)) return;
        this.messages = result.messages;
        this.status = result.status || 'completed';
        if (result.error) this.notice = errorLabel(result.error);
        const latest = this.sessions.find((item) => item.id === sessionId);
        this.updateSession(sessionId, { messages: this.messages.slice(), toolAudit: (latest.toolAudit || []).map((entry) =>
          entry.status === 'reserved' || entry.status === 'started' ? Object.assign({}, entry, { status: 'cancelled' }) : entry) });
        this.tools = this.tools.map((tool) => tool.status === 'running' || tool.status === 'pending' ? Object.assign({}, tool, { status: this.status === 'limited' ? 'limited' : this.status === 'cancelled' ? 'cancelled' : 'error' }) : tool);
        await this.persistSession(sessionId);
      } catch (error) {
        if (!this.valid(generation)) return;
        this.status = error && error.code === 'LIMIT_REACHED' ? 'limited' : error && error.code === 'CANCELLED' ? 'cancelled' : 'error';
        this.notice = errorLabel(error);
      } finally { if (this.valid(generation)) this.busy = false; }
    },
  },
};
</script>
<style lang="less" scoped>
@import "base.less";
.page { width: 100vw; height: 100vh; flex-direction: row; background-color: @bg-base; }
.conversation { width: @content-w; height: 100vh; flex-direction: column; }
.header { width: @content-w; height: 18vh; flex-direction: row; align-items: center; }
.title { width: 48vw; margin-left: 3vw; font-size: @font-md; color: @text-primary; lines: 1; text-overflow: ellipsis; }
.status { width: 20vw; font-size: @font-xs; color: @text-secondary; lines: 1; text-align: right; }
.messages { width: @content-w; height: 58vh; flex-direction: column; }
.message-row { width: @content-w; flex-direction: column; }
.empty { width: @message-inner; margin-left: 3vw; margin-top: 5vh; flex-direction: column; }
.empty-title { width: @message-inner; font-size: @font-lg; color: @accent; }
.empty-copy { width: 62vw; margin-top: 3vh; font-size: @font-sm; color: @text-secondary; }
.notice { width: @message-inner; margin-left: 3vw; margin-top: 2vh; margin-bottom: 2vh; font-size: @font-xs; color: @accent; }
.retry { width: 35vw; min-height: @touch-min; margin-left: 3vw; flex-direction: row; align-items: center; justify-content: center; background-color: @bg-muted; border-radius: @radius-sm; }
.retry-label { font-size: @font-sm; color: @text-primary; }
.composer { width: @content-w; height: 24vh; flex-direction: row; align-items: center; }
.input { width: 46vw; height: 20vh; margin-left: 3vw; flex-direction: row; align-items: center; border-radius: @radius-md; background-color: @bg-muted; }
.draft { width: 42vw; margin-left: 2vw; font-size: @font-sm; color: @text-primary; lines: 1; text-overflow: ellipsis; }
.tools { width: 9vw; height: 20vh; margin-left: 1vw; flex-direction: row; align-items: center; justify-content: center; border-radius: @radius-md; background-color: @bg-muted; }
.tools-label { font-size: @font-xs; color: @text-primary; lines: 1; }
.send { width: 11vw; height: 20vh; margin-left: 1vw; flex-direction: row; align-items: center; justify-content: center; border-radius: @radius-md; }
.send-color { background-color: @brand; }
.stop-color { background-color: @danger; }
.send-label { font-size: @font-sm; color: @text-primary; lines: 1; }
</style>
