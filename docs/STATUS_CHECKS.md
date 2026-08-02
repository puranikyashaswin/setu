# Required GitHub checks

Protect `main` so pull requests cannot merge until these CI jobs pass:

| Check | Job | What it covers |
|-------|-----|----------------|
| `CI / api` | api | Python unit tests + persistence smoke |
| `CI / web` | web | typecheck, unit tests, eslint, Next build |
| `CI / secrets` | secrets | rejects tracked `.env` / `.env.local` |
| `CI / e2e` | e2e | Playwright Voice Health smoke |

Also enable: require PR before merge, require branches up to date, and restrict direct pushes if the team agrees.

The scheduled **Keep API warm** workflow is ops monitoring, not a required PR check. It needs repository variable `API_URL` (Render base URL).
