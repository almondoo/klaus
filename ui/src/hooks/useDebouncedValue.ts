import { useEffect, useState } from "react";

/** 値の変化を delayMs だけ待ってから反映する(入力のたびに API を呼ばないため) */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
