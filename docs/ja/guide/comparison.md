# klaus と Hurl・Bruno・runn・Step CI の比較

このページでは、klaus と用途が重なる 4 つのツール([Hurl](https://hurl.dev)・[Bruno](https://www.usebruno.com)・[runn](https://github.com/k1LoW/runn)・[Step CI](https://stepci.com))との位置づけを整理する。klaus が向く場面と、他のツールのほうが適している場面の両方を書く。他のツールに関する記述は 2026 年 11 月時点で確認した内容であり、変わりうるため、選ぶ前に各プロジェクトの公式ドキュメントを確認すること。

## klaus が向いている用途

klaus は YAML のリクエストフローで HTTP API を検証するツール。同じフローを扱う利用者として、人間と、人間に代わってコマンドを実行する AI エージェントの両方を想定している。そのため次の点に重きを置いている。

- **安全柵。** 送信先ホストの許可リスト(`klaus.config.yaml` の `guard.allowedHosts`)と保護環境(`$protected: true` / `readonly`)により、送信前にリクエストを拒否する。許可リストを外すコマンドラインフラグは意図的に用意していないので、エージェントが自分に課された制限を解除することはできない。詳細は [CLI オプションの既定値](config.md) と [CLI リファレンス](cli.md) を参照。
- **証跡としてのローカル履歴。** 実行はすべて `.klaus/history/` に記録され、シークレットはマスクされ、監査項目(環境・ファイル・実行者・git の状態)が付く。エージェント向けの出力(`--json`)は短く保ち、詳細はこの履歴を指す形にしている。詳細は [実行履歴](history.md) を参照。
- **localhost UI。** `klaus ui` で同じフローをブラウザから実行し、過去の実行を確認できる。トークン認証と CSRF 対策つき。詳細は [localhost UI](ui.md) を参照。
- **record / replay。** 実際のレスポンスを一度保存し、以後はネットワークなしで保存済みカセットに対してフローを検証する。詳細は [record / replay モード](record-replay.md) を参照。
- **Agent Skill。** 同梱のスキルが、コーディングエージェントに `validate`・`run`・`history` の手順と exit code を教える。詳細は [Agent Skill](agent-skill.md) を参照。

これに加えて、フロー型の API チェックに必要な機能も備える。アサーション、ステップ間の JSONPath capture、ステップ単位の `retry`、`if` 条件、データ駆動実行(`--data`)、タグ選択(`--tags`)、並列実行(`--jobs`)、JUnit / TAP レポート、そして HTTP・GraphQL に加えて SSE と WebSocket のステップである。

## klaus が不利な点

- **Node.js が必要。** klaus は Node.js 22.19 以上で動く。単体で完結する 1 つのバイナリではない。
- **gRPC 非対応。** klaus が扱うのは HTTP(GraphQL を含む)・SSE・WebSocket。gRPC には対応していない。
- **スクリプト機能なし。** フローは宣言的な YAML で、独自ロジックのための JavaScript などは組み込めない。
- **全体として対応プロトコルが少ない。** 以下のツールの中には、データベース・SSH・SOAP・ブラウザを同じワークフローで扱えるものがあるが、klaus は扱えない。
- **若いプロジェクト。** 歴史が浅く、実績のあるツールと比べて利用者も少ない。
- **OSI 定義のオープンソースではない。** klaus のライセンスは Elastic License 2.0。利用・改変・再配布は自由だが、第三者へホスティング/マネージドサービスとして提供することはできない。

## 他のツール

### Hurl

2026 年 11 月時点で、Hurl はリクエストをプレーンテキストの `.hurl` 形式で記述し、単一バイナリとして配布されている。扱うのは HTTP のみ。レポートは HTML・JSON・JUnit・TAP で出力でき、並列実行(`--parallel` / `--jobs`)、リトライ(`--retry`)、`--secret` によるシークレットの伏せ字化、curl コマンドへのエクスポートに対応する。レスポンスのスナップショットモードと、実行履歴つきのローカル Web UI はない。

Node.js のランタイムが要らない単一バイナリ、プレーンテキストのリクエスト形式、curl へのエクスポート、HTML レポートが欲しいなら Hurl を選ぶ。安全柵、誰が何を実行したかを残す履歴、ローカル UI、record / replay が欲しいなら klaus を選ぶ。

### Bruno

2026 年 11 月時点で、Bruno はデスクトップ GUI の API クライアントで、コレクションをプレーンファイルとして git で管理でき、MIT ライセンスである。`bru` CLI は JSON・JUnit・HTML のレポートを出力する。JavaScript によるスクリプトに対応し(CLI は v3 以降、既定でサンドボックス化された「Safe Mode」)、REST・GraphQL・gRPC・WebSocket をサポートし、シークレットマネージャー(Vault・AWS・Azure・GCP)と連携できる。

リクエストの探索や作成のためのデスクトップクライアントが欲しい、gRPC が必要、スクリプトを使いたい、シークレットマネージャーから値を取りたいなら Bruno を選ぶ。宣言的なフローを中心とした CLI ファーストの運用、エージェント経由の実行にも効く安全柵、証跡として使える履歴が欲しいなら klaus を選ぶ。

### runn

2026 年 11 月時点で、runn は YAML で「runbook」を定義し、単一の Go バイナリとして配布されている。ステップは HTTP・gRPC・データベース・SSH・ブラウザ(CDP 経由)に対応する。エディタ向けに JSON Schema を公開しており、式ベースの条件とテストを使う。

1 つのシナリオでプロトコルをまたぎたい(たとえば HTTP 呼び出しの後にデータベースを確認する)、単一バイナリが欲しい、式ベースのテストを使いたいなら runn を選ぶ。対象が HTTP 形の API で、その周りの安全柵・履歴・UI が欲しいなら klaus を選ぶ。

### Step CI

2026 年 11 月時点で、Step CI は YAML・JSON・JavaScript でワークフローを定義し、REST・GraphQL・gRPC・tRPC・SOAP を扱う。確認できた最新の GitHub リリースは 2024 年のものである。

対応プロトコル(特に tRPC や SOAP)や、JavaScript で定義するワークフローが必要なら Step CI を選ぶ。検討する際は、プロジェクトの最近のリリース状況を自分で確認すること。プロトコルの幅よりも、安全柵・ローカル履歴・localhost UI を重視するなら klaus を選ぶ。

## 機能比較表

「未評価」は、このページがその有無について何も主張しないという意味で、機能がないという意味ではない。

| 観点 | klaus | Hurl | Bruno | runn | Step CI |
|---|---|---|---|---|---|
| 定義形式 | YAML | プレーンテキストの `.hurl` | git 上のプレーンファイル(デスクトップ GUI で編集) | YAML の runbook | YAML / JSON / JavaScript |
| 実行環境 | Node.js 22.19 以上 | 単一バイナリ | デスクトップアプリと `bru` CLI | 単一の Go バイナリ | 未評価 |
| プロトコル | HTTP・GraphQL・SSE・WebSocket | HTTP のみ | REST・GraphQL・gRPC・WebSocket | HTTP・gRPC・データベース・SSH・ブラウザ(CDP) | REST・GraphQL・gRPC・tRPC・SOAP |
| スクリプト | なし(宣言的) | 未評価 | JavaScript(CLI は v3 以降、既定でサンドボックス化された Safe Mode) | 式ベースの条件とテスト | JavaScript のワークフロー |
| レポート | JSON・テキスト・JUnit・TAP | HTML・JSON・JUnit・TAP | JSON・JUnit・HTML | 未評価 | 未評価 |
| 並列実行とリトライ | `--jobs`、ステップ単位の `retry` | `--parallel` / `--jobs`、`--retry` | 未評価 | 未評価 | 未評価 |
| シークレットの扱い | 出力・履歴・カセットでマスク | `--secret` で伏せ字化 | Vault・AWS・Azure・GCP と連携 | 未評価 | 未評価 |
| 実行履歴つきのローカル Web UI | あり(`klaus ui`) | なし | デスクトップ GUI | 未評価 | 未評価 |
| レスポンスの record / replay | あり(`--record` / `--replay`) | スナップショットモードなし | 未評価 | 未評価 | 未評価 |
| 安全柵(ホスト許可リスト・保護環境) | あり | 未評価 | 未評価 | 未評価 | 未評価 |
| エディタ向け JSON Schema | あり(`klaus schema`) | 未評価 | 未評価 | あり | 未評価 |
| 同梱の Agent Skill | あり | 未評価 | 未評価 | 未評価 | 未評価 |
| ライセンス | Elastic License 2.0 | 未評価 | MIT | 未評価 | 未評価 |

## 関連ページ

- [Getting Started](getting-started.md): klaus のインストールと最初のフロー実行
- [フロー定義リファレンス](flow-definition.md): フローで表現できることの全体
