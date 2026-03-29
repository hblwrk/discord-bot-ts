import {randomInt} from "node:crypto";

export function getSecureRandomIndex(length: number): number {
  return randomInt(length);
}
