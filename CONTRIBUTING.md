# Contributing

Thanks for trying MuRaSame.

1. Fork the repository and create a branch.
2. Keep changes focused; update `CHANGELOG.md` for user-visible behavior.
3. Run the static checks before opening a PR:

```bash
npm test
```

4. To run the HTTP smoke test, start DSH and set `DSH_CREATIVE_URL`:

```bash
DSH_CREATIVE_URL=http://127.0.0.1:49670/api-ext/creative-console npm run test:smoke
```

Please do not commit API keys, generated media, `bin/realesrgan/models/`, or `.creative-console/` output.
