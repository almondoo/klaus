/**
 * 行単位のテキスト diff(依存なしの純粋関数)。
 * JSON ではない body(HTML・プレーンテキスト等)の差分要約に使う。
 * 変更行(`-` 削除 / `+` 追加)だけを順序どおり返し、コンテキスト行は返さない。
 */

export interface LineChange {
  op: "+" | "-";
  line: string;
}

export interface LineDiff {
  added: number;
  removed: number;
  /** 変更行を元の並び順で並べたもの(差が無ければ空) */
  changes: LineChange[];
}

/** 共通の先頭・末尾を除いた中間部の行数の積がこれを超えたら、LCS を取らず全行置換として扱う(メモリ・時間の上限) */
const MAX_LCS_CELLS = 1_000_000;

export function diffLines(before: string, after: string): LineDiff {
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);

  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }

  const a = left.slice(start, leftEnd);
  const b = right.slice(start, rightEnd);
  const changes: LineChange[] = [];

  if (a.length * b.length > MAX_LCS_CELLS) {
    for (const line of a) changes.push({ op: "-", line });
    for (const line of b) changes.push({ op: "+", line });
  } else {
    // lcs[i][j] = a[i..] と b[j..] の最長共通部分列の長さ
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * width + j] =
          a[i] === b[j]
            ? (lcs[(i + 1) * width + j + 1] as number) + 1
            : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i += 1;
        j += 1;
      } else if ((lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number)) {
        changes.push({ op: "-", line: a[i] as string });
        i += 1;
      } else {
        changes.push({ op: "+", line: b[j] as string });
        j += 1;
      }
    }
    for (; i < a.length; i++) changes.push({ op: "-", line: a[i] as string });
    for (; j < b.length; j++) changes.push({ op: "+", line: b[j] as string });
  }

  return {
    added: changes.filter((change) => change.op === "+").length,
    removed: changes.filter((change) => change.op === "-").length,
    changes,
  };
}
