<template>
  <div class="rail">
    <text class="brand">笔上 Agent</text>
    <div class="action" @click="$emit('new')"><text class="action-label">＋ 新会话</text></div>
    <scroller class="sessions" scroll-direction="vertical">
      <div v-for="session in sessions" :key="session.id" class="session" :class="session.id === selectedId ? 'selected' : 'unselected'" @click="$emit('select', session.id)">
        <text class="session-title">{{ session.title || '新会话' }}</text>
      </div>
      <text v-if="!sessions.length" class="hint">会话保存在设备上</text>
    </scroller>
    <div class="action" @click="$emit('settings')"><text class="action-label">设置</text></div>
  </div>
</template>
<script>
export default {
  name: 'SessionRail',
  props: { sessions: { type: Array, default: () => [] }, selectedId: { type: String, default: '' } },
};
</script>
<style lang="less" scoped>
@import "base.less";
.rail { width: @sidebar-w; height: 100vh; flex-direction: column; background-color: @bg-elevated; }
.brand { width: @rail-inner; height: 18vh; margin-left: @rail-inset; font-size: @font-md; color: @accent; lines: 1; }
.action { width: @rail-inner; height: 18vh; margin-left: @rail-inset; flex-direction: row; align-items: center; justify-content: center; background-color: @bg-muted; border-radius: @radius-sm; }
.action-label { font-size: @font-sm; color: @text-primary; lines: 1; }
.sessions { width: @sidebar-w; height: 44vh; margin-top: 1vh; margin-bottom: 1vh; flex-direction: column; }
.session { width: @rail-inner; min-height: 18vh; margin-left: @rail-inset; margin-bottom: 1vh; flex-direction: row; align-items: center; border-radius: @radius-sm; }
.selected { background-color: @brand; }
.unselected { background-color: @bg-elevated; }
.session-title { width: 20vw; margin-left: 1vw; font-size: @font-sm; color: @text-primary; lines: 1; text-overflow: ellipsis; }
.hint { width: @rail-inner; margin-left: @rail-inset; font-size: @font-xs; color: @text-secondary; lines: 2; }
</style>
