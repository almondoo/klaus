import { errorCodeOf, explainError } from "@/utils/errorExplain";

export interface ErrorExplanationProps {
  /** エンジンの原文メッセージ(英語) */
  message: string;
  /** errorCode を持つステップ結果・履歴エントリ(型に errorCode が無くても防御的に読む) */
  source: unknown;
}

/**
 * エラーステップのメッセージ表示。errorCode が既知なら日本語の説明(何が起きたか・対処)を主表示にし、
 * 原文は「詳細」として下に添える。未知・未指定なら従来どおり原文のみを表示する。
 */
export function ErrorExplanation({ message, source }: ErrorExplanationProps) {
  const explained = explainError(errorCodeOf(source));
  if (!explained) return <p className="text-sm text-fail">{message}</p>;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="error-explanation">
      <p className="font-semibold text-fail">{explained.title}</p>
      <p>{explained.hint}</p>
      <p className="font-mono text-xs break-all text-muted-foreground">
        <span className="font-sans font-semibold">詳細: </span>
        {message}
      </p>
    </div>
  );
}
