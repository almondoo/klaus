/**
 * VITE_KLAUS_MOCK=1 のときに使うフィクスチャデータ。
 * server 未実装の間、UI 開発・検証はすべてこのモックで行う。
 */
import type {
  AssertionResult,
  EnvironmentDetail,
  EnvironmentListEntry,
  FlowDetail,
  FlowListEntry,
  HistoryEntry,
  SingleRequestRequestBody,
  StepResult,
} from "./types";

export const mockFlows: FlowListEntry[] = [
  { path: "api/auth-flow.yaml", name: "認証フロー", stepCount: 2 },
  { path: "api/users-flow.yaml", name: "ユーザー一覧", stepCount: 4 },
  {
    path: "api/broken-flow.yaml",
    error: "YAMLException: bad indentation of a mapping entry (line 4, column 3)",
  },
];

export const mockFlowDetails: Record<string, FlowDetail> = {
  "api/auth-flow.yaml": {
    path: "api/auth-flow.yaml",
    name: "認証フロー",
    env: "local",
    steps: [
      { name: "login", method: "POST", url: "{{baseUrl}}/login" },
      { name: "get-me", method: "GET", url: "{{baseUrl}}/me" },
    ],
  },
  "api/users-flow.yaml": {
    path: "api/users-flow.yaml",
    name: "ユーザー一覧",
    env: "local",
    steps: [
      { name: "list-users", method: "GET", url: "{{baseUrl}}/users" },
      { name: "get-user", method: "GET", url: "{{baseUrl}}/users/1" },
      { name: "delete-user", method: "DELETE", url: "{{baseUrl}}/users/1" },
      // delete-user が失敗するため、mock.ts の runFlow により本ステップは自動的に skipped になる
      // (実行ビューで 成功2 → 失敗1 → skip1 のシナリオを確認できるようにする)
      { name: "verify-deleted", method: "GET", url: "{{baseUrl}}/users/1" },
    ],
  },
};

export const mockEnvironments: EnvironmentListEntry[] = [{ name: "local" }, { name: "staging" }];

/**
 * 環境ごとの key-value フィクスチャ(EnvEditor の検証用)。
 * mock.ts の updateEnvironment はここを直接書き換えて保存後の再取得を再現する。
 */
export const mockEnvironmentDetails: Record<string, EnvironmentDetail> = {
  local: {
    name: "local",
    values: { baseUrl: "http://localhost:3000", apiKey: "local-secret" },
  },
  staging: {
    name: "staging",
    values: { baseUrl: "https://staging.example.com", apiKey: "staging-secret" },
  },
};

/**
 * ステップ名ごとの固定結果(成功2件・失敗1件を混ぜて UI 挙動を確認しやすくする)。
 * users-flow.yaml の4番目のステップ(verify-deleted)は delete-user 失敗後に
 * mock.ts の runFlow が自動的に skipped を生成するため、ここには定義しない。
 */
export function buildMockStepResult(flowPath: string, stepName: string): StepResult {
  const startedAt = new Date().toISOString();

  if (flowPath === "api/auth-flow.yaml" && stepName === "login") {
    const assertions: AssertionResult[] = [
      { ok: true, kind: "status", expected: 200, actual: 200, message: "status 200" },
      { ok: true, kind: "body", expected: true, actual: true, message: "$.token exists" },
    ];
    return {
      name: stepName,
      status: "passed",
      startedAt,
      durationMs: 45,
      request: {
        method: "POST",
        url: "http://localhost:3000/login",
        headers: { "Content-Type": "application/json" },
        body: { email: "test@example.com", password: "***" },
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { token: "mock-token-abc123" },
      },
      assertions,
    };
  }

  if (flowPath === "api/auth-flow.yaml" && stepName === "get-me") {
    const assertions: AssertionResult[] = [
      { ok: true, kind: "status", expected: 200, actual: 200, message: "status 200" },
      {
        ok: true,
        kind: "body",
        expected: "test@example.com",
        actual: "test@example.com",
        message: "$.email equals test@example.com",
      },
    ];
    return {
      name: stepName,
      status: "passed",
      startedAt,
      durationMs: 12,
      request: {
        method: "GET",
        url: "http://localhost:3000/me",
        headers: { Authorization: "Bearer mock-token-abc123" },
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { email: "test@example.com", id: 1 },
      },
      assertions,
    };
  }

  if (flowPath === "api/users-flow.yaml" && stepName === "list-users") {
    return {
      name: stepName,
      status: "passed",
      startedAt,
      durationMs: 30,
      request: { method: "GET", url: "http://localhost:3000/users", headers: {} },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: [{ id: 1, name: "Alice" }],
      },
      assertions: [{ ok: true, kind: "status", expected: 200, actual: 200, message: "status 200" }],
    };
  }

  if (flowPath === "api/users-flow.yaml" && stepName === "get-user") {
    return {
      name: stepName,
      status: "passed",
      startedAt,
      durationMs: 18,
      request: { method: "GET", url: "http://localhost:3000/users/1", headers: {} },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { id: 1, name: "Alice" },
      },
      assertions: [{ ok: true, kind: "status", expected: 200, actual: 200, message: "status 200" }],
    };
  }

  if (flowPath === "api/users-flow.yaml" && stepName === "delete-user") {
    const assertions: AssertionResult[] = [
      {
        ok: false,
        kind: "status",
        expected: 204,
        actual: 500,
        message: "expected status 204 but got 500",
      },
    ];
    return {
      name: stepName,
      status: "failed",
      startedAt,
      durationMs: 220,
      request: { method: "DELETE", url: "http://localhost:3000/users/1", headers: {} },
      response: {
        status: 500,
        headers: { "content-type": "application/json" },
        body: { error: "internal server error" },
      },
      assertions,
    };
  }

  // 未知の組み合わせにはフォールバック(通常到達しない)
  return {
    name: stepName,
    status: "passed",
    startedAt,
    durationMs: 10,
    assertions: [],
  };
}

/**
 * POST /api/request のモック結果を生成する。実サーバーへは接続せず、入力をそのまま
 * echo したレスポンスを組み立てて返す(単発実行 UI の見た目確認用)。
 */
export function buildMockSingleRequestResult(body: SingleRequestRequestBody): StepResult {
  const method = (body.request.method ?? "GET").toUpperCase();
  return {
    name: "single-request",
    status: "passed",
    startedAt: new Date().toISOString(),
    durationMs: 60,
    request: {
      method,
      url: body.request.url,
      headers: body.request.headers ?? {},
      body: body.request.body,
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { mock: true, method, url: body.request.url, env: body.env ?? null },
    },
    assertions: [],
  };
}

/** 履歴ブラウザの検証用フィクスチャ。新しい順で複数 run・複数 flow を混在させる */
export const mockHistory: HistoryEntry[] = [
  {
    v: 1,
    runId: "run-003",
    flow: "認証フロー",
    step: "login",
    startedAt: "2026-08-07T09:15:00.000Z",
    durationMs: 45,
    request: {
      method: "POST",
      url: "http://localhost:3000/login",
      headers: { "Content-Type": "application/json" },
      body: { email: "test@example.com" },
    },
    response: { status: 200, headers: {}, body: { token: "abc" } },
    assertions: [{ ok: true, kind: "status", expected: 200, actual: 200, message: "status 200" }],
  },
  {
    v: 1,
    runId: "run-003",
    flow: "認証フロー",
    step: "get-me",
    startedAt: "2026-08-07T09:15:01.000Z",
    durationMs: 12,
    request: { method: "GET", url: "http://localhost:3000/me", headers: {} },
    response: { status: 200, headers: {}, body: { email: "test@example.com" } },
    assertions: [{ ok: true, kind: "status", expected: 200, actual: 200, message: "status 200" }],
  },
  {
    v: 1,
    runId: "run-002",
    flow: "ユーザー一覧",
    step: "list-users",
    startedAt: "2026-08-06T12:00:00.000Z",
    durationMs: 30,
    request: { method: "GET", url: "http://localhost:3000/users", headers: {} },
    response: { status: 200, headers: {}, body: [] },
    assertions: [{ ok: true, kind: "status", expected: 200, actual: 200, message: "status 200" }],
  },
  {
    v: 1,
    runId: "run-002",
    flow: "ユーザー一覧",
    step: "get-user",
    startedAt: "2026-08-06T12:00:01.000Z",
    durationMs: 18,
    request: { method: "GET", url: "http://localhost:3000/users/1", headers: {} },
    response: { status: 200, headers: {}, body: { id: 1, name: "Alice" } },
    assertions: [{ ok: true, kind: "status", expected: 200, actual: 200, message: "status 200" }],
  },
  // NOTE: 4番目の verify-deleted は delete-user 失敗により skipped になるステップだが、
  // src/core/runner.ts の実装上 skipped ステップは historySink に一切渡されず履歴には書き込まれない。
  // そのため本 run はここまでの3件(成功2・失敗1)が実際の永続化結果として正しい姿であり、
  // 「4件目を skipped として履歴に追加する」ことは実装と矛盾するため行わない。
  {
    v: 1,
    runId: "run-002",
    flow: "ユーザー一覧",
    step: "delete-user",
    startedAt: "2026-08-06T12:00:02.000Z",
    durationMs: 220,
    request: { method: "DELETE", url: "http://localhost:3000/users/1", headers: {} },
    response: { status: 500, headers: {}, body: { error: "internal server error" } },
    assertions: [
      {
        ok: false,
        kind: "status",
        expected: 204,
        actual: 500,
        message: "expected status 204 but got 500",
      },
    ],
  },
  {
    v: 1,
    runId: "run-001",
    flow: "認証フロー",
    step: "login",
    startedAt: "2026-08-05T08:30:00.000Z",
    durationMs: 50,
    request: { method: "POST", url: "http://localhost:3000/login", headers: {} },
    response: { status: 200, headers: {}, body: { token: "xyz" } },
    assertions: [{ ok: true, kind: "status", expected: 200, actual: 200, message: "status 200" }],
  },
];
