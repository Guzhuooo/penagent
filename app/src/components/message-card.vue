<template>
  <div class="message" :class="message.role === 'user' ? 'user' : 'assistant'">
    <text class="role">{{ message.role === 'user' ? '你' : 'Agent' }}</text>
    <div v-if="message.reasoning" class="block" @click="reasonOpen = !reasonOpen">
      <text class="block-title">思考过程 {{ reasonOpen ? '收起' : '展开' }}</text>
      <text v-if="reasonOpen" class="block-body">{{ reasoningText }}</text>
    </div>
    <text class="content">{{ displayText }}</text>
    <div v-if="toolCalls.length" class="block" @click="callsOpen = !callsOpen">
      <text class="block-title">工具调用 {{ toolCalls.length }} 个 {{ callsOpen ? '收起' : '展开' }}</text>
      <div v-if="callsOpen" v-for="call in toolCalls" :key="call.id" class="call">
        <text class="call-name">{{ call.function.name }}</text>
        <text class="call-args">{{ call.function.arguments }}</text>
      </div>
    </div>
  </div>
</template>
<script>
import { formatPlainText } from '../utils/plain-text.js';
export default {
  name: 'MessageCard',
  props: { message: { type: Object, required: true } },
  data() { return { reasonOpen: false, callsOpen: false }; },
  computed: {
    displayText() {
      if (typeof this.message.content === 'string' && this.message.content) return formatPlainText(this.message.content);
      return this.message.tool_calls && this.message.tool_calls.length ? '正在使用工具…' : '（无文字内容）';
    },
    reasoningText() { return formatPlainText(this.message.reasoning || ''); },
    toolCalls() { return Array.isArray(this.message.tool_calls) ? this.message.tool_calls : []; },
  },
};
</script>
<style lang="less" scoped>
@import "base.less";
.message { width: @message-inner; min-height: 20vh; margin-left: 3vw; margin-top: 2vh; margin-bottom: 2vh; padding-top: 2vh; padding-bottom: 3vh; flex-direction: column; border-radius: @radius-md; }
.user { background-color: @bg-muted; }
.assistant { background-color: @bg-elevated; }
.role { width: 64vw; margin-left: 2vw; font-size: @font-xs; color: @accent; lines: 1; }
.content { width: 64vw; margin-left: 2vw; margin-top: 1vh; font-size: @font-sm; color: @text-primary; }
.block { width: 64vw; min-height: 6vh; margin-left: 2vw; margin-top: 1vh; flex-direction: column; background-color: @bg-muted; border-radius: @radius-sm; }
.block-title { width: 60vw; margin-left: 2vw; margin-top: 1vh; margin-bottom: 1vh; font-size: @font-xs; color: @accent; lines: 1; }
.block-body { width: 60vw; margin-left: 2vw; margin-bottom: 2vh; font-size: @font-xs; color: @text-secondary; }
.call { width: 60vw; margin-left: 2vw; margin-bottom: 1vh; flex-direction: column; }
.call-name { width: 58vw; font-size: @font-xs; color: @text-primary; lines: 1; }
.call-args { width: 58vw; font-size: @font-xs; color: @text-secondary; }
</style>
