/* Browser contract tests. Every HTTP and Shopify request is intercepted locally.
   Requires playwright and a Chromium executable; no Shopify session is used. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { Shopify } = require("./shopify-fixture.cjs");
const root = path.resolve(__dirname, "..");

(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  let checks = 0;
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage(),
      shop = new Shopify(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.exposeFunction("shopifyRequest", async (url, options) => {
      const response = await shop.fetcher(url, options);
      return { status: response.status, body: await response.json() };
    });
    await context.addInitScript(() => {
      window.shopify = {};
      window.fetch = async (url, options) => {
        if (!String(url).startsWith("shopify:"))
          throw Error("Unexpected network fetch: " + url);
        const r = await window.shopifyRequest(url, options);
        return {
          ok: r.status < 400,
          status: r.status,
          json: async () => r.body,
        };
      };
    });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.host === "tank-board.test") {
        const file =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        return route.fulfill({
          body: fs.readFileSync(path.join(root, file)),
          contentType: file.endsWith(".js") ? "text/javascript" : "text/html",
        });
      }
      // App Bridge is stubbed above, so this never authenticates or mutates a shop.
      return route.fulfill({ body: "", contentType: "text/javascript" });
    });
    const ready = () =>
      page.waitForFunction(
        () =>
          document
            .querySelector("#main")
            ?.textContent.includes("Scheduled for 6:51 am") &&
          !document
            .querySelector(".topbar-right")
            ?.textContent.includes("Working"),
      );
    const open = async () => {
      await page.goto("http://tank-board.test/");
      await ready();
    };
    const nav = async (name) => {
      await page.locator(`[data-page="${name}"]:visible`).first().click();
    };
    const action = async (name) => {
      await nav("actions");
      await page.locator(`[data-action="${name}"]`).click();
    };
    const saved = async () => {
      await ready();
      await page.waitForFunction(() =>
        document
          .querySelector("#toast")
          ?.textContent.includes("Saved to Shopify"),
      );
    };
    await open();
    assert.match(
      await page.locator("#main").innerText(),
      /Previous 30 days: 4/,
    );
    assert.match(
      await page.locator("#main").innerText(),
      /last listed in Shopify/,
    );
    assert.equal(await page.locator(".preview").count(), 0);
    checks++;

    // The approved layout must work across both navigation modes and every screen.
    for (const width of [320, 360, 390, 680, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const screen of ["home", "parts", "trends", "actions", "history"]) {
        await nav(screen);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          `${width}px ${screen} overflow`,
        );
      }
    }
    checks += 35;
    await page.setViewportSize({ width: 390, height: 844 });

    // Blank and invalid inputs cannot become saved zeroes. Drafts survive reloads.
    await action("count");
    await page.locator("[data-count-next]").click();
    assert.match(
      await page.locator("#count-error").textContent(),
      /Count both/,
    );
    await page.locator("#count-garage").fill("12.5");
    await page.locator("#count-shed").fill("80");
    await page.reload();
    await ready();
    await action("count");
    assert.equal(await page.locator("#count-garage").inputValue(), "12.5");
    assert.equal(await page.locator("#count-shed").inputValue(), "80");
    await page.locator("[data-count-review]").click();
    assert.equal(shop.value("RESIN"), 105); // Review has no writes.
    await page.locator("[data-save-count]").click();
    await saved();
    assert.equal(shop.value("RESIN"), 92.5);
    assert.equal(shop.writes[0].op, "BoardRecord");
    checks++;
    await nav("history");
    await page.locator("[data-undo]").first().click();
    await page.locator("[data-confirm-undo]").click();
    await saved();
    assert.equal(shop.value("RESIN"), 105);
    checks++;

    // A failed stocktake keeps both location drafts and offers idempotent recovery.
    await action("count");
    await page.locator("#count-garage").fill("20");
    await page.locator("#count-shed").fill("90");
    await page.locator("[data-count-review]").click();
    shop.before = (r) => (r.op === "BoardStock" ? shop.reply({}, 503) : null);
    await page.locator("[data-save-count]").click();
    await page.getByRole("alert").filter({ hasText: "503" }).waitFor();
    assert.match(await page.locator("#main").innerText(), /save is unfinished/);
    await page.reload();
    await ready();
    await action("count");
    assert.equal(await page.locator("#count-garage").inputValue(), "20");
    assert.equal(await page.locator("#count-shed").inputValue(), "90");
    shop.before = null;
    await page.locator("[data-resume]").click();
    await saved();
    assert.equal(shop.value("RESIN"), 110);
    checks++;

    // Fresh-count conflict returns to review without losing the draft.
    await action("count");
    await page.locator("#count-garage").fill("21");
    await page.locator("#count-shed").fill("90");
    await page.locator("[data-count-review]").click();
    shop.set("RESIN", "on_hand", 108);
    const writes = shop.writes.length;
    await page.locator("[data-save-count]").click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Stock changed in Shopify while you were counting" })
      .waitFor();
    assert.equal(shop.writes.length, writes);
    assert.match(await page.locator(".changes").innerText(), /108 → 111/);
    await page.locator("[data-save-count]").click();
    await saved();
    assert.equal(shop.value("RESIN"), 111);
    checks++;

    // Partial receipt, undo and read-only daily sync.
    await action("receive");
    await page.locator("#receive-code").selectOption("RESIN");
    await page.locator("#receive-qty").fill("10.5");
    await page.locator("[data-save-receive]").click();
    await saved();
    assert.equal(shop.value("RESIN"), 121.5);
    assert.equal(shop.value("RESIN", "on_water"), 29.5);
    await nav("history");
    await page
      .locator(".history-row")
      .filter({ hasText: "received" })
      .first()
      .locator("[data-undo]")
      .click();
    await page.locator("[data-confirm-undo]").click();
    await saved();
    assert.equal(shop.value("RESIN"), 111);
    assert.equal(shop.value("RESIN", "on_water"), 40);
    assert.equal(
      await page
        .locator(".history-row")
        .filter({ hasText: "Daily sync" })
        .locator("[data-undo]")
        .count(),
      0,
    );
    checks++;

    // Dropdown stock out blocks both overdraw and uncounted stock.
    await action("out");
    await page.locator("#out-sku").selectOption("EXTRA");
    assert.equal(await page.locator("[data-save-out]").isDisabled(), true);
    await page.locator("#out-sku").selectOption("SFR-TANK-10L");
    await page.locator("#out-qty").fill("999");
    assert.equal(await page.locator("[data-save-out]").isDisabled(), true);
    await page.locator("#out-qty").fill("1");
    await page.locator('[data-why="gift"]').click();
    await page.locator("[data-save-out]").click();
    await saved();
    assert.equal(shop.value("RESIN"), 101);
    checks++;

    // Shopify names include the 113 suffix; save the full digits used by the daily sync.
    await action("out");
    await page.locator('[data-why="order"]').click();
    await page.locator("#out-qty").fill("2");
    await page.locator("#out-who").fill("1680");
    await page.locator("[data-save-out]").click();
    await saved();
    let record = shop.types.tank_board_movement.find((n) =>
      n.fields.some(
        (f) => f.key === "who" && f.value === "Shopify order #1680113",
      ),
    );
    assert.ok(record);
    assert.equal(
      record.fields.find((f) => f.key === "orders").value,
      "[1680113]",
    );
    const afterOrder = shop.value("RESIN");
    await page.locator("#out-qty").fill("2");
    await page.locator("#out-who").fill("#1680113");
    await page.locator("[data-save-out]").click();
    await page
      .getByRole("alert")
      .filter({ hasText: "already in History" })
      .waitFor();
    assert.equal(shop.value("RESIN"), afterOrder);
    checks++;
    await nav("history");
    await page.locator("#history-search").fill("Shopify order #1680113");
    await page.locator("[data-undo]").first().click();
    await page.locator("[data-confirm-undo]").click();
    await saved();
    assert.equal(shop.value("RESIN"), afterOrder + 20);
    checks++;

    // Limited permissions are visible; no fallback recipes/counts or fake sales.
    shop.denyOrders = true;
    await page.locator("[data-refresh]").click();
    await ready();
    assert.match(
      await page.locator("#main").innerText(),
      /Unshipped orders couldn’t be read/,
    );
    checks++;
    await nav("home");
    assert.match(
      await page.locator("#main").innerText(),
      /will run out before the delivery lands/,
    );
    checks++;
    await nav("parts");
    await page.locator("#parts-search").fill("DI resin");
    assert.match(
      await page.locator("#parts-results").innerText(),
      /Delivery on the way · runs out before it lands/,
    );
    checks++;
    assert.deepEqual(errors, []);
    fs.mkdirSync(path.join(root, "work"), { recursive: true });
    await nav("home");
    await page.screenshot({
      path: path.join(root, "work", "board-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: path.join(root, "work", "board-desktop.png"),
      fullPage: true,
    });
    await context.close();

    // Outside Shopify, the board asks for the admin context and does no API work.
    const plain = await browser.newPage();
    await plain.route("**/*", (r) => {
      const url = new URL(r.request().url());
      return r.fulfill({
        body:
          url.host === "tank-board.test"
            ? fs.readFileSync(
                path.join(
                  root,
                  url.pathname === "/" ? "index.html" : url.pathname.slice(1),
                ),
              )
            : "",
        contentType: url.pathname.endsWith(".js")
          ? "text/javascript"
          : "text/html",
      });
    });
    await plain.goto("http://tank-board.test/");
    assert.match(
      await plain.locator("#main").innerText(),
      /Open this board from Apps/,
    );
    checks++;
    console.log(
      `Passed ${checks} browser checks; no runtime errors. Shopify was mocked throughout.`,
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
