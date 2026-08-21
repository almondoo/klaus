# Docker での publish 相当検証(verify/README.md、verify/CHECKLIST.md「make verify のコンテナで実行する場合」参照)。
#
#   make verify        # 構築 + 検証フロー実行。mock-api / klaus コンテナは起動したまま残る
#   make exec          # 常駐 klaus コンテナに bash で入り、klaus を自由に実行する
#   make verify-down   # コンテナ・ネットワークを片付ける

.PHONY: verify exec verify-down

verify:
	./verify/docker/run.sh

# 常駐の klaus コンテナに入る(事前に make verify で起動しておくこと)。
# exit で抜けてもコンテナは残り、再度 make exec で同じコンテナに戻れる。
exec:
	docker compose -f verify/docker/compose.yaml exec --workdir /work/examples klaus bash

verify-down:
	docker compose -f verify/docker/compose.yaml down -v --remove-orphans
