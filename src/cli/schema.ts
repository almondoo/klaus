/**
 * `klaus schema` サブコマンドの実装。
 * flowSchema(src/core/schema.ts)/ jsonReportSchema(src/cli/reporters/json.ts)から
 * JSON Schema を生成し、stdout に書き出すだけ。ファイル書き出しは行わない
 * (npm パッケージ同梱物の書き出しは schema-gen.ts が別途行う)。
 */
import { z } from "zod";
import { configSchema, flowSchema } from "../core/index.js";
import { jsonReportSchema } from "./reporters/json.js";

/**
 * superRefine による制約(JSON Schema には変換されない)の注記先。
 * flowSchema(src/core/schema.ts)の構造にそのまま対応させているため、schema.ts の形を変えた場合は
 * ここも合わせて見直すこと。存在しないパスは静かに無視する(生成自体は失敗させない)。
 */
const CONSTRAINT_ANNOTATIONS: ReadonlyArray<{ path: readonly string[]; note: string }> = [
  {
    // flowSchema: ステップ名はフロー内で一意である必要がある
    path: ["properties", "steps"],
    note: "Step `name` values must be unique within a flow.",
  },
  {
    // stepSchema: request / ws / use のいずれか一つを必ず指定する(sse は request に付随する修飾子)
    path: ["properties", "steps", "items"],
    note: "Exactly one of `request`, `ws`, or `use` must be set. `sse` is a modifier that attaches to a `request` step.",
  },
  {
    // requestSchema: body / graphql は排他。graphql 指定時のみ method 省略可
    path: ["properties", "steps", "items", "properties", "request"],
    note: "`body` and `graphql` are mutually exclusive. `method` is required unless `graphql` is set.",
  },
  {
    // wsSchema: url は ws:// または wss:// スキームのみ許可(リテラルの場合のみ静的に判定)
    path: ["properties", "steps", "items", "properties", "ws", "properties", "url"],
    note: "Must use the ws:// or wss:// scheme when the value is a literal URL (not a template).",
  },
];

/** obj を path に沿って辿り、object であればそれを返す(途中で欠けていれば undefined) */
function getObjectAt(obj: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  let current: unknown = obj;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "object" && current !== null
    ? (current as Record<string, unknown>)
    : undefined;
}

/** 既存の description があれば note を追記し、なければ note をそのまま description にする */
function appendDescription(target: Record<string, unknown>, note: string): void {
  const existing = target.description;
  target.description =
    typeof existing === "string" && existing.length > 0 ? `${existing} ${note}` : note;
}

/**
 * flowSchema の JSON Schema 表現を生成し、superRefine 由来の制約を description として注記する。
 * method は大文字化する transform を持つため、そのままでは "Transforms cannot be represented in
 * JSON Schema" で失敗する。io: "input" を指定し、transform 適用前(入力側)の型で表現する。
 */
export function buildFlowJsonSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(flowSchema, { io: "input" }) as Record<string, unknown>;
  for (const { path, note } of CONSTRAINT_ANNOTATIONS) {
    const target = getObjectAt(json, path);
    if (target) appendDescription(target, note);
  }
  return json;
}

/**
 * jsonReportSchema(`run --json` の出力形, src/cli/reporters/json.ts)の JSON Schema 表現を生成する。
 * transform を含まないため flow 側と異なり io オプションは不要。
 */
export function buildRunReportJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(jsonReportSchema) as Record<string, unknown>;
}

/**
 * configSchema(klaus.config.yaml, src/core/schema.ts)の JSON Schema 表現を生成する。
 * transform を含まないため flow 側と異なり io オプションは不要。
 */
export function buildConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(configSchema) as Record<string, unknown>;
}

/**
 * `klaus schema` が出力する対象。
 * "flow": フロー定義 YAML のスキーマ(既定)。"run-report": `klaus run --json` 出力のスキーマ。
 * "config": klaus.config.yaml(CLI オプションの既定値ファイル)のスキーマ。
 */
export type SchemaTarget = "flow" | "run-report" | "config";

/** schema コマンド本体。JSON Schema を stdout に書き出すだけ。常に exit 0 */
export async function schemaCommand(target: SchemaTarget = "flow"): Promise<number> {
  const json =
    target === "run-report"
      ? buildRunReportJsonSchema()
      : target === "config"
        ? buildConfigJsonSchema()
        : buildFlowJsonSchema();
  process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  return 0;
}
