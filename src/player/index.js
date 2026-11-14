((Y) => {
  // 播放器装配（Player）

  const Player = { ...Y.PlayerDuration, ...Y.PlayerControls, ...Y.PlayerObserve };

  Y.Player = Player;
})(Y);
