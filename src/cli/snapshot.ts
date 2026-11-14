import type { Command } from "commander";
import {
  acceptSnapshot,
  describeSnapshotDifference,
  listSnapshotMismatches,
  readAllHistoryEntries,
  type SnapshotMismatch,
  selectRunEntries,
} from "../core/index.js";
import { runCommandAction } from "./command-action.js";
import { sanitizeForTerminal } from "./reporters/sanitize.js";
import { truncate } from "./reporters/text.js";

/** snapshot list / accept 共通のオプション(commander から渡される値を正規化した形) */
export interface SnapshotCommandOptions {
  /** accept: このステップ名のものだけを承認する(list では表示を絞る) */
  step?: string;
  json?: boolean;
  text?: boolean;
}

/** 引数の誤り・不明な run・承認対象なしは exit 1(klaus history show / promote と同じ) */
function fail(message: string): number {
  process.stderr.write(`klaus: ${message}\n`);
  return 1;
}

function resolveUseJson(options: SnapshotCommandOptions): boolean {
  return options.json === true ? true : options.text === true ? false : !process.stdout.isTTY;
}

/**
 * runId を決める。省略時は履歴で最も新しい、snapshot アサーションを含む run。
 * 見つからなければ undefined。
 */
async function resolveRunId(cwd: string, runId: string | undefined): Promise<string | undefined> {
  if (runId !== undefined) return runId;
  const history = await readAllHistoryEntries(cwd);
  return history.find((entry) => entry.assertions.some((a) => a.snapshot !== undefined))?.runId;
}

/** 表示用の 1 件(JSON 出力と共通)。candidate は含めない(応答全体のコピーのため) */
function toReportItem(mismatch: SnapshotMismatch) {
  return {
    flow: mismatch.flow,
    step: mismatch.step,
    ...(mismatch.iteration !== undefined ? { iteration: mismatch.iteration } : {}),
    ...(mismatch.flowFile !== undefined ? { flowFile: mismatch.flowFile } : {}),
    snapshotFile: mismatch.snapshotFile,
    key: mismatch.key,
    state: mismatch.state,
    message: mismatch.message,
    differences: mismatch.differences,
    differenceCount: mismatch.differenceCount,
  };
}

/** 承認待ちを text の行にする(キー・ファイル・差分の先頭数件) */
function formatMismatchText(mismatch: SnapshotMismatch): string {
  const head = `${mismatch.state === "missing" ? "MISSING " : "MISMATCH"} ${sanitizeForTerminal(mismatch.key)} (${sanitizeForTerminal(mismatch.snapshotFile)})`;
  const lines = [head];
  for (const difference of mismatch.differences.slice(0, 5)) {
    lines.push(`    ${truncate(sanitizeForTerminal(describeSnapshotDifference(difference)))}`);
  }
  const rest = mismatch.differenceCount - Math.min(mismatch.differences.length, 5);
  if (rest > 0) lines.push(`    ... ${rest} more`);
  return lines.join("\n");
}

/** `klaus snapshot list [runId]` の本体。履歴を読むだけで何も書かない */
export async function snapshotListCommand(
  runId: string | undefined,
  options: SnapshotCommandOptions,
  cwd: string = process.cwd(),
): Promise<number> {
  if (options.json === true && options.text === true) {
    return fail("--json and --text cannot be used together");
  }
  const target = await resolveRunId(cwd, runId);
  if (target === undefined) return fail("no history entries with snapshot assertions found");
  if (selectRunEntries(await readAllHistoryEntries(cwd), target).length === 0) {
    return fail(`no history entries found for runId "${target}"`);
  }
  const mismatches = (await listSnapshotMismatches(cwd, target)).filter(
    (m) => options.step === undefined || m.step === options.step,
  );
  if (resolveUseJson(options)) {
    process.stdout.write(
      `${JSON.stringify({ version: 1, runId: target, mismatches: mismatches.map(toReportItem) })}\n`,
    );
  } else if (mismatches.length === 0) {
    process.stdout.write(`run ${target}: no pending snapshot mismatches\n`);
  } else {
    process.stdout.write(
      `run ${target}: ${mismatches.length} pending snapshot mismatch${mismatches.length === 1 ? "" : "es"}\n${mismatches.map(formatMismatchText).join("\n")}\n`,
    );
  }
  return 0;
}

/**
 * `klaus snapshot accept <runId> [--step <name>]` の本体。履歴に記録された(マスク済みの)応答から、
 * 承認待ちのスナップショットを基準として書き込む。--step を省略すると、その run の承認待ちすべてが対象。
 * exit code: 成功 0 / 引数不正・不明な run・承認対象なし 1 / 書き込み先として許可できない・壊れたファイル 2
 */
export async function snapshotAcceptCommand(
  runId: string,
  options: SnapshotCommandOptions,
  cwd: string = process.cwd(),
): Promise<number> {
  if (options.json === true && options.text === true) {
    return fail("--json and --text cannot be used together");
  }
  if (selectRunEntries(await readAllHistoryEntries(cwd), runId).length === 0) {
    return fail(`no history entries found for runId "${runId}"`);
  }
  const pending = (await listSnapshotMismatches(cwd, runId)).filter(
    (m) => options.step === undefined || m.step === options.step,
  );
  if (pending.length === 0) {
    return fail(
      options.step !== undefined
        ? `run "${runId}" has no pending snapshot for step "${options.step}"`
        : `run "${runId}" has no pending snapshot mismatches`,
    );
  }

  const accepted: { key: string; snapshotFile: string; state: "written" | "updated" }[] = [];
  const failed: { key: string; snapshotFile: string; kind: string; message: string }[] = [];
  for (const mismatch of pending) {
    const outcome = await acceptSnapshot(cwd, runId, {
      snapshotFile: mismatch.snapshotFile,
      key: mismatch.key,
    });
    if (outcome.ok) {
      accepted.push({ key: outcome.key, snapshotFile: outcome.snapshotFile, state: outcome.state });
    } else {
      failed.push({
        key: mismatch.key,
        snapshotFile: mismatch.snapshotFile,
        kind: outcome.kind,
        message: outcome.message,
      });
    }
  }

  if (resolveUseJson(options)) {
    process.stdout.write(`${JSON.stringify({ version: 1, runId, accepted, failed })}\n`);
  } else {
    for (const item of accepted) {
      process.stdout.write(
        `${item.state}: ${sanitizeForTerminal(item.key)} -> ${sanitizeForTerminal(item.snapshotFile)}\n`,
      );
    }
    for (const item of failed) {
      process.stdout.write(
        `failed: ${sanitizeForTerminal(item.key)} (${sanitizeForTerminal(item.snapshotFile)}): ${sanitizeForTerminal(item.message)}\n`,
      );
    }
  }
  return failed.length > 0 ? 2 : 0;
}

/** program に `klaus snapshot` を登録する(src/cli/index.ts から呼ぶ) */
export function registerSnapshotCommand(program: Command): void {
  const snapshot = program
    .command("snapshot")
    .description(
      "review and accept assert.snapshot results recorded in history (list pending mismatches, write them as the new baseline)",
    );

  snapshot
    .command("list")
    .description(
      "list the snapshot mismatches of a run that are waiting to be accepted (read-only; default: the latest run with snapshot assertions)",
    )
    .argument("[runId]", "run ID (see `klaus history`)")
    .option("--step <name>", "only the snapshots of this step")
    .option("--json", "force JSON output (prints JSON even when running on a TTY)")
    .option("--text", "force text output (prints text even when stdout is not a TTY)")
    .addHelpText(
      "after",
      `
Exit codes: 0=success / 1=unknown run or no run with snapshot assertions, invalid arguments, or unexpected error
`,
    )
    .action(async (runId: string | undefined, options: SnapshotCommandOptions) => {
      await runCommandAction(() => snapshotListCommand(runId, options));
    });

  snapshot
    .command("accept")
    .description(
      "write the pending snapshot mismatches of a run as the new baseline, from the masked responses recorded in history (only files under __snapshots__ are written)",
    )
    .argument("<runId>", "run ID whose pending snapshots to accept (see `klaus snapshot list`)")
    .option("--step <name>", "only accept the snapshots of this step (default: all pending)")
    .option("--json", "force JSON output (prints JSON even when running on a TTY)")
    .option("--text", "force text output (prints text even when stdout is not a TTY)")
    .addHelpText(
      "after",
      `
Exit codes: 0=success / 1=unknown run, nothing pending to accept, invalid arguments, or unexpected error / 2=a snapshot file is corrupt or cannot be written safely
Review the resulting diff of the __snapshots__ files before committing.
`,
    )
    .action(async (runId: string, options: SnapshotCommandOptions) => {
      await runCommandAction(() => snapshotAcceptCommand(runId, options));
    });
}
