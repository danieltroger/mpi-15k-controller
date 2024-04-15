import { createHash } from "crypto";

export function sha1(string: string) {
  return createHash("sha1").update(string).digest("hex");
}
