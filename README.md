# Tank Build Board

A static Shopify admin app. The root `index.html` uses App Bridge’s Direct API access at `shopify:admin/api/graphql.json`, with the same API key and metaobject schema as the original board. There is no backend or build step. `board-core.js` handles Shopify and save recovery; `board.js` renders the approved mobile design. `mockup/index.html` remains the original offline design preview.

The production board contains no stock, recipe, sales or History fixtures. Open it from Apps in Shopify to use it. **Merging to `main` publishes to GitHub Pages; test the PR branch before merging.**

## Data contract

- Read all `tank_board_part`, `tank_board_product` and `tank_board_movement` pages, plus `tank_board_settings` / `main`.
- Display `monthly_sales`, `prev_sales`, `listed` and the settings sync position, without writing any of them.
- Only update part `on_hand` and, for receipts/reversed receipts, `on_water`. `on_hold` stays separate from usable stock.
- Every operation writes a `tank_board_movement` with the existing fields: `summary`, `at`, `kind`, `sku`, `qty`, `who`, `changes`, `skipped`, `value`, `recorded_by`, `orders`, `undoes`. Count changes retain `{code, from, to}`; stock out retains `{code, delta}`; receipt changes add `water_delta` inside the existing `changes` JSON field.
- Garage/shed splits are local drafts, scoped to the shop in the App Bridge URL. Only their total is saved to `on_hand`. Drafts survive reloads and failed saves. Litres accept fractional quantities; unit counts must be whole numbers.

## Written daily-sync rules

On-hand allocation starts with each part’s `on_hand`; blanks are unlimited. `on_water` and `on_hold` are excluded. Reserve the recipe parts for visible unshipped order quantities first, except orders already deducted by a movement that has not been put back. Then, in product sort order, give each product up to two units while parts allow. Give each remaining unit to the eligible product with the lowest `units / monthly_sales`, breaking ties by sort order. Stop that product at its next part shortage or when `units >= monthly_sales * 12 / 4.33`. This stopping rule can put cover slightly above 12 weeks; it does not floor the unit limit. Zero-sales products only receive the initial floor. The labelled **After delivery** view runs the same algorithm with `on_water` included as a hypothetical receipt.

An order is already recorded if its **number** appears in a movement’s `orders` list or `#<number>` occurs anywhere in that movement’s `who`, excluding movements named by another movement’s `undoes`. This follows the written sync rules, including their substring comparison. The store uses the `113` suffix: Shopify name `#1651113` means order number `1651`. Manual orders resolve against Shopify and record the canonical number in `orders`, plus the full Shopify name in `who`. A manual stock-out must cover the full tracked quantity of a single-product order; multi-product orders are left to the daily sync to avoid marking an entire order deducted after recording only one product.

Part reorder dates use aggregate recipe demand, reserved unshipped quantities, `on_water`, and `lead_days` (90 days for Extrepure). If shelf cover is shorter than the delivery lead time and stock is already on the way, the board asks to check that delivery instead of ordering again. The schema has no arrival date: delivery warnings compare cover with the part’s lead time, not a known shipment ETA.

## Save and undo behaviour

The board refreshes before saving, checks reviewed counts and undo previews again, blocks negative/uncounted stock-out, and serialises writes between tabs where browser locks are available. Daily-sync and other tools’ History entries are read-only. A stocktake cannot be undone after a later stock change; count again instead of overwriting later movements.

Shopify metaobject updates have no transaction or compare-and-swap operation. The board keeps a local journal before its first write, records a stable movement handle first, checks each part immediately before updating it, and checkpoints confirmed updates. An unfinished movement has `[save in progress]` in its summary and is read-only on other devices. **Check and finish save** resumes the same movement after a failure or reload and skips already-applied changes. Drafts are cleared only after confirmation. If a part no longer matches either its starting or intended value, recovery stops and identifies the part; reconcile that part and the recorded movement in Shopify before retrying. Keep using the original device for recovery.

These checks catch observed conflicts, but cannot eliminate the narrow race between the final read and a simultaneous sync/other-device write. True atomic concurrency would require a shared writer or an API/schema change. The daily sync is scheduled for 6:51 am; its own multi-write operation is outside this repository.

## Validation

Run the dependency-free core checks:

```sh
node tests/board-core.test.cjs
```

Browser checks require Playwright and Chromium (test dependencies only):

```sh
npm install --no-save playwright
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node tests/board-ui.cjs
```

The browser suite intercepts every request and uses `tests/shopify-fixture.cjs`; it never authenticates to or writes to Shopify. It checks all five screens at 320, 360, 390, 680, 768, 1024 and 1440 px, action flows, draft reload/failure recovery, stale count reviews, receipts, undo, stock-out validation, suffixed order dedupe, permissions and the outside-Shopify gate. Screenshots go into ignored `work/`.

Before merging, test in a **live Shopify embedded session**: App Bridge authentication and direct API permissions, real metaobject definitions/field validation, `read_orders` access and Shopify search, pagination on the actual store, both sales windows and listed quantities, and end-to-end count/stock-out/receive/undo persistence. Compare the on-hand split with the scheduled task using the same data and order visibility. Live session behaviour and overlap with the actual 6:51 am task cannot be verified by the mocked suite.
