const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");

const BASE_HOST = "buynownames.com";
const BASE_PATH_WITH_SLASH = "/domain-for-sale/";
const BASE_PATH_NO_SLASH = "/domain-for-sale";

let shouldStop = false;

function requestStop() {
  shouldStop = true;
}

function getChromePath() {
  const possiblePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error("Chrome was not found in the default install locations.");
}

function launchChromeForDebugging() {
  const chromePath = getChromePath();

  const chrome = spawn(
    chromePath,
    ["--remote-debugging-port=9222", "--user-data-dir=C:\\chrome-godaddy"],
    {
      detached: true,
      stdio: "ignore",
    },
  );

  chrome.unref();
}

function buildForwardUrl(domain) {
  return `https://${BASE_HOST}${BASE_PATH_WITH_SLASH}?domain=${encodeURIComponent(domain)}`;
}

function isMatchingBaseForward(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    return (
      host === BASE_HOST &&
      (path === BASE_PATH_WITH_SLASH || path === BASE_PATH_NO_SLASH)
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

async function waitAndClick(page, selectors, timeout = 7000) {
  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      await el.waitFor({ state: "visible", timeout });
      await el.click();
      return true;
    } catch { }
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
    1500,
  );
}

async function collectDomainsWithStatus(page) {
  await page.goto("https://dcc.godaddy.com/control/portfolio", {
    waitUntil: "domcontentloaded",
  });

  await page.waitForLoadState("networkidle").catch(() => null);
  await dismissCookieBanner(page);
  await page.waitForTimeout(6000);

  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(700);
  }

  const domains = await page.evaluate(() => {
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

    function todayStart() {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }

    const results = [];
    const seen = new Set();
    const today = todayStart();

    // Domain rows
    const domainNodes = Array.from(
      document.querySelectorAll('.grid-fixed-columns-container .grid-cell-container.fixed')
    ).filter(el => el.querySelector('.domain-name-cell a'));

    for (const domainRow of domainNodes) {
      const cls = domainRow.className || "";
      const match = cls.match(/row-index-(\d+)/);
      if (!match) continue;

      const rowIndex = match[1];

      const domainEl = domainRow.querySelector('.domain-name-cell a');
      const domain = normalizeText(domainEl?.textContent).toLowerCase();

      if (!domain) continue;
      if (!/^[a-z0-9-]+\.[a-z]{2,}$/i.test(domain)) continue;
      if (seen.has(domain)) continue;

      // Expiration cell for same row-index
      const expirationRow = document.querySelector(
        `.grid-data-container .grid-cell-container.row-index-${rowIndex}[style*="left: 398px"]`
      );

      // Status cell for same row-index
      const statusRow = document.querySelector(
        `.grid-data-container .grid-cell-container.row-index-${rowIndex}.last-column`
      );

      const expirationText = normalizeText(expirationRow?.textContent);
      const statusText = normalizeText(statusRow?.textContent);

      let finalStatus = "Unknown";
      let eligible = false;

      const lowerStatus = statusText.toLowerCase();

      // 1) primary source = row status
      if (lowerStatus.includes("active")) {
        finalStatus = "Active";
        eligible = true;
      } else if (lowerStatus.includes("redemption")) {
        finalStatus = "Redemption";
        eligible = false;
      } else if (lowerStatus.includes("expired")) {
        finalStatus = "Expired";
        eligible = false;
      } else if (lowerStatus.includes("inactive")) {
        finalStatus = "Inactive";
        eligible = false;
      } else {
        // 2) fallback = expiration date
        const expDate = parseDateText(expirationText);

        if (expDate) {
          if (expDate >= today) {
            finalStatus = "Active";
            eligible = true;
          } else {
            finalStatus = "Not Active";
            eligible = false;
          }
        }
      }

      results.push({
        domain,
        expiration: expirationText || "Unknown",
        rawStatus: statusText || "Unknown",
        status: finalStatus,
        eligible,
      });

      seen.add(domain);
    }

    return results;
  });

  return domains;
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
    8000,
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
    8000,
  );

  if (!clickedForwarding) {
    throw new Error("Could not click Forwarding.");
  }

  await page.waitForTimeout(1500);
}

async function findForwardingRow(page, domain) {
  const row = page.locator("tr").filter({ hasText: domain }).first();
  if (await row.count().catch(() => 0)) return row;

  const rowRole = page
    .locator('[role="row"]')
    .filter({ hasText: domain })
    .first();
  if (await rowRole.count().catch(() => 0)) return rowRole;

  return null;
}

async function openEditModal(page, domain) {
  const row = await findForwardingRow(page, domain);
  if (!row) return false;

  const buttons = row.locator("button");
  const count = await buttons.count().catch(() => 0);

  if (count <= 0) return false;

  let clicked = false;

  for (let i = count - 1; i >= 0; i--) {
    try {
      await buttons.nth(i).click();
      clicked = true;
      break;
    } catch { }
  }

  if (!clicked) return false;

  await page.waitForTimeout(1000);

  const modal = page.locator('div[role="dialog"]').first();
  const modalVisible = await modal.isVisible().catch(() => false);

  if (!modalVisible) return false;

  await modal.locator('input[type="text"]').first().waitFor({
    state: "visible",
    timeout: 10000,
  });

  return true;
}

async function readForwardingFromModal(page) {
  const modal = page.locator('div[role="dialog"]').first();

  const modalVisible = await modal.isVisible().catch(() => false);
  if (!modalVisible) return null;

  let protocol = "http://";

  try {
    const select = modal.locator("select").first();
    await select.waitFor({ state: "visible", timeout: 4000 });
    protocol = (await select.inputValue().catch(() => "http://")) || "http://";
  } catch { }

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
  } catch { }

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
    3000,
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
    1500,
  );
}

async function setForwardingForDomain(page, domain, log) {
  log(`\nChecking: ${domain}`);

  await goToDomainForwarding(page, domain);

  const row = await findForwardingRow(page, domain);

  if (!row) {
    log(`SKIP ${domain} -> no forwarding row.`);
    return { status: "skip", reason: "no_row" };
  }

  const opened = await openEditModal(page, domain);

  if (!opened) {
    log(`SKIP ${domain} -> could not open edit modal.`);
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

  launchChromeForDebugging();
  await new Promise((resolve) => setTimeout(resolve, 4000));

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");

  const contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error("No Chrome context found.");
  }

  const context = contexts[0];
  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();

  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(20000);

  log("Make sure you are logged into GoDaddy in the opened Chrome window.");
  log("The bot is starting...");

  const updated = [];
  const skipped = [];
  const failed = [];

  const allDomains = await collectDomainsWithStatus(page);

  if (!allDomains.length) {
    throw new Error("No domains found.");
  }

  log(`Found ${allDomains.length} total domains.`);
  log("");
  log("DOMAIN STATUS LIST:");

  for (const item of allDomains) {
    log(
      `${item.domain} | status=${item.status} | raw=${item.rawStatus} | exp=${item.expiration} | ${item.eligible ? "ACTIVE" : "SKIP"}`
    );
  }

  const activeDomains = allDomains.filter((item) => item.eligible);

  log("");
  log(`Processing only active domains: ${activeDomains.length}`);

  for (const item of activeDomains) {
    if (shouldStop) {
      log("Stop requested. Bot stopped before processing the next domain.");
      break;
    }

    const domain = item.domain;

    try {
      const result = await setForwardingForDomain(page, domain, log);

      if (result.status === "updated") {
        updated.push(domain);
      } else {
        skipped.push({ domain, reason: result.reason });
      }
    } catch (err) {
      log(`FAIL ${domain} -> ${err.message}`);
      failed.push({ domain, reason: err.message });
    }
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
