import { useCallback, useRef } from "react";

/**
 * key が編集可能な行リスト(EnvEditor の key-value 行、RequestEditor の header/query 行など)で
 * React key に使う安定 id を採番する hook。
 * React key はリスト内で一意であればよいため、コンポーネントインスタンスごとに 0 から数え直す
 * per-instance の useRef カウンタで十分(モジュールレベルのグローバルカウンタは不要)。
 * 返り値の生成関数に prefix を渡すことで、同一インスタンス内で複数種類の行(header/query 等)の
 * id を1つのカウンタで採番できる。
 * 返す関数自体は useCallback で参照を固定し、呼び出し側で useEffect/useCallback の依存配列に
 * 含めても不要な再実行を起こさないようにする。
 */
export function useRowId(): (prefix: string) => string {
  const nextIdRef = useRef(0);
  return useCallback((prefix: string) => `${prefix}-${nextIdRef.current++}`, []);
}
