// Shared component mocks for tests that import `desktop/src/App` as a module
// without rendering it. App.tsx pulls heavy UI subtrees at import time; these
// stubs keep module init cheap. Tauri APIs need no entries: vitest.config.ts
// aliases them to tests/mocks/*.ts globally.

export const markdown = {
  WorkspaceProvider: ({ children }: { children?: unknown }) => children ?? null,
};

const passthroughCard = () => null;

export const thread = {
  ActivePlanTaskCard: passthroughCard,
  AssistantMsg: passthroughCard,
  CheckpointApprovalCard: passthroughCard,
  ChoiceApprovalCard: passthroughCard,
  ConfirmApprovalCard: passthroughCard,
  PathAccessApprovalCard: passthroughCard,
  PlanApprovalCard: passthroughCard,
  RevisionApprovalCard: passthroughCard,
  TurnDivider: passthroughCard,
  UserMsg: passthroughCard,
};
