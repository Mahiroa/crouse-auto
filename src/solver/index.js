((Y) => {
  // 答题装配（Solver）

  const Solver = { ...Y.SolverQuestion, ...Y.SolverAI };

  Y.Solver = Solver;
})(Y);
