import { describe, expect, it } from "vitest";
import type { HistoryRunGroup } from "./history";
import {
  buildPromoteBody,
  DEFAULT_PROMOTE_FORM,
  distinctFlowNames,
  explainPromoteError,
  orderedRunIds,
  validateBaseUrlVar,
} from "./promote";

function group(runId: string, startedAt: string, flows: string[]): HistoryRunGroup {
  return {
    runId,
    flow: flows[0] as string,
    startedAt,
    durationMs: 1,
    status: "passed",
    steps: flows.map((flow) => ({
      v: 1,
      runId,
      flow,
      step: "s",
      startedAt,
      durationMs: 1,
      assertions: [],
    })),
  };
}

describe("buildPromoteBody", () => {
  it("既定値は schema アサーション・チェイン有効で、空の項目は送らない", () => {
    expect(buildPromoteBody(["r1"], DEFAULT_PROMOTE_FORM, true)).toEqual({
      runIds: ["r1"],
      assert: "schema",
      chain: true,
      dryRun: true,
    });
  });

  it("入力した項目は前後の空白を除いて送る", () => {
    expect(
      buildPromoteBody(
        ["r1", "r2"],
        {
          assert: "values",
          baseUrlVar: " baseUrl ",
          chain: false,
          name: " my flow ",
          out: " flows/x.yaml ",
          flow: "orders",
        },
        false,
      ),
    ).toEqual({
      runIds: ["r1", "r2"],
      assert: "values",
      chain: false,
      flow: "orders",
      baseUrlVar: "baseUrl",
      name: "my flow",
      out: "flows/x.yaml",
      dryRun: false,
    });
  });
});

describe("validateBaseUrlVar", () => {
  it("空は未指定として有効、識別子は有効、それ以外はメッセージを返す", () => {
    expect(validateBaseUrlVar("")).toBeNull();
    expect(validateBaseUrlVar("base_url2")).toBeNull();
    expect(validateBaseUrlVar("2base")).not.toBeNull();
    expect(validateBaseUrlVar("a-b")).not.toBeNull();
  });
});

describe("選択した run の整理", () => {
  it("runId は重複を除いて古い順に並ぶ", () => {
    const groups = [
      group("r2", "2026-01-02T00:00:00Z", ["f"]),
      group("r1", "2026-01-01T00:00:00Z", ["f"]),
      group("r2", "2026-01-02T00:00:00Z", ["f"]),
    ];
    expect(orderedRunIds(groups)).toEqual(["r1", "r2"]);
  });

  it("フロー名は記録名を重複なく返し、単発リクエストは含めない", () => {
    const groups = [
      group("r1", "2026-01-01T00:00:00Z", ["a", "b"]),
      group("r2", "2026-01-02T00:00:00Z", ["a", "(single)"]),
    ];
    expect(distinctFlowNames(groups)).toEqual(["a", "b"]);
  });
});

describe("explainPromoteError", () => {
  it("テンプレートのリテラルによる拒否は理由と対処を説明する", () => {
    const explanation = explainPromoteError(422, 'literal "{{" found', "template-literal");
    expect(explanation.title).toContain("{{");
    expect(explanation.hint).toContain("OS 環境変数");
    expect(explanation.detail).toBe('literal "{{" found');
  });

  it("フロー化できるステップが無い 422 は専用の説明にする", () => {
    expect(
      explainPromoteError(422, "no promotable steps (every recorded step was skipped)").title,
    ).toContain("ステップがありません");
  });

  it("その他の 422 は汎用の拒否として扱う", () => {
    expect(explainPromoteError(422, "boom").title).toContain("フローとして保存できません");
  });

  it("409 / 403 は保存先の欄に結び付け、Forbidden 接頭辞を取り除く", () => {
    expect(explainPromoteError(409, "exists").field).toBe("out");
    const forbidden = explainPromoteError(403, "Forbidden: path traversal detected");
    expect(forbidden.field).toBe("out");
    expect(forbidden.detail).toBe("path traversal detected");
  });

  it("400 / 404 / その他にも説明を返す", () => {
    expect(explainPromoteError(400, "bad").title).toContain("入力");
    expect(explainPromoteError(404, "none").title).toContain("見つかりません");
    expect(explainPromoteError(undefined, "network").title).toContain("生成できませんでした");
  });
});
