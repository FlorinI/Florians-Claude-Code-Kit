# Contributing

Thanks for taking a look. This is a personal tool I built for my own daily use with
[Claude Code](https://claude.com/claude-code) and share in case it's useful to you.
A few honest expectations up front:

- **It's maintained best-effort, in spare time.** I don't promise a response time on
  issues or pull requests. I might reply in a day, in a month, or not at all — please
  don't read silence as rejection.
- **Issues and PRs are welcome.** Bug reports (especially cross-platform breakage),
  small fixes, and clear improvements are the most likely to get merged.
- **Scope is "what the author actually runs."** The status line encodes my own
  cost/context workflow. Features that don't fit that workflow may be declined — not
  because they're bad, but because every line I merge is a line I maintain. If you
  want something niche, a fork is a perfectly legitimate answer (it's MIT).

## How changes get in

This repo uses the standard GitHub fork-and-pull-request flow. **Nobody pushes
directly to `main`** — not even occasional collaborators. The flow is:

1. Fork the repo to your own account.
2. Create a branch and make your change.
3. Run the tests (below) and make sure they pass.
4. Open a pull request describing *what* changed and *why*.
5. I review when I get to it, ask for changes if needed, and merge.

That's how a public repo stays orderly: the maintainer is the only one who can merge,
so nothing lands without review.

## Before you open a PR

- Keep it focused — one logical change per PR. Small PRs get reviewed; sprawling ones
  stall.
- Run the test suite:

  ```sh
  npm test          # unit + install smoke tests
  npm run parity    # status-line + handover rendering goldens
  ```

- The parity goldens assert the rendered status line byte-for-byte. If your change
  *intentionally* alters the output, re-bless with `npm run parity -- --bless` and
  **say so in the PR**, with a sentence on why the new output is correct. A silent
  golden change will get bounced.
- Match the surrounding style, and add no dependencies — the kit is deliberately
  zero-dependency, pure Node.

## Reporting bugs

Open an issue with: your OS, Node version (`node --version`), what you ran, what you
expected, and what happened. A copy of the rendered line or a screenshot helps a lot.

## Security

Please don't file security problems as public issues — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the MIT License,
the same as the rest of the project.
