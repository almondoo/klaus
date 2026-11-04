/**
 * GET /api/flows・GET /api/flows/detail が使う共通ロジック。
 * core を再利用してパース・検証を行うだけで、実行・アサーションロジックは持たない。
 */
import {
  discoverFlowCandidatesWithRaw,
  flowSchema,
  formatSchemaValidationMessage,
  resolveRequestMethod,
  toDisplayPath,
} from "../../core/index.js";
import type { Step } from "../../core/schema.js";
import type { FlowListEntry } from "../types.js";

/**
 * cwd 以下のフロー候補 YAML(最上位に `steps` キーを持つもの)を走査し、パース結果を一覧化する。
 * 成功時は name/stepCount、失敗時はパースエラー理由(error)を返す。
 * YAML 構文自体が壊れていて top-level のキーを判定できないファイルは、フロー候補として扱わずスキップする。
 */
export async function listFlows(cwd: string): Promise<FlowListEntry[]> {
  // 候補の探索・YAML パース・候補判定は core の discoverFlowCandidatesWithRaw と共有する
  // (並び順は入力順を保つが、最終的な表示順は下の sort で決まる)
  const candidates = await discoverFlowCandidatesWithRaw(cwd);

  const results = candidates.map(({ filePath, raw }): FlowListEntry => {
    const relPath = toDisplayPath(cwd, filePath);
    // parseFlowYaml と同じスキーマ(flowSchema)で検証するが、YAML パース結果(raw)は
    // 候補判定用に取得済みのものを再利用し、二重パースを避ける
    const parsed = flowSchema.safeParse(raw);
    if (parsed.success) {
      const flow = parsed.data;
      return { path: relPath, name: flow.name, stepCount: flow.steps.length };
    }
    // parseFlowYaml(core/loader.ts の toParseError)と同じ整形関数でメッセージを作る
    return { path: relPath, error: formatSchemaValidationMessage(parsed.error) };
  });

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * FlowDetail.steps の1件分を作る(UI 契約(ui/src/api/types.ts)は method/url を必須の string としているため、
 * ws ステップ(HTTP メソッドを持たない)・graphql ステップ(method 省略可)もここで文字列に丸める)。
 * - request ステップ: method はそのまま(graphql で省略された場合は実行時と同じ既定値 "POST" を補う)
 * - ws ステップ: method は固定文字列 "WS"、url は ws.url
 */
export function summarizeStep(step: Step): { name: string; method: string; url: string } {
  if (step.request) {
    // method 省略時(graphql)の既定値は core/runner.ts の実行時ロジックと共有する
    return { name: step.name, method: resolveRequestMethod(step.request), url: step.request.url };
  }
  return { name: step.name, method: "WS", url: step.ws?.url ?? "" };
}
