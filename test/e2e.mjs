/**
 * End-to-end: a real child process speaking MCP over stdio against a local
 * stand-in for the platform. Proves startup, WSDL-driven tool generation,
 * the mode gate, credential injection, and the HTTP-200 failure trap.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const wsdl = readFileSync(new URL("./fixture.wsdl", import.meta.url), "utf8");
let lastRequestBody = null;
let nextResult = "Success";

const http = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(wsdl);
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastRequestBody = body;
    const op = /<soap:Body><(\w+)/.exec(body)?.[1] ?? "Unknown";
    res.writeHead(200, { "Content-Type": "text/xml" });
    // The real platform puts returned DATA in sibling out-parameters of the
    // response element, never inside CCallResult. Measured against production
    // on 12/09/2026. The stub has to do the same or it cannot catch a server
    // that reads only <OpResult> and silently drops the payload.
    const outParams =
      op === "GetGroupsList"
        ? `<oaGroups><CGroupInfo><ID>6739803</ID><Name>list one</Name></CGroupInfo>` +
          `<CGroupInfo><ID>6579563</ID><Name>list two</Name></CGroupInfo></oaGroups>`
        : "";
    res.end(
      `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
      `<soap:Body><${op}Response xmlns="http://messagingsystem.co.il/">` +
      `<${op}Result><Result>${nextResult}</Result><Description>stub</Description></${op}Result>` +
      outParams +
      `</${op}Response></soap:Body></soap:Envelope>`,
    );
  });
});

await new Promise((r) => http.listen(0, r));
const endpoint = `http://127.0.0.1:${http.address().port}/Services.asmx`;

function startServer(mode) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, MESER10_API_KEY: "SECRET-KEY", MESER10_USER_ID: "6798",
           MESER10_ENDPOINT: endpoint, MESER10_MODE: mode },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { const msg = JSON.parse(line);
        if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch {}
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
  return { child, send };
}

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; } };

// ---- read mode
let s = startServer("read");
await s.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });

console.log("\nread mode");
const readTools = (await s.send("tools/list", {})).result.tools;
await t("exposes only read tools", () => {
  const names = readTools.map((x) => x.name);
  assert.ok(names.includes("list_groups"));
  assert.ok(!names.includes("send_sms"), "send_sms must be hidden in read mode");
  assert.ok(!names.includes("delete_group"), "delete_group must be hidden in read mode");
});
await t("hides the legacy Ex variant", () => {
  assert.ok(!readTools.some((x) => x.name === "change_contact_status" && x.description.includes("Legacy")));
});
await t("refusing a gated tool explains how to enable it", async () => {
  const r = await s.send("tools/call", { name: "send_sms", arguments: {} });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /safety gate/);
  assert.match(r.result.content[0].text, /MESER10_MODE/);
});
await t("a read call reaches the platform", async () => {
  const r = await s.send("tools/call", { name: "list_groups", arguments: {} });
  assert.ok(!r.result.isError, "expected success, got: " + r.result.content[0].text);
});
await t("RETURNS THE DATA, not just the status", async () => {
  const r = await s.send("tools/call", { name: "list_groups", arguments: {} });
  const text = r.result.content[0].text;
  assert.ok(!r.result.isError, text);
  // The bug this reproduces: reading only <OpResult> answered a bare
  // {"status":"Success"} while 19 real groups sat in <oaGroups>.
  assert.match(text, /oaGroups/, "the out-parameter must survive to the caller");
  assert.match(text, /6739803/, "the group id must survive");
  assert.match(text, /list two/, "every row must survive, not just the first");
  assert.match(text, /Success/, "the status must still be reported");
});
await t("the request carried the ApiKey and no password", () => {
  assert.ok(lastRequestBody.includes("<ApiKey>SECRET-KEY</ApiKey>"));
  assert.ok(!lastRequestBody.includes("<Password>"));
});
await t("the request carried iUserID from config", () =>
  assert.ok(lastRequestBody.includes("<iUserID>6798</iUserID>")));
s.child.kill();

// ---- send mode
s = startServer("send");
await s.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
console.log("\nsend mode");
const sendTools = (await s.send("tools/list", {})).result.tools;
await t("exposes send tools but still not destructive ones", () => {
  const names = sendTools.map((x) => x.name);
  assert.ok(names.includes("send_sms"));
  assert.ok(!names.includes("delete_group"), "destructive must stay gated at send mode");
});
await t("an SMS send succeeds", async () => {
  const r = await s.send("tools/call", { name: "send_sms",
    arguments: { sPhoneNumber: "0501234567", sMessageText: "hello", eLang: "Hebrew" } });
  assert.ok(!r.result.isError, "expected success, got: " + r.result.content[0].text);
  assert.match(r.result.content[0].text, /Success/);
});

console.log("\nHTTP 200 + LoginFailed must NOT read as success");
nextResult = "LoginFailed";
await t("surfaces the failure as an error with a remedy", async () => {
  const r = await s.send("tools/call", { name: "send_sms",
    arguments: { sPhoneNumber: "0501234567", sMessageText: "hello", eLang: "Hebrew" } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /LoginFailed/);
  assert.match(r.result.content[0].text, /Reissue the key/);
});
nextResult = "Success";

console.log("\nrecipient cap");
await t("refuses a blast over the cap", async () => {
  const r = await s.send("tools/call", { name: "send_sms",
    arguments: { sPhoneNumber: "05", sMessageText: "x", eLang: "Hebrew",
                 saPhoneNumbers: Array.from({length: 500}, (_, i) => "05" + i) } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Refusing to send/);
});
s.child.kill();

// ---- misconfiguration
console.log("\nmisconfiguration");
await t("exits with a readable message when the key is missing", async () => {
  const c = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, MESER10_API_KEY: "", MESER10_USER_ID: "1" }, stdio: ["pipe","pipe","pipe"] });
  let err = ""; c.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => c.on("exit", r));
  assert.equal(code, 2);
  assert.match(err, /MESER10_API_KEY is not set/);
});

http.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
