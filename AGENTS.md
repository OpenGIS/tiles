# Repository conventions

Read [README.md](README.md) and [docs/README.md](docs/README.md) first.

## Stack

- Node.js 24, ESM and plain JavaScript.
- Use British English in code, comments, tests and documentation.
- Prefer Node built-ins in the serving path. Do not add a web framework.

## Configuration

Layer configuration lives in `config/layers.json` and is validated at startup.

## Testing

- Tests use Vitest for unit and integration coverage, and Playwright for the browser smoke test.
- Run `npm test`, `npm run test:e2e` and `npm run format:check` before declaring a change complete.
- Playwright starts its own tile server and Vite instance unless servers are already listening on the
  configured ports; CI never reuses them.

## Development harness

- `npm run dev` starts the tile server and the Vite harness together.
- `npm run dev:server` starts only the tile server on `127.0.0.1:11010`.
- `npm run dev:harness` starts only Vite on `127.0.0.1:11011`.

## Ports

The tile server uses `11010` and the harness uses `11011`. Do not bind ports `5174` or `11000`. For
any other service, choose a free port in the 11001–11999 range and check it with
`lsof -nP -iTCP:<port> -sTCP:LISTEN` before starting. Never stop or kill a process you did not
start.

## Temporary artefacts

Do not commit temporary artefacts. Use the gitignored `tmp/` directory in the project root.

## Project files

Do not write personal names or operational context into project files.

## Git

Do not run git write commands. The repository owner stages and commits manually.

## Verification

Run `npm test`, `npm run test:e2e` and `npm run format:check`.
