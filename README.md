# Dependent Issues

> A GitHub Action for marking issues as dependent on another

This is a fork of the archived [z0al/dependent-issues](https://github.com/z0al/dependent-issues), adapted for use in [leanprover-community](https://github.com/leanprover-community) repositories. It is not intended for general use.

It works with PRs and issues and supports cross-repository dependencies.

## Usage

Create `.github/workflows/dependent-issues.yml` with the following content:

```yaml
name: Dependent Issues

on:
  issues:
    types:
      - opened
      - edited
      - closed
      - reopened
  pull_request_target:
    types:
      - opened
      - edited
      - closed
      - reopened
      # Makes sure we always add status check for PRs. Useful only if
      # this action is required to pass before merging. Otherwise, it
      # can be removed.
      - synchronize

  # Schedule a daily check. Useful if you reference cross-repository
  # issues or pull requests. Otherwise, it can be removed.
  schedule:
    - cron: '0 0 * * *'

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: leanprover-community/dependent-issues@<commit-sha>
        env:
          # (Required) The token to use to make API calls to GitHub.
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # (Optional) The token to use to make API calls to GitHub for remote repos.
          GITHUB_READ_TOKEN: ${{ secrets.GITHUB_READ_TOKEN }}

        with:
          # (Optional) The label to use to mark dependent issues
          label: dependent

          # (Optional) Enable checking for dependencies in issues.
          # Enable by setting the value to "on". Default "off"
          check_issues: off

          # (Optional) Ignore dependabot PRs.
          # Enable by setting the value to "on". Default "off"
          ignore_dependabot: off

          # (Optional) Set a commit status on PRs.
          # Disable by setting the value to "off". Default "on"
          commit_status: on

          # (Optional) Log the changes that would be made without
          # making them. Enable by setting the value to "on". Default "off"
          dry_run: off

          # (Optional) A comma-separated list of keywords. Default
          # "depends on, blocked by"
          keywords: depends on, blocked by

          # (Optional) A custom comment body. See below for the supported tokens.
          comment: >
            This PR/issue depends on:

            {{ dependencies }}

            By **[Dependent Issues](https://github.com/z0al/dependent-issues)** (🤖). Happy coding!
```

Here how it can look like in practice:

![example](./demo.png)

## Inputs

- **label** (Optional): The label to use to mark dependent issues. Default `dependent`.
- **check_issues** (Optional): Enable checking for dependencies in issues. Enable by setting the value to `on`. Default `off`.
- **ignore_dependabot** (Optional): Ignore dependabot PRs. Enable by setting the value to `on`. Default `off`. Use this if you run the action on `pull_request` rather than `pull_request_target`.
- **commit_status** (Optional): Set a commit status (`pending` while blocked, `success` otherwise) on the head commit of PRs. Disable by setting the value to `off`. Default `on`.
- **dry_run** (Optional): Log the changes that would be made (labels, comments, commit statuses) without making them. Enable by setting the value to `on`. Default `off`.
- **keywords** (Optional): A comma-separated list of keywords. Default `depends on, blocked by`.
- **comment** (Optional): A custom comment body. It supports the following tokens:
  - `{{ dependencies }}`: a list of all dependencies, with resolved ones struck through
  - `{{ blockers }}`: a list of the unresolved dependencies
  - `{{ resolved }}`: a list of the resolved dependencies
  - `{{ dependency_count }}`, `{{ blocker_count }}`, `{{ resolved_count }}`: the number of dependencies of each kind
  - `{{ number }}`: the number of the PR/issue itself

  Changing the comment body updates the existing comments on all dependent PRs/issues on the next run. Consider previewing the change with `dry_run: on` first.

## Environment variables

- **GITHUB_TOKEN** (Required): The token to use to make API calls to GitHub.
- **GITHUB_READ_TOKEN** (Optional): The token to use to look up dependencies, e.g. in private repositories. Defaults to `GITHUB_TOKEN`.

## API usage

The action reads the state of all open PRs (and issues, if `check_issues` is on), including their labels, comments and commit statuses, through a small number of paginated GraphQL requests (roughly one per 50 PRs/issues). The state of dependencies outside that set, including cross-repository ones, is looked up in batches of up to 100 per request. GraphQL requests that time out are retried with smaller pages. REST API calls are only made when something needs to change: a label, a comment or a commit status. These are spaced at least a second apart, and retried when GitHub reports a rate limit.

This keeps the action usable on repositories with thousands of open PRs, even when run on a frequent schedule.

Dependencies that can't be found (e.g. a typo, or a private repository the token can't access) are treated as blockers and reported as warnings.

## FAQ

Trouble setting up the action? Check the [FAQ](./FAQ.md).

## Credits

Special thanks to [Jason Etcovitch](https://github.com/JasonEtco) for the original bot idea.

## License

MIT © [Ahmed T. Ali](https://github.com/z0al)

[dependabot-change]: https://github.blog/changelog/2021-02-19-github-actions-workflows-triggered-by-dependabot-prs-will-run-with-read-only-permissions/
