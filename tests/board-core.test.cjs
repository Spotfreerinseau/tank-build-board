const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../board-core.js");
const { Shopify, Storage, f, node } = require("./shopify-fixture.cjs");
const setup = () => {
  const shop = new Shopify(),
    storage = new Storage(),
    board = new T.Board({ fetcher: shop.fetcher.bind(shop), storage });
  return { shop, storage, board };
};
const stockOut = (board, qty = 1) => ({
  kind: "gift",
  summary: "Gift",
  sku: board.products[0].sku,
  qty,
  changes: board.products[0].parts.map((i) => ({
    code: i.code,
    delta: -i.qty * qty,
  })),
});

test("Shopify reader preserves schema, null counts, new product fields and Extrepure lead time", async () => {
  const { board, shop } = setup();
  shop.pageSize = 1;
  await board.refresh();
  assert.equal(board.parts.length, 3);
  assert.equal(board.parts[0].lead_days, 90);
  assert.equal(board.parts[1].lead_days, 14);
  assert.equal(board.parts[2].on_hand, null);
  assert.equal(board.products[0].prev_sales, 4);
  assert.equal(board.products[0].listed, 8);
  assert.equal(board.products[2].prev_sales, null);
  assert.equal(board.products[2].listed, null);
  assert.ok(shop.requests.filter((r) => r.op === "BoardObjects").length > 3);
  assert.equal(shop.writes.length, 0);
});
test("settings sync reservations are used unchanged by the shared-parts allocation", async () => {
  const { board, shop } = setup();
  await board.refresh();
  const reserved = { RESIN: 20, TANK: 2 };
  assert.deepEqual(board.reservations(), reserved);
  const before = JSON.stringify(shop.settings);
  const allocation = T.allocate(
    board.parts,
    board.products,
    board.reservations(),
  );
  assert.ok(allocation.result[0].n * 10 + allocation.result[1].n * 15 <= 85);
  assert.equal(allocation.result[2].unknown, false);
  assert.ok(allocation.result[2].uncounted.includes("CAP"));
  assert.deepEqual(board.reservations(), reserved);
  assert.equal(JSON.stringify(shop.settings), before);
  assert.equal(shop.writes.length, 0);
});
test("allocation conserves parts, honours sort-order floor and exact 4.33 stopping threshold over independent random scenarios", () => {
  let seed = 41;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let run = 0; run < 300; run++) {
    const parts = ["a", "b", "c"].map((code) => ({
      code,
      on_hand: Math.floor(random() * 150),
      on_water: 13,
    }));
    const products = Array.from({ length: 5 }, (_, n) => ({
      sku: String(n),
      monthly_sales: Math.floor(random() * 20),
      parts: [
        { code: ["a", "b", "c"][n % 3], qty: n + 1 },
        { code: "a", qty: 1 },
      ],
    })).map((p) => ({ ...p, parts: T.recipe(p.parts) }));
    const reserve = { a: Math.floor(random() * 20) },
      result = T.allocate(parts, products, reserve);
    const expected = products.map(() => 0),
      stock = Object.fromEntries(
        parts.map((p) => [p.code, p.on_hand - (reserve[p.code] || 0)]),
      );
    const candidates = [];
    for (let k = 0; k < products.length; k++)
      for (let floor = 0; floor < 2; floor++) {
        const p = products[k];
        if (p.parts.every((i) => stock[i.code] >= i.qty)) {
          p.parts.forEach((i) => (stock[i.code] -= i.qty));
          expected[k]++;
        }
      }
    // An independent precomputed priority queue orders all remaining unit claims.
    for (let k = 0; k < products.length; k++) {
      const p = products[k];
      if (!p.monthly_sales) continue;
      for (
        let n = expected[k];
        n < Math.max(2, Math.ceil((p.monthly_sales * 12) / 4.33));
        n++
      )
        candidates.push({ k, n, score: n / p.monthly_sales });
    }
    candidates
      .sort((a, b) => a.score - b.score || a.k - b.k)
      .forEach(({ k, n }) => {
        const p = products[k];
        if (expected[k] !== n) return;
        if (p.parts.every((i) => stock[i.code] >= i.qty)) {
          p.parts.forEach((i) => (stock[i.code] -= i.qty));
          expected[k]++;
        }
      });
    assert.deepEqual(
      result.result.map((r) => r.n),
      expected,
    );
    for (const p of parts)
      assert.ok(
        result.pool[p.code] >=
          Math.min(0, p.on_hand - (reserve[p.code] || 0)) - 1e-7,
      );
    for (const r of result.result)
      if (r.p.monthly_sales)
        assert.ok(
          r.n === Math.ceil((r.p.monthly_sales * 12) / 4.33) || r.w < 12,
        );
  }
  assert.equal(T.weeks(77, 77), 4.33);
});
test("zero-sales products only receive the floor; unknown and invalid recipes never promise stock", () => {
  const p = [{ code: "a", on_hand: 100, on_water: 50 }];
  assert.equal(
    T.allocate(p, [
      { sku: "x", monthly_sales: 0, parts: [{ code: "a", qty: 1 }] },
    ]).result[0].n,
    2,
  );
  assert.equal(
    T.allocate(p, [{ sku: "x", monthly_sales: 10, parts: [] }]).result[0]
      .unknown,
    true,
  );
  assert.equal(
    T.allocate(p, [
      { sku: "x", monthly_sales: 10, parts: [{ code: "missing", qty: 1 }] },
    ]).result[0].unknown,
    true,
  );
  assert.deepEqual(
    T.recipe([
      { code: "a", qty: 2 },
      { code: "a", qty: 3 },
    ]),
    [{ code: "a", qty: 5 }],
  );
  assert.deepEqual(T.recipe([{ code: "a", qty: 0 }]), []);
});
test("older sync settings without reserved use no reservations; refresh picks up the next snapshot", async () => {
  const { board, shop } = setup();
  for (const sync of [
    null,
    { at: "2026-10-21T06:51:00+10:00" },
    { reserved: {} },
  ]) {
    shop.settings = node("settings", "main", { sync });
    await board.refresh();
    assert.deepEqual(board.reservations(), {});
    assert.deepEqual(
      T.allocate(board.parts, board.products, board.reservations()),
      T.allocate(board.parts, board.products),
    );
  }
  const reserved = { RSN: 10, "TNK-817": 1 };
  shop.settings = node("settings", "main", {
    sync: { at: "2026-10-22T06:51:00+10:00", reserved },
  });
  await board.refresh();
  assert.deepEqual(board.reservations(), reserved);
});
test("the board only requests metaobjects and has no order access methods", async () => {
  const { board, shop } = setup();
  await board.refresh();
  await board.save(() => stockOut(board));
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
  assert.equal(board.readOrders, undefined);
  assert.equal(board.refreshOrders, undefined);
  assert.equal(board.manualOrder, undefined);
});
test("legacy order movements retain their fields and undo using metaobjects only", async () => {
  const { board, shop } = setup();
  const orders = [1678113, 1679113, 1680113];
  shop.types.tank_board_movement.push(
    node("legacy-order", "legacy-order", {
      kind: "order",
      recorded_by: T.BY,
      summary: "2 Lite tanks taken out",
      who: "Shopify order #1680113",
      sku: "SFR-TANK-10L",
      qty: 2,
      orders,
      changes: [
        { code: "RESIN", delta: -20 },
        { code: "TANK", delta: -2 },
      ],
    }),
  );
  await board.refresh();
  const original = board.movements.find((m) => m.handle === "legacy-order");
  assert.deepEqual(original.orders, orders);
  assert.equal(T.canUndo(original, board.movements), true);
  assert.equal(
    T.canUndo(
      board.movements.find((m) => m.recorded_by === "Daily sync"),
      board.movements,
    ),
    false,
  );
  const settingsBefore = JSON.stringify(shop.settings);
  const undo = await board.save(() => ({
    kind: "putback",
    summary: "Undid: " + original.summary,
    undoes: original.handle,
    sku: original.sku,
    qty: original.qty,
    changes: T.undoChanges(original, board.parts),
  }));
  assert.equal(undo.undoes, "legacy-order");
  assert.equal(shop.value("RESIN"), 125);
  assert.equal(shop.value("TANK"), 22);
  assert.equal(T.canUndo(original, board.movements), false);
  assert.deepEqual(
    board.movements.find((m) => m.handle === "legacy-order").orders,
    orders,
  );
  assert.deepEqual(board.reservations(), { RESIN: 20, TANK: 2 });
  assert.equal(JSON.stringify(shop.settings), settingsBefore);
});
test("every stock write has a movement first and never changes sync-owned fields", async () => {
  const { board, shop } = setup();
  await board.refresh();
  const protectedBefore = JSON.stringify([
    shop.types.tank_board_product,
    shop.settings,
  ]);
  const m = await board.save(() => stockOut(board));
  assert.equal(shop.writes[0].op, "BoardRecord");
  assert.equal(shop.value("RESIN"), 95);
  assert.equal(shop.value("TANK"), 19);
  assert.equal(board.pending, null);
  assert.equal(shop.types.tank_board_movement.length, 2);
  const saved = f(shop.types.tank_board_movement[0]);
  assert.equal(saved.summary, "Gift");
  assert.equal(m.recorded_by, T.BY);
  assert.deepEqual(
    Object.keys(saved).sort(),
    [
      "summary",
      "at",
      "kind",
      "sku",
      "qty",
      "who",
      "changes",
      "skipped",
      "value",
      "recorded_by",
      "orders",
      "undoes",
    ].sort(),
  );
  assert.equal(
    JSON.stringify([shop.types.tank_board_product, shop.settings]),
    protectedBefore,
  );
});
test("stock out blocks insufficient or uncounted stock before any mutation", async () => {
  const { board, shop } = setup();
  await board.refresh();
  await assert.rejects(
    () => board.save(() => stockOut(board, 100)),
    /below zero/,
  );
  await assert.rejects(
    () =>
      board.save(() => ({
        kind: "sample",
        changes: [{ code: "CAP", delta: -1 }],
      })),
    /Count this part/,
  );
  assert.equal(shop.writes.length, 0);
});
test("counts and partial receipts can be undone with exact on-hand/on-water restoration", async () => {
  const { board, shop } = setup();
  await board.refresh();
  let m = await board.save(() => ({
    kind: "count",
    summary: "Count",
    changes: [{ code: "CAP", from: null, to: 8 }],
  }));
  assert.equal(shop.value("CAP"), 8);
  assert.equal(T.canUndo(m, board.movements), true);
  await board.save(() => ({
    kind: "putback",
    summary: "Undo count",
    undoes: m.handle,
    changes: T.undoChanges(m, board.parts),
  }));
  assert.equal(shop.value("CAP"), null);
  m = await board.save(() => ({
    kind: "receive",
    summary: "Receive",
    changes: [{ code: "RESIN", delta: 15, water_delta: -15 }],
  }));
  assert.equal(shop.value("RESIN"), 120);
  assert.equal(shop.value("RESIN", "on_water"), 25);
  await board.save(() => ({
    kind: "putback",
    summary: "Undo receipt",
    undoes: m.handle,
    changes: T.undoChanges(m, board.parts),
  }));
  assert.equal(shop.value("RESIN"), 105);
  assert.equal(shop.value("RESIN", "on_water"), 40);
});
test("undo blocks stale stocktakes, insufficient receipts, repeat undo, and daily-sync entries", async () => {
  const { board } = setup();
  await board.refresh();
  assert.equal(T.canUndo(board.movements[0], board.movements), false);
  assert.throws(
    () =>
      T.undoChanges(
        { kind: "count", changes: [{ code: "RESIN", from: 1, to: 100 }] },
        board.parts,
      ),
    /changed since/,
  );
  assert.throws(
    () =>
      T.undoChanges(
        {
          kind: "receive",
          changes: [{ code: "RESIN", delta: 200, water_delta: -200 }],
        },
        board.parts,
      ),
    /below zero/,
  );
  const m = {
    handle: "x",
    kind: "gift",
    recorded_by: T.BY,
    summary: "Gift",
    changes: [{ code: "RESIN", delta: -10 }],
  };
  assert.equal(T.canUndo(m, [{ undoes: "x" }]), false);
  assert.equal(
    T.canUndo({ ...m, summary: "Gift [save in progress]" }, []),
    false,
  );
});
for (const applied of [false, true])
  test(`partial multi-part save resumes after reload without double deduction (response lost after apply: ${applied})`, async () => {
    const { board, shop, storage } = setup();
    await board.refresh();
    const fail = (r) =>
      r.op === "BoardStock" && r.v.id === "part-b" ? shop.reply({}, 503) : null;
    if (applied) shop.after = fail;
    else shop.before = fail;
    await assert.rejects(() => board.save(() => stockOut(board)), /503/);
    assert.equal(shop.value("RESIN"), 95);
    assert.ok(storage.getItem("tank-board:pending"));
    assert.equal(
      T.canUndo(
        board.pending.movement,
        board.movements,
        board.pending.movement.handle,
      ),
      false,
    );
    shop.before = shop.after = null;
    const reload = new T.Board({ fetcher: shop.fetcher.bind(shop), storage });
    await reload.resume();
    assert.equal(shop.value("RESIN"), 95);
    assert.equal(shop.value("TANK"), 19);
    assert.equal(reload.pending, null);
    assert.equal(shop.types.tank_board_movement.length, 2);
    assert.equal(f(shop.types.tank_board_movement[0]).summary, "Gift");
  });
test("concurrent sync changes stop a partial save instead of overwriting newer counts", async () => {
  const { board, shop, storage } = setup();
  await board.refresh();
  let changed = false;
  shop.before = (r) => {
    if (r.op === "BoardPart" && r.v.id === "part-b" && !changed) {
      changed = true;
      shop.set("TANK", "on_hand", 17);
    }
  };
  await assert.rejects(
    () => board.save(() => stockOut(board)),
    /No newer count was overwritten/,
  );
  assert.equal(shop.value("TANK"), 17);
  assert.equal(shop.value("RESIN"), 95);
  assert.ok(storage.getItem("tank-board:pending"));
});
test("mutation userErrors leave a recoverable save and never apply stock without a movement", async () => {
  const { board, shop } = setup();
  await board.refresh();
  shop.before = (r) =>
    r.op === "BoardRecord"
      ? shop.reply({
          result: {
            metaobject: null,
            userErrors: [{ message: "Permission denied" }],
          },
        })
      : null;
  await assert.rejects(
    () => board.save(() => stockOut(board)),
    /Permission denied/,
  );
  assert.equal(shop.value("RESIN"), 105);
  assert.ok(board.pending);
  shop.before = null;
  await board.resume();
  assert.equal(shop.value("RESIN"), 95);
});
test("storage failure prevents all writes and stale reviewed counts are rejected", async () => {
  const { board, shop, storage } = setup();
  await board.refresh();
  await assert.rejects(
    () =>
      board.save(() => ({
        kind: "count",
        changes: [{ code: "RESIN", from: 1, to: 10 }],
      })),
    /changed since/,
  );
  storage.setItem = () => {
    throw Error("quota");
  };
  await assert.rejects(
    () => board.save(() => stockOut(board)),
    /local storage/,
  );
  assert.equal(shop.writes.length, 0);
  assert.equal(board.pending, null);
});

test("written sync rules: sequential two-unit floor, unlimited blanks and stop on crossing 12 weeks", () => {
  const products = [
    { sku: "a", monthly_sales: 0, parts: [{ code: "a", qty: 1 }] },
    { sku: "b", monthly_sales: 0, parts: [{ code: "a", qty: 1 }] },
  ];
  assert.deepEqual(
    T.allocate([{ code: "a", on_hand: 2, on_water: 99 }], products).result.map(
      (r) => r.n,
    ),
    [2, 0],
  );
  products[0].monthly_sales = 7;
  const a = T.allocate([{ code: "a", on_hand: null, on_water: 0 }], products)
    .result[0];
  assert.equal(a.n, 20);
  assert.ok(a.w >= 12);
  assert.ok(T.weeks(a.n - 1, 7) < 12);
  assert.deepEqual(a.uncounted, ["a"]);
});

test("a second tab notices a completed recovery instead of retaining a stale pending save", async () => {
  const { board, shop, storage } = setup();
  await board.refresh();
  shop.before = (r) => (r.op === "BoardStock" ? shop.reply({}, 503) : null);
  await assert.rejects(() => board.save(() => stockOut(board)), /503/);
  const other = new T.Board({ fetcher: shop.fetcher.bind(shop), storage });
  shop.before = null;
  await other.resume();
  await board.save(() => stockOut(board));
  assert.equal(shop.value("RESIN"), 85);
  assert.equal(board.pending, null);
});
