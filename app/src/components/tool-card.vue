<template>
  <div class="card">
    <div class="heading" @click="open = !open">
      <text class="name">{{ tool.name || '工具' }}</text>
      <text class="state">{{ stateLabel }} · {{ open ? '收起' : '详情' }}</text>
    </div>
    <text v-if="tool.commandId" class="detail">预设：{{ tool.commandId }}</text>
    <text v-if="tool.error" class="failure">{{ tool.error }}</text>
    <text v-if="tool.elapsedMs != null" class="detail">耗时 {{ tool.elapsedMs }} ms</text>
    <text v-if="open && tool.result" class="detail">{{ resultText }}</text>
  </div>
</template>
<script>
import { formatPlainText } from '../utils/plain-text.js';
export default {
  name: 'ToolCard', props: { tool: { type: Object, required: true } },
  data() { return { open: false }; },
  computed: {
    stateLabel() {
      const labels = { pending: '等待', running: '执行中', completed: '已完成', error: '失败', cancelled: '已停止', limited: '已停止' };
      return labels[this.tool.status] || '等待';
    },
    resultText() { return formatPlainText(this.tool.result || ''); },
  },
};
</script>
<style lang="less" scoped>
@import "base.less";
.card { width: @message-inner; min-height: 14vh; margin-left: 3vw; margin-top: 2vh; padding-top: 2vh; padding-bottom: 3vh; flex-direction: column; background-color: @bg-muted; border-radius: @radius-sm; border-left-width: @stroke; border-left-color: @brand; }
.heading { width: 64vw; min-height: 6vh; margin-left: 2vw; flex-direction: row; align-items: center; }
.name { width: 40vw; font-size: @font-sm; color: @accent; lines: 1; }
.state { width: 24vw; font-size: @font-xs; color: @text-secondary; lines: 1; }
.detail { width: 64vw; margin-left: 2vw; margin-top: 1vh; font-size: @font-xs; color: @text-primary; }
.failure { width: 64vw; margin-left: 2vw; margin-top: 1vh; font-size: @font-xs; color: @danger; }
</style>
