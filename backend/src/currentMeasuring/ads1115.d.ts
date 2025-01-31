// ads1115.d.ts

declare module "@iiot2k/ads1115" {
  // i2c address constants
  export const ADR_48: number; // 0
  export const ADR_49: number; // 1
  export const ADR_4A: number; // 2
  export const ADR_4B: number; // 3

  // ADC input selection constants
  export const MUX_I0_I1: number; // 0
  export const MUX_I0_I3: number; // 1
  export const MUX_I1_I3: number; // 2
  export const MUX_I2_I3: number; // 3
  export const MUX_I0_GND: number; // 4
  export const MUX_I1_GND: number; // 5
  export const MUX_I2_GND: number; // 6
  export const MUX_I3_GND: number; // 7
  export const MUX_DISABLE: number; // 8

  // ADC input gain constants
  export const GAIN_6144: number; // 0
  export const GAIN_4096: number; // 1
  export const GAIN_2048: number; // 2
  export const GAIN_1024: number; // 3
  export const GAIN_512: number; // 4
  export const GAIN_256: number; // 5

  // ADC conversion rate constants
  export const RATE_8: number; // 0
  export const RATE_16: number; // 1
  export const RATE_32: number; // 2
  export const RATE_64: number; // 3
  export const RATE_128: number; // 4
  export const RATE_250: number; // 5
  export const RATE_475: number; // 6
  export const RATE_860: number; // 7

  /**
   * Returns an error text if the last operation failed.
   */
  export function error_text(): string;

  /**
   * Scales an ADC value between given edges.
   *
   * @param in_min - Minimum input value for scaling
   * @param in_max - Maximum input value for scaling
   * @param out_min - Minimum output value after scaling
   * @param out_max - Maximum output value after scaling
   * @param value - The value to be scaled
   * @param clamp - Whether to clamp value to [in_min, in_max]
   * @returns The scaled value (NaN on error)
   */
  export function scale(
    in_min: number,
    in_max: number,
    out_min: number,
    out_max: number,
    value: number,
    clamp?: boolean
  ): number;

  /**
   * Reads a single ADS1115 input asynchronously.
   *
   * @param port - The I2C port (0..9)
   * @param adr - The I2C address (one of ADR_48, ADR_49, ADR_4A, ADR_4B)
   * @param mux - The multiplexer setting (e.g. MUX_I0_I1, MUX_I0_GND, etc.)
   * @param gain - The input gain (e.g. GAIN_256, GAIN_512, etc.)
   * @param rate - The conversion rate (e.g. RATE_8, RATE_16, ...)
   * @param rawdata - If true, returns the raw ADC data instead of mV
   * @param callback - Callback that receives the read value (or undefined on error)
   */
  export function read(
    port: number,
    adr: number,
    mux: number,
    gain: number,
    rate: number,
    rawdata: boolean,
    callback: (data?: number) => void
  ): void;
}
