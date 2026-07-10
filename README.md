# vibesense-games

The official installable games for [VibeSense](https://github.com/stephenleo/vibesense) — play retro games with your controller while Claude Code works.

Each directory under `games/` is a standalone npm package (`@vibesense/game-<id>`) with no build step: a `package.json`, the [VibeSense manifest](https://github.com/stephenleo/vibesense/blob/main/docs/plugin-contract.md) (`vibesense-game.json`), an `index.html` entry page, and the game code.

## Installing a game

```sh
vibesense install <id>        # e.g. vibesense install glider
```

The CLI resolves `<id>` to `@vibesense/game-<id>` on the public npm registry — see the full catalog at [vibesense.dev](https://vibesense.dev).

## Building your own game

Start from [vibesense-game-template](https://github.com/stephenleo/vibesense-game-template) ("Use this template"), then follow the [building-a-game tutorial](https://github.com/stephenleo/vibesense/blob/main/docs/building-a-game.md). Publish under your own npm scope (e.g. `@you/my-game`) — users install it by its full npm name.

Every game in this repo is a working reference implementation you can read and borrow from (Apache-2.0).

## Publishing (maintainers)

Run the `publish-games` workflow (`workflow_dispatch`). It publishes any `games/*/package.json` whose `name@version` isn't already on the registry and skips the rest, so it's safe to re-run.

## License

Apache-2.0
