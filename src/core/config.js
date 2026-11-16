((Y) => {
  // 运行期配置（Config）

  // ---- 脚本配置，用户可修改 ----
  const Config = {
    version: '3.6.7',     // 版本号（必须与 src/manifest.json 一致，构建会校验）
    playbackRate: Y.DEFAULT_PLAYBACK.rate, // 视频播放倍速。进入视频默认 2 倍速，面板里可改回 1
    pptInterval: 3000,    // ppt翻页间隔
    storageKeys: {        // 使用者勿动
      progress: '[脚本]刷课进度信息',
      ai: 'ykt_ai_conf',
      playback: 'ykt_playback_conf', // 倍速与静音
      proClassCount: 'pro_lms_classCount',
      feature: 'ykt_feature_conf', // 是否开启AI作答/自动评论
      pendingAutoStart: 'ykt_pending_auto_start',
      trail: 'ykt_trail',
      panelRect: 'ykt_panel_rect' // 面板位置/尺寸
    }
  };

  Y.Config = Config;
})(Y);
