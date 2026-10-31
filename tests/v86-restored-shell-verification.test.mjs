import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(inline, "VM page should contain its inline controller script");
assert.doesNotThrow(() => new vm.Script(inline[1]), "VM page controller should parse as JavaScript");

const helperStart = inline[1].indexOf("function shellPrompt(text){", inline[1].indexOf("window.emulator.add_listener('emulator-loaded'"));
const helperEnd = inline[1].indexOf("\nfunction startBootMonitor()", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "restored shell verification helper should remain discoverable");
const helperSource =
  "const PROMPT_STABLE_MS = 5;\n" +
  inline[1].slice(helperStart, helperEnd) +
  "\nglobalThis.__verifyRestoredGuestShell = verifyRestoredGuestShell;";

function createVerifier({ initialScreen, afterCommand, commandError = null }) {
  let currentScreen = initialScreen;
  const commands = [];
  const context = {
    Date,
    Math,
    setTimeout,
    clearTimeout,
    screenText: () => currentScreen,
    normalizeScreenLines: (raw) => String(raw || "").replace(/\r/g, "").split("\n").map(line => line.replace(/[ \t]+$/g, "")),
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
      assert.ok(command.endsWith("\n"), "probe must submit the command with Enter");
      return "tc@box:~$ echo " + match[1] + "\n" + match[1] + "\ntc@box:~$";
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
      return "tc@box:~$ echo " + match[1] + "\ntc@box:~$";
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
  const networkAt = inline[1].indexOf("const network=await initializeRestoredGuestNetwork()", verificationAt);
  const readyAt = inline[1].indexOf("bootComplete=true;", listenerStart);
  const agentAt = inline[1].indexOf("connectApiAgent();", listenerStart);
  assert.ok(listenerStart >= 0 && verificationAt > listenerStart);
  assert.ok(networkAt > verificationAt, "restored guest networking must be reinitialized after shell verification");
  assert.ok(readyAt > networkAt, "bootComplete must wait for restored DHCP/DNS/HTTP/HTTPS checks");
  assert.ok(agentAt > networkAt, "API agent connection must follow restored network verification");
  assert.match(inline[1].slice(verificationAt, networkAt), /if\(!verification\.ok\)[\s\S]*?return;/);
  assert.match(inline[1].slice(networkAt, readyAt), /if\(!network\.ok\)[\s\S]*?return;/);
  assert.ok(inline[1].includes("RESTORED_GUEST_NETWORK_READY=1"));
  assert.ok(inline[1].includes("02:00:00:00:00:00"), "admin fallback MAC must be a valid locally administered unicast address");
  assert.match(inline[1], /const virtualMac=.*?'02:00:00:00:00:00'/, "admin fallback MAC must be the reserved valid address");
  assert.doesNotMatch(inline[1], /const virtualMac=.*?'02:ff:ff:ff:ff:ff'/, "do not use the all-FF synthetic MAC fallback");
});
test("restored guest network recovery reapplies its MAC, renews DHCP, and verifies DNS/HTTP/HTTPS", () => {
  const start = inline[1].indexOf("async function initializeRestoredGuestNetwork(){");
  const end = inline[1].indexOf("\\nfunction startBootMonitor(){", start);
  assert.ok(start >= 0 && end > start, "restored network recovery helper should exist");
  const network = inline[1].slice(start, end);
  assert.ok(network.includes("/sbin/ifconfig eth0 hw ether "), "reapply the assigned MAC after restoring the adapter");
  assert.ok(network.includes("/sbin/udhcpc -f -n -q -i eth0"), "renew DHCP with bounded retries");
  assert.ok(network.includes("RESTORE_DHCP_OK"), "require the expected guest IP and gateway before continuing");
  assert.ok(network.includes("nslookup google.com"), "verify DNS after DHCP");
  assert.ok(network.includes("http://www.google.com/"), "verify outbound HTTP after DHCP");
  assert.ok(network.includes("https://www.google.com/generate_204"), "verify outbound HTTPS after DHCP");
  assert.ok(network.includes("RESTORED_GUEST_NETWORK_READY=1"), "emit a final network-ready marker");
  assert.ok(!network.includes("saveVmState"), "network repair must not overwrite the saved snapshot");
});

