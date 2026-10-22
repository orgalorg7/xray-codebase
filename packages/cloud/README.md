# Hosted xray

Paste a public GitHub repository and get its interactive architecture map at a permanent link.
This is the same engine and map UI as `xray open`, run as a web service.

- `/` is the start page. People paste `owner/repo` or any GitHub link (branch, tag, commit,
  file), watch it being mapped, and land on the map.
- `/github/<owner>/<repo>/<sha>` is a map. It never changes, so it can be shared as is, and the
  map's own URL state (selection, mode, search) follows `#`.
- `/github/<owner>/<repo>` maps the default branch's latest commit, then opens it.
  `/github/<owner>/<repo>/tree/<branch-or-tag>` does the same for a branch or tag.
- `/github.com/<anything>` redirects to `/github/<anything>`, so replacing `github.com` with this
  site's address in any GitHub link maps it.

Map pages carry Open Graph tags, so shared links preview as "Interactive map of owner/repo:
1,234 files…". Files in a map link to GitHub at the mapped commit.

## Run it

From the repository root:

```sh
docker compose -f packages/cloud/compose.yaml up --build
# or
docker build -f packages/cloud/Dockerfile -t xray-cloud .
docker run -p 8080:8080 -v xray-data:/data --read-only --tmpfs /tmp --cap-drop ALL xray-cloud
```

Without Docker: `pnpm install && pnpm build`, then `node packages/cloud/dist/main.js` (it needs
`git` on the PATH and Node 24).

Put it behind a TLS-terminating proxy, set `XRAY_PUBLIC_URL`, and set `XRAY_TRUST_PROXY=true`
if the proxy sets `X-Forwarded-For`, so limits apply per visitor rather than to the proxy.
Responses for a commit's map are cacheable for an hour, so a CDN in front helps popular maps.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Where to listen |
| `XRAY_PUBLIC_URL` | | Public address, for link previews |
| `XRAY_DATA_DIR` | `./data` (`/data` in the image) | Results database and checkouts in progress |
| `XRAY_TRUST_PROXY` | `false` | Read client addresses from `X-Forwarded-For` |
| `XRAY_CONCURRENCY` | `2` | Repositories mapped at once |
| `XRAY_MAX_QUEUED` | `50` | Waiting jobs before new ones are refused (503) |
| `XRAY_MAX_JOBS_PER_CLIENT` | `3` | Unfinished jobs per visitor |
| `XRAY_JOB_TIMEOUT_SECONDS` | `600` | A job taking longer fails |
| `XRAY_WORKER_HEAP_MB` | `4096` | Memory limit of each mapping process |
| `XRAY_MAX_REPO_MB` | `500` | Download limit per repository |
| `XRAY_MAX_FILES` | `25000` | Source file limit per repository |
| `XRAY_HISTORY_DEPTH` | `0` | Commits of history to fetch for the churn and co-change layers |
| `XRAY_MAX_STORAGE_MB` | `10000` | Stored maps beyond this are deleted, least recently viewed first |
| `XRAY_CACHED_MAPS` | `12` | Maps kept loaded in memory |
| `XRAY_FAILURE_CACHE_SECONDS` | `600` | A commit that failed fails fast for this long |
| `XRAY_REF_CACHE_SECONDS` | `60` | A branch's latest commit is reused for this long |
| `XRAY_SUBMITS_PER_HOUR` | `30` | New maps per visitor per hour (opening existing maps is free) |
| `XRAY_LOOKUPS_PER_MINUTE` | `30` | Repository lookups per visitor per minute |
| `XRAY_REQUESTS_PER_MINUTE` | `1200` | API requests per visitor per minute |
| `XRAY_GIT_REMOTE` | `https://github.com/{owner}/{repo}.git` | Clone URL template |
| `XRAY_GIT_PROTOCOLS` | `https` | Protocols git may use |

## API

| Request | Answer |
| --- | --- |
| `POST /api/jobs` `{"url": "owner/repo"}` | 200 with `state: "done"` and `path` if mapped; 202 with a job (`id`, `state`, `position`); 400/404 with `error`; 422 if it recently failed; 429/503 when limited |
| `GET /api/jobs/:id` | The job: `queued`, `cloning` (with `bytes`), `scanning`, `saving`, `done` or `failed` (with `error`) |
| `GET /api/jobs/:id/events` | WebSocket: the job on every change, closed when it finishes |
| `GET /api/maps/:owner/:repo/:sha/…` | The map API (`meta`, `map`, `node`, `source`, `search`, `impact`, `trace`, `tree`, `cycles`, `insights`, `dsm`, `roads`, `resolve`), the same as `xray open` serves |
| `GET /api/recent` | Recently mapped repositories |
| `GET /api/health` | Status, running and queued jobs, stored maps |

## How it keeps repositories contained

Mapping is static: xray reads files and never runs anything from a repository. It doesn't run
install scripts, build steps, git hooks or filters. On top of that:

- **Fetching:** one commit, shallow, with no tags, submodules or LFS. Symbolic links are checked
  out as plain files, so nothing can point outside the checkout. Hooks and fsmonitor are off,
  and git runs with no user or system config, no credential prompts and only the allowed
  protocols. Downloads stop at the size limit.
- **Mapping:** each job runs in its own process with a heap limit and a timeout. Its environment
  contains none of the server's variables (no tokens). The process is killed when the job is
  cancelled or times out, and its checkout is deleted either way.
- **Serving:** maps are read-only data. Pages send a strict Content Security Policy (scripts
  only from the site itself, no framing). Every value taken from a URL is escaped.
- **Abuse:** per-visitor limits on new maps, lookups and API requests, a bounded queue, failure
  caching, and storage pruning.
- **The container:** a non-root user, a read-only filesystem except `/data` and `/tmp`, no
  Linux capabilities, `no-new-privileges`, and memory, CPU and process limits (see
  [compose.yaml](compose.yaml)).

Private repositories need a GitHub App with per-installation tokens. That is not built yet.
