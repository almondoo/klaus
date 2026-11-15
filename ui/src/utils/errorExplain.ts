/** エラーコードに対応する日本語の説明(title = 何が起きたか / hint = ユーザーが取れる対処) */
export interface ErrorExplanation {
  title: string;
  hint: string;
}

const EXPLANATIONS: Record<string, ErrorExplanation> = {
  "guard.allowed-hosts": {
    title: "このホストは送信先として許可されていません。リクエストは送信されていません。",
    hint: "klaus.config.yaml の guard.allowedHosts にこのホストを追加するか、URL を許可済みのホストに変更してください。",
  },
  "guard.protected": {
    title: "この環境は保護されている($protected: true)ため、実行が拒否されました。",
    hint: "klaus ui からは保護を解除できません。CLI から klaus run --allow-protected を付けて実行してください。",
  },
  "guard.readonly": {
    title:
      "この環境は読み取り専用($protected: readonly)のため、GET / HEAD / OPTIONS 以外は送信されません。",
    hint: "読み取り系のメソッドに変更するか、別の環境で実行してください。",
  },
  "guard.method-override": {
    title: "読み取り専用の環境では、メソッド上書きヘッダーが付いたリクエストは拒否されます。",
    hint: "X-HTTP-Method-Override などのメソッド上書きヘッダーを外してください。",
  },
  "guard.host-header": {
    title:
      "Host ヘッダーがリクエスト URL と異なるか、使用できない文字が含まれているため拒否されました。",
    hint: "Host ヘッダーを削除するか、URL のホストと同じ値にしてください。",
  },
  "guard.proxy-header": {
    title: "プロキシを設定している間は使用できないヘッダーが含まれているため拒否されました。",
    hint: "該当のヘッダーを外すか、プロキシ設定を見直してください。",
  },
  "guard.path": {
    title:
      "送信しようとしたファイル(body ファイル・multipart のファイル)またはスナップショットのパスがプロジェクトのディレクトリの外にあるため、拒否されました。",
    hint: "ファイルをプロジェクトのディレクトリ内に移し、パスをその中を指すよう修正してください。",
  },
  "guard.redirect": {
    title: "リダイレクト先が安全柵に拒否されました。",
    hint: "リダイレクト先のホストや環境の保護設定を確認してください。必要なら guard.allowedHosts に追加します。",
  },
  "response-too-large": {
    title: "レスポンスが大きすぎるため、受信を打ち切りました。",
    hint: "http.maxResponseBytes の上限を引き上げるか、取得するデータ量を絞ってください。",
  },
};

/** エラーコードを日本語の説明に変換する。未指定・未知のコードは null(説明なし) */
export function explainError(code: string | undefined | null): ErrorExplanation | null {
  if (typeof code !== "string") return null;
  return Object.hasOwn(EXPLANATIONS, code) ? (EXPLANATIONS[code] as ErrorExplanation) : null;
}

/**
 * ステップ結果・履歴エントリから errorCode を防御的に読む。
 * core の型に errorCode が無い版でも型エラーにならないよう、unknown 経由で文字列のときだけ返す。
 */
export function errorCodeOf(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const code = (source as { errorCode?: unknown }).errorCode;
  return typeof code === "string" ? code : undefined;
}
