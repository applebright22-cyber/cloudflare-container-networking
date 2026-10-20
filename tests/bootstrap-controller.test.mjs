import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");
const bootstrap = readFileSync(new URL("../public/runner/tinycore/browser-bootstrap.sh", import.meta.url), "utf8");

test("inline browser scripts parse", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.some((match) => match[1].trim()), "expected an inline script");
  for (const [index, match] of scripts.entries()) {
    const source = match[1].trim();
    if (!source) continue;
    try {
      new vm.Script(source, { filename: "public-vm-inline-" + (index + 1) + ".js" });
    } catch (error) {
      assert.fail("inline script " + (index + 1) + " failed to parse: " + (error && error.stack ? error.stack : String(error)));
    }
  }
});

test("shell prompt detection tolerates blank rows but only accepts the current last line", () => {
  const match = html.match(/function shellPrompt\(text\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "shellPrompt function should exist");
  const shellPrompt = vm.runInNewContext("(" + match[0] + ")");
  assert.equal(shellPrompt("boot output\n tc@box:~$\n\n\n"), "tc@box:~$");
  assert.equal(shellPrompt("tc@box:~$\ncommand still running\n\n"), "");
});

test("VM uses a built ISO asset, a single supported relay configuration, and retries DHCP until a lease is valid", () => {
  assert.ok(html.includes("cdrom:{url:'/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso'}"), "VM should use the existing NIC-enabled experimental ISO");
  assert.ok(html.includes("net_device:{type:'ne2k',relay_url:relayUrl,router_ip:routerIp,vm_ip:virtualIp,masquerade:true,dns_method:'doh',doh_server:'cloudflare-dns.com'}"), "use account-specific synthetic DHCP/DNS through WISP");
  assert.ok(html.includes("wisps://'+window.location.host+'/api/network/wisp"), "route WISP streams through the Cloudflare Worker");
  assert.ok(html.includes("router_ip:routerIp,vm_ip:virtualIp"));
  assert.ok(!html.includes("relay.widgetry.org"), "do not depend on the shared raw-Ethernet relay for DHCP");
  assert.ok(html.includes("function snapshotUrl(){if(!window.snapshotIdentity)"), "snapshots should remain scoped to the selected account identity");
  assert.ok(html.includes('while [ "$attempt" -le 8 ]; do echo DHCP_ATTEMPT=$attempt; /sbin/udhcpc -f -n -q -i "$iface";'), "DHCP should retry a bounded number of times and report failure instead of hanging forever");
  assert.ok(html.includes("/sbin/modprobe ne2k-pci"), "try loading the NE2000 PCI driver when no interface is present");
  assert.ok(html.includes("NIC_MISSING"), "report driver diagnostics instead of retrying DHCP forever without a NIC");
  assert.ok(html.includes("DHCP_RETRYING_NO_LEASE"));
  assert.ok(html.includes("DHCP_STATIC_FALLBACK"), "use the reserved account IP and gateway if synthetic DHCP cannot lease");
  assert.ok(html.includes('/sbin/ifconfig "$iface" "$ip" netmask 255.255.255.0 up'), "static fallback must configure the account-specific guest IP");
  assert.ok(html.includes('/sbin/route add default gw "$gw"'), "static fallback must install the matching virtual gateway");
  assert.ok(html.includes("echo DHCP_OK"), "successful DHCP path should emit its completion marker");
  assert.ok(html.includes("DHCP_EXPECTED_IP=$ip"), "DHCP must report the account-assigned address it expects");
  assert.ok(html.includes("DHCP_ASSIGNED_IP=$ip"), "DHCP must report the address actually leased");
  assert.ok(html.includes("DHCP_ASSIGNED_GATEWAY=$gw"), "DHCP must report the gateway actually installed");
  const firstCommand = html.match(/const commands=\[\s*`([\s\S]*?)`,/);
  assert.ok(firstCommand, "first startup command should be present");
  assert.ok(firstCommand[1].length < 900, "network init command must stay short enough to avoid terminal input truncation");
});

test("restored snapshots automatically run the network diagnostic and save after it finishes", () => {
  assert.ok(html.includes("runDiagnostic('AUTOMATIC NETWORK TEST AFTER SNAPSHOT RESTORE',true)"), "restored VM should not skip the automatic network test");
  assert.ok(html.includes("if(saveAfter&&bootComplete){const tail=screenText().slice(-12000)"), "validate diagnostic results before saving");
  assert.ok(html.includes("const saved=await saveVmState(false)"), "save the state after the diagnostic finishes");
  assert.ok(html.includes("requestedIdentity==='user-usera'?['user-usera','regular-user-a']"), "usera should fall back to the documented legacy snapshot key");
  assert.ok(html.includes("requestedIdentity==='user-userb'?['user-userb','regular-user-b']"), "userb should fall back to the documented legacy snapshot key");
  assert.ok(html.includes("window.snapshotIdentity=identity"), "keep saves scoped to whichever account snapshot was restored");
});

test("startup prompt detection supports changed hostnames and explicitly wakes the shell before the first command", () => {
  assert.ok(html.includes("[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+"), "prompt detection should not depend on one exact hostname");
  assert.ok(html.includes("KEYBOARD INPUT WAKE"));
  assert.ok(html.includes("await sendVmCommand('\\n')"));
});

test("GUI startup handles optional Syslinux boot prompt and reports a bounded boot timeout", () => {
  assert.ok(html.includes("const BOOT_TIMEOUT_MS=300000"), "GUI should allow Tiny Core up to five minutes to reach a shell");
  assert.ok(html.includes("/^boot:\\s*$/i.test(line.trim())"), "GUI should recognize a standalone Syslinux boot prompt");
  assert.ok(html.includes("keyboard_send_scancodes([0x1C,0x9C])"), "GUI should press Enter only when a boot prompt is visible");
  assert.ok(html.includes("BOOT TIMEOUT after "), "GUI should capture the guest screen if boot does not complete");
  assert.ok(html.includes("proofDeadline=Date.now()+30000"), "snapshot login proof should fail visibly instead of looping forever");
});

test("startup completion markers match the sequential command controller", () => {
  const normalized = html.replace(/"\s*"/g, "");
  for (const marker of [
    "DHCP_DONE",
    "__RESOURCE_PREFLIGHT_DONE",
    "__TLS_DOWNLOAD_DONE:",
    "__OPENSSL_INSTALL_DONE:",
    "__CA_CERTIFICATES_INSTALL_DONE:",
    "__EGRESS_PREFLIGHT_DONE:",
    "__NETWORK_DOWNLOAD_DONE:",
    "__NETWORK_TEST_DONE:",
  ]) {
    assert.ok(normalized.includes(marker), "expected startup marker: " + marker);
  }
});

test("TLS installs run in the foreground before HTTPS and certificate checks", () => {
  assert.ok(html.includes("tce-load -w openssl-1.1.1.tcz"));
  assert.ok(html.includes("tce-load -w ca-certificates.tcz"));
  assert.ok(html.includes("tce-load -i openssl-1.1.1 >/tmp/openssl-install.log 2>&1; install_rc=$?"));
  assert.ok(html.includes("openssl version >/dev/null 2>&1"));
  assert.ok(html.includes("tce-load -i ca-certificates >/tmp/ca.log 2>&1; rc=$?"));
  assert.ok(html.includes("CA_BUNDLE_PATH=$CA_BUNDLE"));
  assert.ok(html.includes("find /usr/local/etc/ssl/certs /etc/ssl/certs -type f -name ca-certificates.crt"));
  const caCommand = html.match(/`echo "--- CA certificate install ---";([\s\S]*?)`,/);
  assert.ok(caCommand, "CA install command should be present");
  assert.ok(caCommand[0].length < 600, "CA install command must stay short enough to avoid terminal input truncation");
  assert.ok(html.includes("CA_INSTALL_RC=$rc"));
  assert.ok(html.includes("CA_BUNDLE_PATH=$CA_BUNDLE"));
  assert.ok(!html.includes("tce-load -i openssl-1.1.1 >/tmp/openssl-install.log 2>&1 &"));
  assert.ok(!html.includes("tce-load -i ca-certificates >/tmp/ca.log 2>&1 &"));
  const commandListStart = html.indexOf("const commands=[");
  const commandListEnd = html.indexOf("const markers=", commandListStart);
  assert.ok(commandListStart >= 0 && commandListEnd > commandListStart, "startup command list should be present");
  const commandList = html.slice(commandListStart, commandListEnd);
  assert.ok(commandList.indexOf("tce-load -i openssl-1.1.1") < commandList.indexOf("tce-load -i ca-certificates"));
  assert.ok(commandList.indexOf("tce-load -i ca-certificates") < commandList.indexOf("${apiUrl}/health"));
});

test("bootstrap waits for a fresh completion marker and a shell prompt before advancing", () => {
  assert.ok(html.includes("function markerCount(text,marker)"));
  assert.ok(html.includes("markerCount(t,marker)>markerCountBefore"));
  assert.ok(html.includes("shellPrompt(t.slice(markerAt+marker.length))"));
  assert.ok(html.includes("const markerCountBefore=marker?markerCount(terminal(),marker):0"));
  assert.ok(html.includes("requestAnimationFrame(wait)"));
});

test("VM snapshot save is attempted after the post-boot test sequence", () => {
  assert.ok(html.includes("const saved=await saveVmState(false)"));
  assert.ok(html.includes("Startup and network tests complete; server snapshot saved."));
  assert.ok(html.includes("Startup complete; server snapshot save did not complete."));
});

test("VM downloads active diagnostic scripts from same-origin Worker assets", () => {
  assert.ok(html.includes("${apiUrl}/health"), "HTTPS preflight should test the deployed Worker health endpoint");
  for (const asset of ["network-test.sh"]) {
    assert.ok(html.includes("${apiUrl}/runner/tinycore/" + asset), "VM should download " + asset + " from Worker assets");
  }
  assert.ok(!html.includes("browser-bootstrap.sh"), "paused Mysterium bootstrap must not be downloaded or launched by VM startup");
  assert.ok(!html.includes("raw.githubusercontent.com/brightlambre22-sketch/cloudflare-container-networking"));
  assert.ok(bootstrap.includes("Mysterium bootstrap is temporarily disabled."));
  assert.ok(!bootstrap.includes("wget "));
  assert.ok(!bootstrap.includes("/opt/mysterium/myst"));
});

test("startup keeps DHCP retrying and bounds individual HTTPS probes", () => {
  const startupStart = html.indexOf("async function startBootstrap()");
  const accountUiStart = html.indexOf("function beginAccountSession");
  assert.ok(startupStart >= 0 && accountUiStart > startupStart, "startup and account UI sections should be identifiable");
  assert.ok(!html.slice(startupStart, accountUiStart).includes("setTimeout("), "VM startup must not use JavaScript timeouts");
  const bootMonitorStart = html.indexOf("function startBootMonitor");
  assert.ok(bootMonitorStart > startupStart && bootMonitorStart < accountUiStart, "boot monitor should remain separate from the network command controller");
  assert.ok(!html.slice(startupStart, bootMonitorStart).includes("BOOT_TIMEOUT_MS"), "boot timeout should not be inside the sequential network command controller");
  assert.ok(html.includes('wget -T 10 -t 1 -S -O /dev/null ${apiUrl}/health'));
  assert.ok(!/udhcpc[^\n]*\s-t\s*[0-9]/.test(html), "DHCP should not have a retry-count timeout");
  assert.ok(html.includes('while [ "$tries" -lt 6 ]; do if wget -T 10 -t 1 -S -O /dev/null ${apiUrl}/health'), "HTTPS preflight should retry a bounded number of timed probes");
  assert.ok(html.includes('while [ "$tries" -lt 6 ]'));
  assert.ok(html.includes("sleep 2"));
});
