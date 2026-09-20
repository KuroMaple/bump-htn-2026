/**
 * HTN OS badge-to-badge bump detection via coincident accelerometer shakes.
 *
 * Replaces the custom BLE firmware's bump discovery for badges running HTN OS.
 * The server streams accel data from every configured badge at 20 Hz and
 * watches for two badges spiking above SHAKE_MG within WINDOW_MS of each
 * other.  On a match it:
 *   1. Calls processBump() to register the edge in the database.
 *   2. Pushes each badge's mandela image to the other badge's screen.
 *   3. Flashes both badges' LEDs green.
 *
 * Configure via HTNOS_BADGES env var:
 *   HTNOS_BADGES='[{"id":"xb2b9","key":"hunter2","hardwareId":"e8:3d:c1:29:87:00"},...]'
 *
 * hardwareId must match what is stored in your badges table so processBump
 * can find both parties. Use the HTN-ID itself if the badge is not yet in the
 * bump DB — the edge will come back "unknown_badge" but the screen push still
 * works.
 */

import { getBadgeByHardwareId, processBump, registerBadge } from "./service.js";
import { renderTileB64 } from "./tile-png.js";

const BASE = "https://badge.solana-htn.com";
const SHAKE_MG = 1400;   // milli-g combined vector; ~0.4 g above resting 1 g
const WINDOW_MS = 3000;  // two shakes within this window → bump
const COOLDOWN_MS = 10_000; // minimum gap between the same pair re-bumping
const ACCEL_HZ = 20;

export interface HTNOSBadgeConfig {
  /** HTN-ID shown on the badge (e.g. "xb2b9"). */
  id: string;
  /** App key set in badge Settings → App key. */
  key: string;
  /** hardware_id value in your badges table (MAC or any unique identifier). */
  hardwareId: string;
}

export class HTNOSBumper {
  private readonly badges: HTNOSBadgeConfig[];
  private readonly base: string;
  private stopped = false;

  /** timestamps (epoch ms) of recent shakes, keyed by HTN-ID */
  private shakeLog = new Map<string, number[]>();
  /** last bump time for each ordered pair "a|b", keyed by sorted pair */
  private lastBump = new Map<string, number>();

  constructor(badges: HTNOSBadgeConfig[], base = BASE) {
    this.badges = badges;
    this.base = base;
  }

  start() {
    this.stopped = false;
    for (const badge of this.badges) {
      this.watchBadge(badge);
    }
  }

  stop() {
    this.stopped = true;
  }

  // ── Per-badge monitor ─────────────────────────────────────────────────────

  private async watchBadge(badge: HTNOSBadgeConfig) {
    while (!this.stopped) {
      try {
        // Enter canvas mode first — accel events are silently suppressed in menu mode.
        await this.enterCanvasAndStream(badge);
        await this.listenEvents(badge);
      } catch (err) {
        if (!this.stopped) {
          console.error(`[htnos-bumper] ${badge.id} error:`, err);
          await sleep(5000);
        }
      }
    }
  }

  /**
   * Enter canvas mode (any screen command does this) and start the accel
   * stream.  Must be called before accel events will flow — the badge silently
   * discards stream data while it is in menu mode.
   */
  private async enterCanvasAndStream(badge: HTNOSBadgeConfig) {
    // A text command is the lightest way to enter canvas mode.
    const res = await this.badgePost(badge, "text", {
      text: "BUMP READY",
      x: 68,
      y: 104,
      size: 3,
      color: "#14f195",
      background: "#000000",
      clear: true,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`enter canvas ${res.status}: ${body}`);
    }

    const streamRes = await fetch(`${this.base}/v1/badges/${badge.id}/accel/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Badge-Key": badge.key },
      body: JSON.stringify({ hz: ACCEL_HZ }),
    });
    if (!streamRes.ok) throw new Error(`accel/stream ${streamRes.status}`);
    console.log(`[htnos-bumper] ${badge.id} canvas mode + accel stream active`);
  }

  private async listenEvents(badge: HTNOSBadgeConfig) {
    const res = await fetch(
      `${this.base}/v1/badges/${badge.id}/events?key=${encodeURIComponent(badge.key)}`,
      { signal: AbortSignal.timeout(60_000 * 60) },
    );
    if (!res.ok || !res.body) throw new Error(`events ${res.status}`);

    console.log(`[htnos-bumper] watching ${badge.id}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let eventType = "message";

    while (true) {
      const { done, value } = await reader.read();
      if (done || this.stopped) break;
      buf += dec.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          try {
            const data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
            this.handleEvent(badge, eventType, data);
          } catch { /* malformed frame */ }
          eventType = "message";
        }
      }
    }
  }

  private handleEvent(
    badge: HTNOSBadgeConfig,
    type: string,
    data: Record<string, unknown>,
  ) {
    if (type === "accel") {
      const x = Number(data.x ?? 0);
      const y = Number(data.y ?? 0);
      const z = Number(data.z ?? 0);
      const mag = Math.sqrt(x * x + y * y + z * z);
      // Log every sample so you can tune SHAKE_MG without guessing
      process.stdout.write(`[htnos-bumper] ${badge.id} accel mag=${mag.toFixed(0)}\r`);
      if (mag > SHAKE_MG) {
        console.log(`\n[htnos-bumper] ${badge.id} SHAKE mag=${mag.toFixed(0)}`);
        this.recordShake(badge);
      }
    } else if (type === "online") {
      // Badge reconnected — it reboots into menu mode, so re-enter canvas.
      console.log(`[htnos-bumper] ${badge.id} online — re-entering canvas mode`);
      this.enterCanvasAndStream(badge).catch((err) =>
        console.error(`[htnos-bumper] ${badge.id} re-enter failed:`, err),
      );
    } else if (type === "mode") {
      // User held Home and left canvas mode — re-enter after a short delay so
      // they can navigate if they meant to, but the bumper recovers automatically.
      const mode = String(data.mode ?? "");
      console.log(`[htnos-bumper] ${badge.id} mode → ${mode}`);
      if (mode === "menu") {
        setTimeout(() => {
          if (!this.stopped) {
            this.enterCanvasAndStream(badge).catch((err) =>
              console.error(`[htnos-bumper] ${badge.id} re-enter failed:`, err),
            );
          }
        }, 3000);
      }
    } else if (type === "offline") {
      console.log(`[htnos-bumper] ${badge.id} offline`);
    }
  }

  // ── Shake / bump logic ────────────────────────────────────────────────────

  private recordShake(shaker: HTNOSBadgeConfig) {
    const now = Date.now();
    const times = (this.shakeLog.get(shaker.id) ?? []).filter(
      (t) => now - t < WINDOW_MS,
    );
    times.push(now);
    this.shakeLog.set(shaker.id, times);

    for (const other of this.badges) {
      if (other.id === shaker.id) continue;
      const otherTimes = this.shakeLog.get(other.id) ?? [];
      const coincident = otherTimes.some((t) => Math.abs(now - t) < WINDOW_MS);
      if (coincident) {
        this.onBump(shaker, other);
      }
    }
  }

  private onBump(a: HTNOSBadgeConfig, b: HTNOSBadgeConfig) {
    const pairKey = [a.id, b.id].sort().join("|");
    const now = Date.now();
    if ((this.lastBump.get(pairKey) ?? 0) + COOLDOWN_MS > now) return;
    this.lastBump.set(pairKey, now);

    // Clear shakes to avoid double-fire
    this.shakeLog.set(a.id, []);
    this.shakeLog.set(b.id, []);

    console.log(`[htnos-bumper] BUMP ${a.id} ↔ ${b.id}`);

    void this.registerAndDisplay(a, b);
  }

  private async registerAndDisplay(a: HTNOSBadgeConfig, b: HTNOSBadgeConfig) {
    // Ensure both badges exist in the DB; auto-stub unknowns so the graph node
    // appears immediately and the person can fill in their info later.
    const [profileA, profileB] = await Promise.all([
      this.resolveOrStub(a),
      this.resolveOrStub(b),
    ]);

    try {
      await processBump({
        badge_id_a: a.hardwareId,
        badge_id_b: b.hardwareId,
        timestamp: new Date().toISOString().replace("Z", "+00:00"),
        event_id: `htnos-${[a.id, b.id].sort().join("-")}-${Date.now()}`,
        source: "htnos-bumper",
      });
    } catch (err) {
      console.error("[htnos-bumper] processBump failed:", err);
    }

    // Push each person's profile to the OTHER badge's screen, in parallel
    await Promise.allSettled([
      this.pushProfileToScreen(b, profileA),
      this.pushProfileToScreen(a, profileB),
    ]);

    // Return both badges to bump-ready after 10 s
    await sleep(10_000);
    await Promise.allSettled([
      this.enterCanvasAndStream(a),
      this.enterCanvasAndStream(b),
    ]);
  }

  /** Look up a badge profile from the DB; if not found, register a stub so
   *  the graph node appears immediately. The person can fill in their details
   *  later by visiting /badge/<privateToken> on the web app. */
  private async resolveOrStub(badge: HTNOSBadgeConfig) {
    let row = await getBadgeByHardwareId(badge.hardwareId);
    if (!row) {
      console.log(`[htnos-bumper] ${badge.id} unknown — creating stub profile`);
      row = await registerBadge({
        hardwareId: badge.hardwareId,
        name: badge.id,           // HTN-ID as placeholder name
        projectorIdentity: "alias",
      });
    }
    return row;
  }

  /**
   * Show the subject's profile (mandela + name + contact hint) on the target
   * badge's screen so the target user knows who they bumped with.
   */
  private async pushProfileToScreen(
    targetBadge: HTNOSBadgeConfig,
    subject: Awaited<ReturnType<typeof getBadgeByHardwareId>> & object,
  ) {
    const seed = subject.visualSeed;
    const image = renderTileB64(seed, 30); // 240×240

    // Build a compact contact line from whatever fields are populated
    const contactParts: string[] = [];
    if (subject.role) contactParts.push(subject.role);
    if (subject.company) contactParts.push(subject.company);
    if (subject.linkedin) contactParts.push(`li: ${subject.linkedin}`);
    else if (subject.discord) contactParts.push(`discord: ${subject.discord}`);
    else if (subject.email) contactParts.push(subject.email);
    const contactLine = contactParts.slice(0, 2).join(" · ");

    // Clear → mandela centred → name + contact at bottom
    await this.badgePost(targetBadge, "clear", { color: "#000000" });
    await this.badgePost(targetBadge, "image", {
      image,
      x: 40,
      y: 0,
      fit: "none",
    });
    await this.badgePost(targetBadge, "text", {
      text: subject.name + (contactLine ? `\n${contactLine}` : ""),
      x: 0,
      y: 208,
      size: 1,
      color: "#14f195",
      background: "#000000",
    });

    // Flash LEDs green then off
    await this.badgePost(targetBadge, "leds", { body: { all: "#00ff00" } });
    await sleep(500);
    await this.badgePost(targetBadge, "leds", { body: { all: "#000000" } });
  }

  private async badgePost(badge: HTNOSBadgeConfig, endpoint: string, body: unknown): Promise<Response> {
    const res = await fetch(`${this.base}/v1/badges/${badge.id}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Badge-Key": badge.key },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[htnos-bumper] POST ${badge.id}/${endpoint} → ${res.status}`);
    }
    return res;
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
