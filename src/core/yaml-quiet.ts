import { parseDocument } from "yaml";

/**
 * YAML 文字列をパースして JS の値にする(`yaml` の parse() と同じ結果)。
 * parse() は警告(未知のタグなど)を process.emitWarning で出すが、その文面にはソースの行が含まれる。
 * 読み込み元がユーザーの管理下にないファイル(OpenAPI の $ref 先など)だと、その内容が stderr に漏れるため、
 * 警告は出さず、構文エラーだけを最初の 1 件として投げる。
 */
export function parseYamlQuietly(text: string, options: { merge?: boolean } = {}): unknown {
  const document = parseDocument(text, { logLevel: "silent", ...options });
  const [first] = document.errors;
  if (first) throw first;
  return document.toJS();
}
