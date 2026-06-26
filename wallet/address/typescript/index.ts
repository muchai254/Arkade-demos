import {
  MnemonicIdentity,
  RestArkProvider,
  RestDelegateProvider,
  Wallet,
} from "@arkade-os/sdk";
import {
  type SQLExecutor,
  SQLiteContractRepository,
  SQLiteWalletRepository,
} from "@arkade-os/sdk/repositories/sqlite";
import Database from "better-sqlite3";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const DELEGATE_URL = "https://delegate.arkade.money" as const;

/** 1. Create SQL executor */
const createSQLExecutor = (dbPath: string): SQLExecutor => {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return {
    run: async (sql, params) => {
      db.prepare(sql).run(...(params ?? []));
    },
    get: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...(params ?? [])) as T | undefined,
    all: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...(params ?? [])) as T[],
  };
};
const executor = createSQLExecutor("wallet.sqlite");

/** 2. Create identity */
const identity = MnemonicIdentity.fromMnemonic(SEED_PHRASE);

/** 3. Create wallet */
const wallet = await Wallet.create({
  identity,
  arkProvider: new RestArkProvider(),
  delegateProvider: new RestDelegateProvider(DELEGATE_URL),
  /**
   * Explicitly disable settlement
   * Recommended to leave undefined for production
   */
  settlementConfig: false,
  /**
   * Explicitly disable address rotation
   * Recommended to use 'hd' for production
   */
  walletMode: "static",
  /**
   * Explicitly use SQLite storage
   * Defaults to IndexedDB if undefined
   */
  storage: {
    walletRepository: new SQLiteWalletRepository(executor),
    contractRepository: new SQLiteContractRepository(executor),
  },
});

/** 4. Log wallet address */
console.log({
  address: await wallet.getAddress(),
});
