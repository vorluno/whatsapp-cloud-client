<!-- A pull request without the first two sections costs a round trip nobody wanted to make. -->

**What changes, and why**

<!-- The problem first. If there is an issue, link it: `Fixes #123`. -->

**How it was checked**

<!-- The test that goes red without this change, or the steps to see it by hand. -->

---

- [ ] One change. A fix bundled with a reorganisation is a fix nobody can review
- [ ] `bun test` and `bunx tsc --noEmit` are green — and if something is red for an unrelated reason, said above
- [ ] If the behaviour changed, the documentation says the new thing
