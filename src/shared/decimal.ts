import { Decimal } from "decimal.js";

export function floorToStep(value: Decimal, step: Decimal): Decimal {
  return value.div(step).floor().mul(step);
}

export function isPositiveDecimal(value: string | null): boolean {
  try {
    return value !== null && new Decimal(value).gt(0) && new Decimal(value).isFinite();
  } catch {
    return false;
  }
}
