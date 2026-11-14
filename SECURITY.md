# Security

## API keys

MuRaSame stores API keys through DSH credentials, not in `package.json`, source files or the project JSON. Keys are read at runtime by the Host plugin and are never returned to the client.

If you find a key accidentally committed, revoke it first, then open a private security advisory or contact the maintainer.

## Local file access

- Host routes only open folders inside the plugin output root.
- The Premiere hand-off writes FCP XML only; it does not connect to or modify a running Premiere project.
- Generated files live under `<workspace>/.creative-console/`.

## Reporting

Please use GitHub Security Advisories for sensitive reports. For non-sensitive issues, open a regular issue with reproduction steps and plugin version.
