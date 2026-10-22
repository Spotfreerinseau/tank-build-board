/* Shopify is the source of truth. Only parts and movement records are writable.
   This file also runs under Node for contract and failure-recovery tests. */
"use strict";
(function (root) {
  const BY = "Tank Build Board";
  const WEEKS_PER_MONTH = 4.33;
  const numeric = (v) =>
    v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
      ? null
      : Number(v);
  const json = (v, fallback) => {
    try {
      return JSON.parse(v) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const array = (v) => {
    const parsed = json(v, []);
    return Array.isArray(parsed) ? parsed : [];
  };
  const fields = (node) =>
    Object.fromEntries((node?.fields || []).map((f) => [f.key, f.value]));
  const decimal = (v) =>
    v === null ? "" : String(Math.round(v * 10000) / 10000);
  const same = (a, b) =>
    a === b || (a !== null && b !== null && Math.abs(a - b) < 1e-7);
  const fail = (message) => {
    throw new Error(message);
  };
  const weeks = (units, rate) =>
    units === null || !(rate > 0) ? null : (units / rate) * WEEKS_PER_MONTH;

  function recipe(items) {
    if (!Array.isArray(items) || !items.length) return [];
    const totals = {};
    for (const i of items) {
      if (!i?.code || !(numeric(i.qty) > 0)) return [];
      totals[i.code] = (totals[i.code] || 0) + Number(i.qty);
    }
    return Object.entries(totals).map(([code, qty]) => ({ code, qty }));
  }

  function normalise(data) {
    const parts = data.parts.nodes
      .map((n) => {
        const f = fields(n);
        return {
          ...f,
          id: n.id,
          code: f.code,
          name: f.name || f.code,
          unit: f.unit || "each",
          on_hand: numeric(f.on_hand),
          on_water: numeric(f.on_water) || 0,
          on_hold: numeric(f.on_hold) || 0,
          unit_cost: numeric(f.unit_cost) || 0,
          lead_days: /extrepure/i.test(f.supplier || "")
            ? 90
            : numeric(f.lead_days),
          sort: numeric(f.sort) ?? 999,
        };
      })
      .filter((p) => p.code)
      .sort((a, b) => a.sort - b.sort);
    const products = data.products.nodes
      .map((n) => {
        const f = fields(n);
        return {
          ...f,
          id: n.id,
          name: f.name || f.sku,
          short_name: f.short_name || f.name || f.sku,
          parts: recipe(json(f.parts, null)),
          monthly_sales: numeric(f.monthly_sales) || 0,
          prev_sales: numeric(f.prev_sales),
          listed: numeric(f.listed),
          sort: numeric(f.sort) ?? 999,
        };
      })
      .filter((p) => p.sku)
      .sort((a, b) => a.sort - b.sort);
    const movements = data.moves.nodes
      .map((n) => {
        const f = fields(n);
        return {
          ...f,
          id: n.id,
          handle: n.handle,
          kind: f.kind || "",
          at: f.at || "",
          who: f.who || "",
          summary: f.summary || "Stock change",
          recorded_by: f.recorded_by || "",
          undoes: f.undoes || "",
          changes: array(f.changes).filter(
            (c) => c && typeof c === "object" && c.code,
          ),
          skipped: array(f.skipped),
          orders: array(f.orders),
          qty: numeric(f.qty) || 0,
          value: numeric(f.value) || 0,
        };
      })
      .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
    const settings = fields(data.settings);
    return {
      parts,
      products,
      movements,
      settings: { ...settings, sync: json(settings.sync, null) },
    };
  }

  // The sync stores every digit of the Shopify name, including the 113 suffix.
  function orderNumber(order) {
    return String(order.name || "").replace(/^#/, "");
  }
  function alreadyRecorded(order, movements) {
    const number = orderNumber(order);
    const undone = new Set(
      movements.filter((m) => m.undoes).map((m) => m.undoes),
    );
    return movements.some((m) => {
      if (undone.has(m.handle)) return false;
      // This intentionally uses the sync's substring rule, including the 113 suffix.
      const refs = Array.isArray(m.orders) ? m.orders : [];
      return (
        refs.some((r) => String(r) === number) ||
        (number !== "" && String(m.who || "").includes("#" + number))
      );
    });
  }

  function reserveParts(products, orders, movements) {
    const result = {};
    for (const o of orders) {
      if (o.cancelledAt || alreadyRecorded(o, movements)) continue;
      for (const line of o.lines) {
        const p = products.find((p) => p.sku === line.sku);
        if (!p) continue;
        for (const i of p.parts)
          result[i.code] =
            (result[i.code] || 0) + i.qty * line.unfulfilledQuantity;
      }
    }
    return result;
  }

  function allocate(parts, products, reservations = {}, includeWater = false) {
    const pool = Object.fromEntries(
      parts.map((p) => [
        p.code,
        (p.on_hand === null ? Infinity : p.on_hand) +
          (includeWater ? p.on_water : 0) -
          (reservations[p.code] || 0),
      ]),
    );
    const result = products.map((p) => ({
      p,
      n: 0,
      cap:
        p.monthly_sales > 0
          ? Math.max(2, Math.ceil((p.monthly_sales * 12) / WEEKS_PER_MONTH))
          : 2,
      unknown:
        !p.parts.length ||
        p.parts.some((i) => !parts.some((x) => x.code === i.code)),
      uncounted: p.parts
        .filter((i) =>
          parts.some((x) => x.code === i.code && x.on_hand === null),
        )
        .map((i) => i.code),
    }));
    const short = (r) =>
      !r.p.parts.length
        ? { code: "" }
        : r.p.parts.find(
            (i) => pool[i.code] === undefined || pool[i.code] + 1e-8 < i.qty,
          );
    const give = (r) => {
      for (const i of r.p.parts) pool[i.code] -= i.qty;
      r.n++;
    };
    for (const r of result)
      for (let floor = 0; floor < 2; floor++) {
        if (r.unknown || short(r)) break;
        give(r);
      }
    for (;;) {
      let pick;
      for (const r of result)
        if (
          !r.unknown &&
          r.p.monthly_sales > 0 &&
          r.n < r.cap &&
          !short(r) &&
          (!pick || r.n / r.p.monthly_sales < pick.n / pick.p.monthly_sales)
        )
          pick = r;
      if (!pick) break;
      give(pick);
    }
    for (const r of result) {
      r.blocked = r.n >= r.cap ? null : short(r)?.code;
      r.w = r.unknown ? null : weeks(r.n, r.p.monthly_sales);
      r.atCap = !r.unknown && r.n >= r.cap;
      r.sev =
        r.unknown || r.w === null
          ? "amber"
          : r.atCap
            ? "green"
            : r.w < 6
              ? "red"
              : "amber";
    }
    return { result, pool };
  }

  function undoChanges(m, parts) {
    return m.changes.map((c) => {
      const p = parts.find((p) => p.code === c.code);
      if (!p)
        fail(
          "A part in this entry is missing. Check it in Shopify before undoing.",
        );
      if (m.kind === "count") {
        if (!same(p.on_hand, c.to))
          fail(
            "Stock has changed since this count. Count the part again so later changes are kept.",
          );
        return { code: c.code, from: p.on_hand, to: c.from ?? null };
      }
      if (p.on_hand === null || !Number.isFinite(c.delta))
        fail("Count this part before undoing the entry.");
      const after = p.on_hand - c.delta,
        water = p.on_water - (c.water_delta || 0);
      if (after < -1e-7 || water < -1e-7)
        fail(
          "Stock has changed. This undo would take stock below zero. Count the part again.",
        );
      return {
        code: c.code,
        delta: -c.delta,
        ...(c.water_delta ? { water_delta: -c.water_delta } : {}),
      };
    });
  }
  function canUndo(m, movements, pendingHandle) {
    return (
      m.handle !== pendingHandle &&
      !m.summary.endsWith(" [save in progress]") &&
      m.recorded_by === BY &&
      !m.undoes &&
      ["count", "receive", "order", "gift", "sample", "faulty", "own"].includes(
        m.kind,
      ) &&
      m.changes.length > 0 &&
      !movements.some((x) => x.undoes === m.handle)
    );
  }

  class Board {
    constructor({ fetcher, storage, key = "tank-board" }) {
      this.fetcher = fetcher;
      this.storage = storage;
      this.key = key;
      this.parts = [];
      this.products = [];
      this.movements = [];
      this.settings = {};
      this.orders = [];
      this.ordersError = "";
      this.loadedAt = null;
      this.pending = this.readStored("pending", null);
      this.onUpdate = () => {};
    }
    readStored(name, fallback) {
      try {
        return (
          json(this.storage.getItem(this.key + ":" + name), fallback) ??
          fallback
        );
      } catch {
        return fallback;
      }
    }
    loadPending() {
      try {
        // A missing key means another tab finished the save. A storage access
        // failure keeps our in-memory journal, including any uncertain writes.
        this.pending = json(this.storage.getItem(this.key + ":pending"), null);
      } catch {}
      return this.pending;
    }
    store(name, value) {
      try {
        if (value === null) this.storage.removeItem(this.key + ":" + name);
        else this.storage.setItem(this.key + ":" + name, JSON.stringify(value));
      } catch {
        fail(
          "This browser cannot keep the save record. Allow local storage before saving. Your counts are still on this page.",
        );
      }
    }
    async api(query, variables = {}) {
      let response;
      try {
        response = await this.fetcher("shopify:admin/api/graphql.json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables }),
        });
      } catch {
        fail(
          "Couldn’t reach Shopify. Your work is kept here. Check your connection and try again.",
        );
      }
      if (response.status === 401)
        fail(
          "Shopify needs you to sign in again. Your draft is kept on this device.",
        );
      if (response.status === 403)
        fail(
          "Shopify hasn’t allowed this request. Check the app’s metaobject and order permissions.",
        );
      if (!response.ok)
        fail(
          "Shopify returned " +
            response.status +
            ". Your work is kept here. Try again shortly.",
        );
      const body = await response.json();
      if (body.errors?.length)
        fail(body.errors.map((e) => e.message).join("; "));
      if (!body.data)
        fail("Shopify sent an empty response. Your work is kept here.");
      return body.data;
    }
    async allMeta(type, sort = false) {
      const nodes = [];
      let after = null;
      do {
        const data = await this.api(
          `query BoardObjects($after: String) { metaobjects(type: "${type}", first: 250, after: $after${sort ? ', sortKey: "updated_at", reverse: true' : ""}) { nodes { id handle fields { key value } } pageInfo { hasNextPage endCursor } } }`,
          { after },
        );
        nodes.push(...data.metaobjects.nodes);
        after = data.metaobjects.pageInfo.hasNextPage
          ? data.metaobjects.pageInfo.endCursor
          : null;
      } while (after);
      return { nodes };
    }
    async refresh() {
      const [parts, products, moves, st] = await Promise.all([
        this.allMeta("tank_board_part"),
        this.allMeta("tank_board_product"),
        this.allMeta("tank_board_movement", true),
        this.api(
          'query BoardSettings { settings: metaobjectByHandle(handle: {type: "tank_board_settings", handle: "main"}) { id fields { key value } } }',
        ),
      ]);
      const state = normalise({
        parts,
        products,
        moves,
        settings: st.settings,
      });
      if (!state.parts.length || !state.products.length)
        fail(
          "No board parts or products were found in Shopify. Check the tank_board metaobjects.",
        );
      Object.assign(this, state);
      this.loadedAt = new Date();
      this.onUpdate();
      return this;
    }
    async readOrders(
      search = "fulfillment_status:unfulfilled OR fulfillment_status:partial",
    ) {
      const orders = [];
      let after = null;
      do {
        const data = await this.api(
          `query BoardOrders($after: String, $search: String!) { orders(first: 100, after: $after, query: $search) { nodes { id name cancelledAt lineItems(first: 250) { nodes { sku currentQuantity unfulfilledQuantity } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }`,
          { after, search },
        );
        for (const o of data.orders.nodes) {
          const lines = [...o.lineItems.nodes];
          let cursor = o.lineItems.pageInfo.hasNextPage
            ? o.lineItems.pageInfo.endCursor
            : null;
          while (cursor) {
            const extra = await this.api(
              `query BoardOrderLines($id: ID!, $after: String) { order(id: $id) { lineItems(first: 250, after: $after) { nodes { sku currentQuantity unfulfilledQuantity } pageInfo { hasNextPage endCursor } } } }`,
              { id: o.id, after: cursor },
            );
            lines.push(...extra.order.lineItems.nodes);
            cursor = extra.order.lineItems.pageInfo.hasNextPage
              ? extra.order.lineItems.pageInfo.endCursor
              : null;
          }
          orders.push({
            id: o.id,
            name: o.name,
            cancelledAt: o.cancelledAt,
            lines,
          });
        }
        after = data.orders.pageInfo.hasNextPage
          ? data.orders.pageInfo.endCursor
          : null;
      } while (after);
      return orders;
    }
    async refreshOrders() {
      try {
        this.orders = await this.readOrders();
        this.ordersError = "";
      } catch (e) {
        this.orders = [];
        this.ordersError =
          "Unshipped orders couldn’t be read. Build quantities exclude their reserved parts and may differ from the daily sync. " +
          e.message;
      }
      this.onUpdate();
    }
    reservations() {
      return reserveParts(this.products, this.orders, this.movements);
    }
    async manualOrder(who, sku, qty) {
      if (!/^#?\d+$/.test(who.trim()))
        fail("Enter the Shopify order number, such as #1843.");
      const typed = who.trim().replace(/^#/, "");
      // Accept a short reference or the full digits, with or without #.
      // Resolve against Shopify before deciding which number to store.
      const names = typed.endsWith("113")
        ? ["#" + typed, "#" + typed + "113"]
        : ["#" + typed + "113", "#" + typed];
      let order;
      for (const name of names) {
        const matches = await this.readOrders("name:" + name);
        order = matches.find((o) => o.name === name);
        if (order) break;
      }
      if (!order || order.cancelledAt)
        fail(
          "That order wasn’t found or has been cancelled. Check the order number in Shopify.",
        );
      if (alreadyRecorded(order, this.movements))
        fail(
          "That order is already in History and has not been put back. It cannot come off stock twice.",
        );
      const tracked = order.lines.filter(
        (l) =>
          this.products.some((p) => p.sku === l.sku) && l.currentQuantity > 0,
      );
      if (
        !tracked.length ||
        tracked.some((l) => l.sku !== sku) ||
        tracked.reduce((s, l) => s + l.currentQuantity, 0) !== qty
      )
        fail(
          "Choose the product and full quantity for this order. Orders with several board products must be left to the daily sync so nothing is missed.",
        );
      return order;
    }
    async mutation(operation, variables) {
      const data = await this.api(operation, variables);
      const r = data.result;
      if (!r?.metaobject || r.userErrors?.length)
        fail(
          r?.userErrors?.map((e) => e.message).join("; ") ||
            "Shopify didn’t confirm the change.",
        );
    }
    async record(m) {
      const values = {
        summary: m.summary,
        at: m.at,
        kind: m.kind,
        sku: m.sku || "",
        qty: decimal(m.qty || 0),
        who: m.who || "",
        changes: JSON.stringify(m.changes),
        skipped: JSON.stringify(m.skipped || []),
        value: decimal(m.value || 0),
        recorded_by: BY,
        orders: JSON.stringify(m.orders || []),
        undoes: m.undoes || "",
      };
      await this.mutation(
        `mutation BoardRecord($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) { result: metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { handle } userErrors { field message code } } }`,
        {
          handle: { type: "tank_board_movement", handle: m.handle },
          metaobject: {
            fields: Object.entries(values).map(([key, value]) => ({
              key,
              value,
            })),
          },
        },
      );
    }
    async writePart(id, changes) {
      if (changes.some((f) => !["on_hand", "on_water"].includes(f.key)))
        fail("Only stock counts can be changed by the board.");
      await this.mutation(
        `mutation BoardStock($id: ID!, $metaobject: MetaobjectUpdateInput!) { result: metaobjectUpdate(id: $id, metaobject: $metaobject) { metaobject { handle } userErrors { field message code } } }`,
        { id, metaobject: { fields: changes } },
      );
    }
    async freshPart(id) {
      const data = await this.api(
        "query BoardPart($id: ID!) { metaobject(id: $id) { id fields { key value } } }",
        { id },
      );
      if (!data.metaobject)
        fail(
          "This part was removed from Shopify. Check the pending save before continuing.",
        );
      return fields(data.metaobject);
    }
    async withLock(fn) {
      if (root.navigator?.locks)
        return root.navigator.locks.request(this.key + ":write", fn);
      return fn();
    }
    async save(build) {
      return this.withLock(async () => {
        this.loadPending();
        if (this.pending)
          fail("Finish the pending save before starting another change.");
        await this.refresh();
        const m = await build();
        if (!m?.changes?.length) fail("There are no complete changes to save.");
        m.handle =
          "m-" +
          (root.crypto?.randomUUID?.() ||
            Date.now() + "-" + Math.random().toString(36).slice(2));
        m.at = new Date().toISOString();
        m.recorded_by = BY;
        const targets = m.changes.map((c) => {
          const p = this.parts.find((p) => p.code === c.code);
          if (!p)
            fail(
              "A recipe part is missing in Shopify. Check the recipe before saving.",
            );
          if (Object.hasOwn(c, "from") && !same(c.from, p.on_hand))
            fail(
              "Stock changed since the review. Review the new totals before saving again.",
            );
          const to = Object.hasOwn(c, "to")
            ? c.to
            : p.on_hand === null
              ? fail("Count this part before changing stock.")
              : p.on_hand + c.delta;
          if (to !== null && (!Number.isFinite(to) || to < -1e-7))
            fail("This would take stock below zero.");
          if (to === null && m.kind !== "putback")
            fail("A saved count cannot be blank.");
          const values = [
            {
              key: "on_hand",
              from: p.on_hand,
              to: to === null ? null : Math.max(0, to),
            },
          ];
          if (Object.hasOwn(c, "water_delta")) {
            const water = p.on_water + c.water_delta;
            if (!Number.isFinite(water) || water < -1e-7)
              fail("This would take stock on the way below zero.");
            values.push({
              key: "on_water",
              from: p.on_water,
              to: Math.max(0, water),
            });
          }
          return { id: p.id, code: p.code, values };
        });
        // Persist before ANY network write; use a stable movement handle on recovery.
        const pending = { movement: m, targets, done: [], recorded: false };
        this.store("pending", pending);
        this.pending = pending;
        return this.finishPending();
      });
    }
    async resume() {
      return this.withLock(() => this.finishPending());
    }
    async finishPending() {
      const pending = this.loadPending();
      if (!pending) return null;
      this.pending = pending;
      await this.refresh();
      const m = pending.movement;
      const existing = this.movements.find((x) => x.handle === m.handle);
      if (
        existing &&
        (existing.kind !== m.kind ||
          JSON.stringify(existing.changes) !== JSON.stringify(m.changes))
      )
        fail(
          "The pending movement was changed in Shopify. Check its History entry before continuing.",
        );
      if (!existing)
        await this.record({ ...m, summary: m.summary + " [save in progress]" });
      pending.recorded = true;
      this.store("pending", pending);
      // Metaobject mutations have no transaction/CAS API. Record the movement first,
      // read each part immediately before its update, and checkpoint confirmed writes.
      // A retry only applies fields still at their recorded starting value.
      for (const target of pending.targets) {
        if (pending.done.includes(target.code)) continue;
        const fresh = await this.freshPart(target.id);
        const remaining = [];
        for (const v of target.values) {
          const current =
            numeric(fresh[v.key]) ?? (v.key === "on_water" ? 0 : null);
          if (same(current, v.to)) continue;
          if (!same(current, v.from))
            fail(
              target.code +
                " changed in Shopify during this save. No newer count was overwritten. Check the pending History entry and reconcile this part before retrying.",
            );
          remaining.push({ key: v.key, value: decimal(v.to) });
        }
        if (remaining.length) await this.writePart(target.id, remaining);
        pending.done.push(target.code);
        this.store("pending", pending);
      }
      // Finalise the audit entry only when every part update was confirmed.
      await this.record(m);
      // Keep the pending journal until a final Shopify read succeeds.
      await this.refresh();
      this.store("pending", null);
      this.pending = null;
      return m;
    }
  }
  const api = {
    Board,
    BY,
    WEEKS_PER_MONTH,
    weeks,
    normalise,
    recipe,
    allocate,
    orderNumber,
    alreadyRecorded,
    reserveParts,
    canUndo,
    undoChanges,
    same,
  };
  if (typeof module !== "undefined") module.exports = api;
  else root.TankBoard = api;
})(typeof window !== "undefined" ? window : globalThis);
