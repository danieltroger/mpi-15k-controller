declare module "@iiot2k/ads1115" {
  export const ADR_48 = 0;
  export const ADR_49 = 1;
  export const ADR_4A = 2;
  export const ADR_4B = 3;

  export const MUX_I0_I1 = 0;
  export const MUX_I0_I3 = 1;
  export const MUX_I1_I3 = 2;
  export const MUX_I2_I3 = 3;
  export const MUX_I0_GND = 4;
  export const MUX_I1_GND = 5;
  export const MUX_I2_GND = 6;
  export const MUX_I3_GND = 7;
  export const MUX_DISABLE = 8;

  export const GAIN_6144 = 0;
  export const GAIN_4096 = 1;
  export const GAIN_2048 = 2;
  export const GAIN_1024 = 3;
  export const GAIN_512 = 4;
  export const GAIN_256 = 5;

  export const RATE_8 = 0;
  export const RATE_16 = 1;
  export const RATE_32 = 2;
  export const RATE_64 = 3;
  export const RATE_128 = 4;
  export const RATE_250 = 5;
  export const RATE_475 = 6;
  export const RATE_860 = 7;

  function error_text(): string;

  function scale(
    in_min: number,
    in_max: number,
    out_min: number,
    out_max: number,
    value: number,
    clamp?: boolean
  ): number;

  function read(
    port: number,
    adr: ADR48 | ADR49 | ADR4A | ADR4B,
    mux:
      | MUX_I0_I1
      | MUX_I0_I3
      | MUX_I1_I3
      | MUX_I2_I3
      | MUX_I0_GND
      | MUX_I1_GND
      | MUX_I2_GND
      | MUX_I3_GND
      | MUX_DISABLE,
    gain: GAIN6144 | GAIN4096 | GAIN2048 | GAIN1024 | GAIN512 | GAIN256,
    rate: RATE_8 | RATE_16 | RATE_32 | RATE_64 | RATE_128 | RATE_250 | RATE_475 | RATE_860,
    rawdata: boolean,
    callback: (value: number | undefined) => unknown
  ): void;
}
