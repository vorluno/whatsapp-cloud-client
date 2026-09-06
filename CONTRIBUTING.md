# Contributing

**This is a package we maintain and run in production. Bug fixes are welcome; features are a
conversation before they are a pull request.**

**What gets merged**

- **Bug fixes with a failing test.** The test comes first: it is what proves the bug was real and
  what stops it from coming back.
- **Documentation that corrects something wrong.** Including a wrong example — those cost the most.
- **Compatibility fixes** when Bun, the MCP SDK, or a client changes behaviour.

**What gets discussed first, in an issue**

- New tools, new options, new exports. Open an issue describing **the problem**, not the solution you
  have in mind. We may already have decided against it, and the reason will be there.

**What gets closed**

- Formatting, renaming, or restructuring with no behaviour change.
- Support requests for your own setup. This is not a support channel.

---

## Before you open a pull request

1. **Open an issue first** unless it is a small, obvious fix. Ten minutes of writing can save you an
   afternoon of code we were never going to merge.
2. **One change per pull request.** A fix bundled with a refactor is a fix nobody can review.
3. **Run the checks.** `bun test` and `bunx tsc --noEmit`. If something is red for a reason you
   believe is unrelated, say so in the description — do not silence it.

## What to expect

We answer. We do not always answer fast. See [SECURITY.md](./SECURITY.md) for the one case where a
response time is committed.

If a pull request is closed, it comes with the reason. A closed pull request without a reason is a
bug in how we work, and you are welcome to say so.

## Licence of contributions

By opening a pull request you agree that your contribution is licensed under Apache-2.0, the same as
the rest of the repository. There is no separate contributor agreement to sign — we do not want one.
