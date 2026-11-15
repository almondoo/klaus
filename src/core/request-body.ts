import { Blob } from "node:buffer";
import { constants, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { FormData } from "undici";
import { GuardRefusalError, RuntimeError } from "./errors.js";
import { isPathWithinDir, isRealPathWithinDir, toDisplayPath } from "./path-guard.js";
import type { RequestDef } from "./schema.js";
import { renderString, type TemplateContext } from "./template.js";

/**
 * 送信するファイル(bodyFile と multipart のファイルパート)の合計サイズの上限(100 MiB)。
 * 巨大なファイルを誤って指定してもメモリを使い切らないための上限で、超えるとステップは error になる。
 */
export const MAX_INPUT_FILE_BYTES = 100 * 1024 * 1024;

function tooLarge(label: string, display: string, limit: number): RuntimeError {
  return new RuntimeError(
    `${label} file "${display}" exceeds the limit of ${limit} bytes for files sent in a request`,
  );
}

/** cwd 配下の入力ファイル(multipart のファイルパートと bodyFile)を検証した結果 */
interface InputFile {
  /** 絶対パス */
  absolutePath: string;
  /** cwd からの POSIX 形式の相対パス(履歴・出力に残す表示用) */
  display: string;
  size: number;
}

/**
 * 送信するファイルを検証する。cwd 配下(シンボリックリンクを解決した実パスでも)に限り、通常ファイルのみ許可する。
 * エージェントが書いたフローで任意のファイルを送信先へ流せないようにするための境界で、`step.use` や
 * `klaus req --body @file` と同じ規則(path-guard)を使う。境界外は安全柵の拒否(GuardRefusalError)として
 * 履歴にも記録される。
 */
function resolveInputFile(cwd: string, rawPath: string, label: string): InputFile {
  const resolvedCwd = resolve(cwd);
  const absolutePath = resolve(resolvedCwd, rawPath);
  if (
    !isPathWithinDir(resolvedCwd, absolutePath) ||
    !isRealPathWithinDir(resolvedCwd, absolutePath)
  ) {
    throw new GuardRefusalError(
      `${label} file resolves outside the current directory: "${rawPath}" (files sent in a request must be inside the cwd)`,
      "guard.path",
    );
  }
  let size: number;
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      throw new RuntimeError(`${label} path is not a regular file: "${rawPath}"`);
    }
    size = stat.size;
    if (size > MAX_INPUT_FILE_BYTES) {
      throw tooLarge(label, toDisplayPath(resolvedCwd, absolutePath), MAX_INPUT_FILE_BYTES);
    }
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new RuntimeError(`failed to read ${label} file "${rawPath}"${code ? ` (${code})` : ""}`);
  }
  return { absolutePath, display: toDisplayPath(resolvedCwd, absolutePath), size };
}

/** 送信直前にファイルを読む入力。展開後(テンプレート解決済み)のパス情報だけを持ち、内容は持たない */
export type BodyPayload =
  | {
      kind: "multipart";
      parts: (
        | { name: string; value: string }
        | { name: string; path: string; filename: string; contentType?: string }
      )[];
    }
  | { kind: "file"; path: string };

/** expandBodyForm の結果 */
export interface ExpandedBodyForm {
  /** 履歴・dry-run に残す表現(ファイルの内容は含めず、ファイル名とサイズだけ) */
  snapshotBody: unknown;
  /** 既定で付ける Content-Type(ユーザー指定があれば付けない)。undefined なら付けない */
  contentType?: string;
  payload?: BodyPayload;
}

/** request.form / request.multipart / request.bodyFile のいずれかがあれば展開する。無ければ undefined */
export function expandBodyForm(
  request: RequestDef,
  context: TemplateContext,
  cwd: string,
): ExpandedBodyForm | undefined {
  if (request.form !== undefined) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(request.form)) {
      form.append(key, renderString(value, context));
    }
    // 秘密値が form-urlencoded の形で入っても、履歴のマスクが同じ形を展開して覆う
    return {
      snapshotBody: form.toString(),
      contentType: "application/x-www-form-urlencoded",
    };
  }

  if (request.multipart !== undefined) {
    const snapshot: Record<string, unknown> = {};
    const parts: Extract<BodyPayload, { kind: "multipart" }>["parts"] = [];
    for (const [name, spec] of Object.entries(request.multipart)) {
      if (typeof spec === "string") {
        const value = renderString(spec, context);
        snapshot[name] = value;
        parts.push({ name, value });
        continue;
      }
      const rawPath = renderString(spec.file, context);
      const file = resolveInputFile(cwd, rawPath, "multipart");
      const filename =
        spec.filename !== undefined
          ? renderString(spec.filename, context)
          : (file.display.split("/").pop() as string);
      const contentType =
        spec.contentType !== undefined ? renderString(spec.contentType, context) : undefined;
      // 内容は残さず、ファイル名・パス・サイズだけを記録する
      snapshot[name] = {
        file: file.display,
        filename,
        ...(contentType !== undefined ? { contentType } : {}),
        size: file.size,
      };
      parts.push({
        name,
        path: file.absolutePath,
        filename,
        ...(contentType !== undefined ? { contentType } : {}),
      });
    }
    return {
      snapshotBody: snapshot,
      // boundary は送信時に決まるため、表示用には種別だけを示す(送信ヘッダーには使わない)
      contentType: "multipart/form-data",
      payload: { kind: "multipart", parts },
    };
  }

  if (request.bodyFile !== undefined) {
    const rawPath = renderString(request.bodyFile, context);
    const file = resolveInputFile(cwd, rawPath, "bodyFile");
    return {
      snapshotBody: { bodyFile: file.display, size: file.size },
      payload: { kind: "file", path: file.absolutePath },
    };
  }
  return undefined;
}

/**
 * 送信直前にファイルを読む。展開後の検証から時間が空くため、検証と読み取りの間にパスを差し替えられても
 * 追従しないよう、次の順で行う。
 * 1. パスを解決して cwd 配下を確認する
 * 2. 解決後のパスを O_NOFOLLOW で開く(最後の要素がシンボリックリンクに差し替わっていたら失敗する)
 * 3. 開いたディスクリプタを fstat し、通常ファイルであること・サイズ上限内であること・
 *    パスの現在の実体(解決先と dev / ino)がディスクリプタと同じであること(途中のディレクトリの差し替えも検出)を確認する
 * 4. そのディスクリプタから読む
 * remaining は、同じリクエストの他のファイルと合わせた残りの読み取り可能バイト数。
 */
async function readInputFile(
  cwd: string,
  path: string,
  label: string,
  remaining: number,
): Promise<Buffer> {
  const checked = resolveInputFile(cwd, path, label);
  const resolvedCwd = resolve(cwd);
  const failure = (code?: string) =>
    new RuntimeError(
      `failed to read ${label} file "${checked.display}"${code ? ` (${code})` : ""}`,
    );
  let real: string;
  try {
    real = realpathSync(checked.absolutePath);
  } catch (error) {
    throw failure((error as NodeJS.ErrnoException).code);
  }
  const changed = () =>
    new GuardRefusalError(
      `${label} file changed while it was being read: "${checked.display}" (files sent in a request must be inside the cwd)`,
      "guard.path",
    );
  if (!isPathWithinDir(resolvedCwd, real) || !isRealPathWithinDir(resolvedCwd, real)) {
    throw changed();
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // O_NOFOLLOW で最後の要素がシンボリックリンクだった場合は ELOOP(差し替えとして扱う)
    if (code === "ELOOP") throw changed();
    throw failure(code);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw failure("not a regular file");
    if (opened.size > MAX_INPUT_FILE_BYTES || opened.size > remaining) {
      throw tooLarge(label, checked.display, MAX_INPUT_FILE_BYTES);
    }
    let current: ReturnType<typeof statSync>;
    let currentReal: string;
    try {
      currentReal = realpathSync(checked.absolutePath);
      current = statSync(currentReal);
    } catch (error) {
      throw failure((error as NodeJS.ErrnoException).code);
    }
    if (
      currentReal !== real ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      !isRealPathWithinDir(resolvedCwd, currentReal)
    ) {
      throw changed();
    }
    // 読む量は fstat の大きさ + 1 までに抑える(読み取り中に伸びたファイルでも上限を超えて読まない)
    const buffer = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > opened.size) throw changed();
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error instanceof RuntimeError || error instanceof GuardRefusalError) throw error;
    throw failure((error as NodeJS.ErrnoException).code);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 実際に送るボディと、送信ヘッダーから Content-Type を外すべきか(multipart は boundary を undici が付ける) */
export async function materializePayload(
  payload: BodyPayload,
  cwd: string,
): Promise<{ body: Buffer | FormData; dropContentType: boolean }> {
  if (payload.kind === "file") {
    return {
      body: await readInputFile(cwd, payload.path, "bodyFile", MAX_INPUT_FILE_BYTES),
      dropContentType: false,
    };
  }
  const form = new FormData();
  let remaining = MAX_INPUT_FILE_BYTES;
  for (const part of payload.parts) {
    if ("value" in part) {
      form.append(part.name, part.value);
      continue;
    }
    const content = await readInputFile(cwd, part.path, "multipart", remaining);
    remaining -= content.length;
    const blob = new Blob(
      [new Uint8Array(content)],
      part.contentType ? { type: part.contentType } : {},
    );
    form.append(part.name, blob, part.filename);
  }
  return { body: form, dropContentType: true };
}
