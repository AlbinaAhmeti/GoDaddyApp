const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const BASE_HOST = "buynownames.com";
const BASE_PATH_WITH_SLASH = "/domain-for-sale/";
const BASE_PATH_NO_SLASH = "/domain-for-sale";

const DEBUG_PORT = 9222;
const DEBUG_URL = `http://127.0.0.1:${DEBUG_PORT}`;

let shouldStop = false;

function requestStop() {
  shouldStop = true;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeRun(fn, retries = 2, waitMs = 1500) {
  let lastError;

  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < retries) await delay(waitMs);
    }
  }

  throw lastError;
}

function getChromePath() {
  const possiblePaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error("Chrome was not found in the default install locations.");
}

function getUserDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.tmpdir(), "chrome-godaddy-profile");
  }
  if (process.platform === "win32") {
    return "C:\\chrome-godaddy-profile";
  }
  return path.join(os.tmpdir(), "chrome-godaddy-profile");
}

function tryRemoveOldSingletonLocks(userDataDir) {
  try {
    const candidates = [
      path.join(userDataDir, "SingletonLock"),
      path.join(userDataDir, "SingletonCookie"),
      path.join(userDataDir, "SingletonSocket"),
    ];

    for (const file of candidates) {
      if (fs.existsSync(file)) {
        try {
          fs.rmSync(file, { force: true });
        } catch {}
      }
    }
  } catch {}
}

function isDebugPortReady() {
  return new Promise((resolve) => {
    const req = http.get(`${DEBUG_URL}/json/version`, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });

    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForDebugPort(retries = 20) {
  for (let i = 0; i < retries; i++) {
    const ready = await isDebugPortReady();
    if (ready) return true;
    await delay(1000);
  }
  return false;
}

async function launchChromeForDebugging() {
  const chromePath = getChromePath();
  const userDataDir = getUserDataDir();

  tryRemoveOldSingletonLocks(userDataDir);

  const args = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://dcc.godaddy.com/control/portfolio",
  ];

  if (process.platform === "darwin") {
    spawn("open", ["-na", "Google Chrome", "--args", ...args], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
    }).unref();
  }

  const ready = await waitForDebugPort(20);
  if (!ready) {
    throw new Error("Chrome started, but remote debugging port 9222 did not become available.");
  }
}

async function connectToChromeWithRetry(retries = 8) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await chromium.connectOverCDP(DEBUG_URL);
    } catch (err) {
      lastError = err;
      await delay(1500);
    }
  }

  throw lastError;
}

async function ensureBrowser() {
  await launchChromeForDebugging();
  return await connectToChromeWithRetry();
}

async function ensureContext(browser) {
  const contexts = browser.contexts();
  if (contexts.length) return contexts[0];
  return await browser.newContext();
}

async function ensureWorkingPage(context, log = () => {}) {
  let pages = context.pages().filter((p) => !p.isClosed());
  let page = pages.length ? pages[0] : null;

  if (!page || page.isClosed()) {
    page = await context.newPage();
  }

  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(40000);

  try {
    page.removeAllListeners("close");
  } catch {}

  page.on("close", () => {
    log("⚠️ Page closed unexpectedly.");
  });

  return page;
}

async function rebuildSession(log = () => {}) {
  log("Rebuilding browser session...");
  const browser = await ensureBrowser();
  const context = await ensureContext(browser);
  const page = await ensureWorkingPage(context, log);
  return { browser, context, page };
}

function buildForwardUrl(domain) {
  return `https://${BASE_HOST}${BASE_PATH_WITH_SLASH}?domain=${encodeURIComponent(domain)}`;
}

function isMatchingBaseForward(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const pathname = u.pathname.toLowerCase();

    return (
      host === BASE_HOST &&
      (pathname === BASE_PATH_WITH_SLASH || pathname === BASE_PATH_NO_SLASH)
    );
  } catch {
    return false;
  }
}

function alreadyHasDomainParam(url) {
  try {
    const u = new URL(url);
    return u.searchParams.has("domain");
  } catch {
    return false;
  }
}

function extractVisibleForwardingText(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean || clean === "—" || clean === "-") return "";
  return clean;
}

function looksLikeMatchingForwardingText(text) {
  const clean = extractVisibleForwardingText(text).toLowerCase();

  return (
    clean.startsWith("https://buynownames.com/domain-for-sale") ||
    clean.startsWith("http://buynownames.com/domain-for-sale") ||
    clean.includes("buynownames.com/domain-for-sale")
  );
}

async function waitAndClick(page, selectors, timeout = 7000) {
  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      await el.waitFor({ state: "visible", timeout });
      await el.click();
      return true;
    } catch {}
  }
  return false;
}

async function dismissCookieBanner(page) {
  await waitAndClick(
    page,
    [
      'button:has-text("Accept")',
      'button:has-text("I agree")',
      'button:has-text("Got it")',
    ],
    1500
  );
}

async function gotoPortfolio(page, log = () => {}) {
  await page.goto("https://dcc.godaddy.com/control/portfolio", {
    waitUntil: "domcontentloaded",
  });

  await page.waitForLoadState("networkidle").catch(() => null);
  await dismissCookieBanner(page);
  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (/sign in|log in|login/i.test(bodyText)) {
    throw new Error("You are not logged into GoDaddy in the opened Chrome window.");
  }

  log(`Current URL: ${page.url()}`);
}

async function extractVisiblePortfolioRows(page) {
  return await page.evaluate(() => {
    function normalizeText(text) {
      return (text || "").replace(/\s+/g, " ").trim();
    }

    function parseDateText(text) {
      const clean = normalizeText(text);
      if (!clean) return null;
      const parsed = new Date(clean);
      if (Number.isNaN(parsed.getTime())) return null;
      parsed.setHours(0, 0, 0, 0);
      return parsed;
    }

    function looksLikeDomain(text) {
      return /^[a-z0-9-]+\.[a-z]{2,}$/i.test(text || "");
    }

    const rows = [];
    const seen = new Set();

    const rowCandidates = Array.from(document.querySelectorAll("tr, [role='row']"));

    for (const row of rowCandidates) {
      const links = Array.from(row.querySelectorAll("a"));
      const cells = Array.from(
        row.querySelectorAll("td, [role='cell'], .grid-cell-container")
      );

      let domain = "";
      for (const a of links) {
        const txt = normalizeText(a.textContent).toLowerCase();
        if (looksLikeDomain(txt)) {
          domain = txt;
          break;
        }
      }

      if (!domain) continue;
      if (seen.has(domain)) continue;

      const cellTexts = cells.map((el) => normalizeText(el.textContent));
      const joined = cellTexts.join(" | ");
      const lowerJoined = joined.toLowerCase();

      let expirationText = "";
      for (const c of cellTexts) {
        const d = parseDateText(c);
        if (d) {
          expirationText = c;
          break;
        }
      }

      let rawStatus = "Unknown";
      if (lowerJoined.includes("redemption")) {
        rawStatus = "Redemption";
      } else if (lowerJoined.includes("inactive")) {
        rawStatus = "Inactive";
      } else if (lowerJoined.includes("expired")) {
        rawStatus = "Expired";
      } else if (lowerJoined.includes("pending update")) {
        rawStatus = "Pending Update";
      } else if (lowerJoined.includes("active")) {
        rawStatus = "Active";
      }

      let forwarding = "";
      for (const a of links) {
        const href = a.getAttribute("href") || "";
        const txt = normalizeText(a.textContent);

        if (
          href.toLowerCase().includes("buynownames.com/domain-for-sale") ||
          txt.toLowerCase().includes("buynownames.com/domain-for-sale")
        ) {
          forwarding = href || txt;
          break;
        }
      }

      if (!forwarding) {
        for (const c of cellTexts) {
          if (c.toLowerCase().includes("buynownames.com/domain-for-sale")) {
            forwarding = c;
            break;
          }
        }
      }

      rows.push({
        domain,
        expiration: expirationText || "Unknown",
        rawStatus,
        forwarding: forwarding || "",
      });

      seen.add(domain);
    }

    return rows;
  });
}

function computeEligibility(rows) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return rows.map((item) => {
    const expirationText = item.expiration || "";
    let finalStatus = "Unknown";
    let eligible = false;

    const lowerStatus = (item.rawStatus || "").toLowerCase();

    if (lowerStatus.includes("active") || lowerStatus.includes("pending update")) {
      finalStatus = "Active";
      eligible = true;
    } else if (
      lowerStatus.includes("redemption") ||
      lowerStatus.includes("inactive") ||
      lowerStatus.includes("expired")
    ) {
      finalStatus = item.rawStatus;
      eligible = false;
    } else {
      const parsed = new Date(expirationText);
      if (!Number.isNaN(parsed.getTime())) {
        parsed.setHours(0, 0, 0, 0);
        if (parsed >= today) {
          finalStatus = "Active";
          eligible = true;
        } else {
          finalStatus = "Not Active";
          eligible = false;
        }
      }
    }

    return {
      ...item,
      status: finalStatus,
      eligible,
    };
  });
}

async function collectAllPortfolioDomains(page, log = () => {}) {
  await gotoPortfolio(page, log);

  const all = new Map();
  let sameCount = 0;
  let lastSize = 0;

  for (let round = 0; round < 300; round++) {
    const visible = await extractVisiblePortfolioRows(page);

    for (const item of visible) {
      if (!all.has(item.domain)) {
        all.set(item.domain, item);
      } else {
        const prev = all.get(item.domain);
        all.set(item.domain, {
          ...prev,
          ...item,
          forwarding: item.forwarding || prev.forwarding || "",
          rawStatus: item.rawStatus || prev.rawStatus || "Unknown",
          expiration: item.expiration || prev.expiration || "Unknown",
        });
      }
    }

    const currentSize = all.size;
    log(`Collect round ${round + 1}: ${currentSize} unique domains collected.`);

    if (currentSize === lastSize) {
      sameCount += 1;
    } else {
      sameCount = 0;
      lastSize = currentSize;
    }

    if (sameCount >= 6) {
      break;
    }

    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(700);
  }

  return computeEligibility(Array.from(all.values()));
}

async function goToDomainForwarding(page, domain) {
  const url = `https://dcc.godaddy.com/control/portfolio/${domain}/settings`;

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => null);
  await dismissCookieBanner(page);

  await page.waitForSelector(`text="${domain}"`, { timeout: 15000 });

  const clickedDns = await waitAndClick(
    page,
    ['a:has-text("DNS")', 'button:has-text("DNS")', 'text="DNS"'],
    8000
  );

  if (!clickedDns) {
    throw new Error("Could not click DNS.");
  }

  await page.waitForTimeout(1200);

  const clickedForwarding = await waitAndClick(
    page,
    [
      'a:has-text("Forwarding")',
      'button:has-text("Forwarding")',
      'text="Forwarding"',
    ],
    8000
  );

  if (!clickedForwarding) {
    throw new Error("Could not click Forwarding.");
  }

  await page.waitForTimeout(1500);
}

async function openForwardingEditModal(page) {
  const editButton = page.locator('button:has-text("Edit")').first();
  if (await editButton.isVisible().catch(() => false)) {
    await editButton.click();
    await page.waitForTimeout(1000);
  }

  const modal = page.locator('div[role="dialog"]').first();
  const visible = await modal.isVisible().catch(() => false);
  if (!visible) return false;

  await modal.locator('input[type="text"]').first().waitFor({
    state: "visible",
    timeout: 10000,
  });

  return true;
}

async function readForwardingFromModal(page) {
  const modal = page.locator('div[role="dialog"]').first();
  const visible = await modal.isVisible().catch(() => false);
  if (!visible) return null;

  let protocol = "http://";

  try {
    const select = modal.locator("select").first();
    await select.waitFor({ state: "visible", timeout: 4000 });
    protocol = (await select.inputValue().catch(() => "http://")) || "http://";
  } catch {}

  const input = modal.locator('input[type="text"]').first();
  await input.waitFor({ state: "visible", timeout: 4000 });

  const destination = await input.inputValue().catch(() => null);
  if (!destination) return null;

  return `${protocol}${destination}`.trim();
}

async function fillForwardingModal(page, fullUrl) {
  const modal = page.locator('div[role="dialog"]').first();

  const parsed = new URL(fullUrl);
  const protocol = parsed.protocol + "//";
  const destination = parsed.host + parsed.pathname + parsed.search;

  try {
    const select = modal.locator("select").first();
    await select.waitFor({ state: "visible", timeout: 4000 });

    await select.selectOption(protocol).catch(async () => {
      await select.selectOption({ label: protocol }).catch(() => null);
    });
  } catch {}

  const input = modal.locator('input[type="text"]').first();
  await input.waitFor({ state: "visible", timeout: 4000 });

  await input.click({ clickCount: 3 });
  await input.press("Backspace").catch(() => null);
  await input.fill(destination);
}

async function saveForwardingModal(page) {
  const modal = page.locator('div[role="dialog"]').first();
  const saveBtn = modal.locator('button:has-text("Save")').first();

  await saveBtn.waitFor({ state: "visible", timeout: 7000 });
  await saveBtn.click();

  await page.waitForTimeout(2000);

  await waitAndClick(
    page,
    [
      'button:has-text("Done")',
      'button:has-text("Close")',
      'button[aria-label="Close"]',
      'button[aria-label*="close"]',
    ],
    3000
  );

  await page.waitForTimeout(1000);
}

async function closeModalIfOpen(page) {
  const modal = page.locator('div[role="dialog"]').first();
  const visible = await modal.isVisible().catch(() => false);
  if (!visible) return;

  const cancelBtn = modal.locator('button:has-text("Cancel")').first();
  if (await cancelBtn.isVisible().catch(() => false)) {
    await cancelBtn.click().catch(() => null);
    return;
  }

  await waitAndClick(
    page,
    ['button[aria-label="Close"]', 'button[aria-label*="close"]'],
    1500
  );
}

async function setForwardingForDomain(page, domain, log) {
  log(`\nChecking: ${domain}`);

  await goToDomainForwarding(page, domain);

  const opened = await openForwardingEditModal(page);
  if (!opened) {
    log(`SKIP ${domain} -> could not open forwarding edit modal.`);
    return { status: "skip", reason: "cannot_open_modal" };
  }

  const existingUrl = await readForwardingFromModal(page);
  if (!existingUrl) {
    log(`SKIP ${domain} -> could not read forwarding URL.`);
    await closeModalIfOpen(page);
    return { status: "skip", reason: "no_url" };
  }

  log(`Current: ${existingUrl}`);

  if (!isMatchingBaseForward(existingUrl)) {
    log(`SKIP ${domain} -> different URL found.`);
    await closeModalIfOpen(page);
    return { status: "skip", reason: "different_url" };
  }

  if (alreadyHasDomainParam(existingUrl)) {
    log(`SKIP ${domain} -> already has ?domain=`);
    await closeModalIfOpen(page);
    return { status: "skip", reason: "already_has_param" };
  }

  const newUrl = buildForwardUrl(domain);
  log(`Update: ${newUrl}`);

  await fillForwardingModal(page, newUrl);
  await saveForwardingModal(page);

  log(`OK ${domain} -> saved.`);
  return { status: "updated", reason: "saved" };
}

async function runBot(log) {
  shouldStop = false;

  let { browser, context, page } = await rebuildSession(log);

  log("Make sure you are logged into GoDaddy in the opened Chrome window.");
  log("The bot is starting...");

  const allDomains = await collectAllPortfolioDomains(page, log);

  if (!allDomains.length) {
    throw new Error("No domains found.");
  }

  const activeDomains = allDomains.filter((item) => item.eligible);

  const forwardingCandidates = activeDomains.filter((item) => {
    const forwarding = (item.forwarding || "").toLowerCase();

    if (!forwarding) return false;
    if (!looksLikeMatchingForwardingText(forwarding)) return false;
    if (forwarding.includes("?domain=")) return false;

    return true;
  });

  log(`Found ${allDomains.length} total domains.`);
  log(`Active domains found: ${activeDomains.length}`);
  log(`Matching forwarding candidates: ${forwardingCandidates.length}`);
  log("");

  if (forwardingCandidates.length) {
    log("MATCHING FORWARDING CANDIDATES:");
    for (const item of forwardingCandidates) {
      log(
        `${item.domain} | status=${item.status} | exp=${item.expiration} | forwarding=${item.forwarding}`
      );
    }
  }

  const updated = [];
  const skipped = [];
  const failed = [];

  for (let index = 0; index < forwardingCandidates.length; index++) {
    if (shouldStop) {
      log("Stop requested. Bot stopped before processing the next domain.");
      break;
    }

    const item = forwardingCandidates[index];
    const domain = item.domain;

    log(`\nProgress: ${index + 1}/${forwardingCandidates.length}`);

    try {
      if (!context || context.isClosed()) {
        ({ browser, context, page } = await rebuildSession(log));
      } else {
        page = await ensureWorkingPage(context, log);
      }

      if (index > 0 && index % 40 === 0) {
        log(`Refreshing session after ${index} domains...`);
        ({ browser, context, page } = await rebuildSession(log));
        await delay(2500);
      }

      const result = await safeRun(async () => {
        if (!page || page.isClosed()) {
          page = await ensureWorkingPage(context, log);
        }

        return await setForwardingForDomain(page, domain, log);
      }, 2, 2000);

      if (result.status === "updated") {
        updated.push(domain);
      } else {
        skipped.push({ domain, reason: result.reason });
      }
    } catch (err) {
      const message = err?.message || String(err);
      log(`FAIL ${domain} -> ${message}`);

      if (
        /Target page, context or browser has been closed/i.test(message) ||
        /ECONNREFUSED/i.test(message) ||
        /Session closed/i.test(message) ||
        /ERR_ABORTED/i.test(message)
      ) {
        try {
          log("Attempting recovery after closed page/browser...");
          ({ browser, context, page } = await rebuildSession(log));
        } catch (recoveryErr) {
          log(`Recovery failed -> ${recoveryErr.message}`);
        }
      }

      failed.push({ domain, reason: message });
    }

    await delay(1200);
  }

  log("\n------------------------------");
  log("SUMMARY");
  log("------------------------------");
  log(`Updated: ${updated.length}`);
  log(`Skipped: ${skipped.length}`);
  log(`Failed: ${failed.length}`);

  if (updated.length) {
    log("\nUPDATED DOMAINS:");
    log(updated.join("\n"));
  }

  if (skipped.length) {
    log("\nSKIPPED DOMAINS:");
    for (const item of skipped) {
      log(`${item.domain} -> ${item.reason}`);
    }
  }

  if (failed.length) {
    log("\nFAILED DOMAINS:");
    for (const item of failed) {
      log(`${item.domain} -> ${item.reason}`);
    }
  }
}

module.exports = { runBot, requestStop };