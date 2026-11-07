/** Diagnostic-only span counter; no production imports or budget enforcement. */
export class QueryCount3638 {
  private active = false;
  private queries: string[] = [];
  begin() { if (this.active) throw new Error('overlapping diagnostic span'); this.active = true; this.queries = []; }
  record(query: string) { if (this.active) this.queries.push(query); }
  end() { if (!this.active) throw new Error('no diagnostic span'); this.active = false; const tables: Record<string, number> = {};
    for (const sql of this.queries) {
      const names = new Set([...sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:"public"\.)?"([a-z_]+)"/gi)].map(m => m[1]));
      for (const name of names) tables[name] = (tables[name] ?? 0) + 1;
    }
    return { sqlCount: this.queries.length, tables };
 }
}
