import { createMemo } from "solid-js";

export function useShouldBuyAmpsLessToNotBlowFuse() {
  return createMemo(() => 0);
}
