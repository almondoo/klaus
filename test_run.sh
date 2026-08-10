#!/usr/bin/env bash
# klaus ui のスモークテスト。
#
# チェック1: `--no-open` 指定で起動し、`klaus UI started:` のログ出力・HTTP 200 応答・
#            プロセス生存・SIGTERM による正常終了を確認する。
# チェック2: `--no-open` を付けずに(かつ opener コマンドが見つからない PATH で)起動し、
#            「ブラウザを開けなかった」警告が出た後もプロセスがクラッシュせず動作し続けることを
#            確認する(2026-08 に発生した spawn ENOENT クラッシュの回帰チェック)。
set -euo pipefail

# 既定ポート 4884 は verify 用 docker-compose のポートマッピング(Docker Desktop の
# docker-proxy)と衝突するため、スモーク専用のポートを明示する
CHECK1_PORT=14884
CHECK2_PORT=14885

# スクリプト自身の場所を基準にリポジトリルートへ移動する
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
REPO_ROOT="$(pwd)"

CLI_ENTRY="$REPO_ROOT/dist/cli.js"

if [ ! -f "$CLI_ENTRY" ]; then
  echo "NG: dist/cli.js が見つかりません。先に pnpm build を実行してください。"
  exit 1
fi

# 作業ディレクトリはリポジトリ直下 tmp/ 配下に作る(OS の /tmp は使わない)
mkdir -p "$REPO_ROOT/tmp"
WORK_DIR="$(mktemp -d "$REPO_ROOT/tmp/test-run-ui.XXXXXX")"

CHECK1_LOG="$WORK_DIR/check1.log"
CHECK2_LOG="$WORK_DIR/check2.log"
CHECK1_PID=""
CHECK2_PID=""

FAILURES=()

# 終了時クリーンアップ: ui プロセスの kill と作業ディレクトリ削除。
# クリーンアップ自体の失敗が本体の判定(exit code)を壊さないよう、個々の失敗は無視する。
cleanup() {
  if [ -n "$CHECK1_PID" ] && kill -0 "$CHECK1_PID" 2>/dev/null; then
    kill "$CHECK1_PID" 2>/dev/null || true
  fi
  if [ -n "$CHECK2_PID" ] && kill -0 "$CHECK2_PID" 2>/dev/null; then
    kill "$CHECK2_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# ログファイルに pattern を含む行が現れるまで最大 max_seconds 秒(0.5秒刻み)ポーリングする
wait_for_pattern() {
  local log_file="$1"
  local pattern="$2"
  local max_seconds="$3"
  local start_seconds="$SECONDS"
  while (("$SECONDS" - start_seconds < max_seconds)); do
    if [ -f "$log_file" ] && grep -q "$pattern" "$log_file" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  [ -f "$log_file" ] && grep -q "$pattern" "$log_file" 2>/dev/null
}

# "klaus UI started: <url>" 行が現れるまで最大 max_seconds 秒ポーリングし、見つかれば URL を出力する
wait_for_started_url() {
  local log_file="$1"
  local max_seconds="$2"
  if wait_for_pattern "$log_file" "klaus UI started:" "$max_seconds"; then
    local line
    line="$(grep -m1 "klaus UI started:" "$log_file")"
    echo "${line#*klaus UI started: }"
    return 0
  fi
  return 1
}

# プロセスの正常終了(グレースフル停止)を最大 max_seconds 秒待つ
wait_for_process_exit() {
  local pid="$1"
  local max_seconds="$2"
  local start_seconds="$SECONDS"
  while (("$SECONDS" - start_seconds < max_seconds)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  ! kill -0 "$pid" 2>/dev/null
}

# HTTP 200 が返るかどうかを確認する(127.0.0.1 のみに接続、外部ネットワークには出ない)
check_http_200() {
  local url="$1"
  local code
  code="$(curl -fsS -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

echo "=== チェック1: 基本起動(--no-open) ==="
(
  cd "$WORK_DIR"
  node "$CLI_ENTRY" ui --no-open --port "$CHECK1_PORT" >"$CHECK1_LOG" 2>&1 &
  echo $! >"$WORK_DIR/check1.pid"
)
CHECK1_PID="$(cat "$WORK_DIR/check1.pid")"

CHECK1_OK=true
CHECK1_URL=""
if CHECK1_URL="$(wait_for_started_url "$CHECK1_LOG" 15)"; then
  echo "OK: check1 起動ログ検出 ($CHECK1_URL)"
else
  echo "NG: check1 起動ログ(klaus UI started:)が15秒以内に現れませんでした"
  FAILURES+=("check1: 起動ログ未検出")
  CHECK1_OK=false
fi

if $CHECK1_OK; then
  if check_http_200 "$CHECK1_URL"; then
    echo "OK: check1 HTTP 200 応答確認"
  else
    echo "NG: check1 HTTP 200 応答が確認できませんでした"
    FAILURES+=("check1: HTTP 200 応答なし")
  fi

  if kill -0 "$CHECK1_PID" 2>/dev/null; then
    echo "OK: check1 プロセス生存確認"
  else
    echo "NG: check1 プロセスが生存していません"
    FAILURES+=("check1: プロセス消失")
  fi

  kill -TERM "$CHECK1_PID" 2>/dev/null || true
  if wait_for_process_exit "$CHECK1_PID" 15; then
    echo "OK: check1 SIGTERM による正常終了確認"
  else
    echo "NG: check1 SIGTERM 後もプロセスが終了しませんでした"
    FAILURES+=("check1: グレースフル停止失敗")
  fi
fi

echo "=== チェック2: opener 不在時の回帰確認(--no-open 無し) ==="
# node 実行ファイルのあるディレクトリのみに PATH を絞り、open/xdg-open が見つからない状況を再現する
# (node 自体は絶対パスで起動するため、PATH を絞っても node の起動自体には影響しない)
NODE_BIN_DIR="$(dirname "$(command -v node)")"
(
  cd "$WORK_DIR"
  PATH="$NODE_BIN_DIR" node "$CLI_ENTRY" ui --port "$CHECK2_PORT" >"$CHECK2_LOG" 2>&1 &
  echo $! >"$WORK_DIR/check2.pid"
)
CHECK2_PID="$(cat "$WORK_DIR/check2.pid")"

CHECK2_OK=true
CHECK2_URL=""
if CHECK2_URL="$(wait_for_started_url "$CHECK2_LOG" 15)"; then
  echo "OK: check2 起動ログ検出 ($CHECK2_URL)"
else
  echo "NG: check2 起動ログ(klaus UI started:)が15秒以内に現れませんでした"
  FAILURES+=("check2: 起動ログ未検出")
  CHECK2_OK=false
fi

if $CHECK2_OK; then
  if wait_for_pattern "$CHECK2_LOG" "could not open a browser automatically" 10; then
    echo "OK: check2 opener 不在の警告確認"
  else
    echo "NG: check2 opener 不在の警告(could not open a browser automatically)が10秒以内に現れませんでした"
    FAILURES+=("check2: opener 警告未検出")
  fi

  if kill -0 "$CHECK2_PID" 2>/dev/null; then
    echo "OK: check2 警告後もプロセス生存確認"
  else
    echo "NG: check2 警告後にプロセスがクラッシュしました(spawn ENOENT の回帰の疑い)"
    FAILURES+=("check2: プロセスクラッシュ")
  fi

  if check_http_200 "$CHECK2_URL"; then
    echo "OK: check2 HTTP 200 応答確認"
  else
    echo "NG: check2 HTTP 200 応答が確認できませんでした"
    FAILURES+=("check2: HTTP 200 応答なし")
  fi

  kill -TERM "$CHECK2_PID" 2>/dev/null || true
  if wait_for_process_exit "$CHECK2_PID" 15; then
    echo "OK: check2 SIGTERM による正常終了確認"
  else
    echo "NG: check2 SIGTERM 後もプロセスが終了しませんでした"
    FAILURES+=("check2: グレースフル停止失敗")
  fi
fi

echo ""
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "OK: すべてのチェックが成功しました"
  exit 0
else
  echo "NG: 以下のチェックが失敗しました"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
