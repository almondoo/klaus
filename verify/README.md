# verify

npm publish 相当の検証を、クリーンな Docker コンテナ上で行うための一式。klaus の使い方サンプル
そのものは [../examples/](../examples/) を参照(この `verify/` は examples/ を検証用に呼び出す側)。

## 目的

`verify/docker/` は、npm publish で実際にユーザーへ届く内容(`npm pack` の `files` 選定結果)や
`bin` 配線、依存バンドル漏れ、engines で指定した Node 22 系での動作を、クリーンな Docker
コンテナに tarball を `npm install -g` して確認するための仕組み。具体的には:

- files 指定の過不足(`.map` 等の除外漏れ・必須ファイルの欠落)を tarball ベースで確認する
- `bin.klaus` の配線(`npm install -g` 後に `klaus` コマンドとして解決されるか)を確認する
- バンドル漏れ(zod 以外の実行時依存が `node_modules` に現れず、`dist/*.js` 単体で動くか)を確認する
- engines で指定した Node 22 系のクリーンな環境で実際に動くかを確認する

Docker デーモンが利用できない環境では `docker compose build` の時点で失敗するため、
事前に `docker version` で確認しておく。

## 構成

```
verify/
├── CHECKLIST.md            # 動作確認チェックリスト(examples/ 一式 + make verify のコンテナ実行手順)
└── docker/
    ├── compose.yaml         # mock-api / klaus の2サービス定義
    ├── Dockerfile           # klaus.tgz を npm install -g するクリーンな Node 22 イメージ
    ├── run.sh                # make verify の実体。build:all -> pack -> build -> 起動 -> スモーク一式
    ├── klaus.config.yaml     # コンテナ内専用の config(run.env: docker)。examples/klaus.config.yaml を上書きする
    └── .pack/                # run.sh が生成する pack 作業ディレクトリ(git 管理外)
```

フロー定義・環境ファイル・mock-server は `verify/` 配下に複製せず、`examples/` を丸ごとマウントして
共有している(実行対象は常に `examples/` の実物そのもの)。コンテナだけで変えたいのは
`run.env`(config)だけなので、`klaus.config.yaml` 1ファイルだけを個別マウントでオーバーレイする
(詳細は「コンテナ構成」を参照)。以前は `verify/docker/flows/` `verify/docker/environments/` に
`auth-flow.yaml` 等のミニフィクスチャを複製していたが、`examples/` 側の更新に追随できず内容が
drift するため廃止した。

## make verify が行うこと

`make verify` は `verify/docker/run.sh` を実行する。流れ:

1. `pnpm build:all` で dist / dist/ui を再ビルド
2. `pnpm pack` で publish 相当の tarball を生成(`.pack/klaus.tgz`)
3. `docker compose build` でイメージをビルド(klaus イメージは tarball を `npm install -g`)
4. `mock-api` の healthy 待ちの上で `klaus` コンテナを常駐起動(`sleep infinity`)
5. **auth-flow スモーク**: `examples/flows/auth-flow.yaml`(cwd `/work/examples`)を `-e` なしで
   実行し PASS を確認(config オーバーレイが効いているかを最初に素早く検知する1本)
6. **examples 一式スモーク**: `examples/`(cwd `/work/examples`、`-e docker` 明示)の単発チェック5本+
   シナリオ2本を通しで実行し、7 flow / 10 step passed を確認(SSE・WebSocket・GraphQL 含む)
7. **generate 一連スモーク**: `klaus generate` → `klaus validate` → パスパラメータなし3本の
   `klaus run` を通しで実行し、6ファイル生成 → 全 valid → 3本 passed を確認。生成先はホスト側
   `examples/generated/` を汚さないよう、コンテナ内のみの `/tmp/generated`(マウント外)を使う
8. **klaus.config.yaml オーバーレイの確認**: `-e` なしの素の `klaus run api/*.yaml flows/*.yaml --json`
   (CHECKLIST.md の表そのまま)が 7 flow / 10 step passed になることと、`--env development`
   のような明示指定は config より優先されるため意図的に接続エラー(exit 3 / ECONNREFUSED)に
   なることの両方を確認する

いずれかのスモークが失敗すれば `run.sh` 全体も非0で終わる(各スモークの exit code と集約結果を
最後にまとめて表示する)。コンテナは検証後も起動したまま残る(後片付けはしない)。

## make exec / make verify-down

- `make exec`: 常駐している `klaus` コンテナの `/work/examples` に bash で入る(`cd` 不要)。
  ここから [CHECKLIST.md](./CHECKLIST.md) の 2〜5 章の表を**そのまま**(`-e` を付けずに)実行できる
  (下記「klaus.config.yaml のオーバーレイ」参照)。
- `make verify-down`: コンテナ・ネットワークを片付ける。

## コンテナ構成(compose.yaml)

- `mock-api`: 検証用ダミー API(`examples/mock-server.mjs`)。`HOST=0.0.0.0` で起動し、compose
  ネットワーク越しに他コンテナから `mock-api:3000` として到達できる。examples/ 一式のスモークと
  auth-flow のスモークの両方をこのサービス1本でまかなう。
- `klaus`: `.pack/klaus.tgz`(pack 済み tarball)を `npm install -g` したクリーンな Node 22 の
  常駐コンテナ。`examples/` はホストから rw マウントされており(`../../examples:/work/examples`)、
  `klaus generate` 等の書き込みもそのまま反映される(ただし本検証の generate スモークはコンテナ内
  `/tmp` を使うため、ホスト側の `examples/` には残らない)。フロー定義・環境ファイル・mock-server は
  この rw マウント経由で examples/ の実物をそのまま使う(verify/ 配下への複製はしない)。

### klaus.config.yaml のオーバーレイ

`examples/klaus.config.yaml` は `run.env: local` / `ui.host: 127.0.0.1`(いずれもホスト実行前提)を
既定にしているため、そのままコンテナ内 cwd `/work/examples` で使うと `run` は `baseUrl` が
`127.0.0.1`(klaus コンテナ自身)を指して接続エラーになり、`ui` はコンテナの `127.0.0.1` バインドが
ホストから届かない。これを解決するため、`klaus` サービスの volumes に
`./klaus.config.yaml:/work/examples/klaus.config.yaml:ro` を追加し、`examples/` 丸ごとの rw マウント
より深いターゲットパスとして個別マウントしている。Docker のバインドマウントはターゲットパスが
深いものほど優先されるため、ディレクトリ丸ごとマウントの中の1ファイルだけをコンテナ専用の内容
(`run.env: docker`、`ui.host: 0.0.0.0`、`ui.open: false`。詳細は `verify/docker/klaus.config.yaml`
自体のコメント参照)に差し替えられる。物理コピーではなくマウントで実現しているのは、examples/
側の更新(ファイル追加・書き換え)に verify/ 側が追随できずに drift するのを避けるため。CLI で
`--env` / `--port` / `--host` / `--no-open` を明示すれば、この config オーバーレイよりも優先される
(通常の config 優先順位どおり)。

## 次に見るもの

具体的なコマンド一覧・チェック項目は [CHECKLIST.md](./CHECKLIST.md) を参照。
