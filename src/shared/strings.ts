export function csv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function truncateForLog(text: string, maxLength = 500): string {
  return text.replace(/\r?\n/g, " ").slice(0, maxLength);
}
