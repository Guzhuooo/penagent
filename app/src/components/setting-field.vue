<template>
  <div class="field" @click="$emit('edit')">
    <text class="label">{{ label }}</text><text class="value">{{ value || placeholder }}</text><text class="edit">编辑</text>
  </div>
</template>
<script>
export default { name: 'SettingField', props: { label: String, value: String, placeholder: String } };
</script>
<style lang="less" scoped>
@import "base.less";
.field { width: @message-inner; min-height: 24vh; margin-bottom: 2vh; flex-direction: row; align-items: center; background-color: @bg-muted; border-radius: @radius-sm; }
.label { width: 14vw; margin-left: 2vw; font-size: @font-sm; color: @text-secondary; lines: 1; }
.value { width: 41vw; font-size: @font-sm; color: @text-primary; lines: 1; text-overflow: ellipsis; }
.edit { width: 9vw; font-size: @font-xs; color: @accent; lines: 1; text-align: center; }
</style>
