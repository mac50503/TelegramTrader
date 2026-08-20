import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { floorToStep, isPositiveDecimal } from "../src/shared/decimal.js";
import { extractOutermostJson } from "../src/shared/json-extract.js";
import { secureEqual } from "../src/shared/security.js";
import { csv, truncateForLog } from "../src/shared/strings.js";

describe("secureEqual", () => {
  it("es verdadero solo cuando ambos strings coinciden", () => {
    expect(secureEqual("secret", "secret")).toBe(true);
    expect(secureEqual("secret", "other")).toBe(false);
    expect(secureEqual("short", "much-longer-value")).toBe(false);
  });
});

describe("floorToStep", () => {
  it("redondea hacia abajo al múltiplo del step", () => {
    expect(floorToStep(new Decimal("0.137"), new Decimal("0.01")).toString()).toBe("0.13");
    expect(floorToStep(new Decimal("1"), new Decimal("0.1")).toString()).toBe("1");
  });
});

describe("isPositiveDecimal", () => {
  it.each([["1"], ["0.0001"]])("acepta decimales positivos: %s", (value) => {
    expect(isPositiveDecimal(value)).toBe(true);
  });
  it.each([[null], ["0"], ["-1"], ["abc"], ["Infinity"]])("rechaza valores no positivos o inválidos: %s", (value) => {
    expect(isPositiveDecimal(value)).toBe(false);
  });
});

describe("csv", () => {
  it("separa, recorta espacios y descarta vacíos", () => {
    expect(csv(" a, b ,,c")).toEqual(["a", "b", "c"]);
    expect(csv("")).toEqual([]);
  });
});

describe("truncateForLog", () => {
  it("quita saltos de línea y los reemplaza por espacios", () => {
    expect(truncateForLog("linea1\nlinea2\r\nlinea3")).toBe("linea1 linea2 linea3");
  });

  it("recorta a 500 caracteres por defecto", () => {
    expect(truncateForLog("x".repeat(600)).length).toBe(500);
  });

  it("respeta un límite personalizado", () => {
    expect(truncateForLog("hello world", 5)).toBe("hello");
  });
});

describe("extractOutermostJson", () => {
  it("extrae el objeto entre la primera { y la última }", () => {
    expect(extractOutermostJson('Sure:\n{"a":1,"b":{"c":2}}\nDone.')).toEqual({ a: 1, b: { c: 2 } });
  });

  it("lanza si no hay ninguna llave", () => {
    expect(() => extractOutermostJson("no json here")).toThrow();
  });

  it("lanza si el contenido entre llaves no es JSON válido", () => {
    expect(() => extractOutermostJson("{not valid}")).toThrow();
  });
});
