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
  /** パース対象のファイルパス(判明していれば) */
  readonly filePath?: string;

  constructor(message: string, filePath?: string) {
    super(filePath ? `${filePath}: ${message}` : message);
    this.name = "ParseError";
    this.filePath = filePath;
  }
}

export class RuntimeError extends KlausError {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}
