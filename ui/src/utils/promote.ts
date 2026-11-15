import type { PromoteAssertMode, PromoteRedaction, PromoteRequestBody } from "@/api/types";
import type { HistoryRunGroup } from "./history";

/** 「フローとして保存」ダイアログの入力値(未入力は空文字) */
export interface PromoteForm {
  assert: PromoteAssertMode;
  /** URL の origin を {{name}} に置き換える変数名 */
  baseUrlVar: string;
  /** 先行ステップのレスポンス値を後続で再利用する capture を推論するか */
  chain: boolean;
  /** 生成するフロー名(空ならサーバーが決める) */
  name: string;
  /** 保存先(空ならサーバーの提案パス) */
  out: string;
  /** run が複数フローを含む場合に対象を絞るフロー名 */
  flow: string;
}

export const DEFAULT_PROMOTE_FORM: PromoteForm = {
  assert: "schema",
  baseUrlVar: "",
  chain: true,
  name: "",
  out: "",
  flow: "",
};

export const ASSERT_OPTIONS: ReadonlyArray<{
  value: PromoteAssertMode;
  label: string;
  description: string;
}> = [
  { value: "status", label: "status", description: "ステータスコードだけを検証します" },
  {
    value: "schema",
    label: "schema(既定)",
    description: "ステータス、content-type、レスポンスの型と必須キーを検証します",
  },
  {
    value: "values",
    label: "values",
    description: "ステータス、content-type、安定していそうな値の一致を検証します",
  },
  { value: "all", label: "all", description: "上記すべてを検証します" },
];

const TEMPLATE_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** ベース URL 変数名の入力を検証する。問題なければ null、あれば表示するメッセージ(空は未指定として有効) */
export function validateBaseUrlVar(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || TEMPLATE_VARIABLE_NAME.test(trimmed)) return null;
  return "英数字とアンダースコアのみ使えます(先頭は数字不可)";
}

/** フォームの入力から API のリクエストボディを組み立てる(空の項目は送らない) */
export function buildPromoteBody(
  runIds: readonly string[],
  form: PromoteForm,
  dryRun: boolean,
): PromoteRequestBody {
  const baseUrlVar = form.baseUrlVar.trim();
  const name = form.name.trim();
  const out = form.out.trim();
  const flow = form.flow.trim();
  return {
    runIds: [...runIds],
    assert: form.assert,
    chain: form.chain,
    ...(flow !== "" ? { flow } : {}),
    ...(baseUrlVar !== "" ? { baseUrlVar } : {}),
    ...(name !== "" ? { name } : {}),
    ...(out !== "" ? { out } : {}),
    dryRun,
  };
}

/** 選択した run を、重複を除いて実行順(古い順)の runId 列にする(フローのステップ順になる) */
export function orderedRunIds(groups: readonly HistoryRunGroup[]): string[] {
  const sorted = [...groups].sort((x, y) => x.startedAt.localeCompare(y.startedAt));
  return [...new Set(sorted.map((group) => group.runId))];
}

/** 選択した run が含むフロー名(履歴の記録名)を重複なく返す。単発リクエストは含めない */
export function distinctFlowNames(groups: readonly HistoryRunGroup[]): string[] {
  const names = new Set<string>();
  for (const group of groups) {
    for (const step of group.steps) if (step.flow !== "(single)") names.add(step.flow);
  }
  return [...names];
}

export interface PromoteErrorExplanation {
  title: string;
  detail: string;
  /** 次に何をすればよいか(任意) */
  hint?: string;
  /** 入力欄に結び付けて表示すべき項目 */
  field?: "out";
}

/** サーバー応答の "Forbidden: " 接頭辞を取り除く */
function stripForbidden(message: string): string {
  return message.replace(/^Forbidden:\s*/, "");
}

/**
 * フロー保存 API の拒否・失敗を、利用者向けの説明に変換する。
 * 汎用エラーではなく「何が起きたか・なぜか・どうすればよいか」を示すためのもの(422 の拒否理由が中心)。
 */
export function explainPromoteError(
  status: number | undefined,
  message: string,
  code?: string,
): PromoteErrorExplanation {
  if (status === 422 && code === "template-literal") {
    return {
      title: "記録された値に「{{」が含まれているため、フローにできません",
      detail: message,
      hint: "klaus は「{{」をテンプレートとして展開します。このまま保存すると、フローの実行時に OS 環境変数({{env.X}} など)が送信先へ送られるおそれがあるため、UI では生成を拒否しています。該当する値を取り除いたリクエストを実行し直してから保存してください。",
    };
  }
  if (status === 422 && message.includes("no promotable steps")) {
    return {
      title: "フローにできるステップがありません",
      detail: message,
      hint: "スキップされたステップだけの run は保存できません。実行されたステップを含む run を選んでください。",
    };
  }
  if (status === 422) {
    return {
      title: "この run はフローとして保存できません",
      detail: message,
      hint: "履歴の内容に起因する拒否です。別の run を選ぶか、内容を確認してください。",
    };
  }
  if (status === 409) {
    return {
      title: "同じ場所に既にファイルがあります",
      detail: message,
      hint: "既存のフローは UI から上書きできません。保存先かフロー名を変えてください。",
      field: "out",
    };
  }
  if (status === 403) {
    return {
      title: "この保存先は使えません",
      detail: stripForbidden(message),
      hint: "保存先はカレントディレクトリ内の .yaml / .yml ファイルで、フロー探索の対象になる場所に限られます。",
      field: "out",
    };
  }
  if (status === 404) {
    return {
      title: "履歴に該当する run が見つかりません",
      detail: message,
      hint: "履歴を読み込み直してから、もう一度選んでください。",
    };
  }
  if (status === 400) {
    return { title: "入力を確認してください", detail: message };
  }
  return { title: "フローを生成できませんでした", detail: message };
}

/** 秘密情報らしい値を置き換えた理由の表示名 */
export function describeRedactionReason(reason: PromoteRedaction["reason"]): string {
  return reason === "sensitive key" ? "秘密情報を示すキー" : "トークンのような値";
}
