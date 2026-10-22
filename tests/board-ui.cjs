/* Browser contract tests. Every HTTP and Shopify request is intercepted locally.
   Requires playwright and a Chromium executable; no Shopify session is used. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { Shopify, node } = require("./shopify-fixture.cjs");
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
    await page.clock.install({ time: new Date("2026-10-23T12:00:00+10:00") });
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

    // Stock modes come from metaobjects. Full kits are uncapped; native bundles
    // do not change the shared tank allocation or the Lite + Pro summary total.
    const product = (sku) =>
      page
        .locator(".product")
        .filter({ has: page.locator(`[data-recipe="${sku}"]`) });
    const liteBefore = await product("SFR-TANK-10L")
      .locator(".build-number")
      .textContent();
    const proBefore = await product("SFR-TANK-15L")
      .locator(".build-number")
      .textContent();
    const totalBefore = await page
      .locator(".summary-item strong")
      .first()
      .textContent();
    shop.types.tank_board_part.push(
      node("pole22", "pole22", {
        code: "POLE22",
        name: "22ft pole kit parts",
        on_hand: 100,
        on_water: 0,
        unit: "each",
        lead_days: 14,
        sort: 4,
      }),
      node("pole30", "pole30", {
        code: "POLE30",
        name: "30ft pole kit parts",
        on_hand: 5,
        on_water: 0,
        unit: "each",
        lead_days: 14,
        sort: 5,
      }),
    );
    shop.types.tank_board_product.push(
      node("wfp22", "wfp22", {
        sku: "SFR-WFP22",
        name: "22ft pole kit",
        stock_mode: "full",
        parts: [{ code: "POLE22", qty: 1 }],
        monthly_sales: 2,
        prev_sales: 1,
        listed: 999,
        sort: 4,
      }),
      node("wfp30", "wfp30", {
        sku: "SFR-WFP30",
        name: "30ft pole kit",
        stock_mode: "full",
        parts: [{ code: "POLE30", qty: 1 }],
        monthly_sales: 0,
        prev_sales: 0,
        listed: 999,
        sort: 5,
      }),
      node("bundle-lite", "bundle-lite", {
        sku: "SFR-BUN-10L",
        name: "Lite tank + 22ft pole kit",
        stock_mode: "bundle",
        parts: [
          { code: "RESIN", qty: 10 },
          { code: "TANK", qty: 1 },
          { code: "POLE22", qty: 1 },
        ],
        monthly_sales: 0,
        prev_sales: 0,
        listed: 999,
        sort: 6,
      }),
      node("bundle-pro", "bundle-pro", {
        sku: "SFR-BUN-15L",
        name: "Pro tank + 22ft pole kit",
        stock_mode: "bundle",
        parts: [
          { code: "RESIN", qty: 15 },
          { code: "TANK", qty: 1 },
          { code: "POLE22", qty: 1 },
        ],
        monthly_sales: 0,
        prev_sales: 0,
        listed: 999,
        sort: 7,
      }),
    );
    await page.locator("[data-refresh]").click();
    await ready();
    assert.equal(
      await product("SFR-TANK-10L").locator(".build-number").textContent(),
      liteBefore,
    );
    assert.equal(
      await product("SFR-TANK-15L").locator(".build-number").textContent(),
      proBefore,
    );
    assert.equal(
      await page.locator(".summary-item strong").first().textContent(),
      totalBefore,
    );
    assert.equal(
      await product("SFR-WFP22").locator(".build-number").textContent(),
      "100",
    );
    assert.match(
      await product("SFR-WFP22").innerText(),
      /216\.5 weeks of cover/,
    );
    assert.match(
      await product("SFR-WFP22").locator(".product-foot").innerText(),
      /Held back by 22ft pole kit parts/,
    );
    assert.equal(await product("SFR-WFP22").locator(".cover-track").count(), 0);
    assert.doesNotMatch(
      await product("SFR-WFP22").innerText(),
      /Listed exceeds parts|12-week limit/,
    );
    assert.equal(
      await product("SFR-WFP30").locator(".build-number").textContent(),
      "5",
    );
    assert.equal(await product("SFR-WFP30").locator(".cover-line").count(), 0);
    for (const sku of ["SFR-BUN-10L", "SFR-BUN-15L"]) {
      assert.equal(await product(sku).locator(".build-number").count(), 0);
      assert.match(await product(sku).innerText(), /Shopify bundle/);
      assert.match(
        await product(sku).innerText(),
        /Stock comes from the products inside it in Shopify/,
      );
      assert.doesNotMatch(
        await product(sku).innerText(),
        /Listed exceeds parts|weeks of cover/,
      );
      await product(sku).locator("[data-recipe]").click();
      assert.equal(
        await product(sku).locator(".recipe-details").isVisible(),
        true,
      );
      assert.match(
        await product(sku).locator(".recipe-details").innerText(),
        /DI resin/,
      );
    }
    assert.match(
      await product("SFR-TANK-10L").innerText(),
      /Listed exceeds parts/,
    );
    checks += 4;

    // Forecast rows exercise ETA override, lead-time fallback, order dates,
    // excluded parts and the same arrival dates on mobile/desktop Parts views.
    const forecasts = [
      {
        code: "ETA-RESIN",
        name: "Backup resin",
        unit: "L",
        on_hand: 50,
        on_water: 100,
        lead_days: 90,
        eta: "2026-12-04",
      },
      {
        code: "FALLBACK",
        name: "Factory valves",
        unit: "each",
        on_hand: 40,
        on_water: 100,
        lead_days: 90,
      },
      {
        code: "SOON",
        name: "Meter fittings",
        unit: "each",
        on_hand: 100,
        on_water: 0,
        lead_days: 28,
      },
      {
        code: "OVERDUE",
        name: "Hose ends",
        unit: "each",
        on_hand: 20,
        on_water: 0,
        lead_days: 28,
      },
      {
        code: "COVERED",
        name: "Covered heads",
        unit: "each",
        on_hand: 40,
        on_water: 100,
        lead_days: 90,
        eta: "2026-11-06",
      },
      {
        code: "NO-SALES",
        name: "No sales part",
        unit: "each",
        on_hand: 40,
        on_water: 0,
        lead_days: 90,
      },
      {
        code: "UNCOUNTED",
        name: "Uncounted part",
        unit: "each",
        on_hand: "",
        on_water: 0,
        lead_days: 90,
      },
    ];
    forecasts.forEach((p, i) => {
      shop.types.tank_board_part.push(
        node("forecast-" + p.code, "forecast-" + p.code.toLowerCase(), {
          ...p,
          supplier: "Test supplier",
          sort: 100 + i,
        }),
      );
      shop.types.tank_board_product.push(
        node(
          "forecast-product-" + p.code,
          "forecast-product-" + p.code.toLowerCase(),
          {
            sku: "PLAN-" + p.code,
            name: p.name + " product",
            short_name: p.code === "ETA-RESIN" ? "Refills" : p.name + " kit",
            stock_mode: "full",
            parts: [{ code: p.code, qty: 1 }],
            monthly_sales:
              p.code === "NO-SALES" ? 0 : p.code === "ETA-RESIN" ? 20 : 43.3,
            prev_sales: 0,
            listed: 0,
            sort: 100 + i,
          },
        ),
      );
    });
    shop.types.tank_board_product.push(
      node("service-product", "service-product", {
        sku: "SERVICE",
        name: "Service kits",
        short_name: "Service kits",
        stock_mode: "shared",
        parts: [{ code: "ETA-RESIN", qty: 1 }],
        monthly_sales: 23.3,
        prev_sales: 0,
        listed: 0,
        sort: 120,
      }),
    );
    const syncField = shop.settings.fields.find((f) => f.key === "sync"),
      sync = JSON.parse(syncField.value);
    sync.reserved["ETA-RESIN"] = 10;
    syncField.value = JSON.stringify(sync);
    await page.locator("[data-refresh]").click();
    await ready();
    const shortage = (code) =>
      page.locator(`#running-short [data-part-focus="${code}"]`);
    assert.deepEqual(
      await page
        .locator("#running-short .shortage-row")
        .evaluateAll((rows) => rows.map((r) => r.dataset.partFocus)),
      ["OVERDUE", "RESIN", "ETA-RESIN", "FALLBACK", "SOON"],
    );
    assert.match(await shortage("ETA-RESIN").innerText(), /Test supplier/);
    assert.match(await shortage("ETA-RESIN").innerText(), /4\.0 weeks/);
    assert.match(await shortage("ETA-RESIN").innerText(), /runs out ~20 Nov/);
    assert.match(
      await shortage("ETA-RESIN").innerText(),
      /Holds back: Refills, Service kits/,
    );
    assert.match(
      await shortage("ETA-RESIN").innerText(),
      /100 on the way, lands ~4 Dec\. Runs out about 2\.0 weeks before it lands, about 20 litres short/,
    );
    assert.match(await shortage("OVERDUE").innerText(), /Overdue: order now/);
    assert.equal(
      await shortage("OVERDUE").evaluate((el) => el.classList.contains("red")),
      true,
    );
    assert.match(await shortage("SOON").innerText(), /Order by 4 Dec/);
    assert.equal(
      await shortage("SOON").evaluate((el) => el.classList.contains("amber")),
      true,
    );
    assert.equal(
      await page.evaluate(
        () =>
          document
            .querySelector("#running-short")
            .compareDocumentPosition(document.querySelector(".summary")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      4,
    );
    assert.equal(await page.locator(".notice").count(), 0);
    assert.doesNotMatch(
      await product("PLAN-COVERED").innerText(),
      /Runs out before the delivery lands/,
    );
    checks++;
    await shortage("ETA-RESIN").click();
    assert.equal(
      await page.locator("#parts-search").inputValue(),
      "Backup resin",
    );
    assert.match(
      await page.locator(".part-cards .arrival-date").innerText(),
      /lands ~4 Dec/,
    );
    assert.match(
      await page.locator(".part-cards .part-reorder").innerText(),
      /about 20 litres short/,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.match(
      await page.locator(".part-table .arrival-date").innerText(),
      /lands ~4 Dec/,
    );
    await nav("home");
    await shortage("FALLBACK").click();
    assert.match(
      await page.locator(".part-table .arrival-date").innerText(),
      /lands ~21 Jan/,
    );
    await nav("home");
    checks++;
    const originalParts = structuredClone(shop.types.tank_board_part);
    for (const part of shop.types.tank_board_part)
      for (const field of part.fields) {
        if (field.key === "on_hand") field.value = "100000";
        if (field.key === "on_water") field.value = "0";
      }
    await page.locator("[data-refresh]").click();
    await ready();
    assert.equal(await page.locator("#running-short .shortage-row").count(), 0);
    assert.match(
      await page.locator("#running-short").innerText(),
      /Nothing running short at the current pace\./,
    );
    shop.types.tank_board_part = originalParts;
    await page.locator("[data-refresh]").click();
    await ready();
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

    // Only the three non-order actions remain; their optional note is retained.
    await action("out");
    assert.deepEqual(
      await page
        .locator("[data-why]")
        .evaluateAll((buttons) => buttons.map((b) => b.dataset.why)),
      ["gift", "sample", "faulty"],
    );
    assert.equal(
      await page.locator("#order-note, [data-why=order]").count(),
      0,
    );
    assert.equal(
      await page.getByLabel("Who or a short note (optional)").count(),
      1,
    );
    for (const reason of ["sample", "faulty"]) {
      await page.locator(`[data-why="${reason}"]`).click();
      await page.locator("#out-who").fill("Workshop test");
      await page.locator("[data-save-out]").click();
      await saved();
      const record = shop.types.tank_board_movement[0];
      assert.equal(record.fields.find((f) => f.key === "kind").value, reason);
      assert.equal(
        record.fields.find((f) => f.key === "who").value,
        "Workshop test",
      );
      assert.equal(record.fields.find((f) => f.key === "orders").value, "[]");
    }
    assert.equal(shop.value("RESIN"), 81);
    checks++;

    // Existing manual order entries still display, filter and undo without order access.
    shop.types.tank_board_movement.push(
      node("legacy-order", "legacy-order", {
        kind: "order",
        recorded_by: "Tank Build Board",
        summary: "2 Lite tanks taken out (old order)",
        who: "Shopify order #1680113",
        sku: "SFR-TANK-10L",
        qty: 2,
        orders: [1680113],
        at: "2026-10-20T09:00:00+10:00",
        changes: [
          { code: "RESIN", delta: -20 },
          { code: "TANK", delta: -2 },
        ],
      }),
    );
    await page.locator("[data-refresh]").click();
    await ready();
    await nav("history");
    await page.locator("#history-kind").selectOption("order");
    await page.locator("#history-search").fill("Shopify order #1680113");
    assert.match(
      await page.locator("#history-results").innerText(),
      /old order/,
    );
    await page.locator("[data-undo]").first().click();
    await page.locator("[data-confirm-undo]").click();
    await saved();
    assert.equal(shop.value("RESIN"), 101);
    assert.equal(
      shop.types.tank_board_movement[0].fields.find((f) => f.key === "undoes")
        .value,
      "legacy-order",
    );
    checks++;

    // Allocation and its last-run note come entirely from the settings sync JSON.
    await nav("home");
    const reservedBuild = await page.locator(".build-number").allTextContents();
    const reservedSnapshot = JSON.parse(
      shop.settings.fields.find((f) => f.key === "sync").value,
    ).reserved;
    assert.equal(
      await page.locator("#reservation-note").textContent(),
      "Parts for unshipped orders are set aside at each daily sync (last run 21 Oct, 6:51 am).",
    );
    assert.doesNotMatch(
      await page.locator("#main").innerText(),
      /Unshipped orders couldn.t be read/,
    );
    shop.settings = node("settings", "main", {
      sync: { at: "2026-10-21T06:51:00+10:00", through: "302113" },
    });
    await page.locator("[data-refresh]").click();
    await ready();
    const noReservedBuild = await page
      .locator(".build-number")
      .allTextContents();
    assert.notDeepEqual(noReservedBuild, reservedBuild);
    shop.settings = node("settings", "main", {
      sync: {
        at: "2026-10-21T06:51:00+10:00",
        reserved: reservedSnapshot,
      },
    });
    await page.locator("[data-refresh]").click();
    await ready();
    assert.deepEqual(
      await page.locator(".build-number").allTextContents(),
      reservedBuild,
    );
    checks++;
    await nav("home");
    assert.match(
      await page.locator("#main").innerText(),
      /Runs out about .* weeks before it lands/,
    );
    checks++;
    await nav("parts");
    await page.locator("#parts-search").fill("DI resin");
    assert.match(
      await page.locator("#parts-results").innerText(),
      /on the way, lands ~.*Runs out about/,
    );
    checks++;
    for (const request of shop.requests) {
      assert.ok(
        [
          "BoardObjects",
          "BoardSettings",
          "BoardPart",
          "BoardRecord",
          "BoardStock",
        ].includes(request.op),
      );
      assert.doesNotMatch(request.query, /\borders?\s*\(/);
    }
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
