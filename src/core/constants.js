((Y) => {
  // 基础常量：默认播放设置、轨迹文案、完成阈值
  // 说明：已移除 @downloadURL / @updateURL，脚本不会自动更新，改动不会被上游覆盖。

  // 进入视频后的默认播放设置：2 倍速 + 静音（可在面板「播放设置」里改）
  const DEFAULT_PLAYBACK = { rate: 2, muted: true };

  // 面板轨迹里的「类型」文案。以前只有 video/ppt/course/question/homework/forum，
  // 图文(graph)、PDF、测验等没有对应文案，面板上只剩一个泛化标签，看的人以为脚本不支持。
  const KIND_LABEL = {
    video: '视频',
    audio: '音频',
    ppt: '课件',
    course: '课程',
    question: '题目',
    homework: '作业',
    exercise: '作业',
    forum: '讨论',
    graph: '图文',
    read: '图文',
    quiz: '测验',
    pdf: 'PDF',
    other: '内容'
  };

  // 平台口径下「这一节刷完了」的最低进度。1.0 太严（浮点误差），0.999 足够。
  const DONE_RATE = 0.999;

  Y.DEFAULT_PLAYBACK = DEFAULT_PLAYBACK;
  Y.KIND_LABEL = KIND_LABEL;
  Y.DONE_RATE = DONE_RATE;
})(Y);
