import { Blob } from "node:buffer";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FormData } from "undici";
import { GuardRefusalError, RuntimeError } from "./errors.js";
import { isPathWithinDir, isRealPathWithinDir, toDisplayPath } from "./path-guard.js";
import type { RequestDef } from "./schema.js";
import { renderString, type TemplateContext } from "./template.js";

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
    );
  }
  let size: number;
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      throw new RuntimeError(`${label} path is not a regular file: "${rawPath}"`);
    }
    size = stat.size;
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

/** 送信直前にファイルを読み直す(展開後の検証から時間が空くため、境界を再確認してから読む) */
async function readInputFile(cwd: string, path: string, label: string): Promise<Buffer> {
  const file = resolveInputFile(cwd, path, label);
  try {
    return await readFile(file.absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new RuntimeError(
      `failed to read ${label} file "${file.display}"${code ? ` (${code})` : ""}`,
    );
  }
}

/** 実際に送るボディと、送信ヘッダーから Content-Type を外すべきか(multipart は boundary を undici が付ける) */
export async function materializePayload(
  payload: BodyPayload,
  cwd: string,
): Promise<{ body: Buffer | FormData; dropContentType: boolean }> {
  if (payload.kind === "file") {
    return { body: await readInputFile(cwd, payload.path, "bodyFile"), dropContentType: false };
  }
  const form = new FormData();
  for (const part of payload.parts) {
    if ("value" in part) {
      form.append(part.name, part.value);
      continue;
    }
    const content = await readInputFile(cwd, part.path, "multipart");
    const blob = new Blob(
      [new Uint8Array(content)],
      part.contentType ? { type: part.contentType } : {},
    );
    form.append(part.name, blob, part.filename);
  }
  return { body: form, dropContentType: true };
}
