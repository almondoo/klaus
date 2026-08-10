# OpenAPI からのフロー生成

`klaus generate` は OpenAPI 3.x の定義ファイルから、各オペレーション(`paths` × HTTP メソッド)ごとに単発チェックのフロー定義 YAML を生成する。既存プロジェクトに klaus を導入する際、`api/` 配下の初期セットをゼロから手で書かずに済む。

対応入力は OpenAPI 3.x(`requestBody` / `parameter.schema` 等の 3.x 形状)のみ。Swagger 2.0(`in: body` パラメータやトップレベルの `type` / `default` 等のフラットな形状)を渡した場合は生成を行わず exit code 2 のエラーになる(`openapi 3.x` に変換してから使用すること)。

## 使い方

```
klaus generate <spec> [options]
```

| 引数・オプション | 説明 | デフォルト |
|---|---|---|
| `<spec>` | OpenAPI 定義ファイル(`.yaml` / `.yml` / `.json`) | 必須 |
| `--out-dir <dir>` | 生成先ディレクトリ | `api` |
| `--json` | TTY でも JSON 出力を強制 | — |

spec のパースには [`@apidevtools/swagger-parser`](https://apitools.dev/swagger-parser/) を使い、`$ref` を解決(dereference)したうえでオペレーションを走査する。外部 URL 参照を含む spec にも対応するが、通常はローカルファイルを渡す。

## 生成されるファイル

1オペレーション = 1ファイル。ファイル名・フロー名・ステップ名は次のルールで決める。

- **ファイル名**: `operationId` があれば kebab-case 化した値、無ければ `<method>-<パスをスラッグ化した値>`(例: `operationId` 無しの `GET /users/{id}` → `get-users-id.yaml`)
- **フロー名(`name`)**: `operationId` があればそのまま、無ければ `METHOD /path` 形式(例: `GET /users/{id}`)
- **ステップ名**: ファイル名と同じ id(1ファイル1ステップの単発チェックのため)

内容は [フロー定義リファレンス](flow-definition.md) の `request` / `assert` に沿った最小構成:

- `request.method` / `request.url`: spec の HTTP メソッドとパスから組み立てる。`url` は `{{baseUrl}}` + spec のパス(パスパラメータ `{id}` はそのまま残す。`environments/*.yaml` の `baseUrl` を参照する運用を前提にしている)
- `request.query`: `in: query` のパラメータのうち、example(`example` / `examples` / `schema.example` / `schema.default` の優先順)を持つものだけを含める。example が無いパラメータは省略する
- `request.body` / `request.headers`: `requestBody` がある場合、対象コンテンツタイプ(`application/json` を優先、無ければ最初のコンテンツタイプ)の example を `body` に設定し、`headers.Content-Type` を spec のコンテンツタイプに合わせる。example が無い場合は schema から最小限のプレースホルダ(`required` なプロパティのみを埋めたオブジェクト等)を組み立てる。プレースホルダも作れない場合は `body` を省略する
- `assert.status`: 定義済みレスポンス(`responses`)のうち最小の 2xx コード。無ければ `200`

生成した YAML は書き込み前に klaus 自身のスキーマ検証(`validateFlowYaml`)を通し、検証に通らないものは書き込まずエラーとして報告する。

先頭行には他の生成物と同じ `# yaml-language-server: $schema=...` コメントが付く([JSON Schema](flow-definition.md#json-schema) 参照)。

**既存ファイルは上書きしない。** 出力先に同名ファイルが既にあればスキップし、その旨を報告する。

## 生成例

以下のような spec があるとする。

```yaml
openapi: 3.0.3
info:
  title: Sample API
  version: "1.0.0"
paths:
  /users:
    post:
      operationId: createUser
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, email]
              properties:
                name: { type: string }
                email: { type: string }
            example:
              name: Alice
              email: alice@example.com
      responses:
        "201":
          description: Created
```

`klaus generate openapi.yaml` を実行すると `api/create-user.yaml` が生成される。

```yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json
name: createUser
steps:
  - name: create-user
    request:
      method: POST
      url: "{{baseUrl}}/users"
      headers:
        Content-Type: application/json
      body:
        name: Alice
        email: alice@example.com
    assert:
      status: 201
```

## 生成物は骨組みである

`klaus generate` が作るのはあくまで最小構成の単発チェックであり、実運用のテストスイートとしてはそのままでは不十分なことが多い。生成後は用途に応じて次のような加筆を行うこと。

- 認証ヘッダー(`Authorization` 等)や `environments/*.yaml` への変数追加
- `assert.body` / `assert.headers` によるレスポンス内容の検証
- 複数ステップを `capture` で連結するシナリオへの発展(その場合は `flows/` ディレクトリへ移動する。[ディレクトリ規約](https://github.com/almondoo/klaus/blob/main/docs/dev/architecture.md) 参照)
- example が無かったために省略された `request.query` / `request.body` の補完

## 出力モード・exit code

出力モードの判定は [CLI リファレンス](cli.md) の他コマンドと同じ(TTY なら text、非 TTY または `--json` なら JSON)。

### JSON 出力

```jsonc
{
  "version": 1,
  "generated": ["api/create-user.yaml"],
  "skipped": [],
  "errors": []
}
```

`errors[]` は生成物が klaus 自身のスキーマ検証を通らなかった場合のエントリ(`path` と `message` を持つ)。通常の spec では発生しない想定だが、発生した場合はそのファイルだけ書き込まれない。

### exit code

| code | 意味 |
|---|---|
| 0 | 全オペレーションの生成に成功(スキップのみの場合を含む) |
| 1 | 一般エラー(不正な CLI 引数・予期しない例外) |
| 2 | spec が不正(パース・$ref 解決に失敗)、または生成物がスキーマ検証を通らない |

spec が不正な場合、text モードでは stderr にのみメッセージを出す(stdout には何も出さない)。`--json` 指定時、または非 TTY(パイプ・エージェント実行・CI)の場合は、stdout に `errors` を含むエラーレポート(JSON)を出す。
