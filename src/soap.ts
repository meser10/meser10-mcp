/**
 * SOAP transport.
 *
 * The WSDL exposes only SOAP 1.1 / 1.2 bindings - there is no HttpGet or
 * HttpPost binding - so envelopes are mandatory, not a stylistic choice.
 *
 * The single most important thing in this file is `interpretResult`. Every
 * operation returns CCallResult { Result, Description } and the platform
 * answers HTTP 200 even when Result is LoginFailed or InvalidParameters.
 * Treating HTTP 200 as success is the classic failure mode here, so we never do.
 */
import { XMLParser } from "fast-xml-parser";
import type { ApiModel, Operation, Param } from "./wsdl.js";
import { redact, type Config } from "./config.js";

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: true });

/** EWSCallResultType, straight from the WSDL. */
export const RESULT_CODES = [
  "Success",
  "LoginFailed",
  "NotEnoughPermissions",
  "ApplicationError",
  "InvalidParameters",
  "PartialSuccess",
  "UnknownFunctionName",
  "InvalidOperation",
] as const;
export type ResultCode = (typeof RESULT_CODES)[number];

const SUCCESSFUL: ResultCode[] = ["Success", "PartialSuccess"];

/** Plain-language guidance per failure code, so a caller can act instead of guess. */
const REMEDY: Partial<Record<ResultCode, string>> = {
  LoginFailed: "MESER10_API_KEY was rejected. Reissue the key in the Meser10 UI and restart the server.",
  NotEnoughPermissions:
    "The key authenticated but is not allowed this operation, so this is an account permission and not an MCP setting. " +
    "Measured against production on 12/09/2026: the 44 operations that carry iUserID are the ones that answer this way, " +
    "while the 17 that resolve the account from the key alone succeed with the same key. Two things produce it - " +
    "MESER10_USER_ID naming an account this key may not act on, or a key without the parent privilege the iUserID family needs. " +
    "An id the platform cannot resolve at all fails differently, with ApplicationError 'Specified cast is not valid', " +
    "so this message means the id WAS recognised and the refusal is about rights.",
  InvalidParameters: "The platform rejected an argument. Read Description - it names the offending field.",
  UnknownFunctionName:
    "The endpoint does not implement this operation. The WSDL and the deployed service are out of sync.",
  InvalidOperation: "The operation is not valid for this account or this object's current state.",
  ApplicationError: "A server-side error. Retry once; if it persists this is a platform issue, not a caller issue.",
  PartialSuccess: "Some records succeeded and some failed. Read Description before assuming the batch landed.",
};

export class SoapFault extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "SoapFault";
  }
}

export class ApiCallError extends Error {
  constructor(readonly code: ResultCode, readonly description: string, readonly remedy?: string) {
    super(remedy ? `${code}: ${description} - ${remedy}` : `${code}: ${description}`);
    this.name = "ApiCallError";
  }
}

function escapeXml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Serialises a JS value into the element shape the XSD expects. */
function toXml(name: string, value: unknown, type: string, model: ApiModel): string {
  if (value === undefined || value === null) return "";

  const arrayMatch = /^ArrayOf(.+)$/.exec(type);
  if (arrayMatch) {
    const innerName = arrayMatch[1]!;
    const items = Array.isArray(value) ? value : [value];
    const inner = items.map((v) => toXml(innerName, v, innerName, model)).join("");
    return `<${name}>${inner}</${name}>`;
  }

  const ct = model.complexTypes[type];
  if (ct && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const inner = ct.fields.map((f) => toXml(f.name, obj[f.name], f.type, model)).join("");
    return `<${name}>${inner}</${name}>`;
  }

  if (typeof value === "boolean") return `<${name}>${value ? "true" : "false"}</${name}>`;
  return `<${name}>${escapeXml(String(value))}</${name}>`;
}

export function buildEnvelope(op: Operation, args: Record<string, unknown>, cfg: Config, model: ApiModel): string {
  const body = op.params
    .map((p: Param) => {
      if (p.name === "oLogin") {
        // ApiKey only. UserName/Password exist in CLoginInfo and stay empty by design.
        return `<oLogin><ApiKey>${escapeXml(cfg.apiKey)}</ApiKey></oLogin>`;
      }
      if (p.name === "iUserID") {
        if (cfg.userId === undefined) {
          throw new Error(
            `${op.name} sends an explicit account id, and MESER10_USER_ID is not set. ` +
              `Set it and restart, or use one of the operations that resolve the account ` +
              `from the API key alone (for example GetGroupsList).`,
          );
        }
        return `<iUserID>${cfg.userId}</iUserID>`;
      }
      return toXml(p.name, args[p.name], p.type, model);
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><${op.name} xmlns="${model.targetNamespace}">${body}</${op.name}></soap:Body>` +
    `</soap:Envelope>`
  );
}

/**
 * Turns a CCallResult into either a value or a thrown, actionable error.
 * Operations that return data (the Get* family) return the payload unchanged.
 */
export function interpretResult(payload: any): unknown {
  if (payload && typeof payload === "object" && "Result" in payload) {
    const code = String(payload.Result) as ResultCode;
    const description = String(payload.Description ?? "");
    if (!SUCCESSFUL.includes(code)) {
      throw new ApiCallError(code, description, REMEDY[code]);
    }
    if (code === "PartialSuccess") {
      return { status: code, warning: REMEDY.PartialSuccess, description };
    }
    return { status: code, ...(description ? { description } : {}) };
  }
  return payload;
}

export async function callOperation(
  op: Operation,
  args: Record<string, unknown>,
  cfg: Config,
  model: ApiModel,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const envelope = buildEnvelope(op, args, cfg, model);

  const res = await fetchImpl(cfg.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: op.soapAction,
    },
    body: envelope,
  });

  const text = await res.text();

  if (!res.ok) {
    // A SOAP fault still carries a useful message; surface it, redacted.
    const fault = extractFaultString(text);
    throw new SoapFault(redact(fault ?? `HTTP ${res.status}`, cfg), res.status);
  }

  const parsed = parser.parse(text);
  const body = parsed?.Envelope?.Body;
  if (!body) throw new SoapFault("Response had no SOAP Body.");

  const fault = body.Fault;
  if (fault) throw new SoapFault(redact(String(fault.faultstring ?? "SOAP Fault"), cfg));

  const responseNode = body[`${op.name}Response`];
  if (responseNode === undefined) throw new SoapFault(`Response missing <${op.name}Response>.`);

  const payload = responseNode[`${op.name}Result`];
  if (payload === undefined) return interpretResult(responseNode);

  // interpretResult is the gate: it throws when Result is a failure code, and
  // otherwise hands back { status, description }.
  const status = interpretResult(payload);

  // The data does NOT live inside CCallResult. Every operation that returns
  // something puts it in SIBLING out-parameters of the response element -
  // oaGroups, sToken, oUserLimitsInfo - so reading only <OpResult> throws the
  // payload away and reports a bare "Success". Measured live on 12/09/2026:
  // GetGroupsList answered with 19 groups in <oaGroups> that never reached the
  // caller. The stub in the e2e harness only ever returned a CCallResult, which
  // is why the mock suite could not have caught this.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(responseNode as Record<string, unknown>)) {
    if (key === `${op.name}Result`) continue;
    out[key] = value;
  }
  if (Object.keys(out).length === 0) return status;
  return status && typeof status === "object" ? { ...(status as object), ...out } : out;
}

function extractFaultString(xml: string): string | null {
  const m = /<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i.exec(xml);
  return m ? m[1]!.trim() : null;
}
