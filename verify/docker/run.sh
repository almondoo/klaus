#!/usr/bin/env bash
# npm publish 後にユーザーが受け取る形の klaus を、クリーンな Docker コンテナで
# 実際に動かして検証するスクリプト。
#
# 流れ: build:all -> pack -> compose build -> demo-api / klaus 起動 -> klaus run 実行
#       -> exit code 表示
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

echo "== 1/5: dist の再ビルド (pnpm build:all) =="
(cd "$REPO_ROOT" && pnpm build:all)

echo "== 2/5: publish 相当 tarball の生成 =="
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

echo "== 3/5: イメージビルド (docker compose build) =="
docker compose -f "$COMPOSE_FILE" build

echo "== 4/5: コンテナ起動 (demo-api の healthy 待ち -> klaus 常駐) =="
docker compose -f "$COMPOSE_FILE" up -d klaus

echo "== 5/5: klaus run 実行 =="
set +e
# 常駐コンテナに exec で流す。-T は非対話実行(スクリプト内)での TTY 割り当て回避
docker compose -f "$COMPOSE_FILE" exec -T klaus klaus run flows/auth-flow.yaml
EXIT_CODE=$?
set -e

echo "== klaus run exit code: $EXIT_CODE =="
echo "== コンテナは起動したままです(make exec で入る / 片付けは make verify-down) =="
exit "$EXIT_CODE"
