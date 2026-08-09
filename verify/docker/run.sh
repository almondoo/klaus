#!/usr/bin/env bash
# npm publish 後にユーザーが受け取る形の klaus を、クリーンな Docker コンテナで
# 実際に動かして検証するワンショットスクリプト。
#
# 流れ: build:all -> pack -> compose build -> demo-api 起動 -> klaus run 実行
#       -> exit code 表示 -> 後片付け(compose down)
#
# --keep を付けると後片付けを行わず demo-api を起動したまま残す。
# その後は `docker compose -f verify/docker/compose.yaml run --rm klaus <args>` で
# klaus を自由に実行でき、`make verify-down` で片付けられる。
#
# 注意(依存関係の取得元について):
#   klaus イメージ内の `npm install -g klaus.tgz` は zod をレジストリから
#   取得する(dependencies に残しているため)。これは実際のユーザー環境と同じ挙動であり、
#   意図した検証対象そのもの。
set -euo pipefail

KEEP=0
if [[ "${1:-}" == "--keep" ]]; then
  KEEP=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# pack 生成物(tarball / Dockerfile コピー)の置き場。verify 配下で完結させる
# (tmp/ はクリーンアップで消されることがあるため使わない)。git 管理外(.gitignore 済み)。
WORK_DIR="$SCRIPT_DIR/.pack"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

echo "== 1/6: dist の再ビルド (pnpm build:all) =="
(cd "$REPO_ROOT" && pnpm build:all)

echo "== 2/6: publish 相当 tarball の生成 =="
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

echo "== 3/6: イメージビルド (docker compose build) =="
docker compose -f "$COMPOSE_FILE" build

echo "== 4/6: demo-api 起動 =="
docker compose -f "$COMPOSE_FILE" up -d demo-api

cleanup() {
  if [[ "$KEEP" -eq 1 ]]; then
    echo "== 6/6: --keep 指定のため demo-api は起動したまま(片付けは make verify-down) =="
    return
  fi
  echo "== 6/6: 後片付け (docker compose down) =="
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans
}
trap cleanup EXIT

echo "== 5/6: klaus run 実行 =="
set +e
docker compose -f "$COMPOSE_FILE" run --rm klaus
EXIT_CODE=$?
set -e

echo "== klaus run exit code: $EXIT_CODE =="
exit "$EXIT_CODE"
