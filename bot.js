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
        } catch { }
      }
    }
  } catch { }
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
  if (await isDebugPortReady()) {
    return;
  }

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

function isGodaddyPageUrl(url = "") {
  return /(^https?:\/\/)?([a-z0-9-]+\.)*godaddy\.com/i.test(url);
}

async function ensureWorkingPage(context, log = () => { }) {
  const pages = context.pages().filter((p) => !p.isClosed());
  const godaddyPage = pages.find((p) => isGodaddyPageUrl(p.url()));
  let page = godaddyPage || (pages.length ? pages[pages.length - 1] : null);

  if (!page || page.isClosed()) {
    page = await context.newPage();
  }

  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(40000);

  try {
    page.removeAllListeners("close");
  } catch { }

  page.on("close", () => {
    log("⚠️ Page closed unexpectedly.");
  });

  return page;
}

async function rebuildSession(log = () => { }) {
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

function isRecoverableSessionError(message = "") {
  return (
    /Target page, context or browser has been closed/i.test(message) ||
    /ECONNREFUSED/i.test(message) ||
    /Session closed/i.test(message) ||
    /ERR_ABORTED/i.test(message)
  );
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
    1500
  );
}

async function gotoPortfolio(page, log = () => { }) {
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
    function normalize(text) {
      return (text || "").replace(/\s+/g, " ").trim();
    }

    function isDomain(text) {
      return /^[a-z0-9-]+\.[a-z]{2,}$/i.test((text || "").trim());
    }

    const rows = [];
    const seen = new Set();

    const domainCells = document.querySelectorAll(".domain-name-cell a");

    domainCells.forEach((el) => {
      const domain = normalize(el.textContent).toLowerCase();
      if (!isDomain(domain)) return;
      if (seen.has(domain)) return;

      const row = el.closest('[class*="row-index-"]');
      if (!row) return;

      const rowIndexClass = [...row.classList].find((c) => c.startsWith("row-index-"));
      if (!rowIndexClass) return;

      const allCells = Array.from(document.querySelectorAll(`.${rowIndexClass}`));

      let expiration = "Unknown";
      let status = "Unknown";
      let forwarding = "";

      for (const cell of allCells) {
        const raw = normalize(cell.textContent);
        const text = raw.toLowerCase();

        if (
          expiration === "Unknown" &&
          /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(raw)
        ) {
          expiration = raw;
        }

        if (
          status === "Unknown" &&
          (
            text.includes("active") ||
            text.includes("pending update") ||
            text.includes("redemption") ||
            text.includes("expired") ||
            text.includes("inactive")
          )
        ) {
          status = raw;
        }

        const links = Array.from(cell.querySelectorAll("a"));
        for (const l of links) {
          const href = (l.getAttribute("href") || "").trim();
          const txt = normalize(l.textContent);

          if (href.toLowerCase().includes("buynownames.com/domain-for-sale")) {
            forwarding = href;
            break;
          }

          if (txt.toLowerCase().includes("buynownames.com/domain-for-sale")) {
            forwarding = txt;
            break;
          }
        }

        if (forwarding) break;
      }

      if (!forwarding) {
        for (const cell of allCells) {
          const raw = normalize(cell.textContent);
          if (raw.toLowerCase().includes("buynownames.com/domain-for-sale")) {
            forwarding = raw;
            break;
          }
        }
      }

      rows.push({
        domain,
        expiration,
        rawStatus: status,
        forwarding,
      });

      seen.add(domain);
    });

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

async function collectAllPortfolioDomains(page, log = () => { }) {
  await gotoPortfolio(page, log);

  const all = new Map();
  let currentPage = 1;
  let pagesWithoutNewDomains = 0;

  while (true) {
    log(`\nReading portfolio page ${currentPage}...`);

    const rows = await collectDomainsFromCurrentPage(page, log);

    let addedThisPage = 0;

    for (const item of rows) {
      if (!all.has(item.domain)) {
        all.set(item.domain, item);
        addedThisPage += 1;
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

    log(
      `Page ${currentPage} done: ${rows.length} rows seen, ${addedThisPage} new domains added, ${all.size} total so far.`
    );

    if (addedThisPage === 0) {
      pagesWithoutNewDomains += 1;
    } else {
      pagesWithoutNewDomains = 0;
    }

    const nextPage = currentPage + 1;
    const moved = await goToPortfolioPage(page, nextPage, log);

    if (!moved) {
      log(`No more portfolio pages after page ${currentPage}.`);
      break;
    }

    currentPage = nextPage;

    if (pagesWithoutNewDomains >= 2) {
      log("Stopping pagination because no new domains were found on consecutive pages.");
      break;
    }
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
  const modal = page.locator('div[role="dialog"]').first();

  async function waitForModalVisible(timeout = 4000) {
    try {
      await modal.waitFor({ state: "visible", timeout });
      return true;
    } catch {
      return false;
    }
  }

  async function clickEditTrigger() {
    const editButton = page.locator('button[aria-label="Edit"]').first();
    if (await editButton.isVisible().catch(() => false)) {
      await editButton.click();
      return true;
    }

    // Fallback when aria-label is missing.
    const alt = page.locator('button svg').locator('..').first();
    if (await alt.isVisible().catch(() => false)) {
      await alt.click();
      return true;
    }

    return false;
  }

  // If the modal is already open, do not click Edit again.
  if (!(await waitForModalVisible(600))) {
    const clicked = await clickEditTrigger();
    if (!clicked) return false;

    // Retry only when modal did not open after first click.
    if (!(await waitForModalVisible(4000))) {
      const clickedAgain = await clickEditTrigger();
      if (!clickedAgain) return false;
      if (!(await waitForModalVisible(4000))) return false;
    }
  }

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

async function clickVisibleDialogDismiss(page) {
  const clickedBySelector = await waitAndClick(
    page,
    [
      'div[role="dialog"] button:has-text("Done")',
      'div[role="dialog"] button:has-text("Close")',
      'div[role="dialog"] button:has-text("OK")',
      'div[role="dialog"] button[aria-label="Close"]',
      'div[role="dialog"] button[aria-label*="close"]',
      'div[role="dialog"] button[aria-label*="dismiss"]',
    ],
    900
  );
  if (clickedBySelector) return true;

  // Fallback for icon-only X buttons in the top-right area of the dialog.
  return await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }

    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(isVisible);
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return false;

    const dialogRect = dialog.getBoundingClientRect();
    const buttons = Array.from(dialog.querySelectorAll("button")).filter(isVisible);

    const labeled = buttons.find((b) => {
      const label = `${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`.toLowerCase();
      return label.includes("close") || label.includes("dismiss") || label.includes("done") || label.includes("ok");
    });
    if (labeled) {
      labeled.click();
      return true;
    }

    const topRightCandidates = buttons
      .map((b) => ({ b, r: b.getBoundingClientRect() }))
      .filter(({ r }) => {
        const nearTop = r.top <= dialogRect.top + Math.min(150, dialogRect.height * 0.35);
        const nearRight = r.left >= dialogRect.left + dialogRect.width * 0.65;
        return nearTop && nearRight;
      })
      .sort((a, b) => (b.r.right + b.r.top) - (a.r.right + a.r.top));

    if (topRightCandidates.length) {
      topRightCandidates[0].b.click();
      return true;
    }

    return false;
  });
}

async function dismissDialogsAfterSave(page, maxAttempts = 8) {
  for (let i = 0; i < maxAttempts; i++) {
    const modal = page.locator('div[role="dialog"]').first();
    const visible = await modal.isVisible().catch(() => false);
    if (!visible) return true;

    const clicked = await clickVisibleDialogDismiss(page);
    if (!clicked) {
      await page.keyboard.press("Escape").catch(() => null);
    }

    await page.waitForTimeout(500);
  }

  const stillVisible = await page.locator('div[role="dialog"]').first().isVisible().catch(() => false);
  return !stillVisible;
}

async function getCurrentPortfolioPageNumber(page) {
  return await page.evaluate(() => {
    function normalize(text) {
      return (text || "").replace(/\s+/g, " ").trim();
    }

    const candidates = Array.from(
      document.querySelectorAll('button, a, [role="button"], [aria-current="page"]')
    );

    for (const el of candidates) {
      const text = normalize(el.textContent);
      const ariaCurrent = (el.getAttribute("aria-current") || "").toLowerCase();
      const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
      const cls = (el.className || "").toString().toLowerCase();

      if (/^\d+$/.test(text)) {
        if (
          ariaCurrent === "page" ||
          ariaLabel.includes("current page") ||
          cls.includes("active") ||
          cls.includes("selected") ||
          el.getAttribute("disabled") !== null
        ) {
          return Number(text);
        }
      }
    }

    return 1;
  });
}

async function goToPortfolioPage(page, targetPage, log = () => { }) {
  if (targetPage <= 1) return true;

  for (let attempt = 0; attempt < 3; attempt++) {
    const clicked = await page.evaluate((target) => {
      function normalize(text) {
        return (text || "").replace(/\s+/g, " ").trim();
      }

      function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      }

      const candidates = Array.from(
        document.querySelectorAll('button, a, [role="button"]')
      );

      const direct = candidates.find((el) => {
        const text = normalize(el.textContent);
        return isVisible(el) && text === String(target);
      });

      if (direct) {
        direct.click();
        return true;
      }

      const ariaMatch = candidates.find((el) => {
        const label = (el.getAttribute("aria-label") || "").toLowerCase();
        return isVisible(el) && label.includes(`page ${target}`);
      });

      if (ariaMatch) {
        ariaMatch.click();
        return true;
      }

      return false;
    }, targetPage);

    if (!clicked) {
      log(`Could not click page ${targetPage}.`);
      return false;
    }

    await page.waitForLoadState("domcontentloaded").catch(() => null);
    await page.waitForLoadState("networkidle").catch(() => null);
    await dismissCookieBanner(page);
    await page.waitForTimeout(2000);

    const current = await getCurrentPortfolioPageNumber(page);
    if (current === targetPage) {
      log(`Moved to portfolio page ${targetPage}.`);
      return true;
    }
  }

  return false;
}

async function collectDomainsFromCurrentPage(page, log = () => { }) {
  const pageRows = new Map();
  let sameCount = 0;
  let lastSize = 0;

  for (let round = 0; round < 100; round++) {
    const visible = await extractVisiblePortfolioRows(page);

    for (const item of visible) {
      if (!pageRows.has(item.domain)) {
        pageRows.set(item.domain, item);
      } else {
        const prev = pageRows.get(item.domain);
        pageRows.set(item.domain, {
          ...prev,
          ...item,
          forwarding: item.forwarding || prev.forwarding || "",
          rawStatus: item.rawStatus || prev.rawStatus || "Unknown",
          expiration: item.expiration || prev.expiration || "Unknown",
        });
      }
    }

    const currentSize = pageRows.size;
    log(`Collect round ${round + 1}: ${currentSize} unique domains collected on this page.`);

    if (currentSize === lastSize) {
      sameCount += 1;
    } else {
      sameCount = 0;
      lastSize = currentSize;
    }

    if (sameCount >= 5) break;

    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(800);
  }

  return Array.from(pageRows.values());
}

async function saveForwardingModal(page) {
  const modal = page.locator('div[role="dialog"]').first();
  const saveBtn = modal.locator('button:has-text("Save")').first();

  await saveBtn.waitFor({ state: "visible", timeout: 7000 });
  await saveBtn.click();

  await page.waitForTimeout(2000);

  const dismissed = await dismissDialogsAfterSave(page, 10);
  if (!dismissed) {
    throw new Error("Saved forwarding, but confirmation dialog did not close.");
  }

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

  const clicked = await waitAndClick(
    page,
    ['button[aria-label="Close"]', 'button[aria-label*="close"]'],
    1500
  );

  if (!clicked) {
    const fallbackClicked = await clickVisibleDialogDismiss(page);
    if (!fallbackClicked) {
      await page.keyboard.press("Escape").catch(() => null);
    }
  }
}

async function setForwardingForDomain(page, domain, log, attempt = 1) {
  if (attempt <= 1) {
    log(`\nChecking: ${domain}`);
  } else {
    log(`\nRetry attempt ${attempt}: ${domain}`);
  }

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

  log("RAW COLLECTED DOMAINS:");
  for (const item of allDomains) {
    log(
      `${item.domain} | rawStatus=${item.rawStatus} | exp=${item.expiration} | forwarding=${item.forwarding || "-"}`
    );
  }

  if (!allDomains.length) {
    throw new Error("No domains found.");
  }

  const activeDomains = allDomains.filter((item) => {
    const status = (item.status || item.rawStatus || "").toLowerCase();
    return status.includes("active") || status.includes("pending update");
  });

  log(`Found ${allDomains.length} total domains.`);
  log(`Active domains found: ${activeDomains.length}`);
  log(`Domains to inspect in forwarding modal: ${activeDomains.length}`);
  log("");

  if (activeDomains.length) {
    log("ACTIVE DOMAINS TO INSPECT:");
    for (const item of activeDomains) {
      log(
        `${item.domain} | status=${item.status} | exp=${item.expiration} | tableForwarding=${item.forwarding || "-"}`
      );
    }
  }

  const updated = [];
  const skipped = [];
  const failed = [];

  for (let index = 0; index < activeDomains.length; index++) {
    if (shouldStop) {
      log("Stop requested. Bot stopped before processing the next domain.");
      break;
    }

    const item = activeDomains[index];
    const domain = item.domain;

    log(`\nProgress: ${index + 1}/${activeDomains.length}`);

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

      let domainAttempt = 0;
      const result = await safeRun(async () => {
        domainAttempt += 1;
        if (!page || page.isClosed()) {
          page = await ensureWorkingPage(context, log);
        }

        return await setForwardingForDomain(page, domain, log, domainAttempt);
      }, 2, 2000);

      if (result.status === "updated") {
        updated.push(domain);
      } else {
        skipped.push({ domain, reason: result.reason });
      }
    } catch (err) {
      let message = err?.message || String(err);
      log(`FAIL ${domain} -> ${message}`);

      if (isRecoverableSessionError(message)) {
        try {
          log("Attempting recovery after closed page/browser...");
          ({ browser, context, page } = await rebuildSession(log));

          log(`Retrying ${domain} once after recovery...`);
          let recoveryAttempt = 0;
          const retryResult = await safeRun(async () => {
            recoveryAttempt += 1;
            if (!context || context.isClosed()) {
              ({ browser, context, page } = await rebuildSession(log));
            } else if (!page || page.isClosed()) {
              page = await ensureWorkingPage(context, log);
            }

            return await setForwardingForDomain(page, domain, log, recoveryAttempt);
          }, 1, 2000);

          if (retryResult.status === "updated") {
            updated.push(domain);
          } else {
            skipped.push({ domain, reason: retryResult.reason });
          }

          await delay(1200);
          continue;
        } catch (recoveryErr) {
          message = recoveryErr?.message || String(recoveryErr);
          log(`Recovery/retry failed -> ${message}`);
        }
      }

      failed.push({ domain, reason: message });
    }

    await delay(1200);
  }

  log("\n------------------------------");
  log("SUMMARY:");
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

