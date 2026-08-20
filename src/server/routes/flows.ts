/**
 * GET /api/flows・GET /api/flows/detail が使う共通ロジック。
 * core を再利用してパース・検証を行うだけで、実行・アサーションロジックは持たない。
 */
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  collectYamlFiles,
  flowSchema,
  formatZodError,
  isFlowCandidate,
  isPathWithinDir,
  isRealPathWithinDir,
  resolveRequestMethod,
} from "../../core/index.js";
import type { Step } from "../../core/schema.js";
import type { FlowListEntry } from "../types.js";

/**
 * cwd 以下のフロー候補 YAML(最上位に `steps` キーを持つもの)を走査し、パース結果を一覧化する。
 * 成功時は name/stepCount、失敗時はパースエラー理由(error)を返す。
 * YAML 構文自体が壊れていて top-level のキーを判定できないファイルは、フロー候補として扱わずスキップする。
 */
export async function listFlows(cwd: string): Promise<FlowListEntry[]> {
  const files = await collectYamlFiles(cwd);

  // 各ファイルの読み込み・パースは互いに独立しているため Promise.all で並行に行う
  // (core/discovery.ts の discoverFlowCandidates と同じ方針。Promise.all は入力順を保つため、
  // 候補外を取り除いた後もファイル一覧の並び順は維持される。最終的な表示順は下の sort で決まる)
  const entries = await Promise.all(
    files.map(async (filePath): Promise<FlowListEntry | undefined> => {
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        return undefined;
      }

      let raw: unknown;
      try {
        raw = parseYaml(content);
      } catch {
        // YAML 構文エラーで最上位のキーを判定できない場合は候補外とする
        return undefined;
      }

      if (!isFlowCandidate(raw)) return undefined;

      const relPath = relative(cwd, filePath).split(sep).join("/");
      // parseFlowYaml と同じスキーマ(flowSchema)で検証するが、YAML パース結果(raw)は
      // 上で isFlowCandidate 判定用に取得済みのものを再利用し、二重パースを避ける
      const parsed = flowSchema.safeParse(raw);
      if (parsed.success) {
        const flow = parsed.data;
        return { path: relPath, name: flow.name, stepCount: flow.steps.length };
      }
      // parseFlowYaml(core/loader.ts の toParseError)が ZodError から生成するメッセージと同じ形式にする
      const message = `schema validation failed: ${formatZodError(parsed.error)}`;
      return { path: relPath, error: message };
    }),
  );

  const results = entries.filter((entry): entry is FlowListEntry => entry !== undefined);
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

/**
 * 与えられた相対パスを cwd 基準で正規化解決する。
 * 解決結果が cwd の外を指す場合(path traversal・絶対パス注入)は null を返す。
 */
export function resolveWithinCwd(cwd: string, relPath: string): string | null {
  const resolvedPath = resolve(cwd, relPath);
  // 境界判定は core/path-guard.ts の isPathWithinDir に委譲する(env.ts・loader.ts と同じロジックを共有する)。
  // 加えて isRealPathWithinDir でシンボリックリンク解決後の実パスも検証し、cwd 配下に仕込まれた
  // シンボリックリンク経由で境界外を読み出す攻撃を防ぐ
  if (!isPathWithinDir(cwd, resolvedPath) || !isRealPathWithinDir(cwd, resolvedPath)) return null;
  return resolvedPath;
}
