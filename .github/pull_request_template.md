## Summary

<!-- What changed and why -- a sentence or two is fine for small PRs. -->

## Test plan

<!-- How this was verified: tests run, screenshots, commands executed. -->

## Review checklist

- [ ] If this touches `infra/**`, the **CDK Infrastructure Diff** comment posted by `cdk-diff.yml` below has been reviewed — confirm the proposed AWS changes match what's described above before merging.
- [ ] No secrets, API keys, or PII committed (check `git diff` output, not just the changed files list).
- [ ] `task.md` updated if this closes, changes, or surfaces a follow-up to a tracked item.
- [ ] For security-relevant changes (auth, IAM, guardrails): the specific requirement being satisfied is called out explicitly, not just "looks fine."
