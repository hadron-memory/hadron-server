/** Diagnostic-only span counter; intentionally incomplete red-first checkpoint. */
export class QueryCount3638 {
  private active = false;
  private queries: string[] = [];
  begin() { if (this.active) throw new Error('overlapping diagnostic span'); this.active = true; this.queries = []; }
  record(_query: string) { /* red checkpoint: listener drops events */ }
  end() { if (!this.active) throw new Error('no diagnostic span'); this.active = false; return { sqlCount: this.queries.length, tables: {} as Record<string, number> }; }
}
