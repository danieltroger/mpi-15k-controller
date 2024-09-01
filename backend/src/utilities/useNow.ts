import { Accessor, createContext, createSignal, JSX, onCleanup, useContext } from "solid-js";

const NowContext = createContext<Accessor<number>>();

export function NowProvider(props: { children?: JSX.Element }) {
  const [currentTime, setCurrentTime] = createSignal(+new Date());
  const timeInterval = setInterval(() => setCurrentTime(+new Date()), 2000);
  onCleanup(() => clearInterval(timeInterval));

  return NowContext.Provider({
    value: currentTime,
    get children() {
      return props.children;
    },
  });
}

export function useNow() {
  const nowAccessor = useContext(NowContext);
  if (!nowAccessor) {
    throw new Error("useNow must be used within a NowProvider");
  }
  return nowAccessor;
}
