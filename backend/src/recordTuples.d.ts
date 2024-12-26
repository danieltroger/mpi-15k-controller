declare module "@bloomberg/record-tuple-polyfill" {
  export function Record<T>(t: T): T;
  export function Tuple<T extends any[]>(...ts: T): T;
}
