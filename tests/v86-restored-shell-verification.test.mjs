import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");
const inline = html.match(/<script>\\s*([\\s\\S]*?)<\\/script>/);
assert.ok(inline, "VM page should contain its inline controller script");
assert.doesNotThrow(() => new vm.Script(inline[1]), "VM page controller should parse as JavaScript");

const helperStart = inline[1].indexOf("function shellPrompt(text){");
const helperEnd = inline[1].indexOf("\\nfunction startBootMonitor()", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "restored shell verification helper should remain discoverable");
const helperSource =
  "const PROMPT_STABLE_MS = 5;\\n" +
  inline[1].slice(helperStart, helperEnd) +
  "\\nglobalThis.__verifyRestoredGuestShell = verifyRestoredGuestShell;";

function createVerifier({ initialScreen, afterCommand, commandError = null }) {
  let currentScreen = initialScreen;
  const commands = [];
  const context = {
    Date,
    Math,
    setTimeout,
    clearTimeout,
    screenText: () => currentScreen,
    normalizeScreenLines: (raw) => String(raw || "").replace(/\\r/g, "").split("\\n").map(line => line.replace(/[ \\t]+$/g, "")),
    sendVmCommand: async (command) => {
      commands.push(command);
      if (commandError) throw commandError;
      currentScreen = afterCommand ? afterCommand(currentScreen, command) : currentScreen;
    },
  };
  vm.runInNewContext(helperSource, context);
  return { verify: context.__verifyRestoredGuestShell, commands };
}

test("restored guest passes only when the shell echo marker returns and the prompt reappears", async () => {
  const guest = createVerifier({
    initialScreen: "tc@box:~$",
    afterCommand: (_screen, command) => {
      const match = command.match(/echo (__V86_RESTORE_SHELL_OK_[a-z0-9]+__)/);
      assert.ok(match, "probe must send a unique echo marker");
      return "tc@box:~$ echo " + match[1] + "\\n" + match[1] + "\\ntc@box:~$";
    },
  });
  const result = await guest.verify(200, 100);
  assert.equal(result.ok, true);
  assert.match(result.marker, /^__V86_RESTORE_SHELL_OK_[a-z0-9]+__$/);
  assert.equal(guest.commands.length, 1);
});

test("restored guest fails clearly when no stable shell prompt appears", async () => {
  const guest = createVerifier({ initialScreen: "Tiny Core booting..." });
  const result = await guest.verify(25, 25);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no stable Tiny Core shell prompt/);
  assert.equal(guest.commands.length, 0);
});

test("restored guest fails when the echo marker never returns", async () => {
  const guest = createVerifier({
    initialScreen: "tc@box:~$",
    afterCommand: (_screen, command) => {
      const match = command.match(/echo (__V86_RESTORE_SHELL_OK_[a-z0-9]+__)/);
      assert.ok(match);
      return "tc@box:~$ echo " + match[1] + "\\ntc@box:~$";
    },
  });
  const result = await guest.verify(200, 25);
  assert.equal(result.ok, false);
  assert.match(result.reason, /echo probe output or the shell prompt did not return/);
});

test("restored guest reports keyboard probe errors as failures", async () => {
  const guest = createVerifier({
    initialScreen: "tc@box:~$",
    commandError: new Error("keyboard unavailable"),
  });
  const result = await guest.verify(200, 100);
  assert.equal(result.ok, false);
  assert.match(result.reason, /keyboard unavailable/);
});

test("restored VM does not mark boot complete before the command probe passes", () => {
  const listenerStart = inline[1].indexOf("window.emulator.add_listener('emulator-loaded'");
  const verificationAt = inline[1].indexOf("const verification=await verifyRestoredGuestShell()", listenerStart);
  const readyAt = inline[1].indexOf("bootComplete=true;", listenerStart);
  const agentAt = inline[1].indexOf("connectApiAgent();", listenerStart);
  assert.ok(listenerStart >= 0 && verificationAt > listenerStart);
  assert.ok(readyAt > verificationAt, "bootComplete must be set only after verification");
  assert.ok(agentAt > verificationAt, "API agent connection must follow verification");
  assert.match(inline[1].slice(verificationAt, readyAt), /if\(!verification\.ok\)[\\s\\S]*?return;/);
});
