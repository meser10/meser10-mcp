/**
 * Operation -> MCP tool.
 *
 * Three jobs, all of them about developer experience rather than plumbing:
 *  1. Classify every operation by blast radius so the safety gate can enforce it.
 *  2. Collapse the Ex / Ex2 families. The WSDL exposes five of them; exposing all
 *     15 variants would make a model choose between near-identical tools and pick
 *     wrong. We surface the richest variant and hide the rest behind a flag.
 *  3. Give each tool a name and a description written for a caller, not a
 *     maintainer. "GetGroupsList" is what the server calls it; "list_groups" is
 *     what a developer reaches for.
 */
import type { ApiModel, Operation } from "./wsdl.js";
import { operationInputSchema, type JsonSchema } from "./schema.js";
import type { Mode } from "./config.js";

export interface ToolDef {
  /** Friendly, stable, snake_case. */
  name: string;
  /** The underlying SOAP operation. */
  operation: Operation;
  description: string;
  inputSchema: JsonSchema;
  mode: Mode;
  /** True when a newer Ex variant supersedes this one. */
  legacy: boolean;
}

/** Blast radius. Order matters: the first match wins. */
export function classify(name: string): Mode {
  if (/^(Delete|Remove)/.test(name)) return "destructive";
  if (/Send/.test(name)) return "send";
  if (/^Get/.test(name)) return "read";
  return "write";
}

const MODE_NOTE: Record<Mode, string> = {
  read: "Read-only.",
  write: "Modifies data in the account. Does not deliver anything to a recipient.",
  send: "DELIVERS MESSAGES TO REAL RECIPIENTS and consumes account credit. Not reversible.",
  destructive: "PERMANENTLY REMOVES DATA. Not reversible.",
};

/** Hand-written names for the operations a developer actually reaches for first. */
const FRIENDLY: Record<string, string> = {
  GetGroupsList: "list_groups",
  GetGroups: "get_groups",
  GetCampaignsBasicInfo: "list_campaigns",
  GetCampaign: "get_campaign",
  GetCampaignResultSummary: "get_campaign_summary",
  GetCampaignResultDetails: "get_campaign_details",
  GetCampaignResultsBetweenDates: "get_campaign_results_by_date",
  GetCampaignLinkClicks: "get_campaign_link_clicks",
  GetCampaignLinkClicksBetweenDates: "get_campaign_link_clicks_by_date",
  GetSingleMessagesResultsBetweenDatesEx: "get_transactional_results_by_date",
  GetSingleMessagesResultsByIds: "get_transactional_results_by_id",
  GetBouncedAddresses: "list_bounced_addresses",
  GetRemovedEMailAddresses: "list_unsubscribed_addresses",
  GetUserSendLimitsInfo: "get_send_limits",
  GetCouponStatus: "get_coupon_status",
  CreateContact: "create_contact",
  ChangeContactEMail: "change_contact_email",
  ChangeContactPhone: "change_contact_phone",
  ChangeContactStatusEx: "change_contact_status",
  AddGroup: "create_group",
  DeleteGroup: "delete_group",
  DeleteContact: "delete_contact",
  DeleteContacts: "delete_contacts",
  RemoveContactFromGroup: "remove_contact_from_group",
  RemoveContactFromList: "remove_contact_from_list",
  SendSingleMessageEx2: "send_transactional_message",
  SendSingleMessageWithAttachments: "send_transactional_message_with_attachments",
  SendSingleSmsMessage: "send_sms",
  CreateAndSendSMSCampaignEx2: "create_and_send_sms_campaign",
  CreateAndSendEMailCampaignWithAttachments: "create_and_send_email_campaign_with_attachments",
  CreateAndSendEMail: "create_and_send_email_campaign",
  CreateUser: "create_white_label_user",
  LoginUser: "verify_credentials",
};

/** Short, caller-facing purpose lines. Falls back to a generated sentence. */
const PURPOSE: Record<string, string> = {
  list_groups: "List the mailing lists on the account, with their ids. Start here - most other calls take a group.",
  get_send_limits: "How much sending quota the account has left. Check before a large campaign.",
  list_bounced_addresses: "Addresses that hard-bounced. Feed these back into your own suppression list.",
  list_unsubscribed_addresses: "Addresses that asked to be removed. Never re-add these.",
  get_campaign_summary: "Totals for one campaign: sent, opened, clicked, bounced.",
  get_campaign_details: "Per-recipient outcome for one campaign.",
  create_contact: "Add one contact. Takes a list name, not a list id.",
  send_sms: "Send one SMS to one number.",
  send_transactional_message: "Send one transactional email or SMS to one recipient.",
  verify_credentials: "Check that the configured API key works. Costs nothing and sends nothing.",
};

/**
 * Ex / Ex2 families: keep the highest suffix, mark the rest legacy.
 * Measured against the live WSDL there are exactly five such families.
 */
export function findLegacyVariants(operations: Operation[]): Set<string> {
  const families = new Map<string, string[]>();
  for (const op of operations) {
    const base = op.name.replace(/Ex\d*$/, "");
    families.set(base, [...(families.get(base) ?? []), op.name]);
  }
  const legacy = new Set<string>();
  for (const [, names] of families) {
    if (names.length < 2) continue;
    const rank = (n: string) => {
      const m = /Ex(\d*)$/.exec(n);
      if (!m) return 0;
      return m[1] ? Number(m[1]) : 1;
    };
    const winner = [...names].sort((a, b) => rank(b) - rank(a))[0]!;
    for (const n of names) if (n !== winner) legacy.add(n);
  }
  return legacy;
}

function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/_+/g, "_");
}

export function buildTools(model: ApiModel): ToolDef[] {
  const legacySet = findLegacyVariants(model.operations);

  return model.operations.map((operation) => {
    const name = FRIENDLY[operation.name] ?? toSnake(operation.name);
    const mode = classify(operation.name);
    const legacy = legacySet.has(operation.name);

    const purpose = PURPOSE[name] ?? `Calls ${operation.name} on the Meser10 platform.`;
    const description = [
      purpose,
      MODE_NOTE[mode],
      legacy ? "Legacy variant - a newer version of this operation exists and should be preferred." : "",
      `SOAP operation: ${operation.name}.`,
    ]
      .filter(Boolean)
      .join(" ");

    return {
      name,
      operation,
      description,
      inputSchema: operationInputSchema(operation.params, model),
      mode,
      legacy,
    };
  });
}
