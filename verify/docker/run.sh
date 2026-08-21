#!/usr/bin/env bash
# npm publish 後にユーザーが受け取る形の klaus を、クリーンな Docker コンテナで
# 実際に動かして検証するスクリプト。
#
# 流れ: build:all -> pack -> compose build -> mock-api / klaus 起動
#       -> auth-flow スモーク -> examples 一式スモーク -> generate 一連のスモーク
#       -> klaus.config.yaml オーバーレイの確認 -> exit code の集約・表示
#
# コンテナは起動したまま残す(後片付けはしない)。その後は `make exec` で
# klaus コンテナに入って自由に実行でき、`make verify-down` で片付ける。
#
# 注意(依存関係の取得元について):
#   klaus イメージ内の `npm install -g klaus.tgz` は zod をレジストリから
#   取得する(dependencies に残しているため)。これは実際のユーザー環境と同じ挙動であり、
#   意図した検証対象そのもの。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# pack 生成物(tarball / Dockerfile コピー)の置き場。verify 配下で完結させる
# (tmp/ はクリーンアップで消されることがあるため使わない)。git 管理外(.gitignore 済み)。
WORK_DIR="$SCRIPT_DIR/.pack"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"
# klaus generate の出力先。examples/(ホスト rw マウント)を汚さないよう、コンテナ内のみに
# 閉じる /tmp 配下(マウント対象外)を使う。ホスト側には一切残らない。
GENERATE_OUT_DIR="/tmp/generated"

echo "== 1/8: dist の再ビルド (pnpm build:all) =="
(cd "$REPO_ROOT" && pnpm build:all)

echo "== 2/8: publish 相当 tarball の生成 =="
# 注意: このリポジトリの検証ポリシー上 npm CLI が使えないため pnpm pack を使う。
# pnpm pack は package.json の files フィールドを npm と同じ規則で解釈するため、
# 生成される tarball の内容は npm pack と同一になる。
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
(cd "$REPO_ROOT" && pnpm pack --pack-destination "$WORK_DIR")
TARBALL="$(ls "$WORK_DIR"/*.tgz | head -n 1)"
cp "$TARBALL" "$WORK_DIR/klaus.tgz"
cp "$SCRIPT_DIR/Dockerfile" "$WORK_DIR/Dockerfile"
echo "tarball: $TARBALL"

echo "== 3/8: イメージビルド (docker compose build) =="
docker compose -f "$COMPOSE_FILE" build

echo "== 4/8: コンテナ起動 (mock-api の healthy 待ち -> klaus 常駐) =="
docker compose -f "$COMPOSE_FILE" up -d klaus

echo "== 5/8: auth-flow のスモーク実行 (cwd /work/examples、素早い失敗検知用の1本) =="
# examples/flows/auth-flow.yaml を使う(verify 配下への複製はしない。compose.yaml 参照)。
# -e を付けずに実行する: klaus.config.yaml オーバーレイ(compose.yaml 参照)により
# コンテナ内では run.env: docker が既定になるため、これ自体が「素の table のコマンドが
# 通ること」の最小スモークになる。常駐コンテナへ exec で流す。-T は非対話実行
# (スクリプト内)での TTY 割り当て回避。
set +e
docker compose -f "$COMPOSE_FILE" exec -T --workdir /work/examples klaus klaus run flows/auth-flow.yaml --json
AUTH_EXIT_CODE=$?
set -e
echo "== auth-flow exit code: $AUTH_EXIT_CODE =="

echo "== 6/8: examples 一式(単発チェック5本 + シナリオ2本)のスモーク実行 (cwd /work/examples, -e docker) =="
# examples/ の全サンプル(SSE・WebSocket・GraphQL 含む)を通しで実行する。
# --text で強制的に人間可読な出力にする(非TTY の exec では既定で JSON 出力になるため)。
set +e
EXAMPLES_OUTPUT="$(docker compose -f "$COMPOSE_FILE" exec -T --workdir /work/examples klaus \
  klaus run \
  api/login-check.yaml api/users-check.yaml api/graphql-check.yaml \
  api/sse-events-check.yaml api/ws-echo-check.yaml \
  flows/auth-flow.yaml flows/users-crud-flow.yaml \
  -e docker --text 2>&1)"
EXAMPLES_RUN_CODE=$?
set -e
echo "$EXAMPLES_OUTPUT"
echo "== examples run exit code: $EXAMPLES_RUN_CODE =="

EXAMPLES_EXIT_CODE=0
if [ "$EXAMPLES_RUN_CODE" -ne 0 ]; then
  EXAMPLES_EXIT_CODE=$EXAMPLES_RUN_CODE
elif ! echo "$EXAMPLES_OUTPUT" | grep -q "7 flows, 10 steps: 10 passed"; then
  echo "== examples smoke: NG (期待したサマリー行 '7 flows, 10 steps: 10 passed' が見つからない) =="
  EXAMPLES_EXIT_CODE=1
else
  echo "== examples smoke: OK (7 flow / 10 step passed) =="
fi

echo "== 7/8: generate 一連(generate -> validate -> run)のスモーク実行 (cwd /work/examples, -e docker) =="
# 前回実行分が残っていても再現性を保てるよう、生成先を先に空にする
docker compose -f "$COMPOSE_FILE" exec -T --workdir /work/examples klaus rm -rf "$GENERATE_OUT_DIR"

set +e
GENERATE_JSON="$(docker compose -f "$COMPOSE_FILE" exec -T --workdir /work/examples klaus \
  klaus generate openapi/users-api.yaml --out-dir "$GENERATE_OUT_DIR" --json)"
GENERATE_RUN_CODE=$?
set -e
# generate/validate は --text を持たないため --json 固定で受け、パース自体はホスト側の node で行う
# (コンテナ側に jq が無いため)。
GENERATE_COUNTS="$(node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf-8"));
console.log(`generated=${data.generated.length} skipped=${data.skipped.length} errors=${data.errors.length}`);
' <<<"$GENERATE_JSON")"
echo "== generate: $GENERATE_COUNTS (exit code: $GENERATE_RUN_CODE) =="

# operationId を kebab-case 化したファイル名(examples/README.md 参照)。パス固定のため glob 不要
GENERATE_FILES="$GENERATE_OUT_DIR/login.yaml $GENERATE_OUT_DIR/get-current-user.yaml $GENERATE_OUT_DIR/list-users.yaml $GENERATE_OUT_DIR/create-user.yaml $GENERATE_OUT_DIR/get-user.yaml $GENERATE_OUT_DIR/delete-user.yaml"

set +e
# shellcheck disable=SC2086 # 意図的な単語分割(固定のファイルパス一覧を複数引数として渡す)
VALIDATE_JSON="$(docker compose -f "$COMPOSE_FILE" exec -T --workdir /work/examples klaus \
  klaus validate $GENERATE_FILES --json)"
VALIDATE_RUN_CODE=$?
set -e
VALIDATE_COUNTS="$(node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf-8"));
const invalid = data.files.filter((f) => !f.valid).length;
console.log(`files=${data.files.length} invalid=${invalid}`);
' <<<"$VALIDATE_JSON")"
echo "== validate: $VALIDATE_COUNTS (exit code: $VALIDATE_RUN_CODE) =="

# パスパラメータ・認証ヘッダーの手直しが不要な3本(login / list-users / create-user)のみ実行する
# (get-user / delete-user / get-current-user は骨組みのままでは動かない。examples/README.md 参照)
set +e
GENERATE_RUN_OUTPUT="$(docker compose -f "$COMPOSE_FILE" exec -T --workdir /work/examples klaus \
  klaus run \
  "$GENERATE_OUT_DIR/login.yaml" "$GENERATE_OUT_DIR/list-users.yaml" "$GENERATE_OUT_DIR/create-user.yaml" \
  -e docker --text 2>&1)"
GENERATE_RUN_EXEC_CODE=$?
set -e
echo "$GENERATE_RUN_OUTPUT"
echo "== generate 実行分 exit code: $GENERATE_RUN_EXEC_CODE =="

GENERATE_EXIT_CODE=0
if [ "$GENERATE_RUN_CODE" -ne 0 ] || [ "$GENERATE_COUNTS" != "generated=6 skipped=0 errors=0" ]; then
  echo "== generate smoke: NG (generate 段階) =="
  GENERATE_EXIT_CODE=1
elif [ "$VALIDATE_RUN_CODE" -ne 0 ] || [ "$VALIDATE_COUNTS" != "files=6 invalid=0" ]; then
  echo "== generate smoke: NG (validate 段階) =="
  GENERATE_EXIT_CODE=1
elif [ "$GENERATE_RUN_EXEC_CODE" -ne 0 ] || ! echo "$GENERATE_RUN_OUTPUT" | grep -q "3 flows, 3 steps: 3 passed"; then
  echo "== generate smoke: NG (run 段階) =="
  GENERATE_EXIT_CODE=1
else
  echo "== generate smoke: OK (6 ファイル生成 -> 全 valid -> 3 本 run passed) =="
fi

echo "== 8/8: klaus.config.yaml オーバーレイの確認 (config 既定 vs 明示指定) =="
# ユーザーが実際に踏んだ再現コマンド(-e なしの素の table コマンド)がそのまま通ることを確認する。
# api/*.yaml flows/*.yaml のグロブ展開はコンテナ内シェルで行う必要があるため bash -c を使う。
set +e
BARE_OUTPUT="$(docker compose -f "$COMPOSE_FILE" exec -T --workdir /work/examples klaus \
  bash -c 'klaus run api/*.yaml flows/*.yaml --json')"
BARE_RUN_CODE=$?
set -e
BARE_SUMMARY="$(node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf-8"));
console.log(`flows=${data.summary.flows} steps=${data.summary.steps} passed=${data.summary.passed}`);
' <<<"$BARE_OUTPUT" 2>/dev/null || echo "parse-error")"
echo "== 素の table コマンド(-e なし): $BARE_SUMMARY (exit code: $BARE_RUN_CODE) =="

# --env のような明示指定は config の既定より優先されるはず。development.yaml はホスト実行用
# (baseUrl: 127.0.0.1)のため、コンテナ内で明示指定すると意図的に接続エラーで失敗する
# (= 明示指定が config の docker 既定を上書きできている証拠)。
set +e
OVERRIDE_OUTPUT="$(docker compose -f "$COMPOSE_FILE" exec -T --workdir /work/examples klaus \
  klaus run api/login-check.yaml --env development --json 2>&1)"
OVERRIDE_RUN_CODE=$?
set -e
echo "$OVERRIDE_OUTPUT"
echo "== --env development(明示指定)の exit code: $OVERRIDE_RUN_CODE(3=runtime error を期待。127.0.0.1 への接続失敗という想定どおりの理由) =="

OVERLAY_EXIT_CODE=0
if [ "$BARE_RUN_CODE" -ne 0 ] || [ "$BARE_SUMMARY" != "flows=7 steps=10 passed=10" ]; then
  echo "== config overlay smoke: NG (素のコマンドが config の docker 既定で通らない) =="
  OVERLAY_EXIT_CODE=1
elif [ "$OVERRIDE_RUN_CODE" -ne 3 ] || ! echo "$OVERRIDE_OUTPUT" | grep -q "ECONNREFUSED"; then
  echo "== config overlay smoke: NG (--env development が期待どおり(exit 3 / ECONNREFUSED)で失敗しなかった。明示指定が config に勝てていない可能性) =="
  OVERLAY_EXIT_CODE=1
else
  echo "== config overlay smoke: OK (config の docker 既定がそのまま通り、--env development の明示指定はそれを上書きして ECONNREFUSED で失敗する) =="
fi

# 4スモークのいずれかが失敗していれば run.sh 全体も非0で終わる(最初に検出した非0を採用する)
EXIT_CODE=0
for code in "$AUTH_EXIT_CODE" "$EXAMPLES_EXIT_CODE" "$GENERATE_EXIT_CODE" "$OVERLAY_EXIT_CODE"; do
  if [ "$code" -ne 0 ] && [ "$EXIT_CODE" -eq 0 ]; then
    EXIT_CODE="$code"
  fi
done

echo "== auth-flow: $AUTH_EXIT_CODE / examples: $EXAMPLES_EXIT_CODE / generate: $GENERATE_EXIT_CODE / config overlay: $OVERLAY_EXIT_CODE => 集約 exit code: $EXIT_CODE =="
echo "== コンテナは起動したままです(make exec で入る / 片付けは make verify-down) =="
echo "== verify/ 一式の手順は verify/CHECKLIST.md、構成の説明は verify/README.md を参照 =="
exit "$EXIT_CODE"
