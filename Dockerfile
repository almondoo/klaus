# klaus の利用者向けイメージ(ENTRYPOINT は klaus CLI)。
#
# 使い方:
#   docker build -t klaus .
#   docker run --rm -v "$PWD":/work klaus validate flows/
#   docker run --rm -v "$PWD":/work -p 4884:4884 klaus ui --host 0.0.0.0 --no-open
#
# `klaus ui` は既定で 127.0.0.1 に bind するため、コンテナの外から届くよう
# `--host 0.0.0.0 --no-open` を明示する(既定値は変更しない)。
# /work はユーザーのフローをバインドマウントする場所。klaus run は /work 配下に
# .klaus/history/*.jsonl を書くため、マウント元が実行ユーザー(node, uid 1000)から
# 書き込めるようにすること。
#
# 方針は verify/docker/Dockerfile と同じ: ベースイメージは node:26.12-slim をタグ + digest で固定し、
# pnpm は公式 GitHub Release のスタンドアロンバイナリを ADD --checksum で取得する
# (更新手順は verify/docker/Dockerfile のコメントを参照。pnpm の版は CI と揃える)。
ARG TARGETARCH

FROM scratch AS pnpm-amd64
ADD --checksum=sha256:565ff81174a14f6f7bd5d84c1b17e51031a80230d370a1fe24be5d16bd02a825 \
    https://github.com/pnpm/pnpm/releases/download/v12.16.1/pnpm-linux-x64.tar.gz /pnpm.tar.gz

FROM scratch AS pnpm-arm64
ADD --checksum=sha256:f5847699e5d528f8f8e9bcfb385e58cb9fba7482af1b1aa7b70737be42277f81 \
    https://github.com/pnpm/pnpm/releases/download/v12.16.1/pnpm-linux-arm64.tar.gz /pnpm.tar.gz

# COPY --from は変数展開を受け付けないため、グローバル ARG でステージを選ぶ中継ステージを挟む
FROM pnpm-${TARGETARCH} AS pnpm

# ---- build: ソースから dist を作り、npm 公開物と同じ内容(files フィールド)に絞って pack する ----
FROM node:26.12-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0 AS build

COPY --from=pnpm /pnpm.tar.gz /tmp/pnpm.tar.gz
RUN mkdir -p /opt/pnpm \
    && tar -xzf /tmp/pnpm.tar.gz -C /opt/pnpm --no-same-owner
ENV PATH=/opt/pnpm:${PATH}

WORKDIR /src

# 依存解決を先に行い、ソース変更時にもレイヤーキャッシュを効かせる(workspace は ui/ を含む)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ui/package.json ./ui/package.json
RUN CI=true pnpm install --frozen-lockfile

COPY . .
# clean → tsup → JSON Schema → UI(dist/ui)。リリースと同じ build:all を使う
RUN pnpm build:all \
    && mkdir /out \
    && pnpm pack --pack-destination /out \
    && mkdir /pkg \
    && tar -xzf /out/*.tgz -C /pkg

# 実行時依存(zod のみ。型のために dependencies に残している)を本番依存だけで入れる。
# 公開から 7 日未満の版は解決しない(pnpm-workspace.yaml の minimumReleaseAge と同じ方針)。
WORKDIR /pkg/package
RUN CI=true pnpm_config_minimum_release_age=10080 pnpm install --prod --ignore-scripts

# ---- runtime: 公開パッケージ相当の内容 + 本番依存のみ ----
FROM node:26.12-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0

# dist/cli.js から見て dist/ui を解決する(src/server/index.ts)ため、dist 構造を保ったまま置く
COPY --from=build /pkg/package /opt/klaus
RUN ln -s /opt/klaus/dist/cli.js /usr/local/bin/klaus \
    && chmod +x /opt/klaus/dist/cli.js \
    && mkdir -p /work \
    && chown node:node /work

WORKDIR /work
USER node
EXPOSE 4884

ENTRYPOINT ["klaus"]
