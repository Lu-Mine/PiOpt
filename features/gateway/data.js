"use strict";

const crypto = require("crypto");

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function keyId(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
}

function maskKey(key) {
  const value = String(key || "");
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : "••••••••";
}

function modelRows(data) {
  const list = Array.isArray(data && data.data) ? data.data : [];
  return list
    .filter(item => item && typeof item.id === "string")
    .map(item => ({ id: item.id, owner: String(item.owned_by || "unknown") }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function credentialRows(data) {
  const files = Array.isArray(data && data.files) ? data.files : [];
  return files.map(file => ({
    name: String(file.name || ""),
    authIndex: String(file.auth_index ?? file.authIndex ?? ""),
    provider: String(file.provider || file.type || "oauth"),
    account: String(file.account || file.email || file.label || file.name || ""),
    disabled: Boolean(file.disabled),
    status: String(file.status || "active"),
    unavailable: Boolean(file.unavailable),
    failed: number(file.failed),
    lastRefresh: String(file.last_refresh || ""),
  })).filter(file => file.name);
}

function accountAvailable(account) {
  return Boolean(account.enabled) && ![
    "tokenExpired", "needRelogin", "inCooldown", "reserveBlocked",
    "dailyLimitBlocked", "creditLimitReached",
  ].some(field => account[field]);
}

function accountRows(data) {
  const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
  return accounts.map(account => {
    const credits = account.credits || {};
    return {
      uid: String(account.uid || ""),
      name: String(account.nickname || account.uid || "未命名账号"),
      realm: String(account.realm || ""),
      enabled: Boolean(account.enabled),
      available: accountAvailable(account),
      remain: number(credits.remain),
      total: number(credits.size),
      used: number(credits.used),
      tokens: number(account.dailyTokensToday),
      error: String(account.lastError || ""),
    };
  }).filter(account => account.uid);
}

function poolSummary(accounts) {
  return accounts.reduce((sum, account) => {
    sum.remain += account.remain;
    sum.total += account.total;
    sum.used += account.used;
    sum.tokens += account.tokens;
    if (account.available) sum.available += 1;
    return sum;
  }, { remain: 0, total: 0, used: 0, tokens: 0, available: 0 });
}

const QUOTA_GROUPS = [
  { id: "gemini", name: "Gemini 模型", match: /gemini/i },
  { id: "claude-gpt", name: "Claude / GPT", match: /claude|gpt/i },
  { id: "argon", name: "Argon 4", match: /argon/i },
];

// Argon is tested first: Google names it "Gemini 4 Argon", which would
// otherwise match the Gemini group.
const MATCH_ORDER = ["argon", "gemini", "claude-gpt"];

function quotaCategory(group) {
  const name = String(group.displayName || "");
  const text = `${name} ${group.description || ""}`;
  for (const id of MATCH_ORDER) {
    const category = QUOTA_GROUPS.find(item => item.id === id);
    if (category.match.test(name)) return category;
  }
  return QUOTA_GROUPS.find(category => category.match.test(text)) || null;
}

function parseBucketWindow(bucket) {
  const w = String(bucket?.window || "").toLowerCase();
  const d = String(bucket?.displayName || "").toLowerCase();
  if (w === "5h" || w.includes("5h") || w.includes("5 hour") || w.includes("five") || d.includes("5h") || d.includes("5 hour") || d.includes("five")) {
    return "5h";
  }
  if (w === "weekly" || w.includes("week") || d.includes("weekly") || d.includes("week")) {
    return "weekly";
  }
  return null;
}

function quotaGroupBuckets(group) {
  const buckets = Array.isArray(group.buckets) ? group.buckets : [];
  let fiveHour = null;
  let weekly = null;
  for (const bucket of buckets) {
    const win = parseBucketWindow(bucket);
    if (win === "5h" && fiveHour === null && bucket.remainingFraction !== undefined && bucket.remainingFraction !== null) {
      fiveHour = Math.max(0, Math.min(100, Math.round(number(bucket.remainingFraction) * 100)));
    } else if (win === "weekly" && weekly === null && bucket.remainingFraction !== undefined && bucket.remainingFraction !== null) {
      weekly = Math.max(0, Math.min(100, Math.round(number(bucket.remainingFraction) * 100)));
    }
  }
  return { fiveHour, weekly };
}

function quotaPercent(group) {
  const { fiveHour, weekly } = quotaGroupBuckets(group);
  return fiveHour ?? weekly ?? null;
}

function aggregateAntigravity(accounts, summaries) {
  const byEmail = new Map(summaries.map(item => [String(item.email).toLowerCase(), item.summary]));
  const groups = new Map(QUOTA_GROUPS.map(group => [
    group.id,
    {
      ...group,
      fiveHourSum: 0,
      fiveHourCount: 0,
      weeklySum: 0,
      weeklyCount: 0,
      accountSet: new Set(),
    }
  ]));

  for (const account of accounts) {
    const email = String(account.email || "").toLowerCase();
    const summary = byEmail.get(email);
    for (const group of (summary && Array.isArray(summary.groups) ? summary.groups : [])) {
      const category = quotaCategory(group);
      if (!category) continue;
      const target = groups.get(category.id);
      const { fiveHour, weekly } = quotaGroupBuckets(group);
      if (fiveHour !== null) {
        target.fiveHourSum += fiveHour;
        target.fiveHourCount += 1;
        target.accountSet.add(email);
      }
      if (weekly !== null) {
        target.weeklySum += weekly;
        target.weeklyCount += 1;
        target.accountSet.add(email);
      }
    }
  }

  return Array.from(groups.values()).map(group => {
    const fiveHour = group.fiveHourCount ? Math.round(group.fiveHourSum / group.fiveHourCount) : null;
    const weekly = group.weeklyCount ? Math.round(group.weeklySum / group.weeklyCount) : null;
    return {
      id: group.id,
      name: group.name,
      fiveHour,
      weekly,
      percent: fiveHour ?? weekly ?? null,
      accounts: group.accountSet.size || Math.max(group.fiveHourCount, group.weeklyCount),
    };
  });
}

function usageSummary(analytics) {
  return analytics && analytics.summary && analytics.summary.window
    ? analytics.summary.window
    : {};
}

module.exports = {
  number,
  keyId,
  maskKey,
  modelRows,
  credentialRows,
  accountRows,
  accountAvailable,
  poolSummary,
  aggregateAntigravity,
  usageSummary,
};
