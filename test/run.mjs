import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parseWsdl } from "../dist/wsdl.js";
import { buildTools, classify, findLegacyVariants } from "../dist/tools.js";
import { buildEnvelope, interpretResult, ApiCallError } from "../dist/soap.js";
import { loadConfig, modeAllows, redact } from "../dist/config.js";

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; } };

const model = parseWsdl(readFileSync(new URL("./fixture.wsdl", import.meta.url), "utf8"));

console.log("\nWSDL parsing");
t("finds all operations", () => assert.equal(model.operations.length, 5));
t("reads targetNamespace", () => assert.equal(model.targetNamespace, "http://messagingsystem.co.il/"));
t("reads endpoint from service port", () => assert.match(model.endpoint, /Services\.asmx$/));
t("reads SOAPAction from binding", () =>
  assert.equal(model.operations.find(o=>o.name==="GetGroupsList").soapAction,
    "http://messagingsystem.co.il/GetGroupsList"));
t("reads params incl. oLogin/iUserID", () => {
  const op = model.operations.find(o=>o.name==="SendSingleSmsMessage");
  assert.deepEqual(op.params.map(p=>p.name), ["oLogin","iUserID","sPhoneNumber","sMessageText","eLang"]);
});
t("reads return type", () =>
  assert.equal(model.operations.find(o=>o.name==="GetGroupsList").returnType, "ArrayOfCGroup"));
t("reads complex types", () =>
  assert.deepEqual(model.complexTypes.CLoginInfo.fields.map(f=>f.name), ["UserName","Password","ApiKey"]));
t("reads enums", () => assert.deepEqual(model.enums.ELang, ["Default","Hebrew","English"]));

console.log("\nSafety classification");
t("Get* is read", () => assert.equal(classify("GetGroupsList"), "read"));
t("Send* is send", () => assert.equal(classify("SendSingleSmsMessage"), "send"));
t("Delete* is destructive", () => assert.equal(classify("DeleteGroup"), "destructive"));
t("Create* is write", () => assert.equal(classify("CreateContact"), "write"));
t("destructive beats send in ordering", () => assert.equal(classify("RemoveContactFromList"), "destructive"));

console.log("\nEx/Ex2 collapsing");
const legacy = findLegacyVariants(model.operations);
t("marks the older variant legacy", () => assert.ok(legacy.has("ChangeContactStatus")));
t("keeps the newest variant", () => assert.ok(!legacy.has("ChangeContactStatusEx")));

console.log("\nTool generation");
const tools = buildTools(model);
const byName = Object.fromEntries(tools.map(x=>[x.name,x]));
t("applies friendly names", () => assert.ok(byName.list_groups));
t("omits injected params from schema", () => {
  const s = byName.send_sms.inputSchema;
  assert.ok(!("oLogin" in s.properties) && !("iUserID" in s.properties));
  assert.ok("sPhoneNumber" in s.properties);
});
t("maps enum params to a constrained schema", () =>
  assert.deepEqual(byName.send_sms.inputSchema.properties.eLang.enum, ["Default","Hebrew","English"]));
t("marks required vs optional from minOccurs", () =>
  assert.ok(byName.send_sms.inputSchema.required.includes("eLang")));
t("send tools carry the irreversible warning", () =>
  assert.match(byName.send_sms.description, /DELIVERS MESSAGES TO REAL RECIPIENTS/));

console.log("\nMode gate");
t("read mode blocks send", () => assert.equal(modeAllows("read","send"), false));
t("send mode allows read", () => assert.equal(modeAllows("send","read"), true));
t("send mode blocks destructive", () => assert.equal(modeAllows("send","destructive"), false));
t("destructive allows everything", () => assert.equal(modeAllows("destructive","send"), true));

console.log("\nEnvelope building");
const cfg = { apiKey:"KEY-123", userId: 6798, endpoint:"x", mode:"send", maxRecipients:100 };
const env = buildEnvelope(model.operations.find(o=>o.name==="SendSingleSmsMessage"),
  { sPhoneNumber:"0501234567", sMessageText:"hi <there> & \"you\"", eLang:"Hebrew" }, cfg, model);
t("injects ApiKey, never a password", () => {
  assert.ok(env.includes("<ApiKey>KEY-123</ApiKey>"));
  assert.ok(!env.includes("<Password>"));
});
t("injects iUserID from config", () => assert.ok(env.includes("<iUserID>6798</iUserID>")));
t("escapes XML in user input", () =>
  assert.ok(env.includes("hi &lt;there&gt; &amp; &quot;you&quot;")));
t("declares the operation namespace", () =>
  assert.ok(env.includes('<SendSingleSmsMessage xmlns="http://messagingsystem.co.il/">')));

console.log("\nResult interpretation (the HTTP-200 trap)");
t("Success returns a value", () =>
  assert.equal(interpretResult({Result:"Success",Description:""}).status, "Success"));
t("LoginFailed throws, not returns", () => {
  assert.throws(()=>interpretResult({Result:"LoginFailed",Description:"bad key"}), ApiCallError);
});
t("failure carries actionable remedy", () => {
  try { interpretResult({Result:"LoginFailed",Description:"bad key"}); }
  catch (e) { assert.match(e.message, /Reissue the key/); }
});
t("PartialSuccess surfaces a warning rather than silent success", () => {
  const r = interpretResult({Result:"PartialSuccess",Description:"3 of 5"});
  assert.match(r.warning, /before assuming the batch landed/);
});
t("data payloads pass through untouched", () =>
  assert.deepEqual(interpretResult({CGroup:[{ID:1,Name:"a"}]}), {CGroup:[{ID:1,Name:"a"}]}));

console.log("\nRedaction");
t("redacts the api key from any text", () =>
  assert.equal(redact("oops KEY-123 leaked", cfg), "oops ***REDACTED*** leaked"));
t("redacts credential elements echoed in a fault", () =>
  assert.match(redact("<Password>hunter2</Password>", cfg), /\*\*\*REDACTED\*\*\*/));

t("NotEnoughPermissions names BOTH causes, not just 'no permission'", () => {
  // Measured live 12/09/2026: iUserID=6341 -> NotEnoughPermissions, iUserID=0 -> ApplicationError.
  // The two codes mean different things and the remedy has to say which one the caller hit.
  try {
    interpretResult({ Result: "NotEnoughPermissions", Description: "You have not enough permissions for this operation" });
    assert.fail("must throw");
  } catch (e) {
    assert.match(e.message, /MESER10_USER_ID/);
    assert.match(e.message, /parent privilege/);
    assert.match(e.message, /Specified cast is not valid/);
  }
});

console.log("\nConfig validation");
t("rejects a missing api key", () =>
  assert.throws(()=>loadConfig({MESER10_USER_ID:"1"}), /MESER10_API_KEY is not set/));
t("rejects a non-numeric user id", () =>
  assert.throws(()=>loadConfig({MESER10_API_KEY:"k",MESER10_USER_ID:"abc"}), /positive integer/));
t("rejects an unknown mode", () =>
  assert.throws(()=>loadConfig({MESER10_API_KEY:"k",MESER10_USER_ID:"1",MESER10_MODE:"yolo"}), /MESER10_MODE/));
t("defaults to read mode", () =>
  assert.equal(loadConfig({MESER10_API_KEY:"k",MESER10_USER_ID:"1"}).mode, "read"));

// Proven against the live endpoint on 12/09/2026: GetGroupsList authenticates
// from the ApiKey alone and returns real lists with no iUserID in the envelope.
// A read-only operator must therefore start without MESER10_USER_ID, and the
// error has to arrive at the call that actually needs the field.
t("starts without a user id, because 17 operations never send one", () => {
  const c = loadConfig({MESER10_API_KEY:"k"});
  assert.equal(c.userId, undefined);
  assert.equal(c.mode, "read");
});
t("an operation that needs iUserID says so, and names a way forward", () => {
  const noUser = { apiKey:"KEY-123", endpoint:"x", mode:"read", maxRecipients:100 };
  const op = model.operations.find(o => o.params.some(p => p.name === "iUserID"));
  assert.ok(op, "the fixture must contain an operation carrying iUserID");
  assert.throws(() => buildEnvelope(op, {}, noUser, model), /MESER10_USER_ID is not set[\s\S]*GetGroupsList/);
});
t("an operation that needs no iUserID builds fine without one", () => {
  const noUser = { apiKey:"KEY-123", endpoint:"x", mode:"read", maxRecipients:100 };
  const op = model.operations.find(o => !o.params.some(p => p.name === "iUserID"));
  assert.ok(op);
  const xml = buildEnvelope(op, {}, noUser, model);
  assert.ok(xml.includes("<ApiKey>KEY-123</ApiKey>"));
  assert.ok(!xml.includes("<iUserID>"));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
