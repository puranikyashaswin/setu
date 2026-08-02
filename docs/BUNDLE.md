# Web bundle budget

Track Next.js client JS size after `cd web && npm run build`.

| Signal | Soft budget |
|--------|-------------|
| First Load JS (shared) | alert if it jumps >15% vs previous main build |
| Largest page chunk (`/`) | prefer staying under ~350 kB gzipped where practical |

Optional local analysis:

```bash
cd web
ANALYZE=1 npx next experimental-analyze
# or install @next/bundle-analyzer when you want a treemap
```

Fail CI only after a measured baseline is recorded for two consecutive releases.
