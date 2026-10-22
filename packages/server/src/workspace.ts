import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { gitHead, gitHistory } from "@xray/analysis/git";
import { Engine, type ScanReport, type Watcher } from "@xray/engine";
import { type Snapshot, XrayService } from "@xray/service";
import { GraphStore } from "@xray/store";

export type WorkspaceOptions = {
  root: string;
  /** Where the index lives. Default `<root>/.xray/index.db`; `":memory:"` keeps it in memory. */
  indexPath?: string;
  ignore?: readonly string[];
  /** Read git history for churn and co-change (default true). */
  git?: boolean;
};

export type WorkspaceEvents = {
  scanning: [];
  scanned: [ScanReport];
  error: [unknown];
};

/**
 * One repository kept in sync: its index, engine, git history and the service answering
 * questions about the latest scan. Emits `scanning`, `scanned` and `error`.
 */
export class Workspace extends EventEmitter<WorkspaceEvents> {
  readonly root: string;
  readonly store: GraphStore;
  readonly #engine: Engine;
  readonly #useGit: boolean;
  #service: XrayService | undefined;
  #git: Snapshot["git"];
  #gitHead: string | undefined;
  #watcher: Watcher | undefined;
  #lastReport: ScanReport | undefined;
  #firstScan: Promise<void> | undefined;

  constructor(options: WorkspaceOptions) {
    super();
    this.root = resolve(options.root);
    const indexPath = options.indexPath ?? join(this.root, ".xray", "index.db");
    if (indexPath !== ":memory:") mkdirSync(dirname(indexPath), { recursive: true });
    this.store = GraphStore.open(indexPath);
    this.#engine = new Engine({
      root: this.root,
      store: this.store,
      ...(options.ignore ? { ignore: options.ignore } : {}),
    });
    this.#useGit = options.git ?? true;
  }

  get lastReport(): ScanReport | undefined {
    return this.#lastReport;
  }

  /** The service for the latest scan. Scans first if nothing was scanned yet. */
  async service(): Promise<XrayService> {
    if (!this.#service) {
      this.#firstScan ??= this.scan().then(() => undefined);
      await this.#firstScan;
    }
    return this.#service as XrayService;
  }

  async scan(options: { force?: boolean } = {}): Promise<ScanReport> {
    this.emit("scanning");
    const report = await this.#engine.scan(options);
    this.#refreshGit();
    this.#service = new XrayService(this.#snapshot(report));
    this.#lastReport = report;
    this.emit("scanned", report);
    return report;
  }

  /** Rescans on file changes, emitting events for each scan. */
  watch(): void {
    if (this.#watcher) return;
    this.#watcher = this.#engine.watch(
      (report) => {
        this.#refreshGit();
        this.#service = new XrayService(this.#snapshot(report));
        this.#lastReport = report;
        this.emit("scanned", report);
      },
      (error) => this.emit("error", error),
    );
  }

  close(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    this.store.close();
  }

  #refreshGit(): void {
    if (!this.#useGit) return;
    const head = gitHead(this.root);
    if (head === this.#gitHead && this.#git) return;
    this.#gitHead = head;
    if (head === undefined) {
      this.#git = undefined;
      return;
    }
    const history = gitHistory(this.root);
    this.#git = {
      commits: history.commits,
      files: Object.fromEntries(history.files),
      coChange: history.coChange,
    };
  }

  #snapshot(report: ScanReport): Snapshot {
    const root = this.root;
    const snapshot: Snapshot = {
      name: basename(root),
      root,
      graph: this.store.exportGraph(root),
      scannedAt: new Date().toISOString(),
      diagnostics: report.diagnostics,
      // Read lazily; the service only asks for files that are modules of the graph.
      sources: (path) => {
        const absolute = resolve(root, path);
        if (!absolute.startsWith(root + sep)) return undefined;
        try {
          return readFileSync(absolute, "utf8");
        } catch {
          return undefined;
        }
      },
    };
    if (this.#git) snapshot.git = this.#git;
    return snapshot;
  }
}
