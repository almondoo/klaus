import type { DataRow } from "./data.js";
import { loadEnvironment, toTemplateVariables } from "./env.js";
import { GuardRefusalError, KlausError } from "./errors.js";
import type { GuardOptions } from "./guard.js";
import {
  assertSendAllowed,
  buildRunUnits,
  buildStepGuard,
  expandStepRequest,
  isSseStep,
  type LoadedFlowEntry,
  type StepGuard,
} from "./runner.js";
import type { Environment, Flow, Step } from "./schema.js";
import type { TemplateContext } from "./template.js";
import type { RequestSnapshot } from "./types.js";

/** dry-run のオプション。RunFlowOptions のうち、送信を伴わない展開・判定に必要なものだけを受け取る */
export interface DryRunOptions {
  cwd?: string;
  /** フロー定義の env を上書きする環境名(RunFlowOptions.envNameOverride と同じ意味) */
  envNameOverride?: string | undefined;
  /** 任意パスの環境ファイル(RunFlowOptions.envFilePath と同じ意味) */
  envFilePath?: string | undefined;
  /** テンプレートの env 名前空間へ上書きマージする追加変数(RunFlowOptions.variables と同じ意味) */
  variables?: Record<string, string> | undefined;
  /** $protected の環境への実行を許可するか(実行時の --allow-protected と同じ。dry-run でも同じ判定にする) */
  allowProtected?: boolean | undefined;
  /** 送信先ホストの許可リスト(実行時と同じ判定を通す) */
  guard?: GuardOptions | undefined;
  /** --data の行データ。実行時と同じ順序(行(外側) × フロー(内側))でユニットに展開する */
  dataRows?: DataRow[] | undefined;
  /**
   * 展開で解決した {{env.X}} の値(シークレット)を呼び出し元へ渡すコールバック(RunFlowOptions.onSecrets と同じ用途)。
   * 呼び出し元がマスクに使う。ユニット(行 × フローの組)ごとに、収集済みの値の全体を渡す
   */
  onSecrets?: ((secrets: readonly string[]) => void) | undefined;
}

/** 安全柵の判定結果。undetermined は、判定に必要な送信先ホストが未解決の変数に依存していて決められない場合 */
export type DryRunGuardStatus = "allowed" | "refused" | "undetermined";

/** dry-run での 1 ステップの結果 */
export interface DryRunStepResult {
  name: string;
  /** ステップの種別(http / sse / ws) */
  kind: "http" | "sse" | "ws";
  /**
   * テンプレート展開後の送信内容。前段の capture に依存する変数は `{{name}}` のまま残る。
   * 展開が実行時にも失敗する場合(error が設定される場合)は省略する
   */
  request?: RequestSnapshot;
  /** 前段の capture に依存するため解決できず、`{{name}}` のまま残した変数名(出現順、重複なし) */
  unresolved: string[];
  /** `if` 条件を持つか。条件は実行時のステータス・capture に依存するため dry-run では評価しない */
  conditional: boolean;
  /** `if` の条件式のテキスト(conditional のときのみ) */
  if?: string;
  /** 実行時と同じ安全柵の判定結果。refused の場合 reason に拒否理由が入る */
  guard: { status: DryRunGuardStatus; reason?: string };
  /**
   * 実行時にも必ず失敗する展開エラー(前段の capture でも環境でもない変数の参照、未定義の OS 環境変数)。
   * 実行時と同じメッセージになる
   */
  error?: string;
}

/** dry-run での 1 フロー(1 ユニット)の結果 */
export interface DryRunFlowResult {
  name: string;
  file: string;
  /** --data 実行時のみ設定される 1 始まりのイテレーション番号 */
  iteration?: number;
  steps: DryRunStepResult[];
}

/** dry-run の結果 */
export interface DryRunResult {
  /** 実行時と同じ入力順(行(外側) × フロー(内側)) */
  flows: DryRunFlowResult[];
}

/** ステップ種別。展開前に判定できるため、展開に失敗したステップにも付けられる */
function stepKind(step: Step): "http" | "sse" | "ws" {
  if (step.ws) return "ws";
  return isSseStep(step) ? "sse" : "http";
}

/**
 * 展開後の URL の「スキーム + オーソリティ」部にプレースホルダーが残っている(または URL として
 * 先頭を読み取れない)ため、送信先ホストを決められないかどうかを返す。
 * パスやクエリに未解決の変数が残っていても、ホストが確定していれば判定できる。
 */
function isHostUndetermined(url: string): boolean {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url);
  return match === null || (match[1] as string).includes("{{");
}

/**
 * 実行時と同じ安全柵(assertSendAllowed)を展開後の送信内容に適用し、結果を返す。
 * 拒否は例外(GuardRefusalError)なので、ここで捕まえて reason にする。
 * ホストが未解決の変数に依存する場合は、ホストに依存しない判定(保護環境・メソッド・上書きヘッダー)だけを行い、
 * それで拒否されなければ、許可リストが設定されているときに限り undetermined にする。
 */
function evaluateGuard(
  stepGuard: StepGuard | undefined,
  snapshot: RequestSnapshot,
  hasUnresolved: boolean,
): DryRunStepResult["guard"] {
  const hostUndetermined = hasUnresolved && isHostUndetermined(snapshot.url);
  try {
    assertSendAllowed(stepGuard, snapshot.method, snapshot.url, snapshot.headers, hostUndetermined);
  } catch (error) {
    if (error instanceof GuardRefusalError) {
      return { status: "refused", reason: error.message };
    }
    throw error;
  }
  if (hostUndetermined && stepGuard?.options?.allowedHosts !== undefined) {
    return {
      status: "undetermined",
      reason:
        "the target host depends on a variable captured by an earlier step, so guard.allowedHosts cannot be checked yet",
    };
  }
  return { status: "allowed" };
}

/** 1 ステップを送信せずに展開し、安全柵を判定する */
function dryRunStep(
  step: Step,
  baseContext: { env: Environment; secrets: Set<string> },
  stepGuard: StepGuard | undefined,
  /** このステップより前のステップが capture で定義する変数名 */
  priorCaptureNames: ReadonlySet<string>,
): DryRunStepResult {
  const unresolved = new Set<string>();
  const templateContext: TemplateContext = {
    captures: {},
    env: baseContext.env,
    secrets: baseContext.secrets,
    deferred: priorCaptureNames,
    unresolved,
  };
  const common = {
    name: step.name,
    kind: stepKind(step),
    conditional: step.if !== undefined,
    ...(step.if !== undefined ? { if: step.if } : {}),
  };

  try {
    const { snapshot } = expandStepRequest(step, templateContext);
    return {
      ...common,
      request: snapshot,
      unresolved: [...unresolved],
      guard: evaluateGuard(stepGuard, snapshot, unresolved.size > 0),
    };
  } catch (error) {
    // 前段の capture ではない未解決変数・未定義の OS 環境変数は、実行時にも必ず同じエラーになる
    if (error instanceof KlausError) {
      return {
        ...common,
        unresolved: [...unresolved],
        guard: {
          status: "undetermined",
          reason: "the request could not be expanded (see error)",
        },
        error: error.message,
      };
    }
    throw error;
  }
}

/**
 * 既に読み込み済みの Flow 1 件を、リクエストを送らずに展開して安全柵を判定する(1 ユニット分)。
 * 履歴・カセットには一切触れず、リトライ・アサーション・capture は行わない。
 * 環境ファイルの読み込み失敗は executeFlow と同じく ParseError として投げる。
 */
export async function dryRunFlow(
  flow: Flow,
  filePath: string,
  options: DryRunOptions = {},
  iteration?: number,
): Promise<DryRunFlowResult> {
  const cwd = options.cwd ?? process.cwd();
  const environment = await loadEnvironment(
    cwd,
    flow.env,
    options.envNameOverride,
    options.envFilePath,
  );
  const stepGuard = buildStepGuard(
    options.envFilePath ?? options.envNameOverride ?? flow.env,
    environment,
    options.allowProtected,
    options.guard,
  );
  const secrets = new Set<string>();
  // --var は環境ファイルの値を上書きする(executeFlow と同じ優先順位)
  const baseContext = {
    env: { ...toTemplateVariables(environment), ...options.variables },
    secrets,
  };

  const priorCaptureNames = new Set<string>();
  const steps: DryRunStepResult[] = [];
  for (const step of flow.steps) {
    steps.push(dryRunStep(step, baseContext, stepGuard, priorCaptureNames));
    for (const name of Object.keys(step.capture ?? {})) priorCaptureNames.add(name);
  }

  options.onSecrets?.([...secrets]);
  return {
    name: flow.name,
    file: filePath,
    steps,
    ...(iteration !== undefined ? { iteration } : {}),
  };
}

/**
 * 読み込み済みの Flow 群を、runLoadedFlows と同じユニット展開(行(外側) × フロー(内側))で dry-run する。
 * 送信を伴わないため並列化せず、常に入力順に逐次処理する(--jobs を指定しても出力順は変わらない)。
 */
export async function dryRunLoadedFlows(
  entries: LoadedFlowEntry[],
  options: DryRunOptions = {},
): Promise<DryRunResult> {
  const units = buildRunUnits(entries, {
    variables: options.variables,
    dataRows: options.dataRows,
  });
  const flows: DryRunFlowResult[] = [];
  for (const unit of units) {
    flows.push(
      await dryRunFlow(
        unit.flow,
        unit.filePath,
        { ...options, ...(unit.variables !== undefined ? { variables: unit.variables } : {}) },
        unit.iteration,
      ),
    );
  }
  return { flows };
}
