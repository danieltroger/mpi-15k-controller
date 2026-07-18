import { createContext, type JSX, useContext } from "solid-js";
import type { useBatteryValues } from "./useBatteryValues.ts";

/** The full bundle of battery-derived accessors produced by useBatteryValues. */
export type BatteryValues = ReturnType<typeof useBatteryValues>;

const BatteryValuesContext = createContext<BatteryValues>();

/**
 * Shares the battery-derived accessors (socAh, clampedSocAh, latestAnchor) with the whole
 * subtree so the selling/buying/feeding/trading modules can pull what they need via
 * useBatteryValuesProvider() instead of having them threaded down from index.ts as props.
 * useBatteryValues is still called once, above this provider; its result is handed in as `value`.
 */
export function BatteryValuesProvider(props: { children: JSX.Element; value: BatteryValues }) {
  return BatteryValuesContext.Provider({
    value: props.value,
    get children() {
      return props.children;
    },
  });
}

/** The shared battery-values bundle; throws if used outside a BatteryValuesProvider. */
export function useBatteryValuesProvider() {
  const contextValue = useContext(BatteryValuesContext);
  if (!contextValue) {
    throw new Error("useBatteryValuesProvider must be used within a BatteryValuesProvider");
  }
  return contextValue;
}
