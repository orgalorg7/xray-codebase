import { LANGUAGE_NAMES, type Language } from "@xray/schema";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { formatCount, plural, timeAgo } from "./format";
import { savedTheme } from "./state";

/** A mapping job as the hosted server reports it. */
type Job = {
  id?: string;
  owner: string;
  repo: string;
  sha: string;
  ref: string;
  state: "queued" | "cloning" | "scanning" | "saving" | "done" | "failed";
  position?: number;
  bytes?: number;
  files?: number;
  error?: string;
  path: string;
};

type MapSummary = {
  owner: string;
  repo: string;
  sha: string;
  ref: string;
  files: number;
  symbols: number;
  languages: Record<string, number>;
  createdAt: number;
  path: string;
};

const EXAMPLES = ["expressjs/express", "psf/requests", "sindresorhus/ky", "pallets/flask"];

const FEATURES = [
  {
    title: "Trace calls across files",
    text: "Directions from one function to another, and call trees up and down.",
  },
  {
    title: "Dependencies and cycles",
    text: "Every import, call and inheritance link, with circular imports and where to cut them.",
  },
  {
    title: "Where a feature lives",
    text: "Describe it in plain words and fly to its territory and entry points.",
  },
  {
    title: "Blast radius",
    text: "Pick a function to see everything a change would reach, ring by ring.",
  },
];

const STEPS: { state: Job["state"]; label: string }[] = [
  { state: "queued", label: "Waiting for a free worker" },
  { state: "cloning", label: "Downloading the code" },
  { state: "scanning", label: "Mapping files, symbols and links" },
  { state: "saving", label: "Saving the map" },
];

const megabytes = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** Opens a finished map, keeping any view state in the URL hash. */
const openMap = (path: string) => window.location.assign(`${path}${window.location.hash}`);

/**
 * The hosted start page: paste a GitHub repository, watch it being mapped, land on the map.
 * With `target` (a /github/... link to a repository not mapped yet), mapping starts at once.
 */
export function Home({ target, repo }: { target?: string | undefined; repo?: string | undefined }) {
  const [input, setInput] = useState(repo ?? "");
  const [job, setJob] = useState<Job | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<MapSummary[] | undefined>();
  const socket = useRef<WebSocket | undefined>(undefined);

  useEffect(() => {
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = savedTheme() ?? (prefersDark ? "dark" : "light");
    fetch("/api/recent?limit=12")
      .then((r) => (r.ok ? (r.json() as Promise<MapSummary[]>) : []))
      .then(setRecent, () => setRecent([]));
    return () => socket.current?.close();
  }, []);

  /** Follows a job over a WebSocket, falling back to polling, until it finishes. */
  const follow = useCallback((started: Job) => {
    let finished = false;
    const update = (next: Job) => {
      setJob(next);
      if (next.state === "done") {
        finished = true;
        openMap(next.path);
      } else if (next.state === "failed") {
        finished = true;
        setBusy(false);
        setError(next.error ?? "Mapping failed.");
      }
    };
    const poll = () => {
      if (finished) return;
      fetch(`/api/jobs/${started.id}`)
        .then((r) => r.json() as Promise<Job>)
        .then(update)
        .catch(() => undefined)
        .finally(() => {
          if (!finished) setTimeout(poll, 2000);
        });
    };
    const url = new URL(`/api/jobs/${started.id}/events`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    socket.current = ws;
    ws.onmessage = (message) => update(JSON.parse(String(message.data)) as Job);
    ws.onclose = () => {
      if (!finished) poll();
    };
  }, []);

  const start = useCallback(
    async (url: string) => {
      setError(undefined);
      setJob(undefined);
      setBusy(true);
      try {
        const response = await fetch("/api/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const body = (await response.json()) as Job & { error?: string };
        if (body.state === "done") return openMap(body.path);
        if (!response.ok && !body.id) {
          setBusy(false);
          setError(body.error ?? `The server answered ${response.status}.`);
          if (body.state === "failed") setJob(body);
          return;
        }
        setJob(body);
        follow(body);
      } catch {
        setBusy(false);
        setError("xray could not be reached. Check your connection and try again.");
      }
    },
    [follow],
  );

  // Visiting /github/<owner>/<repo> for a repository not mapped yet maps it right away.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (target && !autoStarted.current) {
      autoStarted.current = true;
      void start(target);
    }
  }, [target, start]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (input.trim()) void start(input.trim());
  };

  return (
    <div className="home">
      <header className="home-top">
        <a className="home-brand" href="/">
          <span className="logo" aria-hidden="true" />
          xray
        </a>
        <span className="home-tagline">Google Maps for codebases</span>
      </header>

      <main className="home-main">
        <section className="hero">
          <h1>X-ray vision for any codebase</h1>
          <p className="lead">
            Paste a public GitHub repository and get an interactive map of its architecture: every
            file, class and function, what calls what, circular imports, and the blast radius of a
            change.
          </p>
          <form className="repo-form" onSubmit={submit}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="github.com/owner/repository"
              aria-label="GitHub repository"
              spellCheck={false}
              autoComplete="off"
              // biome-ignore lint/a11y/noAutofocus: the page exists to take this one input
              autoFocus={!target}
            />
            <button type="submit" disabled={busy || !input.trim()}>
              {busy ? "Mapping…" : "Map it"}
            </button>
          </form>
          <p className="examples">
            Try{" "}
            {EXAMPLES.map((example, i) => (
              <span key={example}>
                {i > 0 && " · "}
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => {
                    setInput(example);
                    void start(example);
                  }}
                >
                  {example}
                </button>
              </span>
            ))}
          </p>
          <p className="hint">
            Tip: in any GitHub link, replace <code>github.com</code> with{" "}
            <code>{window.location.host}/github.com</code>.
          </p>
        </section>

        {(job || error) && <Progress job={job} error={error} />}

        <section className="features" aria-label="What xray shows">
          {FEATURES.map((f) => (
            <div key={f.title} className="feature">
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </div>
          ))}
        </section>

        {recent && recent.length > 0 && (
          <section className="recent">
            <h2>Recently mapped</h2>
            <ul>
              {recent.map((m) => (
                <li key={m.path}>
                  <a href={m.path}>
                    <span className="recent-name">
                      {m.owner}/<strong>{m.repo}</strong>
                    </span>
                    <span className="recent-meta">
                      {formatCount(m.files)} files · {formatCount(m.symbols)} symbols
                    </span>
                    <span className="recent-meta">
                      {Object.keys(m.languages)
                        .map((l) => LANGUAGE_NAMES[l as Language] ?? l)
                        .join(", ")}{" "}
                      · {m.ref === m.sha ? m.sha.slice(0, 7) : m.ref} ·{" "}
                      {timeAgo(new Date(m.createdAt).toISOString())}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="home-footer">
        Static analysis only: nothing in a repository is ever run. Also as a command line tool (
        <code>npx xray-codebase open</code>) and a VS Code extension.
      </footer>
    </div>
  );
}

function Progress({ job, error }: { job?: Job | undefined; error?: string | undefined }) {
  const current = job ? STEPS.findIndex((s) => s.state === job.state) : -1;
  const failed = job?.state === "failed" || (!job && error);
  return (
    <section className={failed ? "progress failed" : "progress"} aria-live="polite">
      {job && (
        <h2>
          {job.owner}/{job.repo}
          <span className="progress-ref">
            {job.ref === job.sha ? job.sha.slice(0, 7) : `${job.ref} @ ${job.sha.slice(0, 7)}`}
          </span>
        </h2>
      )}
      {job && job.state !== "failed" && (
        <ol className="steps">
          {STEPS.map((step, i) => (
            <li
              key={step.state}
              className={i < current ? "done" : i === current ? "active" : undefined}
              aria-current={i === current ? "step" : undefined}
            >
              {step.label}
              {i === current && step.state === "queued" && job.position !== undefined && (
                <span className="step-detail">
                  {job.position === 0 ? "next up" : `${plural(job.position, "map")} ahead`}
                </span>
              )}
              {i === current && step.state === "cloning" && job.bytes !== undefined && (
                <span className="step-detail">{megabytes(job.bytes)}</span>
              )}
              {i <= current && step.state === "saving" && job.files !== undefined && (
                <span className="step-detail">{plural(job.files, "file")}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p className="progress-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
