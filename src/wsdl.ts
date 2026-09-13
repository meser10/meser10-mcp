/**
 * WSDL introspection.
 *
 * The whole point of this server is that nobody hand-writes 61 tools. We read
 * the live contract and derive the tool surface from it, so a new operation
 * shipped by the platform shows up here without a code change.
 */
import { XMLParser } from "fast-xml-parser";

export interface Param {
  name: string;
  /** Local XSD type name, e.g. "string", "int", "ArrayOfString", "CAttachmentInfo". */
  type: string;
  optional: boolean;
}

export interface Operation {
  name: string;
  soapAction: string;
  params: Param[];
  returnType: string;
}

export interface ComplexType {
  name: string;
  fields: Param[];
}

export interface ApiModel {
  targetNamespace: string;
  endpoint: string;
  operations: Operation[];
  complexTypes: Record<string, ComplexType>;
  enums: Record<string, string[]>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (_n, _j, _a, isAttr) => !isAttr && false,
});

/** fast-xml-parser collapses single-element arrays; this restores the invariant. */
function arr<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function stripNs(t: string | undefined): string {
  if (!t) return "string";
  const i = t.indexOf(":");
  return i === -1 ? t : t.slice(i + 1);
}

export function parseWsdl(xml: string): ApiModel {
  const doc = parser.parse(xml);
  const def = doc.definitions;
  if (!def) throw new Error("Not a WSDL document: no <definitions> root.");

  const targetNamespace: string = def["@_targetNamespace"] ?? "http://messagingsystem.co.il/";

  // --- schema: top-level elements (request/response wrappers), complex types, enums
  const schemas = arr<any>(def.types?.schema);
  const elements: Record<string, any> = {};
  const complexTypes: Record<string, ComplexType> = {};
  const enums: Record<string, string[]> = {};

  for (const schema of schemas) {
    for (const el of arr<any>(schema.element)) {
      if (el?.["@_name"]) elements[el["@_name"]] = el;
    }
    for (const ct of arr<any>(schema.complexType)) {
      const name = ct?.["@_name"];
      if (!name) continue;
      complexTypes[name] = { name, fields: readFields(ct) };
    }
    for (const st of arr<any>(schema.simpleType)) {
      const name = st?.["@_name"];
      if (!name) continue;
      const values = arr<any>(st.restriction?.enumeration)
        .map((e) => e?.["@_value"])
        .filter((v): v is string => typeof v === "string");
      if (values.length) enums[name] = values;
    }
  }

  function readFields(node: any): Param[] {
    const seq = node?.sequence ?? node?.complexType?.sequence ?? node?.all;
    return arr<any>(seq?.element).map((e) => ({
      name: e?.["@_name"] ?? "",
      type: stripNs(e?.["@_type"]),
      // minOccurs="0" or nillable both mean "may be omitted"
      optional: e?.["@_minOccurs"] === "0" || e?.["@_nillable"] === "true",
    }));
  }

  // --- portType: the operation list
  const portTypes = arr<any>(def.portType);
  const opNames: string[] = [];
  for (const pt of portTypes) {
    for (const op of arr<any>(pt.operation)) {
      const n = op?.["@_name"];
      if (n && !opNames.includes(n)) opNames.push(n);
    }
  }

  // --- binding: SOAPAction per operation
  const soapActions: Record<string, string> = {};
  for (const b of arr<any>(def.binding)) {
    for (const op of arr<any>(b.operation)) {
      const n = op?.["@_name"];
      const action = op?.operation?.["@_soapAction"];
      if (n && action && !soapActions[n]) soapActions[n] = action;
    }
  }

  // --- service: endpoint address
  let endpoint = "https://ns.mesereser.com/Services/Services.asmx";
  for (const svc of arr<any>(def.service)) {
    for (const port of arr<any>(svc.port)) {
      const loc = port?.address?.["@_location"];
      if (loc) { endpoint = loc; break; }
    }
  }

  const operations: Operation[] = opNames.map((name) => {
    const reqEl = elements[name];
    const resEl = elements[`${name}Response`];
    return {
      name,
      soapAction: soapActions[name] ?? `${targetNamespace}${name}`,
      params: reqEl ? readFields(reqEl.complexType ?? reqEl) : [],
      returnType: resEl ? (readFields(resEl.complexType ?? resEl)[0]?.type ?? "string") : "string",
    };
  });

  return { targetNamespace, endpoint, operations, complexTypes, enums };
}

export async function fetchWsdl(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = endpoint.includes("?") ? `${endpoint}&WSDL` : `${endpoint}?WSDL`;
  const res = await fetchImpl(url, { headers: { Accept: "text/xml" } });
  if (!res.ok) throw new Error(`WSDL fetch failed: HTTP ${res.status} from ${url}`);
  const text = await res.text();
  if (!text.includes("<definitions") && !text.includes(":definitions")) {
    throw new Error(`WSDL fetch returned something that is not a WSDL (${text.length} bytes).`);
  }
  return text;
}
