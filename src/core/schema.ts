import { z } from "zod";

/**
 * フロー定義 YAML / 環境ファイル YAML の zod スキーマ。
 * ここでの型が loader.ts のパース結果の型になり、runner.ts 以降で使われる。
 */

/** ヘッダーアサーション(1件) */
export const headerAssertionSchema = z.object({
  name: z.string(),
  equals: z.string().optional(),
  contains: z.string().optional(),
  regex: z.string().optional(),
  exists: z.boolean().optional(),
});
export type HeaderAssertion = z.infer<typeof headerAssertionSchema>;

/** body(JSON)に対する jsonpath ベースのアサーション(1件) */
export const bodyAssertionSchema = z.object({
  path: z.string(),
  exists: z.boolean().optional(),
  equals: z.unknown().optional(),
  contains: z.string().optional(),
  regex: z.string().optional(),
});
export type BodyAssertion = z.infer<typeof bodyAssertionSchema>;

/** 生テキストに対するアサーション */
export const bodyTextAssertionSchema = z.object({
  equals: z.string().optional(),
  contains: z.string().optional(),
  regex: z.string().optional(),
});
export type BodyTextAssertion = z.infer<typeof bodyTextAssertionSchema>;

/** 所要時間に対するアサーション */
export const durationAssertionSchema = z.object({
  maxMs: z.number(),
});
export type DurationAssertion = z.infer<typeof durationAssertionSchema>;

/** SSE 受信イベント数に対するアサーション */
export const eventCountAssertionSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  equals: z.number().optional(),
});
export type EventCountAssertion = z.infer<typeof eventCountAssertionSchema>;

/** SSE 個別イベントに対するアサーション(1件) */
export const eventAssertionSchema = z.object({
  index: z.number().optional(),
  path: z.string().optional(),
  exists: z.boolean().optional(),
  equals: z.unknown().optional(),
  contains: z.string().optional(),
  regex: z.string().optional(),
});
export type EventAssertion = z.infer<typeof eventAssertionSchema>;

/** WS 受信メッセージ数に対するアサーション。セマンティクスは eventCount と同一 */
export const messageCountAssertionSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  equals: z.number().optional(),
});
export type MessageCountAssertion = z.infer<typeof messageCountAssertionSchema>;

/** WS 個別メッセージに対するアサーション(1件)。セマンティクスは events と同一 */
export const messageAssertionSchema = z.object({
  index: z.number().optional(),
  path: z.string().optional(),
  exists: z.boolean().optional(),
  equals: z.unknown().optional(),
  contains: z.string().optional(),
  regex: z.string().optional(),
});
export type MessageAssertion = z.infer<typeof messageAssertionSchema>;

/** ステップのアサーション定義全体 */
export const assertSchema = z.object({
  status: z.number().optional(),
  headers: z.array(headerAssertionSchema).optional(),
  body: z.array(bodyAssertionSchema).optional(),
  bodyText: bodyTextAssertionSchema.optional(),
  duration: durationAssertionSchema.optional(),
  eventCount: eventCountAssertionSchema.optional(),
  events: z.array(eventAssertionSchema).optional(),
  messageCount: messageCountAssertionSchema.optional(),
  messages: z.array(messageAssertionSchema).optional(),
});
export type AssertDef = z.infer<typeof assertSchema>;

/** GraphQL リクエスト定義。query / variables の文字列値はテンプレート展開対象 */
export const graphqlRequestSchema = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()).optional(),
});
export type GraphqlRequestDef = z.infer<typeof graphqlRequestSchema>;

/**
 * リクエスト定義。method は大文字化して保持する。
 * graphql 指定時のみ method 省略可(実行時に POST が既定値になる。schema 側ではデフォルト値を入れず、
 * runner.ts の実行時解決に委ねる)。body と graphql は排他。
 */
export const requestSchema = z
  .object({
    method: z
      .string()
      .transform((value) => value.toUpperCase())
      .optional(),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    graphql: graphqlRequestSchema.optional(),
    timeoutMs: z.number().positive().default(30000),
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
export const sseOptionsSchema = z.object({
  maxEvents: z.number().positive().default(100),
  maxDurationMs: z.number().positive().default(10000),
});
export type SseOptions = z.infer<typeof sseOptionsSchema>;

/** WS 接続後に送信する1件。文字列はそのまま送信、object は JSON.stringify して送信する */
export const wsSendItemSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
export type WsSendItem = z.infer<typeof wsSendItemSchema>;

/** WebSocket 接続定義。request の代わりにステップへ指定する */
export const wsSchema = z
  .object({
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    send: z.array(wsSendItemSchema).optional(),
    maxMessages: z.number().positive().default(100),
    maxDurationMs: z.number().positive().default(10000),
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

/** ステップ定義。request / ws のいずれか一方を必ず指定する */
export const stepSchema = z
  .object({
    name: z.string().min(1),
    request: requestSchema.optional(),
    ws: wsSchema.optional(),
    sse: sseOptionsSchema.optional(),
    capture: z.record(z.string(), z.string()).optional(),
    assert: assertSchema.optional(),
  })
  .superRefine((step, ctx) => {
    if (step.request !== undefined && step.ws !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "step.request and step.ws are mutually exclusive",
        path: ["ws"],
      });
    }
    if (step.request === undefined && step.ws === undefined) {
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
  .object({
    name: z.string().min(1),
    env: z.string().optional(),
    steps: z.array(stepSchema).min(1),
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

/** 環境ファイル(environments/<name>.yaml)。値はテンプレート可の文字列 */
export const environmentSchema = z.record(z.string(), z.string());
export type Environment = z.infer<typeof environmentSchema>;
