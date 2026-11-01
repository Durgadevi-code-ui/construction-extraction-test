// In-memory stand-in for the Supabase client (tables + storage) used by
// the import tests. `faults.failInsert` makes inserts into that table fail;
// `faults.storageFails` makes every upload fail. `routes` sends whole
// tables to another client instead (e.g. tests/support/pgRest.cjs, which
// runs them on a real PostgreSQL).
function fakeSupabase(faults = {}, routes = {}) {
  const tables = { users: [], work_items: [], departments: [], standard_departments: [], admin_delegations: [], user_project_roles: [] };
  const files = new Map(); // storage path -> Uint8Array
  let seq = 0;
  const pk = { work_items: "work_item_id", departments: "department_id", users: "user_id" };

  function query(table) {
    const ops = { filters: [], orders: [], range: null, limit: null, insert: null, update: null, del: false, head: false, single: null };
    const rowsOf = () => tables[table] ?? (tables[table] = []);
    const matches = (r) =>
      ops.filters.every(([op, col, v]) =>
        op === "eq" ? r[col] === v : op === "gte" ? r[col] >= v : op === "lte" ? r[col] <= v : op === "is" ? (r[col] ?? null) === v : op === "like" ? String(r[col] ?? "").startsWith(v.replace(/%$/, "")) : true
      );
    const run = () => {
      if (ops.insert) {
        if (faults.failInsert === table) return { data: null, error: { message: `simulated ${table} insert failure` } };
        const list = (Array.isArray(ops.insert) ? ops.insert : [ops.insert]).map((v) => ({
          ...(pk[table] ? { [pk[table]]: `${table}-${++seq}` } : {}),
          created_at: new Date(Date.now() + seq).toISOString(),
          ...structuredClone(v),
        }));
        rowsOf().push(...list);
        return { data: list, error: null };
      }
      let hit = rowsOf().filter(matches);
      if (ops.update) {
        hit.forEach((r) => Object.assign(r, structuredClone(ops.update)));
        return { data: hit, error: null };
      }
      if (ops.del) {
        tables[table] = rowsOf().filter((r) => !matches(r));
        return { data: hit, error: null };
      }
      if (ops.head) return { data: null, count: hit.length, error: null };
      if (ops.orders.length) {
        const cmp = (x, y) => (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y)));
        hit = [...hit].sort((a, b) => {
          for (const [c, asc] of ops.orders) {
            const d = cmp(a[c], b[c]);
            if (d) return asc ? d : -d;
          }
          return 0;
        });
      }
      if (ops.range) hit = hit.slice(ops.range[0], ops.range[1] + 1);
      if (ops.limit !== null) hit = hit.slice(0, ops.limit);
      return { data: structuredClone(hit), error: null };
    };
    const finish = () => {
      const r = run();
      if (ops.single === "single") return { data: r.data?.[0] ?? null, error: r.data?.[0] ? null : { message: "0 rows" } };
      if (ops.single === "maybe") return { data: r.data?.[0] ?? null, error: null };
      return r;
    };
    const b = {
      select: (_cols, opts) => ((ops.head = !!opts?.head), b),
      eq: (c, v) => (ops.filters.push(["eq", c, v]), b),
      is: (c, v) => (ops.filters.push(["is", c, v]), b),
      gte: (c, v) => (ops.filters.push(["gte", c, v]), b),
      lte: (c, v) => (ops.filters.push(["lte", c, v]), b),
      like: (c, v) => (ops.filters.push(["like", c, v]), b),
      in: (c, vs) => (ops.filters.push(["in", c, vs]), b),
      order: (c, o) => (ops.orders.push([c, o?.ascending !== false]), b),
      range: (from, to) => ((ops.range = [from, to]), b),
      limit: (n) => ((ops.limit = n), b),
      insert: (v) => ((ops.insert = v), b),
      update: (v) => ((ops.update = v), b),
      delete: () => ((ops.del = true), b),
      single: async () => ((ops.single = "single"), finish()),
      maybeSingle: async () => ((ops.single = "maybe"), finish()),
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    };
    return b;
  }

  const storage = {
    from: () => ({
      upload: async (p, bytes) => {
        if (faults.storageFails) return { error: { message: "simulated storage outage" } };
        if (files.has(p)) return { error: { message: "exists" } };
        files.set(p, new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.buffer ?? bytes));
        return { error: null };
      },
      list: async (folder) => ({
        data: [...files.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/")).map((p) => ({ name: p.slice(folder.length + 1) })),
        error: null,
      }),
      download: async (p) => (files.has(p) ? { data: new Blob([files.get(p)]), error: null } : { data: null, error: { message: "not found" } }),
      remove: async (paths) => (paths.forEach((p) => files.delete(p)), { error: null }),
    }),
  };
  return { from: (table) => (routes[table] ? routes[table](table) : query(table)), storage, rpc: async () => ({ data: null, error: { message: "no rpc" } }), tables, files };
}

module.exports = { fakeSupabase };
