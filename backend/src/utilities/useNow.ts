import { createSignal, onCleanup } from "solid-js";

export function useNow() {
  const [currentTime, setCurrentTime] = createSignal(+new Date());
  const timeInterval = setInterval(() => setCurrentTime(+new Date()), 2000);
  onCleanup(() => clearInterval(timeInterval));

  return currentTime;
}
