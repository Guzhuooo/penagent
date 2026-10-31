<template>
  <div class="message" :class="message.role === 'user' ? 'user' : 'assistant'">
    <text class="role">{{ message.role === 'user' ? '你' : 'Agent' }}</text>
    <text class="content">{{ displayText }}</text>
  </div>
</template>
<script>
export default {
  name: 'MessageCard',
  props: { message: { type: Object, required: true } },
  computed: {
    displayText() {
      if (typeof this.message.content === 'string' && this.message.content) return this.message.content;
      return this.message.tool_calls && this.message.tool_calls.length ? '正在使用工具…' : '（无文字内容）';
    },
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
</style>
