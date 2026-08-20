import { z } from "zod";

/**
 * フロー定義 YAML / 環境ファイル YAML の zod スキーマ。
 * ここでの型が loader.ts のパース結果の型になり、runner.ts 以降で使われる。
 *
 * オブジェクトは全て z.strictObject を使う(未知キー・typo をスキーマ検証エラーとして検出するため)。
 * ただし z.record によるフィールド(headers/query/capture/variables/environmentSchema)はキーが
 * ユーザー定義の自由な文字列であるため strict 化の対象外(record 自体がキー集合を制限しない)。
 */

/** ヘッダーアサーション(1件) */
export const headerAssertionSchema = z.strictObject({
  name: z.string().describe("Response header name to assert against (case-insensitive)."),
  equals: z.string().optional().describe("Passes if the header value equals this string exactly."),
  contains: z.string().optional().describe("Passes if the header value contains this substring."),
  regex: z
    .string()
    .optional()
    .describe("Passes if the header value matches this regular expression."),
  exists: z
    .boolean()
    .optional()
    .describe("If true, passes when the header is present; if false, when it is absent."),
});
export type HeaderAssertion = z.infer<typeof headerAssertionSchema>;

/** body(JSON)に対する jsonpath ベースのアサーション(1件) */
export const bodyAssertionSchema = z.strictObject({
  path: z
    .string()
    .describe('JSONPath expression (e.g. "$.token") selecting a value in the response body.'),
  exists: z
    .boolean()
    .optional()
    .describe("If true, passes when the path resolves to a value; if false, when it does not."),
  equals: z
    .unknown()
    .optional()
    .describe("Passes if the resolved value strictly equals this value."),
  contains: z
    .string()
    .optional()
    .describe("Passes if the resolved value (stringified) contains this substring."),
  regex: z
    .string()
    .optional()
    .describe("Passes if the resolved value (stringified) matches this regular expression."),
});
export type BodyAssertion = z.infer<typeof bodyAssertionSchema>;

/** 生テキストに対するアサーション */
export const bodyTextAssertionSchema = z.strictObject({
  equals: z
    .string()
    .optional()
    .describe("Passes if the raw response body text equals this string exactly."),
  contains: z
    .string()
    .optional()
    .describe("Passes if the raw response body text contains this substring."),
  regex: z
    .string()
    .optional()
    .describe("Passes if the raw response body text matches this regular expression."),
});
export type BodyTextAssertion = z.infer<typeof bodyTextAssertionSchema>;

/** 所要時間に対するアサーション */
export const durationAssertionSchema = z.strictObject({
  maxMs: z.number().describe("Passes if the step's duration is at most this many milliseconds."),
});
export type DurationAssertion = z.infer<typeof durationAssertionSchema>;

/** SSE 受信イベント数に対するアサーション */
export const eventCountAssertionSchema = z.strictObject({
  min: z
    .number()
    .optional()
    .describe("Passes if the number of received SSE events is at least this value."),
  max: z
    .number()
    .optional()
    .describe("Passes if the number of received SSE events is at most this value."),
  equals: z
    .number()
    .optional()
    .describe("Passes if the number of received SSE events equals this value exactly."),
});
export type EventCountAssertion = z.infer<typeof eventCountAssertionSchema>;

/** SSE 個別イベントに対するアサーション(1件) */
export const eventAssertionSchema = z.strictObject({
  index: z
    .number()
    .optional()
    .describe("Zero-based index of the received SSE event to assert against."),
  path: z
    .string()
    .optional()
    .describe("JSONPath expression selecting a value inside the event's JSON-parsed data field."),
  exists: z
    .boolean()
    .optional()
    .describe("If true, passes when the path resolves to a value; if false, when it does not."),
  equals: z
    .unknown()
    .optional()
    .describe("Passes if the resolved value strictly equals this value."),
  contains: z
    .string()
    .optional()
    .describe("Passes if the resolved value (stringified) contains this substring."),
  regex: z
    .string()
    .optional()
    .describe("Passes if the resolved value (stringified) matches this regular expression."),
});
export type EventAssertion = z.infer<typeof eventAssertionSchema>;

/** WS 受信メッセージ数に対するアサーション。セマンティクスは eventCount と同一 */
export const messageCountAssertionSchema = z.strictObject({
  min: z
    .number()
    .optional()
    .describe("Passes if the number of received WS messages is at least this value."),
  max: z
    .number()
    .optional()
    .describe("Passes if the number of received WS messages is at most this value."),
  equals: z
    .number()
    .optional()
    .describe("Passes if the number of received WS messages equals this value exactly."),
});
export type MessageCountAssertion = z.infer<typeof messageCountAssertionSchema>;

/** WS 個別メッセージに対するアサーション(1件)。セマンティクスは events と同一 */
export const messageAssertionSchema = z.strictObject({
  index: z
    .number()
    .optional()
    .describe("Zero-based index of the received WS message to assert against."),
  path: z
    .string()
    .optional()
    .describe("JSONPath expression selecting a value inside the message's JSON-parsed data."),
  exists: z
    .boolean()
    .optional()
    .describe("If true, passes when the path resolves to a value; if false, when it does not."),
  equals: z
    .unknown()
    .optional()
    .describe("Passes if the resolved value strictly equals this value."),
  contains: z
    .string()
    .optional()
    .describe("Passes if the resolved value (stringified) contains this substring."),
  regex: z
    .string()
    .optional()
    .describe("Passes if the resolved value (stringified) matches this regular expression."),
});
export type MessageAssertion = z.infer<typeof messageAssertionSchema>;

/** ステップのアサーション定義全体 */
export const assertSchema = z.strictObject({
  status: z
    .number()
    .optional()
    .describe("Passes if the HTTP response status code equals this value."),
  headers: z
    .array(headerAssertionSchema)
    .optional()
    .describe("List of header assertions to evaluate."),
  body: z
    .array(bodyAssertionSchema)
    .optional()
    .describe("List of JSONPath-based body assertions to evaluate."),
  bodyText: bodyTextAssertionSchema
    .optional()
    .describe("Assertion against the raw (non-JSON) response body text."),
  duration: durationAssertionSchema
    .optional()
    .describe("Assertion against the step's elapsed duration."),
  eventCount: eventCountAssertionSchema
    .optional()
    .describe("Assertion against the number of received SSE events (SSE steps only)."),
  events: z
    .array(eventAssertionSchema)
    .optional()
    .describe("List of per-event assertions (SSE steps only)."),
  messageCount: messageCountAssertionSchema
    .optional()
    .describe("Assertion against the number of received WS messages (WS steps only)."),
  messages: z
    .array(messageAssertionSchema)
    .optional()
    .describe("List of per-message assertions (WS steps only)."),
  bodySchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "JSON Schema (draft 2020-12) object to validate the JSON-parsed response body against. Each violation is reported as a separate assertion result.",
    ),
});
export type AssertDef = z.infer<typeof assertSchema>;

/** GraphQL リクエスト定義。query / variables の文字列値はテンプレート展開対象 */
export const graphqlRequestSchema = z.strictObject({
  query: z
    .string()
    .describe("GraphQL query or mutation document. Template placeholders are expanded."),
  variables: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("GraphQL variables object. String values are template-expanded."),
});
export type GraphqlRequestDef = z.infer<typeof graphqlRequestSchema>;

/**
 * リクエスト定義。method は大文字化して保持する。
 * graphql 指定時のみ method 省略可(実行時に POST が既定値になる。schema 側ではデフォルト値を入れず、
 * runner.ts の実行時解決に委ねる)。body と graphql は排他。
 */
export const requestSchema = z
  .strictObject({
    method: z
      .string()
      .transform((value) => value.toUpperCase())
      .optional()
      .describe(
        "HTTP method (case-insensitive, normalized to upper case). Required unless `graphql` is set, in which case it defaults to POST.",
      ),
    url: z.string().describe("Request URL. Template placeholders are expanded."),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("HTTP request headers. Values are template-expanded."),
    /**
     * URL のクエリ文字列にマージするキー・値。値はテンプレート展開対象。
     * URL に既に同名キーがある場合は query 側の値で上書きする(実行時解決は runner.ts 側)。
     */
    query: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Query string parameters merged into the URL. Values are template-expanded. Overrides any same-named key already present in `url`.",
      ),
    body: z.unknown().optional().describe("Request body. Mutually exclusive with `graphql`."),
    graphql: graphqlRequestSchema
      .optional()
      .describe("GraphQL request definition. Mutually exclusive with `body`."),
    timeoutMs: z
      .number()
      .positive()
      .default(30000)
      .describe("Request timeout in milliseconds. Defaults to 30000."),
  })
  .superRefine((request, ctx) => {
    if (request.body !== undefined && request.graphql !== undefined) {
      ctx.addIssue({
        // zod 4 では ZodIssueCode は非推奨(生の文字列リテラルを使う)
        code: "custom",
        message: "request.body and request.graphql are mutually exclusive",
        path: ["graphql"],
      });
    }
    if (request.method === undefined && request.graphql === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "request.method is required unless request.graphql is set",
        path: ["method"],
      });
    }
  });
export type RequestDef = z.infer<typeof requestSchema>;

/** SSE 受信オプション */
export const sseOptionsSchema = z.strictObject({
  maxEvents: z
    .number()
    .positive()
    .default(100)
    .describe("Stop receiving after this many SSE events. Defaults to 100."),
  maxDurationMs: z
    .number()
    .positive()
    .default(10000)
    .describe("Stop receiving after this many milliseconds. Defaults to 10000."),
});
export type SseOptions = z.infer<typeof sseOptionsSchema>;

/** WS 接続後に送信する1件。文字列はそのまま送信、object は JSON.stringify して送信する */
export const wsSendItemSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe(
    "A single WS message to send after connecting. Strings are sent as-is; objects are JSON.stringify'd before sending.",
  );
export type WsSendItem = z.infer<typeof wsSendItemSchema>;

/** WebSocket 接続定義。request の代わりにステップへ指定する */
export const wsSchema = z
  .strictObject({
    url: z
      .string()
      .describe("WebSocket URL. Must use the ws:// or wss:// scheme (when not a template)."),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Headers sent with the WS connection handshake. Values are template-expanded."),
    send: z
      .array(wsSendItemSchema)
      .optional()
      .describe("Messages to send right after connecting, in order."),
    maxMessages: z
      .number()
      .positive()
      .default(100)
      .describe("Stop receiving after this many WS messages. Defaults to 100."),
    maxDurationMs: z
      .number()
      .positive()
      .default(10000)
      .describe("Stop receiving after this many milliseconds. Defaults to 10000."),
  })
  .superRefine((ws, ctx) => {
    // url はテンプレート可のため、リテラルに http(s):// で始まる場合のみ静的に弾く
    // (テンプレート変数を含む URL は実行時まで実際のスキームがわからない)
    if (/^https?:\/\//i.test(ws.url)) {
      ctx.addIssue({
        code: "custom",
        message: `ws.url must use the ws:// or wss:// scheme (got "${ws.url}")`,
        path: ["url"],
      });
    }
  });
export type WsDef = z.infer<typeof wsSchema>;

/**
 * ステップ単位のリトライ設定。assert 失敗(failed)・例外(error)の両方をトリガーとし、
 * passed になった時点でループを止める。バックオフや条件式は持たず、固定間隔のみ。
 */
export const retrySchema = z.strictObject({
  count: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe(
      "Number of retries after the first attempt (Hurl semantics: max count+1 total executions). Integer between 1 and 100.",
    ),
  intervalMs: z
    .number()
    .int()
    .min(0)
    .max(600000)
    .default(1000)
    .describe("Fixed wait between attempts in milliseconds. Defaults to 1000."),
});
export type RetryDef = z.infer<typeof retrySchema>;

/**
 * ステップ定義。request / ws / use のいずれか一方を必ず指定する(use は request/ws/sse と排他)。
 * use を指定した場合、実際の request/sse は loader.ts のロード時に参照先ファイルから取り込まれる
 * (materialize)ため、スキーマとしては request/ws を要求しない(ロード経路を持たない
 * validateFlowYaml から見ると、use ステップは request 無しでも valid になる)。
 */
export const stepSchema = z
  .strictObject({
    name: z.string().min(1).describe("Step name. Must be non-empty and unique within the flow."),
    request: requestSchema
      .optional()
      .describe("HTTP request definition. Exactly one of `request`, `ws`, or `use` must be set."),
    ws: wsSchema
      .optional()
      .describe(
        "WebSocket connection definition. Exactly one of `request`, `ws`, or `use` must be set.",
      ),
    sse: sseOptionsSchema
      .optional()
      .describe(
        "If set, treat the response as a Server-Sent Events stream and collect events using these options.",
      ),
    use: z
      .string()
      .optional()
      .describe(
        "Path (relative to this flow file) to a single-step flow file to reuse as this step's " +
          "request/sse/assert. Mutually exclusive with `request`, `ws`, and `sse`. `name` and `capture` " +
          "always come from this step; `assert` (if set here) is merged additively with the referenced " +
          "step's assert.",
      ),
    capture: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Map of variable name to JSONPath expression, extracted from the step's response body and made available as `{{name}}` in later steps.",
      ),
    assert: assertSchema.optional().describe("Assertions to evaluate against the step's result."),
    retry: retrySchema
      .optional()
      .describe(
        "Retry the whole step (request/ws/sse) when its outcome is `failed` (assertion failure) or `error` (thrown exception). Only the final attempt is recorded in results/history.",
      ),
  })
  .superRefine((step, ctx) => {
    if (step.request !== undefined && step.ws !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "step.request and step.ws are mutually exclusive",
        path: ["ws"],
      });
    }
    if (step.use !== undefined) {
      if (step.request !== undefined || step.ws !== undefined || step.sse !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "step.use is mutually exclusive with request/ws/sse",
          path: ["use"],
        });
      }
    } else if (step.request === undefined && step.ws === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "either step.request or step.ws is required",
        path: ["request"],
      });
    }
  });
export type Step = z.infer<typeof stepSchema>;

/** フロー定義(YAML 1ファイル分) */
export const flowSchema = z
  .strictObject({
    name: z.string().min(1).describe("Flow name. Must be non-empty."),
    env: z
      .string()
      .optional()
      .describe("Name of an environment file (environments/<env>.yaml) to load variables from."),
    steps: z
      .array(stepSchema)
      .min(1)
      .describe("Ordered list of steps to execute. Must contain at least one step."),
  })
  .superRefine((flow, ctx) => {
    // ステップ名はフロー内で一意でなければならない
    const seen = new Set<string>();
    flow.steps.forEach((step, index) => {
      if (seen.has(step.name)) {
        ctx.addIssue({
          // zod 4 では ZodIssueCode は非推奨(生の文字列リテラルを使う)
          code: "custom",
          message: `step name "${step.name}" is duplicated within the flow`,
          path: ["steps", index, "name"],
        });
      }
      seen.add(step.name);
    });
  });
export type Flow = z.infer<typeof flowSchema>;

/**
 * 環境ファイル(environments/<name>.yaml)。値はテンプレート可の文字列。
 * `$protected` は予約キーで、true の場合はこの環境への run をデフォルトで拒否する
 * (--allow-protected を明示した場合のみ実行可能。src/core/runner.ts 参照)。
 * テンプレート変数展開の対象からは除外する(src/core/env.ts の toTemplateVariables)。
 */
export const environmentSchema = z
  .object({
    $protected: z
      .boolean()
      .optional()
      .describe(
        "Reserved key. When true, running against this environment is refused unless --allow-protected is passed.",
      ),
  })
  .catchall(z.string())
  .describe(
    "Environment variables map (variable name to string value). Values may themselves be templates. " +
      "The reserved key $protected (boolean) marks the environment as protected.",
  );
export type Environment = z.infer<typeof environmentSchema>;

/**
 * klaus.config.yaml(CLI オプションの既定値ファイル)のスキーマ。
 * `run` / `ui` サブコマンドのオプションのうち、既定値として設定してよいものだけを列挙する。
 * 意図的に含めないオプション:
 * - `--allow-protected`(config で既定 true にするとガードレールが形骸化するため)
 * - `--record` / `--replay`(実行モードは呼び出しごとに明示させる)
 * - `--json` / `--text`(出力モードも呼び出しごとに明示させる)
 * 除外理由の詳細は docs/guide/config.md を参照。
 */
export const configSchema = z.strictObject({
  run: z
    .strictObject({
      env: z.string().optional().describe("Default value for `klaus run --env <name>`."),
      report: z
        .literal("junit")
        .optional()
        .describe('Default value for `klaus run --report <type>`. Only "junit" is supported.'),
      reportFile: z
        .string()
        .optional()
        .describe("Default value for `klaus run --report-file <path>`."),
      history: z
        .boolean()
        .optional()
        .describe(
          "Default for whether execution history is written. Equivalent to omitting --no-history (true) or passing it (false).",
        ),
      mask: z
        .boolean()
        .optional()
        .describe(
          "Default for whether secret masking is applied to stdout. Equivalent to omitting --no-mask (true) or passing it (false).",
        ),
    })
    .optional()
    .describe("Default values for `klaus run` options."),
  ui: z
    .strictObject({
      port: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .optional()
        .describe("Default value for `klaus ui --port <n>`."),
      host: z.string().optional().describe("Default value for `klaus ui --host <host>`."),
      open: z
        .boolean()
        .optional()
        .describe(
          "Default for whether a browser is opened automatically. Equivalent to omitting --no-open (true) or passing it (false).",
        ),
    })
    .optional()
    .describe("Default values for `klaus ui` options."),
});
export type CliConfig = z.infer<typeof configSchema>;
