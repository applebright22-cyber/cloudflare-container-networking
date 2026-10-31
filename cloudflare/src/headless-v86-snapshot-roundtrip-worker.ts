import V86 from "../dist/headless-v86-bundle.js";
import { createCompiledV86WasmFn, getCompiledV86WasmInfo } from "./headless-v86-wasm";
import { commitGuestSnapshot, readCommittedGuestSnapshot } from "./headless-snapshot-store";
import { AccountRegistry } from "./account-registry";
import { WispRelay } from "./wisp-relay";
import { virtualGatewayForIp } from "./virtual-network";

export { AccountRegistry, WispRelay };

const BOOTLOADER_PROMPT_TIMEOUT_MS = 20000;
// Tiny Core can take several minutes to reach a usable console in this image.
const BOOT_TIMEOUT_MS = 300000;
const SHELL_COMMAND_TIMEOUT_MS = 20000;

type Stage = { attempted: boolean; passed: boolean; marker: string; error?: string; output?: string };

type BaselineSnapshot = { generation: string; chunks: number; byteLength: number; state: Uint8Array };

async function readAdminBaseline(bucket: R2Bucket): Promise<BaselineSnapshot | null> {
  const object = await bucket.get("vm-snapshots/admin/manifest.json");
  if (!object) return null;
  const manifest = await object.json<{
    version?: unknown; generation?: unknown; chunks?: unknown; byteLength?: unknown;
    adminReady?: unknown; checks?: { guest_booted?: unknown; shell_command_passed?: unknown; dhcp_passed?: unknown; ca_certificates_passed?: unknown };
  }>();
  if (manifest.version !== 1 || typeof manifest.generation !== "string" ||
      !/^[a-z0-9-]{1,40}$/.test(manifest.generation) ||
      !Number.isInteger(manifest.chunks) || (manifest.chunks as number) < 1 || (manifest.chunks as number) > 128 ||
      !Number.isInteger(manifest.byteLength) || (manifest.byteLength as number) < 1 || (manifest.byteLength as number) > 536870912 ||
      manifest.chunks !== Math.ceil((manifest.byteLength as number) / (8 * 1024 * 1024))) {
    throw new Error("admin_baseline_manifest_invalid");
  }
  const checks = manifest.checks;
  if (manifest.adminReady !== true || !checks || checks.guest_booted !== true ||
      checks.shell_command_passed !== true || checks.dhcp_passed !== true || checks.ca_certificates_passed !== true) {
    throw new Error("admin_baseline_not_ready");
  }
  const state = new Uint8Array(manifest.byteLength as number);
  const prefix = "vm-snapshots/admin/" + manifest.generation + "/";
  let offset = 0;
  for (let part = 0; part < (manifest.chunks as number); part++) {
    const item = await bucket.get(prefix + part + ".bin");
    const expected = Math.min(8 * 1024 * 1024, (manifest.byteLength as number) - offset);
    if (!item || item.size !== expected) throw new Error("admin_baseline_chunk_invalid_" + part);
    state.set(new Uint8Array(await item.arrayBuffer()), offset);
    offset += expected;
  }
  return { generation: manifest.generation, chunks: manifest.chunks as number, byteLength: manifest.byteLength as number, state };
}

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher; VM_SNAPSHOTS: R2Bucket; ACCOUNT_REGISTRY: DurableObjectNamespace<AccountRegistry>; WISP_RELAY: DurableObjectNamespace<WispRelay> }) {
    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;
    if (path === "/api/network/wisp/" && request.method === "GET") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
      const identity = requestUrl.searchParams.get("identity") ?? "";
      const ticket = requestUrl.searchParams.get("ticket") ?? "";
      if (!/^(acct-[a-f0-9-]{36}|test-[a-z0-9-]{1,32})$/.test(identity) || !/^[a-f0-9]{64}$/.test(ticket)) return Response.json({ error: "invalid_network_ticket" }, { status: 401 });
      const relay = env.WISP_RELAY.get(env.WISP_RELAY.idFromName(identity));
      return relay.fetch(request);
    }
    if (path === "/ready") return Response.json({ ready: true, probe: "tinycore-dhcp-openssl-ca" });
    if (path === "/progress" && request.method === "GET") {
      const identity = (requestUrl.searchParams.get("identity") ?? "").toLowerCase();
      if (!/^(acct-[a-f0-9-]{36}|test-[a-z0-9-]{1,32})$/.test(identity)) return Response.json({ error: "invalid_snapshot_identity" }, { status: 400 });
      const object = await env.VM_SNAPSHOTS.get("runtime-jobs/" + identity + ".json");
      if (!object) return Response.json({ error: "progress_not_found", identity }, { status: 404 });
      return new Response(object.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    if ((path !== "/run" && path !== "/snapshot-roundtrip") || request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    let requestedIdentity = path === "/snapshot-roundtrip" ? "test-v86-roundtrip" : "";
    try {
      const body = await request.json() as { identity?: unknown };
      if (typeof body.identity === "string") requestedIdentity = body.identity.toLowerCase();
    } catch {
      if (path !== "/snapshot-roundtrip") return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (!/^(acct-[a-f0-9-]{36}|test-[a-z0-9-]{1,32})$/.test(requestedIdentity)) return Response.json({ error: "invalid_snapshot_identity" }, { status: 400 });
    const snapshotIdentity = requestedIdentity;
    const jobKey = "runtime-jobs/" + snapshotIdentity + ".json";
    let jobStatus = "running", jobStep = "starting_vm";
    const jobStartedAt = new Date().toISOString();
    const jobDetails: Record<string, unknown> = {};
    const writeProgress = async (status = jobStatus, step = jobStep, details: Record<string, unknown> = {}) => {
      const changed = status !== jobStatus || step !== jobStep;
      jobStatus = status; jobStep = step; Object.assign(jobDetails, details);
      await env.VM_SNAPSHOTS.put(jobKey, JSON.stringify({ identity: snapshotIdentity, status: jobStatus, step: jobStep, started_at: jobStartedAt, updated_at: new Date().toISOString(), ...jobDetails }), { httpMetadata: { contentType: "application/json" } });
      if (changed) console.log("V86_SNAPSHOT_PROGRESS", JSON.stringify({ identity: snapshotIdentity, status: jobStatus, step: jobStep }));
    };
    await writeProgress("running", "starting_vm");
    let baselineSnapshot: BaselineSnapshot | null = null;
    if (path === "/snapshot-roundtrip") {
      try {
        baselineSnapshot = await readAdminBaseline(env.VM_SNAPSHOTS);
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        await writeProgress("error", "baseline_snapshot_validation", { error: message });
        return Response.json({ probe: "tinycore-snapshot-save-readback", runtime: "workerd", passed: false, baseline_snapshot_used: false, error: message }, { status: 409 });
      }
      if (baselineSnapshot) await writeProgress("running", "restoring_admin_baseline", { baseline_snapshot_used: true, baseline_generation: baselineSnapshot.generation, baseline_byte_length: baselineSnapshot.byteLength });
    }

    const wasm = getCompiledV86WasmInfo();
    await writeProgress("running", "booting_linux", { wasm_module_loaded: wasm.module_loaded });
    const base = new URL(request.url);
    const allocationRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
    // The allocator intentionally accepts only production account IDs. For test-* snapshot
    // identities, derive a deterministic synthetic account UUID so repeated test runs reuse
    // the same address without weakening production account-ID validation.
    let networkAccountId = snapshotIdentity;
    if (!networkAccountId.startsWith("acct-")) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshotIdentity));
      const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      networkAccountId = "acct-" + hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) + "-8" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
    }
    const allocationResponse = await allocationRegistry.fetch("https://account-registry.internal/network/allocate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ account_id: networkAccountId }),
    });
    if (!allocationResponse.ok) {
      await writeProgress("error", "network_identity", { error: "virtual_network_allocation_failed" });
      return Response.json({ probe: "tinycore-snapshot-save-readback", runtime: "workerd", passed: false, guest_booted: false, error: "virtual_network_allocation_failed" }, { status: 503 });
    }
    const allocationResult = await allocationResponse.json() as { allocation?: { virtual_ip?: unknown; virtual_mac?: unknown } };
    const virtualIp = typeof allocationResult.allocation?.virtual_ip === "string" ? allocationResult.allocation.virtual_ip : "";
    const virtualMac = typeof allocationResult.allocation?.virtual_mac === "string" ? allocationResult.allocation.virtual_mac : "";
    const routerIp = virtualGatewayForIp(virtualIp);
    if (!routerIp || !/^02(?::[0-9a-f]{2}){5}$/.test(virtualMac)) {
      await writeProgress("error", "network_identity", { error: "invalid_virtual_network_identity" });
      return Response.json({ probe: "tinycore-snapshot-save-readback", runtime: "workerd", passed: false, guest_booted: false, error: "invalid_virtual_network_identity" }, { status: 500 });
    }
    const relay = env.WISP_RELAY.get(env.WISP_RELAY.idFromName(snapshotIdentity));
    const ticketResponse = await relay.fetch("https://wisp-relay.internal/ticket", { method: "POST" });
    if (!ticketResponse.ok) {
      await writeProgress("error", "network_identity", { error: "network_ticket_unavailable" });
      return Response.json({ probe: "tinycore-snapshot-save-readback", runtime: "workerd", passed: false, guest_booted: false, error: "network_ticket_unavailable" }, { status: 503 });
    }
    const ticketData = await ticketResponse.json() as { ticket?: unknown };
    if (typeof ticketData.ticket !== "string") {
      await writeProgress("error", "network_identity", { error: "invalid_network_ticket" });
      return Response.json({ probe: "tinycore-snapshot-save-readback", runtime: "workerd", passed: false, guest_booted: false, error: "invalid_network_ticket" }, { status: 500 });
    }
    const wsScheme = base.protocol === "https:" ? "wisps://" : "wisp://";
    const relayUrl = wsScheme + base.host + "/api/network/wisp/?identity=" + encodeURIComponent(snapshotIdentity) + "&ticket=" + encodeURIComponent(ticketData.ticket);
    let finishBoot!: (value: { booted: boolean; reason?: string }) => void;
    const bootObserved = new Promise<{ booted: boolean; reason?: string }>((resolve) => { finishBoot = resolve; });
    let started = false;
    let loaded = false;
    let emulator: any;

    class AssetXMLHttpRequest {
      method = "GET"; url = ""; responseType = ""; response: unknown = null; responseText = "";
      readyState = 0; status = 0; onreadystatechange: (() => void) | null = null;
      timeout = 0; onload: (() => void) | null = null; onerror: (() => void) | null = null; ontimeout: (() => void) | null = null;
      open(method: string, url: string) { this.method = method; this.url = url; this.readyState = 1; this.onreadystatechange?.(); }
      setRequestHeader(_name: string, _value: string) {}
      getResponseHeader(_name: string) { return null; }
      getAllResponseHeaders() { return ""; }
      async send() {
        try {
          const target = new URL(this.url, request.url);
          const response = await env.ASSETS.fetch(new Request(target.toString(), { method: this.method }));
          this.status = response.status;
          if (this.responseType === "arraybuffer") this.response = await response.arrayBuffer();
          else { this.responseText = await response.text(); this.response = this.responseText; }
          this.readyState = 4; this.onreadystatechange?.(); this.onload?.();
        } catch { this.onerror?.(); }
      }
    }
    (globalThis as unknown as { XMLHttpRequest: typeof AssetXMLHttpRequest }).XMLHttpRequest = AssetXMLHttpRequest;

    try {
      const netDevice: { type: "ne2k"; relay_url: string; vm_ip: string; router_ip: string; masquerade: boolean; dns_method: string; doh_server: string } = {
        type: "ne2k", relay_url: relayUrl, vm_ip: virtualIp, router_ip: routerIp,
        masquerade: true, dns_method: "doh", doh_server: "cloudflare-dns.com",
      };
      emulator = new V86({
        wasm_fn: createCompiledV86WasmFn(),
        memory_size: 128 * 1024 * 1024,
        vga_memory_size: 1024 * 1024,
        bios: { url: new URL("/bios/seabios.bin", base).toString() },
        vga_bios: { url: new URL("/bios/vgabios.bin", base).toString() },
        cdrom: { url: new URL("/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso", base).toString() },
        autostart: !baselineSnapshot,
        disable_keyboard: false,
        disable_mouse: true,
        net_device: netDevice,
      } as ConstructorParameters<typeof V86>[0]);
      emulator.add_listener("emulator-loaded", async () => {
        loaded = true;
        try {
          let bootPrompt = false;
          if (baselineSnapshot) {
            await emulator.restore_state(baselineSnapshot.state.buffer as ArrayBuffer);
            baselineSnapshot.state = new Uint8Array(0);
            await emulator.run();
          } else {
            // Clean-boot path is retained for environments that have no admin baseline yet.
            try {
              bootPrompt = Boolean(await emulator.wait_until_vga_screen_contains(/boot:/i, {
                timeout_msec: BOOTLOADER_PROMPT_TIMEOUT_MS,
              }));
            } catch {
              // A missing boot prompt is expected for an auto-booting ISO.
            }
            if (bootPrompt) {
              await emulator.keyboard_send_scancodes([0x1C, 0x9C]);
              await new Promise<void>((resolve) => setTimeout(resolve, 1000));
            }
          }
          const shellReached = await emulator.wait_until_vga_screen_contains(/tc@box:~\\$|tc@box:~\$|tc@box|localhost login:|login:/i, { timeout_msec: BOOT_TIMEOUT_MS });
          finishBoot(shellReached
            ? { booted: true }
            : { booted: false, reason: baselineSnapshot
                ? "admin_baseline_restore_did_not_reach_linux_shell"
                : bootPrompt ? "linux_shell_or_login_marker_not_seen_after_boot_prompt" : "linux_shell_or_login_marker_not_seen_after_auto_boot" });
        } catch (error) {
          finishBoot({ booted: false, reason: "boot_probe_error: " + (error instanceof Error ? error.message : String(error)).slice(0, 250) });
        }
      });
      emulator.add_listener("emulator-started", () => { started = true; });
    } catch (error) {
      finishBoot({ booted: false, reason: "constructor_error: " + (error instanceof Error ? error.message : String(error)).slice(0, 250) });
    }

    // Publish real VGA text while the guest boots. Previously the page stayed on
    // the static "emulator started" fallback until the entire shell wait ended.
    let stopBootHeartbeat = false;
    const bootHeartbeat = (async () => {
      const startedAt = Date.now();
      const bootStartedAt = new Date(startedAt).toISOString();
      let previousExcerpt: string | undefined;
      let screenLastChangedAt = startedAt;
      while (!stopBootHeartbeat) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5000));
        if (stopBootHeartbeat) break;
        let excerpt = "";
        try { excerpt = emulator?.screen_adapter?.get_text_screen?.().join("\n").slice(-900) ?? ""; } catch {}
        const now = Date.now();
        if (excerpt !== previousExcerpt) {
          previousExcerpt = excerpt;
          screenLastChangedAt = now;
        }
        try {
          await writeProgress("running", "booting_linux", {
            wasm_module_loaded: wasm.module_loaded,
            emulator_loaded: loaded,
            emulator_started: started,
            boot_started_at: bootStartedAt,
            boot_wait_seconds: Math.floor((now - startedAt) / 1000),
            boot_screen_unchanged_seconds: Math.floor((now - screenLastChangedAt) / 1000),
            boot_screen_excerpt: excerpt,
            boot_heartbeat_at: new Date(now).toISOString(),
          });
        } catch {
          // A transient progress-store failure must not stop the boot probe itself.
        }
      }
    })();

    const boot = await Promise.race([
      bootObserved,
      new Promise<{ booted: boolean; reason?: string }>((resolve) => setTimeout(
        () => resolve({ booted: false, reason: "guest_boot_timeout" }),
        BOOT_TIMEOUT_MS + BOOTLOADER_PROMPT_TIMEOUT_MS + 15000,
      )),
    ]);
    stopBootHeartbeat = true;
    await bootHeartbeat;

    const stages: Record<string, Stage> = {};
    let bootScreenExcerpt = "";
    try { bootScreenExcerpt = emulator?.screen_adapter?.get_text_screen?.().join("\n").slice(-900) ?? ""; } catch {}
    await writeProgress(boot.booted ? "running" : "error", boot.booted ? "linux_booted" : "linux_boot_failed", {
      guest_booted: boot.booted,
      boot_error: boot.reason ?? null,
      boot_screen_excerpt: bootScreenExcerpt,
      boot_finished_at: new Date().toISOString(),
    });
    const runStage = async (key: string, command: string, marker: string, timeout: number, asRoot = false): Promise<boolean> => {
      const stage: Stage = { attempted: true, passed: false, marker };
      stages[key] = stage;
      await writeProgress("running", key, { stage: key, stage_status: "started" });
      try {
        // Do not inject multiline shell source into the interactive terminal. v86's
        // keyboard path can lose/reorder characters in long lines and here-docs.
        // Octal escapes keep the payload inert. Keep each octal chunk at 24
        // characters so the complete printf command stays below Tiny Core's
        // terminal line-buffer limit; 64-character chunks were truncated and
        // corrupted the DHCP script.
        const markerText = "__" + marker + "__";
        const payload = "(\n" + command + "\n)\nstage_rc=$?\necho STAGE_SCRIPT_RC=$stage_rc\nprintf '\\n" + markerText + "\\n'\n";
        // Tiny Core's BusyBox build has no base64 applet. Transfer the ASCII
        // script using shell printf octal escapes, which are supported by the
        // guest's shell and avoid depending on optional decoder utilities.
        const octal = Array.from(payload, (char) => "\\" + char.charCodeAt(0).toString(8).padStart(3, "0")).join("");
        const chunks = octal.match(/[\s\S]{1,24}/g) ?? [];
        const sendLine = async (line: string) => {
          await emulator.keyboard_send_text(line + "\n");
          // Let the emulated keyboard/TTY consume this short line before sending
          // the next one; sending a whole script in one call was corrupting input.
          await new Promise<void>((resolve) => setTimeout(resolve, 80));
        };
        await sendLine(": > /tmp/headless-v86-stage.sh");
        for (const chunk of chunks) {
          await sendLine("printf '%b' '" + chunk + "' >> /tmp/headless-v86-stage.sh");
        }
        const runner = asRoot
          ? "sudo -n sh /tmp/headless-v86-stage.sh"
          : "sh /tmp/headless-v86-stage.sh";
        await emulator.keyboard_send_text(runner + "\n");
        const observed = await emulator.wait_until_vga_screen_contains(new RegExp(markerText), { timeout_msec: timeout });
        let screen = "";
        try { screen = emulator.screen_adapter?.get_text_screen?.().join("\n") ?? ""; } catch {}
        stage.output = screen.slice(-24000);
        stage.passed = Boolean(observed) && screen.includes(markerText);
        if (stage.passed && key === "post_save_dhcp_verify") {
          // VGA exposes only the current screen, not scrollback. Read the log one
          // source line at a time between markers; this preserves every log line and
          // avoids treating terminal line-wraps as missing bytes.
          const collected: string[] = [];
          const sizeMarker = "__POST_SAVE_DHCP_LOG_SIZE__";
          await sendLine("printf '\\nPOST_SAVE_DHCP_LOG_LINES='; wc -l < /tmp/post-save-dhcp.log; echo " + sizeMarker);
          const sizeSeen = await emulator.wait_until_vga_screen_contains(new RegExp(sizeMarker), { timeout_msec: 10000 });
          let sizeScreen = "";
          try { sizeScreen = emulator.screen_adapter?.get_text_screen?.().join("\n") ?? ""; } catch {}
          const sizeMatch = sizeSeen ? sizeScreen.match(/POST_SAVE_DHCP_LOG_LINES=(\d+)/) : null;
          const lineCount = sizeMatch ? Number(sizeMatch[1]) : -1;
          if (!Number.isSafeInteger(lineCount) || lineCount < 0 || lineCount > 160) {
            stage.passed = false;
            stage.error = "post_save_dhcp_log_line_count_unavailable_or_exceeds_limit";
            stage.output = "LOG_CAPTURE_ERROR line_count=" + lineCount + "\n" + sizeScreen.slice(-1200);
          } else {
            for (let line = 1; line <= lineCount; line++) {
              const startMarker = "__DHCP_LOG_LINE_START_" + line + "__";
              const endMarker = "__DHCP_LOG_LINE_END_" + line + "__";
              await sendLine("printf '\\n" + startMarker + "\\n'; sed -n '" + line + "p' /tmp/post-save-dhcp.log; printf '\\n" + endMarker + "\\n'");
              const lineSeen = await emulator.wait_until_vga_screen_contains(new RegExp(endMarker), { timeout_msec: 10000 });
              let lineScreen = "";
              try { lineScreen = emulator.screen_adapter?.get_text_screen?.().join("\n") ?? ""; } catch {}
              const startIndex = lineScreen.lastIndexOf(startMarker);
              const endIndex = lineScreen.lastIndexOf(endMarker);
              if (!lineSeen || startIndex < 0 || endIndex <= startIndex) {
                stage.passed = false;
                stage.error = "post_save_dhcp_log_line_capture_failed_" + line;
                collected.push("LOG_CAPTURE_ERROR line=" + line);
                break;
              }
              const content = lineScreen.slice(startIndex + startMarker.length, endIndex).replace(/^\n/, "").replace(/\n$/, "").replace(/\n/g, "");
              collected.push(content);
            }
            stage.output = collected.join("\n");
            stage.output += "\nPOST_SAVE_DHCP_LOG_EXPECTED_LINES=" + lineCount + "\nPOST_SAVE_DHCP_LOG_CAPTURED_LINES=" + collected.length;
            if (stage.passed && collected.length !== lineCount) {
              stage.passed = false;
              stage.error = "post_save_dhcp_log_capture_incomplete";
            }
          }
        }
        if (!stage.passed && !stage.error) stage.error = "stage_marker_not_seen_within_timeout";
      } catch (error) {
        stage.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      }
      await writeProgress("running", key, { stage: key, stage_status: stage.passed ? "passed" : "failed", stage_error: stage.error ?? null, stage_results: Object.fromEntries(Object.entries(stages).map(([name, item]) => [name, { attempted: item.attempted, passed: item.passed, marker: item.marker, error: item.error ?? null, output: item.output ?? null }])) });
      return stage.passed;
    };

    if (boot.booted) {
      // Reuse the known-good NETWORK INIT command from the user's real VM run.
      // Bound DHCP retries so a missing lease fails quickly and the workflow can report diagnostics.
      const dhcpCommand = `set +e
echo "--- NETWORK INIT ---"
id
iface=$(/sbin/ifconfig -a 2>/dev/null | grep -E "^(eth|en|wlan)" | head -n 1 | cut -d " " -f 1)
if [ -z "$iface" ]; then
  /sbin/modprobe ne2k-pci 2>&1
  /sbin/modprobe 8390 2>&1
  sleep 1
  iface=$(/sbin/ifconfig -a 2>/dev/null | grep -E "^(eth|en|wlan)" | head -n 1 | cut -d " " -f 1)
fi
echo DHCP_INTERFACE=$iface
echo DHCP_EXPECTED_IP=${virtualIp}
echo DHCP_EXPECTED_GATEWAY=${routerIp}
echo DHCP_EXPECTED_MAC=${virtualMac}
if [ -z "$iface" ]; then
  echo NIC_MISSING
  cat /proc/net/dev
  dmesg 2>/dev/null | tail -n 20
  exit 1
fi
/sbin/ifconfig "$iface" down 2>/dev/null
/sbin/ifconfig "$iface" hw ether "${virtualMac}" || { echo MAC_ASSIGN_FAILED; exit 1; }
/sbin/ifconfig "$iface" up || exit 1
tries=0
while [ "$tries" -lt 12 ]; do
  /sbin/udhcpc -f -n -q -t 2 -T 2 -i "$iface"
  actual_ip=$(/sbin/ifconfig "$iface" | awk '/inet addr:/{sub(/.*inet addr:/,"");sub(/ .*/,"");print;exit} /inet /{for(i=1;i<=NF;i++)if($i=="inet"){print $(i+1);exit}}')
  actual_gateway=$(/sbin/route -n | awk '$1=="0.0.0.0"{print $2;exit}')
  echo DHCP_ACTUAL_IP=$actual_ip
  echo DHCP_ACTUAL_GATEWAY=$actual_gateway
  if [ "$actual_ip" = "${virtualIp}" ] && [ "$actual_gateway" = "${routerIp}" ]; then
    echo DHCP_OK
    exit 0
  fi
  echo DHCP_RETRYING_NO_LEASE_OR_WRONG_ADDRESS
  tries=$((tries+1))
  sleep 2
done
echo DHCP_TIMEOUT
/sbin/ifconfig -a
/sbin/route -n
exit 1`;
      await runStage("resource_preflight",
        "echo \"--- RESOURCE PREFLIGHT ---\"; df -h / /tmp /usr/local/tce 2>&1; free 2>&1; cat /proc/meminfo 2>/dev/null | head -n 8; echo \"TLS prerequisite installation will run before HTTPS preflight.\"",
        "RESOURCE_PREFLIGHT_DONE", SHELL_COMMAND_TIMEOUT_MS);
      const dhcpPassed = await runStage("dhcp", dhcpCommand, "DHCP_DONE", 90000, true);
      const dhcpOutput = stages.dhcp.output ?? "";
      stages.dhcp.passed = dhcpPassed && /DHCP_OK/.test(dhcpOutput) &&
        dhcpOutput.includes("DHCP_ACTUAL_IP=" + virtualIp) && dhcpOutput.includes("DHCP_ACTUAL_GATEWAY=" + routerIp) &&
        !/NIC_MISSING|DHCP_TIMEOUT|MAC_ASSIGN_FAILED/.test(dhcpOutput);
      if (!stages.dhcp.passed) stages.dhcp.error = /NIC_MISSING/.test(dhcpOutput)
        ? "guest_nic_missing"
        : /MAC_ASSIGN_FAILED/.test(dhcpOutput) ? "account_mac_assignment_failed"
        : /DHCP_TIMEOUT/.test(dhcpOutput) ? "no_expected_dhcp_ip_and_gateway_within_ninety_seconds" : (stages.dhcp.error ?? "dhcp_stage_failed");

      if (stages.dhcp.passed) {
        const httpPreflightCommand = `set +e
echo '--- EXTERNAL PLAIN HTTP EGRESS PREFLIGHT ---'
wget -T 30 -t 1 -S -O /dev/null http://neverssl.com/ >/tmp/http-egress.log 2>&1
rc=$?
cat /tmp/http-egress.log
echo HTTP_EGRESS_RC=$rc
[ "$rc" -eq 0 ] && echo TCP_HTTP_EGRESS_OK || { echo TCP_HTTP_EGRESS_FAILED; exit 1; }`;
        await runStage("http_preflight", httpPreflightCommand, "HTTP_EGRESS_PREFLIGHT_DONE", 90000);
        const httpOut = stages.http_preflight.output ?? "";
        stages.http_preflight.passed = stages.http_preflight.passed &&
          /HTTP_EGRESS_RC=0/.test(httpOut) && /TCP_HTTP_EGRESS_OK/.test(httpOut);
        if (!stages.http_preflight.passed) stages.http_preflight.error = "external_tcp_http_egress_failed";
      }

      if (stages.dhcp.passed) {
        if (baselineSnapshot) {
          const baselineTlsCommand = `set +e
echo "--- VERIFY TLS PREREQUISITES FROM RESTORED ADMIN SNAPSHOT ---"
OPENSSL_BIN=$(command -v openssl 2>/dev/null)
echo OPENSSL_PATH=$OPENSSL_BIN
if [ -n "$OPENSSL_BIN" ] && openssl version 2>&1; then echo OPENSSL_PRESENT_RC=0; else echo OPENSSL_PRESENT_RC=1; fi
CA_BUNDLE=$(find /usr/local/etc/ssl/certs /etc/ssl/certs /usr/local/share/ca-certificates /etc/ssl -type f -name ca-certificates.crt 2>/dev/null | head -n 1)
echo CA_BUNDLE_PATH=$CA_BUNDLE
if [ -n "$CA_BUNDLE" ] && [ -s "$CA_BUNDLE" ] && grep -q 'BEGIN CERTIFICATE' "$CA_BUNDLE"; then echo CA_BUNDLE_CHECK_RC=0; else echo CA_BUNDLE_CHECK_RC=1; fi`;
          await runStage("baseline_tls_verify", baselineTlsCommand, "BASELINE_TLS_VERIFY_DONE", 60000, true);
          const baselineTlsOut = stages.baseline_tls_verify.output ?? "";
          stages.baseline_tls_verify.passed = stages.baseline_tls_verify.passed &&
            /OPENSSL_PRESENT_RC=0/.test(baselineTlsOut) && /OpenSSL 1\./.test(baselineTlsOut) &&
            /CA_BUNDLE_CHECK_RC=0/.test(baselineTlsOut);
          if (!stages.baseline_tls_verify.passed) stages.baseline_tls_verify.error = "admin_baseline_missing_openssl_or_ca_certificates";
        } else {
          const tlsDownloadCommand = `set +e
echo '--- TLS package downloads with mirror fallback ---'
mirrors='http://distro.ibiblio.org/tinycorelinux/ http://repo.tinycorelinux.net/'
openssl_dl=1
for mirror in $mirrors; do
  echo TCE_MIRROR_ATTEMPT=$mirror
  printf '%s\\n' "$mirror" > /opt/tcemirror
  timeout 45 tce-load -w openssl-1.1.1.tcz
  openssl_dl=$?
  if [ "$openssl_dl" -eq 0 ]; then break; fi
  echo OPENSSL_DOWNLOAD_RETRY_AFTER_RC=$openssl_dl
done
ca_dl=1
for mirror in $mirrors; do
  echo CA_MIRROR_ATTEMPT=$mirror
  printf '%s\\n' "$mirror" > /opt/tcemirror
  timeout 45 tce-load -w ca-certificates.tcz
  ca_dl=$?
  if [ "$ca_dl" -eq 0 ]; then break; fi
  echo CA_DOWNLOAD_RETRY_AFTER_RC=$ca_dl
done
echo OPENSSL_DOWNLOAD_RC=$openssl_dl
echo CA_DOWNLOAD_RC=$ca_dl`;
          await runStage("tls_download", tlsDownloadCommand, "TLS_DOWNLOAD_DONE", 240000);
          const dlOut = stages.tls_download.output ?? "";
          stages.tls_download.passed = stages.tls_download.passed && /OPENSSL_DOWNLOAD_RC=0/.test(dlOut) && /CA_DOWNLOAD_RC=0/.test(dlOut);
          if (!stages.tls_download.passed) stages.tls_download.error = "openssl_or_ca_package_download_failed";

          if (stages.tls_download.passed) {
            const opensslInstallCommand = `echo '--- OpenSSL install ---'
tce-load -i openssl-1.1.1 >/tmp/openssl-install.log 2>&1
install_rc=$?
if [ "$install_rc" -eq 0 ] && openssl version >/dev/null 2>&1; then rc=0; else rc=1; fi
echo OPENSSL_PATH=$(command -v openssl 2>/dev/null)
echo OPENSSL_INSTALL_RC=$rc
openssl version 2>&1`;
            await runStage("openssl_install", opensslInstallCommand, "OPENSSL_INSTALL_DONE", 60000);
            const sslOut = stages.openssl_install.output ?? "";
            stages.openssl_install.passed = stages.openssl_install.passed && /OPENSSL_INSTALL_RC=0/.test(sslOut) && /OpenSSL 1\./.test(sslOut);
            if (!stages.openssl_install.passed) stages.openssl_install.error = "openssl_install_or_version_check_failed";

            const caInstallCommand = `set +e
echo '--- CA certificate install ---'
echo CA_EXTENSION_FILES
ls -l /tmp/tce/optional/ca-certificates* /usr/local/tce/optional/ca-certificates* 2>&1
su - tc -c 'id; tce-load -i /tmp/tce/optional/ca-certificates.tcz' >/tmp/ca.log 2>&1
rc=$?
echo CA_INSTALL_RC=$rc
tail -n 20 /tmp/ca.log 2>&1
CA_BUNDLE=$(find /usr/local/etc/ssl/certs /etc/ssl/certs /usr/local/share/ca-certificates /etc/ssl -type f -name ca-certificates.crt 2>/dev/null | head -n 1)
echo CA_BUNDLE_PATH=$CA_BUNDLE
if [ -n "$CA_BUNDLE" ] && [ -s "$CA_BUNDLE" ] && grep -q 'BEGIN CERTIFICATE' "$CA_BUNDLE"; then echo CA_BUNDLE_CHECK_RC=0; else echo CA_BUNDLE_CHECK_RC=1; fi`;
            await runStage("ca_install", caInstallCommand, "CA_CERTIFICATES_INSTALL_DONE", 600000, true);
            const caOut = stages.ca_install.output ?? "";
            stages.ca_install.passed = stages.ca_install.passed && /CA_INSTALL_RC=0/.test(caOut) && /CA_BUNDLE_CHECK_RC=0/.test(caOut);
            if (!stages.ca_install.passed) stages.ca_install.error = "ca_install_or_bundle_check_failed";
          }
        }

        const tlsPrerequisitesPassed = baselineSnapshot
          ? stages.baseline_tls_verify?.passed === true
          : stages.openssl_install?.passed === true && stages.ca_install?.passed === true;
        if (tlsPrerequisitesPassed) {
          const httpsPreflightCommand = `set +e
echo '--- EXTERNAL HTTPS EGRESS PREFLIGHT ---'
cat /etc/resolv.conf 2>&1
wget -T 30 -t 1 -S -O /dev/null https://www.google.com/generate_204 >/tmp/https-egress.log 2>&1
rc=$?
cat /tmp/https-egress.log
echo HTTPS_EGRESS_RC=$rc
[ "$rc" -eq 0 ] && echo TCP_HTTPS_EGRESS_OK || { echo TCP_HTTPS_EGRESS_FAILED; exit 1; }`;
          await runStage("https_preflight", httpsPreflightCommand, "EGRESS_PREFLIGHT_DONE", 90000);
          const httpsOut = stages.https_preflight.output ?? "";
          stages.https_preflight.passed = stages.https_preflight.passed &&
            /HTTPS_EGRESS_RC=0/.test(httpsOut) && /TCP_HTTPS_EGRESS_OK/.test(httpsOut);
          if (!stages.https_preflight.passed) stages.https_preflight.error = "external_tcp_https_egress_failed";
        }
      }
    }

    const tlsPrerequisitesPassed = baselineSnapshot
      ? stages.baseline_tls_verify?.passed === true
      : stages.tls_download?.passed === true && stages.openssl_install?.passed === true && stages.ca_install?.passed === true;
    const guestChecksPassed = boot.booted && stages.dhcp?.passed === true &&
      stages.resource_preflight?.passed === true && stages.http_preflight?.passed === true &&
      tlsPrerequisitesPassed && stages.https_preflight?.passed === true;
    let snapshotRoundtrip: Record<string, unknown> = {
      attempted: false, saved: false, readback: false, restored: false, marker_verified: false,
    };
    let roundtripPassed = false;
    if (guestChecksPassed) {
      const marker = "V86_SNAPSHOT_PERSISTED_MARKER_7f8d2a";
      const markerStage = await runStage("snapshot_marker", "printf '%s\\n' '" + marker + "' > /tmp/v86-snapshot-roundtrip-marker; test \"$(cat /tmp/v86-snapshot-roundtrip-marker)\" = '" + marker + "' && echo SNAPSHOT_MARKER_WRITTEN", "SNAPSHOT_MARKER_DONE", SHELL_COMMAND_TIMEOUT_MS);
      snapshotRoundtrip.attempted = true;
      snapshotRoundtrip.marker_written = markerStage && /SNAPSHOT_MARKER_WRITTEN/.test(stages.snapshot_marker?.output ?? "");
      if (snapshotRoundtrip.marker_written) {
        try {
          let state: ArrayBuffer | undefined = await emulator.save_state();
          const stateBytes = state.byteLength;
          snapshotRoundtrip.state_bytes = stateBytes;
          const checks = {
            guest_booted: true, shell_command_passed: true,
            dhcp_passed: stages.dhcp?.passed === true,
            dns_passed: stages.https_preflight?.passed === true,
            https_passed: stages.https_preflight?.passed === true,
          };
          const generation = "gen-" + Date.now().toString(36);
          const manifest = await commitGuestSnapshot(env.VM_SNAPSHOTS, snapshotIdentity, generation, state, checks);
          state = undefined; // Release the original ~100 MiB state before verifying stored bytes.
          snapshotRoundtrip.saved = true;
          snapshotRoundtrip.generation = manifest.generation;
          snapshotRoundtrip.sha256 = manifest.sha256;
          await writeProgress("running", "snapshot_saved", { snapshot_roundtrip: { ...snapshotRoundtrip } });

          // Re-run the user's requested interface/route/DNS DHCP diagnostics only
          // after the snapshot has been durably saved. This checks live networking
          // at the post-save verification point without allocating a second emulator.
          const postSaveDhcpCommand = `set +e
LOG=/tmp/post-save-dhcp.log
{
  echo "===== DHCP TEST START $(date -u 2>/dev/null) ====="
  echo "LOG_PATH=$LOG"
  echo "--- Identity / time ---"
  id
  date -u 2>&1
  IFACE=eth0
  echo "IFACE=$IFACE"
  echo "--- Interfaces before DHCP ---"
  /sbin/ifconfig -a 2>&1
  echo "--- Existing routes ---"
  /sbin/route -n 2>&1
  echo "--- Existing DNS ---"
  cat /etc/resolv.conf 2>&1
  echo "--- DHCP lease files (if present) ---"
  for f in /var/lib/udhcpc/* /var/db/dhclient* /tmp/udhcpc*; do
    if [ -f "$f" ]; then echo "LEASE_FILE=$f"; cat "$f" 2>&1; fi
  done
  echo "--- Bring interface up ---"
  sudo -n /sbin/ifconfig "$IFACE" up 2>&1
  echo "IFCONFIG_UP_RC=$?"
  echo "--- Request DHCP lease ---"
  sudo -n /sbin/udhcpc -f -n -q -i "$IFACE" 2>&1
  DHCP_CLIENT_RC=$?
  echo "DHCP_CLIENT_RC=$DHCP_CLIENT_RC"
  echo "--- Interface after DHCP ---"
  /sbin/ifconfig "$IFACE" 2>&1
  echo "IFCONFIG_AFTER_RC=$?"
  echo "--- Routes after DHCP ---"
  /sbin/route -n 2>&1
  echo "ROUTE_AFTER_RC=$?"
  echo "--- DNS after DHCP ---"
  cat /etc/resolv.conf 2>&1
  echo "===== DHCP TEST COMPLETE ====="
  echo "POST_SAVE_DHCP_LOG_RC=$DHCP_CLIENT_RC"
} > "$LOG" 2>&1
LOG_WRITE_RC=$?
echo "POST_SAVE_DHCP_LOG_WRITE_RC=$LOG_WRITE_RC"
echo "--- BEGIN COMPLETE POST-SAVE DHCP LOG ---"
cat "$LOG" 2>&1
CAT_RC=$?
echo "POST_SAVE_DHCP_LOG_CAT_RC=$CAT_RC"
echo "--- END COMPLETE POST-SAVE DHCP LOG ---"
echo POST_SAVE_DHCP_DIAGNOSTICS_DONE`;
          await runStage("post_save_dhcp_verify", postSaveDhcpCommand, "POST_SAVE_DHCP_DIAGNOSTICS_DONE", 90000, true);
          const postSaveDhcpOutput = stages.post_save_dhcp_verify.output ?? "";
          const postSaveDhcpClientRc = postSaveDhcpOutput.match(/DHCP_CLIENT_RC=(\\d+)/)?.[1];
          const postSaveHasIpv4 = /inet addr:\\d+\\.\\d+\\.\\d+\\.\\d+|inet \\d+\\.\\d+\\.\\d+\\.\\d+/.test(postSaveDhcpOutput);
          const postSaveHasDefaultRoute = /0\\.0\\.0\\.0\\s+\\d+\\.\\d+\\.\\d+\\.\\d+/.test(postSaveDhcpOutput);
          stages.post_save_dhcp_verify.passed = stages.post_save_dhcp_verify.passed &&
            postSaveDhcpClientRc === "0" && postSaveHasIpv4 && postSaveHasDefaultRoute &&
            /DHCP TEST COMPLETE/.test(postSaveDhcpOutput);
          if (!stages.post_save_dhcp_verify.passed) {
            stages.post_save_dhcp_verify.error = "post_save_dhcp_lease_interface_or_default_route_verification_failed";
            snapshotRoundtrip.post_save_dhcp_verified = false;
          } else {
            snapshotRoundtrip.post_save_dhcp_verified = true;
          }
          await writeProgress("running", "post_save_dhcp_verified", {
            snapshot_roundtrip: { ...snapshotRoundtrip },
            stage_results: Object.fromEntries(Object.entries(stages).map(([name, item]) => [name, { attempted: item.attempted, passed: item.passed, marker: item.marker, error: item.error ?? null, output: item.output ?? null }]))
          });

          try { emulator?.stop(); } catch {}
          emulator = undefined;
          const readback = await readCommittedGuestSnapshot(env.VM_SNAPSHOTS, snapshotIdentity);
          snapshotRoundtrip.readback = true;
          await writeProgress("running", "snapshot_readback_verified", { snapshot_roundtrip: { ...snapshotRoundtrip } });
          snapshotRoundtrip.readback_digest_verified = readback.manifest.sha256 === manifest.sha256 &&
            readback.state.byteLength === stateBytes;
          if (!snapshotRoundtrip.readback_digest_verified) throw new Error("snapshot_readback_digest_mismatch");
          snapshotRoundtrip.restore_deferred_to_dashboard = true;
          await writeProgress("running", "snapshot_readback_verified", {
            snapshot_roundtrip: { ...snapshotRoundtrip },
            note: "Snapshot save, post-save DHCP diagnostics, and R2 read-back digest are verified. The authenticated dashboard GUI will load this saved state; this signup test does not start a second emulator."
          });
          // Do not allocate a second ~100 MiB emulator here. The browser dashboard
          // will recover this exact snapshot after registration completes.
          roundtripPassed = snapshotRoundtrip.saved === true && snapshotRoundtrip.post_save_dhcp_verified === true &&
            snapshotRoundtrip.readback === true && snapshotRoundtrip.readback_digest_verified === true;
        } catch (error) {
          snapshotRoundtrip.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
          try { emulator?.stop(); } catch {}
        }
      }
    }
    let screenExcerpt = "";
    try { screenExcerpt = emulator?.screen_adapter?.get_text_screen?.().join("\\n").slice(-5000) ?? ""; } catch {}
    try { emulator?.stop(); } catch {}
    const passed = guestChecksPassed && roundtripPassed;
    await writeProgress(passed ? "running" : "error", passed ? "snapshot_readback_verified" : "failed", { guest_checks_passed: guestChecksPassed, passed, snapshot_ready_for_dashboard: passed, guest_booted: boot.booted, boot_error: boot.reason ?? null, stages: Object.fromEntries(Object.entries(stages).map(([name, item]) => [name, { attempted: item.attempted, passed: item.passed, marker: item.marker, error: item.error ?? null, output: item.output ?? null }])), snapshot_roundtrip: snapshotRoundtrip });
    return Response.json({
      probe: "tinycore-snapshot-save-readback",
      identity: snapshotIdentity,
      runtime: "workerd",
      baseline_snapshot_used: Boolean(baselineSnapshot),
      baseline_generation: baselineSnapshot?.generation ?? null,
      wasm_module_loaded: wasm.module_loaded,
      emulator_initialized: loaded,
      emulator_started: started,
      guest_booted: boot.booted,
      guest_boot_evidence: boot.booted ? "vga_text_marker" : null,
      network_relay_configured: Boolean(relayUrl),
      network_relay_source: env.NETWORK_RELAY_URL ? "environment_override" : "same_default_as_public_vm_html",
      boot_error: boot.reason,
      stages,
      snapshot_roundtrip: snapshotRoundtrip,
      guest_checks_passed: guestChecksPassed,
      passed,
      screen_excerpt: screenExcerpt,
      note: "Requires a real Tiny Core boot, DHCP and HTTPS checks, guest marker creation, v86 save_state, and R2 chunk write/read-back digest verification. The dashboard GUI is responsible for loading the saved snapshot and displaying the login proof; no second emulator is started in this test.",
    }, { headers: { "cache-control": "no-store" } });
  },
};
