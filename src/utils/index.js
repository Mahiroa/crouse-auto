((Y) => {
  // 工具集装配（Utils）

  const Utils = { ...Y.UtilsTiming, ...Y.UtilsText, ...Y.UtilsHumanCheck, ...Y.UtilsDom };

  Y.Utils = Utils;
})(Y);
