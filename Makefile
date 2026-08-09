# Docker での publish 相当検証(VERIFICATION.md 4.5 参照)。
#
#   make verify        # 構築 + 検証フロー実行。demo API は起動したまま残るので、
#                      # そのあと自分で klaus を実行できる:
#                      #   docker compose -f verify/docker/compose.yaml run --rm klaus --help
#                      #   docker compose -f verify/docker/compose.yaml run --rm klaus run flows/auth-flow.yaml
#   make verify-down   # コンテナ・ネットワークを片付ける

.PHONY: verify verify-down

verify:
	./verify/docker/run.sh --keep

verify-down:
	docker compose -f verify/docker/compose.yaml down -v --remove-orphans
