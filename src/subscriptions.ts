// Subscription quota accounting: config-declared plans + local-ledger usage.
//
// There is no universal provider API for "how much subscription quota is left
// and when does it reset". Anthropic/OpenAI expose rate-limit RESPONSE HEADERS
// (per call) and Admin-key usage APIs; MiniMax's Token Plan (5h rolling + weekly
// windows, no carryover) is dashboard-only. So the portable, cross-provider
// method — and the one that matches MiniMax's actual structure and Anthropic's
// window model — is to DECLARE each plan's rolling windows in config and measure
// consumption from the local ledger. This mirrors the zoder `quota.rs` engine so
// every consumer (zoder CLI + this plugin) reports identically.

import { readFileSync } from "node:fs";
import type { LedgerEntry } from "./ledger.js";

export type QuotaUnit = "tokens" | "requests" | "messages";

export interface QuotaWindow {
  /** Display name, e.g. "5h" or "weekly". */
  name: string;
  /** Rolling window length in hours (5h = 5, weekly = 168). */
  hours: number;
  /** What the cap counts. Default "tokens". */
  unit?: QuotaUnit;
  /** Cap value, in `unit`, over the rolling window. */
  cap: number;
}

export interface SubscriptionPlan {
  /** Provider id this plan covers (matched against ledger `provider`). */
  provider: string;
  /** Flat monthly fee in USD (amortized across the month's calls). */
  monthly_fee_usd?: number;
  /** Rolling rate-limit windows (e.g. a 5h cap plus a weekly cap). */
  windows: QuotaWindow[];
}

export interface SubscriptionsConfig {
  plans: SubscriptionPlan[];
}

/** pct at/above which a window is flagged as approaching its cap. */
export const APPROACHING_THRESHOLD = 0.8;

/** Consumption of one rolling window for a provider. */
export interface WindowUsage {
  name: string;
  hours: number;
  unit: QuotaUnit;
  used: number;
  cap: number;
  /** Fraction of cap consumed (0..; may exceed 1 over cap). */
  pct: number;
  /** When the oldest in-window call ages out (`oldest_ts + hours`) — the next
   * time capacity frees in this rolling window. Undefined when the window is
   * empty (full capacity). RFC3339 UTC. */
  nextResetUtc?: string;
  /** True when usage is at/above {@link APPROACHING_THRESHOLD} of the cap. */
  approaching: boolean;
}

function unitAmount(e: LedgerEntry, unit: QuotaUnit): number {
  return unit === "tokens" ? e.tokens_in + e.tokens_out : 1;
}

/** Consumption of one rolling window for `provider`, over the trailing `hours`. */
export function windowUsage(
  entries: LedgerEntry[],
  provider: string,
  w: QuotaWindow,
  now: Date = new Date(),
): WindowUsage {
  const unit = w.unit ?? "tokens";
  const nowMs = now.getTime();
  const sinceMs = nowMs - w.hours * 3_600_000;
  let used = 0;
  let oldestMs: number | undefined;
  for (const e of entries) {
    if (e.provider !== provider) {
      continue;
    }
    const t = Date.parse(e.ts_utc);
    if (Number.isNaN(t) || t < sinceMs || t > nowMs) {
      continue;
    }
    used += unitAmount(e, unit);
    oldestMs = oldestMs === undefined ? t : Math.min(oldestMs, t);
  }
  const pct = w.cap > 0 ? used / w.cap : 0;
  const nextResetUtc =
    oldestMs === undefined ? undefined : new Date(oldestMs + w.hours * 3_600_000).toISOString();
  return {
    name: w.name,
    hours: w.hours,
    unit,
    used,
    cap: w.cap,
    pct,
    nextResetUtc,
    approaching: pct >= APPROACHING_THRESHOLD,
  };
}

/** Consumption of every window in a plan, for one provider. */
export function planUsage(
  entries: LedgerEntry[],
  plan: SubscriptionPlan,
  now: Date = new Date(),
): WindowUsage[] {
  return plan.windows.map((w) => windowUsage(entries, plan.provider, w, now));
}

/** Amortized $/call for the flat fee: monthly fee / calls on this provider in
 * the trailing 30 days. 0 when the plan has no fee or no calls. */
export function amortizedPerCall(
  entries: LedgerEntry[],
  plan: SubscriptionPlan,
  now: Date = new Date(),
): number {
  const fee = plan.monthly_fee_usd ?? 0;
  if (fee <= 0) {
    return 0;
  }
  const sinceMs = now.getTime() - 30 * 86_400_000;
  let calls = 0;
  for (const e of entries) {
    if (e.provider === plan.provider && Date.parse(e.ts_utc) >= sinceMs) {
      calls += 1;
    }
  }
  return calls === 0 ? 0 : fee / calls;
}

export interface ProviderQuota {
  provider: string;
  windows: WindowUsage[];
  amortized_per_call_usd: number;
}

export interface SubscriptionReport {
  generated: string;
  providers: ProviderQuota[];
}

/** Per-provider rolling-window usage + amortized per-call cost for every plan. */
export function buildSubscriptionReport(
  entries: LedgerEntry[],
  config: SubscriptionsConfig,
  now: Date = new Date(),
): SubscriptionReport {
  return {
    generated: now.toISOString(),
    providers: config.plans.map((plan) => ({
      provider: plan.provider,
      windows: planUsage(entries, plan, now),
      amortized_per_call_usd: amortizedPerCall(entries, plan, now),
    })),
  };
}

/** Keep only well-formed plans/windows from raw config (tolerant). */
export function sanitizeSubscriptions(raw: unknown): SubscriptionsConfig {
  const out: SubscriptionsConfig = { plans: [] };
  if (raw === null || typeof raw !== "object") {
    return out;
  }
  const plans = (raw as { plans?: unknown }).plans;
  if (!Array.isArray(plans)) {
    return out;
  }
  for (const p of plans) {
    if (p === null || typeof p !== "object") {
      continue;
    }
    const provider = (p as { provider?: unknown }).provider;
    const windowsRaw = (p as { windows?: unknown }).windows;
    if (typeof provider !== "string" || !Array.isArray(windowsRaw)) {
      continue;
    }
    const windows: QuotaWindow[] = [];
    for (const w of windowsRaw) {
      if (w === null || typeof w !== "object") {
        continue;
      }
      const ww = w as Record<string, unknown>;
      if (
        typeof ww.name === "string" &&
        typeof ww.hours === "number" &&
        Number.isFinite(ww.hours) &&
        ww.hours > 0 &&
        typeof ww.cap === "number" &&
        Number.isFinite(ww.cap) &&
        ww.cap >= 0
      ) {
        const unit = ww.unit;
        windows.push({
          name: ww.name,
          hours: ww.hours,
          cap: ww.cap,
          unit:
            unit === "requests" || unit === "messages" || unit === "tokens"
              ? (unit as QuotaUnit)
              : "tokens",
        });
      }
    }
    if (windows.length === 0) {
      continue;
    }
    const fee = (p as { monthly_fee_usd?: unknown }).monthly_fee_usd;
    out.plans.push({
      provider,
      windows,
      monthly_fee_usd: typeof fee === "number" && Number.isFinite(fee) && fee >= 0 ? fee : 0,
    });
  }
  return out;
}

/** Load subscription config from a JSON file. Missing/malformed → empty config
 * (never throws): subscription tracking simply reports nothing until configured. */
export function loadSubscriptions(
  path: string,
  logger?: (msg: string) => void,
): SubscriptionsConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { plans: [] }; // absent → empty, silently (not configured yet)
  }
  try {
    return sanitizeSubscriptions(JSON.parse(raw));
  } catch (err) {
    logger?.(`tokenomics: subscriptions config at ${path} is not valid JSON; ignoring (${err})`);
    return { plans: [] };
  }
}
