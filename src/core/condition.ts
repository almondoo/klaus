/**
 * 将来の `if:` ステップフィールド用の条件式パーサー / 評価器。
 *
 * 文法(空白は寛容に扱う):
 *   condition := ref op literal
 *   ref       := "steps." stepName ".status" | "captures." captureName
 *   op        := "==" | "!="
 *   literal   := ダブルクォート文字列 | シングルクォート文字列 | 空白を含まないベアトークン
 *
 * 設計判断(意図的に小さい文法に留める。式ライブラリは使わない):
 * - stepName / captureName は "." と空白を含めない。ネストした capture 名や
 *   ドット区切りの深い参照が将来必要になった場合は別途拡張する(この段階では対象外)。
 * - クォート文字列はエスケープシーケンスをサポートしない。クォート文字自体を値に
 *   含めたい場合は反対側のクォート種別を使うこと(例: 二重引用符を含めたいなら
 *   シングルクォートで囲む)。
 * - 比較は常に文字列として行う。capture 側の値のみ String() で強制変換してから
 *   比較する(steps.*.status は元々 string のため変換は事実上の no-op)。
 */

import { RuntimeError } from "./errors.js";

/** 条件式の評価に必要なコンテキスト */
export interface ConditionContext {
  /** これまでのステップの実行結果ステータス(ステップ名 → status 文字列) */
  stepStatuses: ReadonlyMap<string, string>;
  /** これまでのステップで capture した変数 */
  captures: Readonly<Record<string, unknown>>;
}

// グループ番号: 1=stepName, 2=captureName, 3=op, 4=literal(クォート込み)
// ref 側の alternation(steps.../captures...)はどちらか一方だけがマッチするため、
// 名前付きキャプチャではなく番号付きキャプチャで受け取り、undefined 判定で分岐する。
const CONDITION_PATTERN =
  /^\s*(?:steps\.([^\s.]+)\.status|captures\.([^\s.]+))\s*(==|!=)\s*("[^"]*"|'[^']*'|\S+)\s*$/;

const GRAMMAR_HINT =
  'expected "ref op literal", e.g. steps.<name>.status == "ok" or captures.<name> != value';

/**
 * 条件式を評価する。
 *
 * - `steps.<name>.status` は未知のステップ名なら RuntimeError(利用可能なステップ名一覧つき)。
 * - `captures.<name>` は未知の capture 名なら RuntimeError(利用可能な capture 名一覧つき。値は含めない)。
 * - 文法に合わない式(演算子なし・不正な ref プレフィックス・リテラル欠落・末尾のごみ・空文字列など)は
 *   RuntimeError(式そのものと文法ヒントつき)。
 */
export function evaluateCondition(expression: string, context: ConditionContext): boolean {
  const match = CONDITION_PATTERN.exec(expression);
  if (!match) {
    throw new RuntimeError(`invalid condition expression: "${expression}" (${GRAMMAR_HINT})`);
  }

  const [, stepName, captureName, op, rawLiteral] = match;

  const actual =
    stepName !== undefined
      ? resolveStepStatus(stepName, context)
      : resolveCapture(captureName as string, context);

  // rawLiteral は上記正規表現で必ずマッチするグループのため undefined にはならない
  const expected = unquoteLiteral(rawLiteral as string);
  const equal = String(actual) === expected;
  return op === "==" ? equal : !equal;
}

/** steps.<name>.status を解決する。未知のステップ名は RuntimeError */
function resolveStepStatus(stepName: string, context: ConditionContext): string {
  const status = context.stepStatuses.get(stepName);
  if (status === undefined) {
    throw new RuntimeError(
      `unknown step "${stepName}" in condition (available steps: ${formatNames([...context.stepStatuses.keys()])})`,
    );
  }
  return status;
}

/** captures.<name> を解決する。未知の capture 名は RuntimeError(値は列挙しない) */
function resolveCapture(captureName: string, context: ConditionContext): unknown {
  if (!Object.hasOwn(context.captures, captureName)) {
    throw new RuntimeError(
      `unknown capture "${captureName}" in condition (available captures: ${formatNames(Object.keys(context.captures))})`,
    );
  }
  return context.captures[captureName];
}

/** エラーメッセージ用に名前一覧を整形する。空なら "none" とする(値そのものは含めない) */
function formatNames(names: readonly string[]): string {
  return names.length > 0 ? names.join(", ") : "none";
}

/** クォート付きリテラルの引用符を取り除く。ベアトークンはそのまま返す(エスケープなし) */
function unquoteLiteral(literal: string): string {
  const first = literal[0];
  const last = literal[literal.length - 1];
  if (literal.length >= 2 && first === last && (first === '"' || first === "'")) {
    return literal.slice(1, -1);
  }
  return literal;
}
