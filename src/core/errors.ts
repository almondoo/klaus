/**
 * klaus core 共通のエラー型。
 * exit code との対応は CLI 側(第2段)で行うが、ここでは種別だけを表現する。
 * - ParseError: フロー定義 / 環境ファイルのパース・検証失敗(CLI では exit 2 相当)
 * - RuntimeError: 接続不能・タイムアウト・変数未解決などの実行時エラー(CLI では exit 3 相当)
 * - アサーション失敗は例外にせず、StepResult.assertions の中で表現する
 */
export class KlausError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KlausError";
  }
}

export class ParseError extends KlausError {
  /** パース対象のファイルパス(判明していれば)。コンストラクタ引数をそのまま代入するため undefined も許容する */
  readonly filePath?: string | undefined;

  constructor(message: string, filePath?: string) {
    super(filePath ? `${filePath}: ${message}` : message);
    this.name = "ParseError";
    this.filePath = filePath;
  }
}

/**
 * ステップを error にした原因を機械的に識別するための安定したコード(StepResult.errorCode / 履歴の errorCode)。
 * メッセージ(英語の自由文)の文字列照合に頼らず、エラーを作る箇所で付ける。値は公開契約なので変更しない。
 * - guard.allowed-hosts: 送信先ホストが guard.allowedHosts に無い(URL を解釈できず fail closed にした場合を含む)
 * - guard.protected: 環境の $protected: true による実行の拒否
 * - guard.readonly: $protected: readonly で GET / HEAD / OPTIONS 以外を拒否
 * - guard.method-override: $protected: readonly でメソッド上書きヘッダーを拒否
 * - guard.host-header: Host ヘッダーが URL と食い違う、または書式が不正
 * - guard.proxy-header: proxy 利用時にホップ間ヘッダー等の禁止ヘッダーを拒否
 * - guard.path: cwd の外を指すファイル(送信ファイル・スナップショット)を拒否
 * - guard.redirect: リダイレクトのホップを拒否(そのホップの拒否が上のいずれかのコードを持つ場合は、
 *   より具体的な元のコードを残す。コードを持たない拒否のときだけこの値になる)
 * - response-too-large: http.maxResponseBytes を超えた
 * それ以外のエラーには付けない(包括的なコードは作らない)。
 */
export type ErrorCode =
  | "guard.allowed-hosts"
  | "guard.protected"
  | "guard.readonly"
  | "guard.method-override"
  | "guard.host-header"
  | "guard.proxy-header"
  | "guard.path"
  | "guard.redirect"
  | "response-too-large";

export class RuntimeError extends KlausError {
  /** エラーの原因を識別するコード。該当するコードが無いエラーでは undefined */
  readonly errorCode?: ErrorCode | undefined;

  constructor(message: string, errorCode?: ErrorCode) {
    super(message);
    this.name = "RuntimeError";
    this.errorCode = errorCode;
  }
}

/** 例外から errorCode を取り出す(RuntimeError 以外・コード無しは undefined) */
export function errorCodeOf(error: unknown): ErrorCode | undefined {
  return error instanceof RuntimeError ? error.errorCode : undefined;
}

/**
 * 安全柵(送信先ホストの許可リスト・保護環境)による送信拒否。RuntimeError の一種で、
 * CLI では他の実行時エラーと同じく exit 3 になる。拒否は監査のため、他の実行時エラーと異なり
 * 履歴にも記録する(runner.ts の executeStep が型で判別する)。
 */
export class GuardRefusalError extends RuntimeError {
  constructor(message: string, errorCode?: ErrorCode) {
    super(message, errorCode);
    this.name = "GuardRefusalError";
  }
}
