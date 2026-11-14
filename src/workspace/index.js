((Y) => {
  // 学习空间装配（AiWorkspace）

  const AiWorkspace = { ...Y.WorkspaceMedia, ...Y.WorkspaceDom };

  Y.AiWorkspace = AiWorkspace;
})(Y);
