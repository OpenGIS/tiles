# Repository conventions

Read [README.md](README.md) and [docs/README.md](docs/README.md) first.

## Stack

- Node.js 24, ESM and plain JavaScript.
- Use British English in code, comments, tests and documentation.
- Prefer Node built-ins in the serving path. Do not add a web framework.

## Configuration

Layer configuration will live in `config/layers.json` once the serving core lands.

## Testing

- Tests use Vitest.
- Vite, MapLibre and Playwright arrive with the development harness.

## Ports

Do not bind ports 5174 or 11000. Choose a free port in the 11001–11999 range and check it with
`lsof -nP -iTCP:<port> -sTCP:LISTEN` before starting. Never stop or kill a process you did not
start.

## Temporary artefacts

Do not commit temporary artefacts. Use the session's ignored scratch directory.

## Project files

Do not write personal names or session context into project files.

## Git

Do not run git write commands. The repository owner stages and commits manually.

## Verification

Run `npm test` and `npm run format:check`.
