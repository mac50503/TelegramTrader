import { randomBytes, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function newAssignmentToken(): string {
  return randomBytes(24).toString("base64url");
}
