# klaus.config.yaml(CLI オプションの既定値)

`klaus run` / `klaus ui` でよく使うオプションは、`klaus.config.yaml` に既定値として書いておくことで、毎回コマンドライン引数として渡さなくて済む。

## ファイル名と探索規則

ファイル名は `klaus.config.yaml` 固定。cwd から上方探索で解決する(規則は[環境ファイル](flow-definition.md)の探索と同じ)。

- cwd から順に親ディレクトリへ辿り、各ディレクトリ直下の `klaus.config.yaml` の存在を確認する。見つかった時点でそのパスを使う。
- 探索の上限(境界)は「`.git` エントリを含む最初の祖先ディレクトリ(そのディレクトリ自身は含めて調べたうえで打ち切る)」または「ファイルシステムのルート」のいずれか先に到達した方。リポジトリルートを跨いで探索することはない。
- どの祖先ディレクトリにも見つからなかった場合は既定値を使わない(エラーにはならない)。

cwd より上の祖先ディレクトリで見つかった場合は、そのディレクトリとファイルの所有者・パーミッションを検査する(共有ホストで他ユーザーが仕込んだ config を黙って読み込まないようにするため)。所有者が自分以外、または other-writable(誰でも書き換え可能)と判定された場合はエラーで拒否する。cwd 自身に置いた `klaus.config.yaml` はこの検査の対象外。

## 優先順位

**CLI で明示指定したオプション > `klaus.config.yaml` > 組み込みの既定値**

コマンドライン引数で明示的に指定したオプションは常に `klaus.config.yaml` の値より優先される。CLI で指定しなかったオプションにのみ、`klaus.config.yaml` の値が(あれば)適用される。`--no-history` / `--no-mask` / `--no-open` のような否定フラグも同様に扱われる: CLI で明示的に `--no-xxx` を渡した場合はその値が優先され、何も指定しなかった場合にだけ `klaus.config.yaml` の値が効く。

## 設定可能なキー

```yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/klaus-config.schema.json
run:
  env: local
  report: junit
  reportFile: klaus-report.xml
  history: true
  mask: true
ui:
  port: 4884
  host: 127.0.0.1
  open: true
```

| キー | 対応する CLI オプション | 型 |
|---|---|---|
| `run.env` | `klaus run --env <name>` | string |
| `run.report` | `klaus run --report <type>` | `"junit"` |
| `run.reportFile` | `klaus run --report-file <path>` | string |
| `run.history` | `klaus run --no-history`(`false` で無効化に相当) | boolean |
| `run.mask` | `klaus run --no-mask`(`false` で無効化に相当) | boolean |
| `ui.port` | `klaus ui --port <n>` | number(1〜65535) |
| `ui.host` | `klaus ui --host <host>` | string |
| `ui.open` | `klaus ui --no-open`(`false` で無効化に相当) | boolean |

いずれのキーも省略可能。未知のキーを含む場合はスキーマ検証エラーになる([実行結果](#エラー時の扱い)を参照)。

## 意図的に設定不可なキー

以下のオプションは `klaus.config.yaml` では設定できない(スキーマにフィールドがなく、指定すると未知キーとしてエラーになる)。

| オプション | 理由 |
|---|---|
| `--allow-protected` | `$protected: true` の環境への実行を拒否するガードレールを、config で既定 true にすることで形骸化させないため |
| `--record` / `--replay` | record/replay モードは副作用(実際のネットワークアクセスの有無)が大きく変わる実行モードのため、呼び出しごとに明示させる |
| `--json` / `--text` | 出力モードは呼び出し元(人が読むか、エージェントやスクリプトが読むか)に依存するため、コマンドラインで都度明示させる |

## エラー時の扱い

`klaus.config.yaml` が YAML として不正、またはスキーマ違反(未知キーを含む)の場合、`klaus run` / `klaus ui` はファイルパスと理由を stderr に出力して **exit code 2** で終了する(フロー定義・環境ファイルのパースエラーと同じ扱い)。

## JSON Schema

`klaus.config.yaml` のスキーマも JSON Schema として公開している。

- 公開 URL: `https://almondoo.github.io/klaus/schema/klaus-config.schema.json`
- npm パッケージ同梱パス: `node_modules/@almondoo/klaus/dist/schema/klaus-config.schema.json`
- `klaus schema --target config` でも同じ内容を stdout に出力できる([CLI リファレンス](cli.md#klaus-schema)参照)

YAML ファイルの先頭に `# yaml-language-server: $schema=` コメントを書くと、対応エディタ(VS Code の YAML 拡張など)で補完・検証が効くようになる。

```yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/klaus-config.schema.json
run:
  env: local
```
