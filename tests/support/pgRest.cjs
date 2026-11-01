// A minimal supabase-js style query builder (from().select/eq/gte/lte/
// order/range/limit/insert/delete, count with head) that runs REAL SQL on a PostgreSQL database
// (PGlite in the tests). Like Supabase's PostgREST it returns at most
// `maxRows` rows per request (Supabase's default max-rows is 1000), so
// code that must page past that limit is actually exercised, and real
// Postgres errors (constraint, foreign key, trigger) come back as
// { error: { message, code } } exactly where the app checks for them.
function pgRest(pg, { maxRows = 1000 } = {}) {
  const ident = (s) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsupported identifier: ${s}`);
    return `"${s}"`;
  };
  const normalize = (row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v;
    return out;
  };

  return (table) => {
    const ops = { cols: "*", filters: [], orders: [], range: null, limit: null, insert: null, del: false, head: false };
    const run = async () => {
      const params = [];
      const p = (v) => {
        params.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v);
        return `$${params.length}`;
      };
      try {
        const where = ops.filters.length
          ? ` where ${ops.filters.map(([op, c, v]) => (op === "eq" ? `${ident(c)} = ${p(v)}` : op === "gte" ? `${ident(c)} >= ${p(v)}` : op === "lte" ? `${ident(c)} <= ${p(v)}` : `${ident(c)} is null`)).join(" and ")}`
          : "";
        const target = `public.${ident(table)}`;
        if (ops.insert) {
          const list = Array.isArray(ops.insert) ? ops.insert : [ops.insert];
          if (list.length === 0) return { data: null, error: null };
          const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
          const values = list.map((r) => `(${cols.map((c) => (r[c] === undefined ? "default" : p(r[c]))).join(", ")})`).join(", ");
          await pg.query(`insert into ${target} (${cols.map(ident).join(", ")}) values ${values}`, params);
          return { data: null, error: null };
        }
        if (ops.del) {
          await pg.query(`delete from ${target}${where}`, params);
          return { data: null, error: null };
        }
        if (ops.head) {
          const res = await pg.query(`select count(*)::int as n from ${target}${where}`, params);
          return { data: null, count: res.rows[0].n, error: null };
        }
        const cols = ops.cols === "*" ? "*" : ops.cols.split(",").map((c) => ident(c.trim())).join(", ");
        const order = ops.orders.length ? ` order by ${ops.orders.map(([c, asc]) => `${ident(c)} ${asc ? "asc" : "desc"}`).join(", ")}` : "";
        let offset = 0;
        let limit = maxRows;
        if (ops.range) {
          offset = ops.range[0];
          limit = Math.min(maxRows, ops.range[1] - ops.range[0] + 1);
        }
        if (ops.limit !== null) limit = Math.min(limit, ops.limit);
        const res = await pg.query(`select ${cols} from ${target}${where}${order} limit ${limit} offset ${offset}`, params);
        return { data: res.rows.map(normalize), error: null };
      } catch (err) {
        return { data: null, error: { message: err.message, code: err.code } };
      }
    };
    const b = {
      select: (cols = "*", opts) => ((ops.cols = cols), (ops.head = !!opts?.head), b),
      eq: (c, v) => (ops.filters.push(["eq", c, v]), b),
      is: (c) => (ops.filters.push(["is", c, null]), b),
      gte: (c, v) => (ops.filters.push(["gte", c, v]), b),
      lte: (c, v) => (ops.filters.push(["lte", c, v]), b),
      order: (c, o) => (ops.orders.push([c, o?.ascending !== false]), b),
      range: (from, to) => ((ops.range = [from, to]), b),
      limit: (n) => ((ops.limit = n), b),
      insert: (v) => ((ops.insert = v), b),
      delete: () => ((ops.del = true), b),
      then: (resolve, reject) => run().then(resolve, reject),
    };
    return b;
  };
}

module.exports = { pgRest };
