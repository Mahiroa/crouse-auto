((Y) => {
  // 文本解析与完成度文案判定

  const pctText = value => (Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '未知');

  const UtilsText = {
    // 将一个 JSON 字符串解析为 JavaScript 对象
    safeJSONParse(value, fallback) {
      try {
        return JSON.parse(value);
      } catch (_) {
        return fallback;
      }
    },
    // 使用UI课程完成度来判别是否完成课程
    isProgressDone(text) {
      if (!text) return false;
      return text.includes('100%') || text.includes('99%') || text.includes('98%') || text.includes('已完成');
    },
    // 离开当前视频前只认页面上的完成标记，98%、99% 时平台往往还没写成已完成
    isMarkedDone(text) {
      if (!text) return false;
      if (text.includes('未完成') || text.includes('未开始')) return false;
      return text.includes('100%') || text.includes('已完成');
    }
  };

  Y.pctText = pctText;
  Y.UtilsText = UtilsText;
})(Y);
