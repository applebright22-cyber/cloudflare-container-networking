import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL("../" + path, import.meta.url), "utf8");
const vmPage = read("public/vm.html");
const runtime = read("public/v86/libv86.js");
const dohPatcher = read("scripts/patch-v86-doh.js");
const studio = read("public/studio.js");
const workspace = read("public/workspace.js");

test("VM page resolves the browser-exported v86 constructor explicitly", () => {
  assert.ok(vmPage.includes('<script src="/v86/libv86.js"></script>'), "the browser runtime loads before the VM bootstrap");
  assert.ok(runtime.includes('window.V86=Q'), "the checked-in runtime exports its constructor on window");
  assert.ok(dohPatcher.includes('"return!0}",'), "the automatic DNS patch must close its replacement function");
  assert.ok(vmPage.includes("const V86Constructor=window.V86"), "startup reads the actual browser global");
  assert.ok(vmPage.includes("typeof V86Constructor!=='function'"), "a missing runtime gets a clear loading error");
  assert.ok(vmPage.includes("new V86Constructor("), "the emulator is created from the verified constructor");
  assert.ok(!vmPage.includes("new V86({"), "startup must not depend on an implicit global lexical binding");
});

test("account session remains shared across Studio, workspace, and VM navigation", () => {
  for (const page of [vmPage, studio, workspace]) {
    assert.ok(page.includes("vm-account-id"), "each app surface uses the same account identity key");
    assert.ok(page.includes("vm-session-token"), "each app surface uses the same authenticated session key");
  }
  assert.ok(vmPage.includes("sessionStorage.setItem('vm-session-token'"), "login stores the session for same-tab app navigation");
  assert.ok(vmPage.includes("fetch('/api/auth/session'"), "returning to the VM validates the existing session with the server");
  assert.ok(studio.includes("fetch('/api/auth/session'"), "Studio validates the same server-side session");
  assert.ok(workspace.includes("authorization':'Bearer '+token"), "workspace API calls use the same account session");
  assert.doesNotMatch(vmPage + studio + workspace, /localStorage[.](?:setItem|getItem)[(][^)]*(?:password|session-token)/i,
    "passwords and session tokens must not be persisted in localStorage");
});

test("account VM snapshots remain server-backed and account-scoped", () => {
  assert.ok(vmPage.includes("function snapshotUrl()"), "snapshot API remains account-scoped");
  assert.ok(vmPage.includes("'/api/vm-snapshots/'+encodeURIComponent(window.snapshotIdentity)"), "snapshot identity is part of the server URL");
  assert.ok(vmPage.includes("async function saveVmState("), "VM state continues to save to the server");
  assert.ok(vmPage.includes("async function loadVmState()"), "VM state continues to restore from the server");
  assert.ok(vmPage.includes("snapshotLoadFailed"), "failed restore continues to block overwriting saved account data");
});

test("Studio and workspace continue to use Cloudflare-backed project records", () => {
  assert.ok(studio.includes("function cloudUrl("), "Studio retains its Cloudflare project API");
  assert.ok(studio.includes("loadCloudProjects()"), "Studio reloads cloud projects after session validation");
  assert.ok(workspace.includes("'/api/studio/projects'"), "workspace reads and writes the same project API");
  assert.ok(workspace.includes("fetch(projectsUrl()"), "workspace reloads projects from the server");
});
