# npm publish 後にユーザーが受け取る状態を再現するための klaus イメージ。
# ビルドコンテキストは tmp/docker-verify/(tarball とこのファイルのコピーのみ)であり、
# リポジトリの node_modules は一切持ち込まない。zod はここで npm レジストリから
# 取得される(dependencies に残しているため、実際のユーザー環境と同じ挙動)。
FROM node:22.19-slim

WORKDIR /work

# グローバルインストールは /usr/local 配下への書き込みが必要なため root(デフォルト)で行う。
COPY klaus.tgz /tmp/klaus.tgz
RUN npm install -g /tmp/klaus.tgz && rm /tmp/klaus.tgz

# klaus run は既定で cwd(/work)配下に .klaus/history/*.jsonl を書き込むため、
# 非 root ユーザーへ切り替える前に書き込み権限を渡しておく。
RUN chown node:node /work

# 実行時は公式イメージが用意する非 root ユーザー node に切り替える。
USER node

ENTRYPOINT ["klaus"]
