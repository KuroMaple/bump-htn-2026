/**
 * Drives a live scrolling terminal on an HTN OS badge screen.
 *
 * Font size 1 = 6×12 px per glyph → 53 chars wide, 20 rows tall on 320×240.
 * The module maintains a line buffer server-side and redraws the full screen
 * on each new line so the badge stays in sync even after reconnects.
 *
 * Usage:
 *   const term = new BadgeTerminal({ badgeId: "xb2b9", key: "hunter2" });
 *   term.start();
 *   term.writeLine("hello from server");
 *   term.stop();
 */

import { subscribe } from "./events.js";
import { db } from "./db/client.js";
import { badges, bumpEvents, connections } from "./db/schema.js";
import { eq, desc } from "drizzle-orm";

const BASE = "https://badge.solana-htn.com";
const ROWS = 20;      // 240 / 12
const COLS = 53;      // 320 / 6
const FONT_SIZE = 1;
const FG = "#14f195"; // HTN green
const BG = "#000000";
const DIM = "#3a3a3a"; // older lines

interface BadgeTerminalOptions {
  badgeId: string;
  key: string;
  /** Base URL override for local dev (default: https://badge.solana-htn.com) */
  baseUrl?: string;
}

export class BadgeTerminal {
  private readonly badgeId: string;
  private readonly key: string;
  private readonly base: string;
  private readonly lines: string[] = [];
  private ws: WebSocket | null = null;
  private unsubscribe: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: BadgeTerminalOptions) {
    this.badgeId = opts.badgeId;
    this.key = opts.key;
    this.base = opts.baseUrl ?? BASE;
  }

  start() {
    this.stopped = false;
    this.connect();
    this.unsubscribe = subscribe((ev) => {
      if (ev.type === "bump:accepted") {
        this.onBump(ev.connection.sourceId, ev.connection.targetId, ev.connection.occurredAt);
      }
    });
    this.writeLine(`HTN terminal v1  ${new Date().toLocaleTimeString("en-CA", { hour12: false })}`);
    this.writeLine(`badge: ${this.badgeId}`);
    this.writeLine("─".repeat(COLS));
  }

  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  writeLine(text: string) {
    const trimmed = text.slice(0, COLS);
    this.lines.push(trimmed);
    if (this.lines.length > ROWS) this.lines.shift();
    this.flush();
  }

  // ── private ────────────────────────────────────────────────────────────────

  private async onBump(sourceId: string, targetId: string, at: string) {
    const [source, target] = await Promise.all([
      this.resolveName(sourceId),
      this.resolveName(targetId),
    ]);
    const time = new Date(at).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    this.writeLine(`${time}  ${truncate(source, 20)} ↔ ${truncate(target, 20)}`);
    this.flashLeds();
  }

  private async resolveName(badgeId: string): Promise<string> {
    try {
      const row = await db.select({ alias: badges.publicAlias, name: badges.name })
        .from(badges)
        .where(eq(badges.id, badgeId))
        .limit(1);
      return row[0]?.alias ?? row[0]?.name ?? badgeId.slice(0, 8);
    } catch {
      return badgeId.slice(0, 8);
    }
  }

  private flush() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Build one text command: pad buffer to ROWS, colour last line bright
    const padded = Array.from({ length: ROWS }, (_, i) => this.lines[i] ?? "");
    const text = padded.join("\n");
    this.send({ cmd: "text", text, x: 0, y: 0, size: FONT_SIZE, color: FG, background: BG, clear: true });
  }

  private flashLeds() {
    this.send({ cmd: "leds", body: { all: "#14f195" } });
    setTimeout(() => this.send({ cmd: "leds", body: { all: "#000000" } }), 200);
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private connect() {
    if (this.stopped) return;
    const wsBase = this.base.replace(/^http/, "ws");
    const url = `${wsBase}/v1/badges/${this.badgeId}/ws?key=${encodeURIComponent(this.key)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      console.log(`[badge-terminal] connected to ${this.badgeId}`);
      this.flush();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "event" && msg.data?.event === "button" && msg.data.pressed) {
          this.handleButton(msg.data.button as string);
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      if (!this.stopped) {
        console.log(`[badge-terminal] disconnected, reconnecting in 5s`);
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    };

    ws.onerror = (err) => {
      console.error("[badge-terminal] ws error", err);
    };
  }

  private handleButton(button: string) {
    if (button === "b") {
      // B = clear screen
      this.lines.length = 0;
      this.writeLine("-- cleared --");
    }
  }
}

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
