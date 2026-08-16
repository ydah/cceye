declare module "better-sqlite3" {
  namespace Database {
    interface Statement {
      get(...parameters: unknown[]): unknown;
      all(...parameters: unknown[]): unknown[];
      run(...parameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    }

    interface Database {
      defaultSafeIntegers(toggle?: boolean): void;
      pragma(source: string, options?: { simple?: boolean }): unknown;
      exec(source: string): void;
      prepare(source: string): Statement;
      transaction<T>(fn: () => T): () => T;
      backup(filename: string): Promise<unknown>;
      close(): void;
    }
  }

  const Database: {
    new (filename: string, options?: { readonly?: boolean }): Database.Database;
  };
  export = Database;
}
