# publish 後にユーザーが受け取る状態を再現するための klaus イメージ。
# ビルドコンテキストは verify/docker/.pack/(tarball とこのファイルのコピーのみ)であり、
# リポジトリの node_modules は一切持ち込まない。zod はここで npm レジストリから
# 取得される(dependencies に残しているため、実際のユーザー環境と同じ挙動)。
# このリポジトリの方針でイメージ内でも npm / npx / corepack は使わず、pnpm で
# グローバルインストールする(npm 固有のグローバルインストール挙動の差異は検証対象外)。
# ベースイメージはタグに加えて digest(マルチアーキの index digest)でも固定する。
# 同じタグが後から差し替えられても、検証環境に意図しないイメージが混入しない。
# 更新手順: `docker buildx imagetools inspect node:<新タグ>` で Digest を取得し、
# 公開から 7 日以上経ったタグを選んで、このファイルと Dockerfile.mock-api の両方を更新する(Dependabot は両ファイルのタグと digest を更新する)。
#
# pnpm は slim イメージに corepack / curl が無いため、公式 GitHub Release の
# スタンドアロンバイナリ(tar.gz)を ADD --checksum で取得する。sha256 が一致しなければ
# ビルドが失敗するので、ダウンロードが改ざんされても検証環境に混入しない。
# sha256 は GitHub Release API の assets[].digest と、実ファイルの shasum -a 256 の一致を確認済み。
# 更新手順: 公開から 7 日以上経った pnpm の版を選び、
# `gh-api-get repos/pnpm/pnpm/releases/tags/v<版> --jq '.assets[] | {name, digest}'` で
# pnpm-linux-x64.tar.gz / pnpm-linux-arm64.tar.gz の digest を取得して、
# このファイルと Dockerfile.mock-api の URL と sha256 を両方更新する(Dependabot は更新しないため手動)
# (版は CI の pnpm と揃える)。
# amd64 / arm64 の両方に対応するため、アーキごとにステージを分けて TARGETARCH で選ぶ
# (ビルド対象でないアーキのステージは BuildKit がビルドしないのでダウンロードも走らない)。
ARG TARGETARCH

FROM scratch AS pnpm-amd64
ADD --checksum=sha256:565ff81174a14f6f7bd5d84c1b17e51031a80230d370a1fe24be5d16bd02a825 \
    https://github.com/pnpm/pnpm/releases/download/v12.16.1/pnpm-linux-x64.tar.gz /pnpm.tar.gz

FROM scratch AS pnpm-arm64
ADD --checksum=sha256:f5847699e5d528f8f8e9bcfb385e58cb9fba7482af1b1aa7b70737be42277f81 \
    https://github.com/pnpm/pnpm/releases/download/v12.16.1/pnpm-linux-arm64.tar.gz /pnpm.tar.gz

# COPY --from は変数展開を受け付けないため、グローバル ARG でステージを選ぶ中継ステージを挟む
FROM pnpm-${TARGETARCH} AS pnpm

FROM node:26.12-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0

WORKDIR /work

# tar.gz には実行ファイル pnpm と、同じ階層に置く必要がある dist/ が入っているため、
# 展開したディレクトリごと /opt/pnpm に置いて PATH に通す(pnpm 単体のコピーでは動かない)。
COPY --from=pnpm /pnpm.tar.gz /tmp/pnpm.tar.gz
RUN mkdir -p /opt/pnpm \
    && tar -xzf /tmp/pnpm.tar.gz -C /opt/pnpm --no-same-owner \
    && rm /tmp/pnpm.tar.gz

# pnpm 12 のグローバル bin は $PNPM_HOME/bin(PATH に無いとグローバルインストールが失敗する)。
# 非 root の node ユーザーでも klaus を実行できるよう、読み取り可能な共有パスにする。
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=/opt/pnpm:${PNPM_HOME}/bin:${PATH}

# グローバルインストールは PNPM_HOME への書き込みが必要なため root(デフォルト)で行う。
# pnpm_config_minimum_release_age(分)でレジストリ経由の依存(zod 等)にも公開から 7 日以上の
# 版しか解決させない(10080 分)。ビルドスクリプトは pnpm の既定どおり許可しない。
COPY klaus.tgz /tmp/klaus.tgz
RUN pnpm_config_minimum_release_age=10080 pnpm add -g /tmp/klaus.tgz \
    && rm /tmp/klaus.tgz

# klaus run は既定で cwd(/work)配下に .klaus/history/*.jsonl を書き込むため、
# 非 root ユーザーへ切り替える前に書き込み権限を渡しておく。
RUN chown node:node /work

# 実行時は公式イメージが用意する非 root ユーザー node に切り替える。
USER node

ENTRYPOINT ["klaus"]
