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

function quotaCategory(group) {
  const text = `${group.displayName || ""} ${group.description || ""}`;
  return QUOTA_GROUPS.find(category => category.match.test(text)) || null;
}

function quotaPercent(group) {
  const buckets = Array.isArray(group.buckets) ? group.buckets : [];
  const fiveHour = buckets.find(bucket => bucket.window === "5h");
  const weekly = buckets.find(bucket => bucket.window === "weekly");
  const bucket = fiveHour || weekly;
  return bucket ? Math.round(number(bucket.remainingFraction) * 100) : null;
}

function aggregateAntigravity(accounts, summaries) {
  const byEmail = new Map(summaries.map(item => [String(item.email).toLowerCase(), item.summary]));
  const groups = new Map(QUOTA_GROUPS.map(group => [group.id, { ...group, sum: 0, count: 0 }]));
  for (const account of accounts) {
    const summary = byEmail.get(account.email.toLowerCase());
    for (const group of (summary && Array.isArray(summary.groups) ? summary.groups : [])) {
      const category = quotaCategory(group);
      const percent = quotaPercent(group);
      if (!category || percent === null) continue;
      const target = groups.get(category.id);
      target.sum += Math.max(0, Math.min(100, percent));
      target.count += 1;
    }
  }
  return Array.from(groups.values()).map(group => ({
    id: group.id,
    name: group.name,
    percent: group.count ? Math.round(group.sum / group.count) : null,
    accounts: group.count,
  }));
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
