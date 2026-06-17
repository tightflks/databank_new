declare module 'better-sqlite3' {
  interface Database {
    pragma(source: string, options?: any): any;
    exec(source: string): void;
    prepare(source: string): Statement;
    transaction(fn: (...args: any[]) => any): (...args: any[]) => any;
    close(): void;
  }

  interface Statement {
    run(...params: any[]): RunResult;
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }

  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: any): Database;
    (filename: string, options?: any): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
