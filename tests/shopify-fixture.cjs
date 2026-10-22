// Test data only. Production files contain no inventory, recipe or sales fixtures.
const node = (id, handle, values) => ({
  id,
  handle,
  fields: Object.entries(values).map(([key, value]) => ({
    key,
    value:
      typeof value === "object" ? JSON.stringify(value) : String(value ?? ""),
  })),
});
const f = (n) => Object.fromEntries(n.fields.map((x) => [x.key, x.value]));
class Storage {
  constructor() {
    this.values = new Map();
  }
  getItem(k) {
    return this.values.get(k) ?? null;
  }
  setItem(k, v) {
    this.values.set(k, v);
  }
  removeItem(k) {
    this.values.delete(k);
  }
}
class Shopify {
  constructor() {
    this.types = {
      tank_board_part: [
        node("part-a", "resin", {
          code: "RESIN",
          name: "DI resin",
          unit: "L",
          on_hand: 105,
          on_water: 40,
          on_hold: 7,
          supplier: "Extrepure",
          lead_days: 10,
          unit_cost: 3,
          sort: 1,
        }),
        node("part-b", "tank", {
          code: "TANK",
          name: "Tank shells",
          unit: "each",
          on_hand: 20,
          on_water: 10,
          supplier: "Local",
          lead_days: 14,
          unit_cost: 9,
          sort: 2,
        }),
        node("part-c", "cap", {
          code: "CAP",
          name: "Caps",
          unit: "each",
          on_hand: "",
          on_water: 0,
          lead_days: 7,
          sort: 3,
        }),
      ],
      tank_board_product: [
        node("prod-a", "lite", {
          sku: "SFR-TANK-10L",
          name: "Lite tank",
          short_name: "Lite tank",
          parts: [
            { code: "RESIN", qty: 10 },
            { code: "TANK", qty: 1 },
          ],
          monthly_sales: 7,
          prev_sales: 4,
          listed: 8,
          sort: 1,
        }),
        node("prod-b", "pro", {
          sku: "SFR-TANK-15L",
          name: "Pro tank",
          short_name: "Pro tank",
          parts: [
            { code: "RESIN", qty: 15 },
            { code: "TANK", qty: 1 },
          ],
          monthly_sales: 3,
          prev_sales: 2,
          listed: 4,
          sort: 2,
        }),
        node("prod-c", "extra", {
          sku: "EXTRA",
          name: "Extra kit",
          parts: [{ code: "CAP", qty: 1 }],
          monthly_sales: 2,
          prev_sales: "",
          listed: "",
          sort: 3,
        }),
      ],
      tank_board_movement: [
        node("move-sync", "sync-1", {
          kind: "order",
          summary: "1 order taken off stock",
          at: "2026-10-21T06:51:00+10:00",
          who: "Shopify orders #300113, #301113, #302113",
          recorded_by: "Daily sync",
          changes: [{ code: "RESIN", delta: -10 }],
          orders: [300, 301, 302],
        }),
      ],
    };
    this.settings = node("settings", "main", {
      sales_window: "Last complete 30 days",
      sync: { at: "2026-10-21T06:51:00+10:00", through: "302" },
    });
    this.orders = [
      {
        id: "gid://shopify/Order/9002",
        name: "#303113",
        cancelledAt: null,
        lines: [
          { sku: "SFR-TANK-10L", currentQuantity: 2, unfulfilledQuantity: 2 },
        ],
      },
    ];
    this.writes = [];
    this.requests = [];
    this.before = null;
    this.after = null;
    this.denyOrders = false;
    this.pageSize = 250;
  }
  part(code) {
    return this.types.tank_board_part.find((p) => f(p).code === code);
  }
  value(code, key = "on_hand") {
    const v = f(this.part(code))[key];
    return v === "" ? null : Number(v);
  }
  set(code, key, value) {
    this.part(code).fields.find((x) => x.key === key).value = String(
      value ?? "",
    );
  }
  reply(data, status = 200) {
    return { ok: status < 400, status, json: async () => ({ data }) };
  }
  async fetcher(url, options) {
    if (url !== "shopify:admin/api/graphql.json")
      throw Error("Wrong API transport");
    const { query, variables: v } = JSON.parse(options.body);
    const op = /(?:query|mutation) (\w+)/.exec(query)[1];
    const request = { op, query, v };
    this.requests.push(request);
    if (this.before) {
      const response = await this.before(request);
      if (response) return response;
    }
    let data;
    if (op === "BoardObjects") {
      const type = /type: "(\w+)"/.exec(query)[1],
        start = Number(v.after || 0),
        all = this.types[type];
      const end = Math.min(start + this.pageSize, all.length);
      data = {
        metaobjects: {
          nodes: structuredClone(all.slice(start, end)),
          pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
        },
      };
    } else if (op === "BoardSettings")
      data = { settings: structuredClone(this.settings) };
    else if (op === "BoardPart")
      data = {
        metaobject: structuredClone(
          this.types.tank_board_part.find((p) => p.id === v.id),
        ),
      };
    else if (op === "BoardOrders") {
      if (this.denyOrders)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            errors: [{ message: "Access denied for orders field" }],
          }),
        };
      const nodes = this.orders
        .filter(
          (o) => !v.search.startsWith("name:") || o.name === v.search.slice(5),
        )
        .map((o) => ({
          ...o,
          lineItems: {
            nodes: o.lines,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }));
      data = {
        orders: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
      };
    } else if (op === "BoardRecord") {
      if (v.handle.type !== "tank_board_movement")
        throw Error("Wrong write type");
      const list = this.types.tank_board_movement;
      let entry = list.find((n) => n.handle === v.handle.handle);
      if (!entry) {
        entry = {
          id: "move-" + list.length,
          handle: v.handle.handle,
          fields: [],
        };
        list.unshift(entry);
      }
      entry.fields = structuredClone(v.metaobject.fields);
      this.writes.push(request);
      data = {
        result: { metaobject: { handle: entry.handle }, userErrors: [] },
      };
    } else if (op === "BoardStock") {
      const entry = this.types.tank_board_part.find((n) => n.id === v.id);
      if (!entry) throw Error("Wrong write target");
      for (const field of v.metaobject.fields) {
        if (!["on_hand", "on_water"].includes(field.key))
          throw Error("Sync-owned field write: " + field.key);
        const old = entry.fields.find((f) => f.key === field.key);
        if (old) old.value = field.value;
        else entry.fields.push({ ...field });
      }
      this.writes.push(request);
      data = {
        result: { metaobject: { handle: entry.handle }, userErrors: [] },
      };
    } else throw Error("Unexpected operation: " + op);
    if (this.after) {
      const response = await this.after(request);
      if (response) return response;
    }
    return this.reply(data);
  }
}
module.exports = { Shopify, Storage, node, f };
