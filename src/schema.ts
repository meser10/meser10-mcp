/**
 * XSD -> JSON Schema.
 *
 * The quality of these schemas is the whole developer experience. A model that
 * gets a clean, enum-constrained, well-described schema calls the right
 * operation the first time; a model that gets `{}` guesses and fails.
 */
import type { ApiModel, Param } from "./wsdl.js";

export type JsonSchema = Record<string, any>;

const PRIMITIVES: Record<string, JsonSchema> = {
  string: { type: "string" },
  int: { type: "integer" },
  long: { type: "integer" },
  short: { type: "integer" },
  decimal: { type: "number" },
  double: { type: "number" },
  float: { type: "number" },
  boolean: { type: "boolean" },
  dateTime: { type: "string", format: "date-time" },
  date: { type: "string", format: "date" },
  base64Binary: { type: "string", contentEncoding: "base64" },
};

/**
 * Hungarian notation carries real information in this API and throwing it away
 * loses type hints the WSDL does not otherwise give us.
 *   s = string, i = int, b = bool, e = enum, o = object, sa/ia/oa = array
 */
export function humanize(paramName: string): string {
  const stripped = paramName.replace(/^(sa|ia|oa|ba|s|i|b|e|o|d)(?=[A-Z])/, "");
  return stripped
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

export function typeToSchema(type: string, model: ApiModel, depth = 0): JsonSchema {
  if (PRIMITIVES[type]) return { ...PRIMITIVES[type] };

  if (model.enums[type]) {
    return { type: "string", enum: model.enums[type] };
  }

  // ArrayOfX -> array of X
  const arrayMatch = /^ArrayOf(.+)$/.exec(type);
  if (arrayMatch) {
    const inner = arrayMatch[1]!;
    const innerType = PRIMITIVES[lowerFirst(inner)] ? lowerFirst(inner) : inner;
    return { type: "array", items: depth > 4 ? { type: "object" } : typeToSchema(innerType, model, depth + 1) };
  }

  const ct = model.complexTypes[type];
  if (ct) {
    if (depth > 4) return { type: "object", description: `${type} (nested too deep to expand)` };
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const f of ct.fields) {
      properties[f.name] = { ...typeToSchema(f.type, model, depth + 1), title: humanize(f.name) };
      if (!f.optional) required.push(f.name);
    }
    return { type: "object", properties, ...(required.length ? { required } : {}) };
  }

  // Unknown type: be permissive rather than block the call.
  return { type: "string", description: `Unmapped WSDL type "${type}" - passed through as text.` };
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Builds the JSON Schema for one operation's inputs.
 * `oLogin` and `iUserID` are deliberately omitted: the server injects them from
 * configuration so a model never sees, guesses, or leaks a credential.
 */
export function operationInputSchema(params: Param[], model: ApiModel): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const p of params) {
    if (p.name === "oLogin" || p.name === "iUserID") continue;
    properties[p.name] = { ...typeToSchema(p.type, model), title: humanize(p.name) };
    if (!p.optional) required.push(p.name);
  }

  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

export const INJECTED_PARAMS = new Set(["oLogin", "iUserID"]);
