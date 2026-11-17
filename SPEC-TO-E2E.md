# From specification files to end-to-end tests

Design notes for turning a few hundred specification files, each linked to a Jira ticket,
into a Gherkin + Playwright suite that is checked against the running application as it
is written. This document records the decisions, the reasons behind them and the
concerns that are still open. Written November 2026.

The sample implementation is in this repository:

| File | What it is |
|---|---|
| [`.archon/workflows/kiro-spec-to-e2e.yaml`](.archon/workflows/kiro-spec-to-e2e.yaml) | The workflow: one run turns one spec folder into feature files and passing tests |
| [`.archon/spec-to-e2e/bin/run-all.sh`](.archon/spec-to-e2e/bin/run-all.sh) | The driver: one run per spec folder, one at a time, restartable |
| [`.archon/spec-to-e2e/bin/`](.archon/spec-to-e2e/bin/) | Scripts the workflow uses: ticket resolution, status tags, the freeze, report parsing |
| [`.archon/spec-to-e2e/suite-template/`](.archon/spec-to-e2e/suite-template/) | What the first run puts in the suite: pinned `package.json`, `playwright.config.ts`, lint and matrix scripts |
| [`.archon/spec-to-e2e/example-specs/`](.archon/spec-to-e2e/example-specs/) | One example spec, for a trial run against the public TodoMVC demo |

The Jira and Confluence steps are stubs marked **UNIMPLEMENTED**. Section 19 lists what
was tested and what was not.

---

## 1. The goal and the constraints

**Goal.** Go through every specification, one at a time. Keep only what can be tested end
to end in a browser, write it as Gherkin tagged with its ticket, confirm each scenario
against the real application, generate a Playwright test for it, and make that test pass
deterministically. When all the specs are done, the result is a test suite for the whole
application. Every scenario traces back to a ticket, and every scenario has passed
against the running application.

**Constraints that shaped the design:**

- **The client's machine, under WSL.** Everything runs headless from the command line.
  The UI is slow there, so nothing may depend on it.
- **Tests run against the dev server, not localhost.** The agent never has the app's
  source code, so it cannot "fix" the app to make a test pass.
- **Everything is committed.** Feature files, step definitions, evidence and progress
  state all live in the repository. Progress can be read with `git log` and `ls`, and
  another person can pick the work up.
- **No extra infrastructure.** Beads isn't available on the client machine and there is no
  database. State is plain files.
- **Specs vary.** Some are product specs, some are technical. Many contain little or
  nothing that a browser can check.
- **The app keeps growing.** By release 0.3, behaviour will exist that no spec described.
  It still has to be traced back to the ticket it grew out of.

---

## 2. One run per spec, with state kept in files

The workflow handles **one spec folder per run**. A small shell script,
[`run-all.sh`](.archon/spec-to-e2e/bin/run-all.sh), starts the runs one after another.

Why not one workflow run that loops over all 200 specs:

- **A failure stays small.** One bad spec ends its own run, not the batch.
- **You can stop and restart.** Kill the driver at any point. On the next start it skips
  every ticket whose state file says `done` for the current version of the spec.
- **No long-lived run.** Archon only keeps state within a run. A 200-spec run would run
  for days, its context would keep growing, and one stuck spec would stall the rest.
- **Each run can be inspected on its own.** It has its own transcript, artifacts and
  state file.

**State is one JSON file per ticket**, `state/<TICKET>.json`. Its fields are `status`,
`reason`, the spec's hash, the failing step if any, how many rounds and revisions it
took, the app build that was seen, per-scenario browser results, `to_review`, the run ID
and a timestamp. With one file per ticket, merges never conflict and `git diff` stays
readable.

`to_review` counts the scenarios that the browser check kept out of the tests
(`app-mismatch`, `unreachable`, `needs-test-hook`, `unexplored`). **A `done` ticket can
still have scenarios waiting for a person.** In the trial run, 3 of 8 were kept out, and
one of those was a mistake by the model. The driver prints the count after each run.

Ticket statuses:

| Status | Meaning | What the driver does |
|---|---|---|
| `done` | The last test attempt was green: 3 runs of every confirmed scenario, no retries | skips it until the spec changes |
| `no-e2e` | Nothing in the spec can be checked in a browser; `not-e2e.md` says why | skips it until the spec changes |
| `needs-human` | The spec and the app disagree, or no scenario could be confirmed | holds it; `--retry needs-human` runs it again |
| `flagged` | The tests could not be made to pass, or a rule was broken | holds it; `--retry flagged` |
| `error` | The run itself failed (extract crashed, Kiro error) | holds it; `--retry error` |

The spec's hash (`spec_sha`) is part of the state, so **editing a spec re-runs its
ticket automatically** while unchanged specs are skipped.

---

## 3. Layout of the suite

```
acceptance/                          # the suite_dir input; committed
  package.json                       # exact versions of playwright-bdd and @playwright/test
  playwright.config.ts               # frozen while the workflow writes steps
  scripts/
    lint-features.sh                 # the Gherkin rules (section 10); model and gate both run it
    lint-steps.sh                    # the anti-cheat rules for step code (section 8)
    matrix.sh                        # builds TRACEABILITY.md from tags and state files
  features/PROJ-123/*.feature        # one folder per ticket
  steps/PROJ-123/*.steps.ts          # step definitions written for that ticket
  steps/common/                      # shared steps, written and owned by people
  evidence/PROJ-123/
    explore.json                     # what the browser check saw, per scenario
    not-e2e.md                       # every requirement left out, and why
    emergent.md                      # behaviour seen in the app that the spec missed
  state/PROJ-123.json                # progress, one file per ticket
  TRACEABILITY.md                    # generated, never edited by hand
  reports/, test-results/, .features-gen/, node_modules/   # gitignored
```

The spec folders stay where they are. Nothing is moved or renamed.

---

## 4. Ticket identity and traceability

### Which ticket a spec belongs to

The workflow never asks a model for the ticket ID. A script,
[`resolve-ticket.sh`](.archon/spec-to-e2e/bin/resolve-ticket.sh), works it out, in this
order:

1. **The folder name**: `PROJ-123` or `PROJ-123-checkout`. This is the recommended
   convention.
2. **A `TICKET` file** in the folder.
3. **The only ticket ID mentioned in the folder's files.**

If none of these gives exactly one ID, the spec is reported as `BAD` and nothing runs.
Guessing a ticket would quietly corrupt the traceability.

**Set `jira_projects`** (for example `PROJ|CORE`). Without it, any `ABC-123` pattern counts
as an ID, including `UTF-8` and `SHA-256`. Other ticket IDs a spec mentions are recorded
as `related` in the state file.

### Tags

```gherkin
# spec: specs/PROJ-123-checkout
@PROJ-123
Feature: Checkout

  # source: checkout.md, section 3.2
  @PROJ-123
  Scenario: Approver can reject a submitted claim
    ...

  # source: browser check, PROJ-123 run of 2026-11-17
  @emergent @origin-PROJ-123 @since-0.3
  Scenario: Bulk discount is applied above 10 items
    ...
```

- `@PROJ-123` goes on the Feature and on **every** Scenario. Playwright-bdd turns tags into
  Playwright tags, so `--grep @PROJ-123` and `bddgen --tags` both work per ticket.
- `# source:` names the file and section of the spec each scenario came from. It is the
  finer-grained half of the traceability.
- **Emergent behaviour** gets `@emergent @origin-<TICKET>` instead of `@<TICKET>`.
  `@since-<release>` is optional and records when it first appeared. The lint accepts
  either form and rejects a scenario that has neither.

### Emergent features

The browser check is told to list up to five behaviours it noticed that users would rely
on but no scenario covers. Examples are validation messages, empty states and sort order.
These are **candidates, not tests**, because something the agent saw is not necessarily
intended. It might be a bug. They go into `evidence/<TICKET>/emergent.md` as a checklist:

```markdown
- [ ] Empty input is ignored — pressing Enter on an empty field adds nothing
- [x] Bulk discount above 10 items — the total drops by 5% when quantity reaches 11
```

A person ticks the ones that are real. The next run of that ticket adds each ticked line
as an `@emergent @origin-<TICKET>` scenario. To trigger that run, either run the workflow
for that spec directly, or delete its state file so that the driver picks it up again.
`--retry` does not re-run `done` tickets. From then on it goes through the same browser check and tests as everything
else. This way, behaviour nobody wrote down still gets tied to the ticket it grew out of,
and a person decides what counts as intended.

### What was left out, and why

`evidence/<TICKET>/not-e2e.md` lists every requirement the extract step dropped, with its
place in the spec and the reason (internal id format, performance figure, storage schema,
and so on). Reviewers can spot-check it. It also answers "why is ticket X not in the
suite?" without anyone re-reading the spec.

### The matrix and Confluence

[`matrix.sh`](.archon/spec-to-e2e/suite-template/scripts/matrix.sh) builds
`TRACEABILITY.md` **from the tags and state files only, never from a model**. It has one
table of tickets (status, reason) and one table of scenarios (ticket, spec or emergent,
status, file and line). It is regenerated at the end of every run and committed with the
ticket.

Publishing to Confluence is a separate, **unimplemented** step (`publish` in the
workflow). It should publish only the rows of `done` tickets whose scenarios are
`active`, so that the Confluence page lists exactly what is proven to work. It can be a
Kiro node with a Confluence MCP server and no other tools, or a bash node calling the
REST API.

---

## 5. The pipeline

```
resolve (bash)        ticket ID, spec hash                         ── no AI: IDs must be exact
jira (stub)           ticket JSON                                  ── UNIMPLEMENTED
setup (bash)          suite created once, npm install, browsers
extract (Kiro)        draft .feature files, not-e2e.md             ── runs the feature lint itself
extract-verdict       testable | no-e2e
rounds (loop_group, at most 3: the draft + up to 2 revisions, fresh Kiro session each)
│  lint (bash)        the same feature lint, as a gate
│  explore (Kiro)     every scenario checked on the dev server     ── browser + read only
│  record (bash)      evidence saved, status tags applied, FREEZE
│  tests (loop_group, at most 3 attempts)
│  │  write-steps (Kiro)   step definitions in steps/<TICKET>/ only
│  │  run-tests (bash)     4 gates, then 3 runs per scenario, 0 retries
│  classify (bash)    done | revise | stop
│  revise (Kiro)      acts only when classify says revise; otherwise answers "none"
│  round-end (bash)   undoes a revision that changed an expected value
finish (bash)         state file, @flagged if not done, TRACEABILITY.md
publish (stub)        Confluence                                   ── UNIMPLEMENTED
commit (bash)         only this ticket's paths (commit=yes)
report (bash)         summary, then SPEC-TO-E2E <status> <TICKET>  ── the console line
```

What each step does:

1. **Extract.** Kiro reads the spec and the Jira ticket and keeps only what a user can see
   or do. It writes short, declarative scenarios (section 10) and lists what it left out.
   It runs the feature lint and fixes the file until the lint passes.
2. **Explore.** Before any test code exists, a separate Kiro turn walks every scenario on
   the dev server through Playwright MCP. It gives each scenario one status:
   - `confirmed`
   - `app-mismatch`: the steps work but the app shows something else
   - `unreachable`
   - `needs-test-hook`: the state can't be set up from outside

   It records evidence for each scenario: the texts it saw, working locators, and the
   requests the app made that created the state the `Given` needs. This node can only use
   the browser and read files. It cannot write.
3. **Record and freeze.** Bash saves the evidence and **writes the status tags itself**.
   A model that could tag a hard scenario `@unreachable` would quietly remove it from the
   suite. Bash then freezes the ticket's feature files, every step file outside
   `steps/<TICKET>/`, `playwright.config.ts` and `package.json`.
4. **Tests.** Kiro writes step definitions from the frozen features and the evidence.
   Bash runs them behind four gates (section 8): every scenario 3 times, no retries. This
   repeats up to 3 times, and each attempt sees the last attempt's failing steps and
   errors.
5. **Classify.** Bash reads the saved attempts and decides one of:
   - **done**: green.
   - **revise**: the same Gherkin step failed in every attempt that ran.
   - **stop**: failures moved between steps, a rule was broken, or no revisions are left.
6. **Revise.** Kiro may change *how* a scenario is checked, never *what* it expects
   (section 7). The revised feature goes back through the browser check in the next
   round.
7. **Finish.** Bash writes the state file and regenerates the matrix. A ticket that is
   not done gets `@flagged` on its features. That keeps it out of the regular suite run
   without deleting anything.

---

## 6. When a test fails, whose fault is it?

There are four suspects. The design tries to separate them cheaply and deterministically.

| Suspect | How it shows | What the workflow does |
|---|---|---|
| **The feature file** (wrong wording, missing precondition, too coarse) | The **same Gherkin step** fails in every attempt, **however the step code is rewritten** | revise the feature (outer loop) |
| **The test code** (bad locator, wrong wait) | Failures **move** between steps from one attempt to the next; or a hook fails; or step generation fails | keep repairing the code (inner loop); stop as `flagged` when attempts run out |
| **The app** (it disagrees with the spec) | The browser check says `app-mismatch`; or the revise step says `needs-human` | tag the scenario, keep it out of the run, send it to a person |
| **The environment** (dev server down, deploy mid-run) | Everything fails at once, often with navigation or network errors | not automated yet: `app_build` in the state file helps spot deploys |

Three things make this work:

- **The browser check runs before any test code exists.** A scenario that reaches the
  test loop has already been seen working in the real app. A failure after that is much
  more likely to be the code's fault than the feature's.
- **playwright-bdd ties every failure to a Gherkin step** (`feature:line`) in its Cucumber
  JSON report. [`test-report.sh`](.archon/spec-to-e2e/bin/test-report.sh) extracts it, so
  bash can compare failing steps across attempts.
- **The error text gives a first guess**:
  - `strict mode violation`, `element(s) not found` or a timeout → probably the test code.
  - `Expected:` / `Received:` with a real value → the element was found but showed
    something else. That is the one case where the app and the spec may disagree.

**One caveat** came out of the playwright-bdd comparison: a locator bug fails the *same*
step in all three repeats of a single run. So "the same step fails" is only evidence
against the feature **across rewrites of the code**, never across repeats within one
attempt. That is why the outer loop compares attempts, not repeats.

---

## 7. Revising a feature, and what must never change

A feature file can be wrong even after the browser check. The check is lenient because an
agent judges it, while a test is strict. Typical cases:

- the scenario relied on data that happened to exist during exploration;
- its wording can't be made deterministic ("sees recent orders");
- it is too coarse;
- a precondition is missing.

So after the inner loop gives up on the same step, the feature gets **at most two
revisions**. Each revision must pass the browser check again before it is frozen and
tested.

Rules for a revision:

- **Allowed:** reword a step to match what the page offers, add a missing `Given`, split a
  scenario, make an expectation deterministic.
- **Not allowed:** changing the **expected outcome**. Every quoted value in a `Then` step
  (and in the `And`/`But` steps after it) must survive word for word.
  [`then-values.sh`](.archon/spec-to-e2e/bin/then-values.sh) lists them before and after.
  If any value changed or went missing, `round-end` **puts the frozen copy back** and marks
  the ticket `needs-human`.
- **If the scenario can only pass by expecting something else, the model must not edit.**
  It answers `needs-human` and states what the spec expects and what the app does.

This is the one place where a person, not the model, has to decide whether the spec is
wrong. Letting a model bend a `Then` to match the app would record a bug as expected
behaviour, and nobody would notice.

The lint makes this check possible by requiring every `Then` to **quote** its expected
value (`Then the footer shows "2 items left"`). The expected outcome is then data that can
be compared, not prose that can be softened.

Known gap: in a `Scenario Outline`, the expected values live in the `Examples` table,
which `then-values.sh` does not compare yet.

---

## 8. Gates against a fake pass

If a loop runs "until the tests pass", the model will sooner or later make a test pass by
weakening it. Bash gates check for this before and after every test run:

| Gate | Catches | Where |
|---|---|---|
| Freeze | Edits to feature files, other tickets' steps, `playwright.config.ts`, `package.json` | `run-tests`, via `freeze-list.sh` |
| Step lint | `test.skip/fixme/fail/only`, `testInfo.skip/fail`, `$test.`, `expect.soft`, `try/catch`, `.catch(`, `waitForTimeout`, `tags:`, and any `http(s)://` URL (tests must use paths relative to `BASE_URL`) | `scripts/lint-steps.sh` |
| Feature lint | `@skip @fixme @fail @only @slow @timeout:` tags, missing ticket tags, unquoted `Then` values, more than one `When` | `scripts/lint-features.sh` |
| Step generation | Undefined or ambiguous steps (`missingSteps: 'fail-on-gen'`); `.features-gen` is deleted and regenerated every time, so a stale test never runs | `run-tests` |
| Report check | A step that ended `skipped`, `pending`, `undefined` or `ambiguous`; a run count that is not a multiple of 3 | `run-tests`, via `test-report.sh` |
| Expected values | A revision that changes or drops a quoted `Then` value | `round-end` |
| Status tags | The model taking a scenario out of the run | only bash writes those tags |

Two findings from the playwright-bdd comparison are behind some of these. **`@fail` makes
a failing scenario exit 0** (Playwright counts it as "expected"). And **running
`playwright test` without regenerating** runs the old test while the report shows the
edited feature as passed.

What the gates **cannot** prove is that an assertion is strong enough. The trial run
produced two examples that passed every gate:

- `Then the todo {string} is marked as completed` ignored its `{string}` and checked the
  only checkbox on the page;
- `the footer shows {string}` searched the whole page instead of the footer.

The prompt now names both mistakes, and the quoted values are frozen. But reviewing a
sample of the generated steps by hand is worthwhile in the first weeks, and so is a
stronger model for `write-steps`.

---

## 9. Determinism on a shared dev server

- **3 runs, 0 retries.** A test is green only if every scenario passed 3 out of 3 times.
  A retry would hide exactly the flakiness this is meant to catch.
- **One worker** by default (`playwright.config.ts`). The dev server is shared, and one
  ticket's scenarios may touch the same records.
- **Unique data.** Anything a scenario creates gets a unique name (`e2e-…` plus a
  timestamp), because each scenario runs 3 times. Never assert totals for the whole system
  ("3 orders"). Assert on the records the scenario created.
- **No order dependence.** A scenario never relies on another having run.
- **Record the build.** The browser check records the app's version if the UI shows one
  (`app_build` in the state file). A failure that starts right after a deploy can then be
  told apart from a bad test.
- **Regression is a separate run.** A ticket's run only runs that ticket's scenarios. Run
  the whole suite (`npm run test:suite`) nightly to catch one ticket's steps breaking
  another's.

---

## 10. Writing behaviour tests the BDD way

Use **short, declarative scenarios: one behaviour each, with state set up the fastest
reliable way.**

```gherkin
@PROJ-123
Scenario: Approver can reject a submitted claim
  Given a claim in "submitted" state          # set up through the API, no clicking
  When the approver rejects it with a reason  # the one UI action under test
  Then the claim shows "Rejected"
  And the reason is shown
```

- **One `When` per scenario.** Several outcomes of that one action are fine as `Then`/`And`.
- **`Given` describes a state, not clicks.** "Given a claim in submitted state", not "Given
  I log in, click New claim, fill the form, submit". How it gets there is the step code's
  job.
- **Set state up through the app's API, not the database.** Writing straight to the
  database skips business rules, ties tests to the schema, and can corrupt data other
  people use on a shared dev server. The browser check records the requests the app makes
  when it creates that state, and `write-steps` uses them through Playwright's `request`
  fixture. Use the UI only as a last resort.
- **`Then` names what the user sees, with the exact value in quotes.**
- **Every scenario stands alone.**

**State machines.** For an entity with a lifecycle (draft → submitted → approved → paid),
write **one scenario per transition**. Each `Given` puts the entity in the starting state
through the API, and a `Scenario Outline` covers a table of transitions. Then add one
`@journey` scenario that walks the whole lifecycle through the UI (section 11).

**When a state can't be set up from outside** (expiry, a timeout, a third party
declining a payment, a background job), mark the scenario `needs-test-hook` instead of
faking it. Collect these for the developers: a test endpoint or a clock override would
make them testable. That list is a useful result of this process in its own right.

Anti-patterns the lint or the prompts guard against:

| Anti-pattern | Why it hurts here |
|---|---|
| Long imperative scenarios ("click, type, click, check, click...") | A failure at step 12 could be caused by step 7; the repair loop can't tell which |
| Scenarios that depend on each other | Order-dependent; one failure cascades |
| `Then` without a concrete value | Can't be frozen, so a model can soften it |
| Data set up through the database | Bypasses business rules on a shared server |
| Expectations about time, random ids or ordering the app doesn't promise | Flaky by construction |

---

## 11. Short scenarios and long journeys

### Why short is the default

- **Attribution.** With one behaviour per scenario, the failing step is almost always
  the culprit. That is what makes the "same step keeps failing" signal (section 6) work.
- **Cost.** With `--repeat-each=3` and up to 3 attempts in each of up to 3 rounds, a
  scenario can run around 27 times. That is fine for 20 seconds and painful for 10
  minutes.
- **No masking.** In a long flow, a failure at step 3 means steps 4 to 15 are never
  tested.

### Where journeys still matter

Short scenarios can all pass while the hand-offs between screens are broken: state
carried from one page to the next, navigation after a save, a session that expires
halfway through. A few **journeys** that walk a whole business flow through the UI catch
these problems.

### Very long workflows on the dev server

This repository does not have a journey workflow yet. Here is how one should be built
when the time comes.

**Keep journeys out of the repair loop.** A journey that fails should go to a person, or
to a classifier that maps the failing step back to its short scenario. It should never go
to an agent told to make it pass. A 15-minute flow repaired 8 times is two hours of dev
server time and almost certainly a weakened test.

**Build journeys from the same step library.** A journey is a `@journey` scenario made of
steps that the short scenarios already define and prove. A journey should need no new
step code, or very little. Then a journey failure on a step whose short scenario is green
points straight at the hand-off between screens, which is exactly what journeys exist to
find. Tag each journey with every ticket it crosses (`@journey @PROJ-123 @PROJ-140`), so
that the matrix shows which tickets it covers.

**Make them checkpointed and resumable.** Split a journey into stages with
`test.step()` or Gherkin `Rule:` blocks (create → approve → pay → refund). At each
boundary, record the entity's ID and state, so that a failed run can be investigated, or
restarted from a known state, without replaying an hour of UI. Where the API allows it,
let a stage start from state set up through the API, so stages can also run on their own.

**Give each journey run its own namespace.** Prefix everything it creates with a run ID
(`e2e-journey-<run>-…`) and clean up at the end, best-effort. Long runs leave the most
debris on a shared server. A periodic cleanup job for `e2e-` data is worth asking the dev
team for.

**Check the build at the start and at the end.** Read the app version at the start and
again at the end. If it changed, a deploy happened mid-run, and the result is
inconclusive rather than a failure. Also check that the dev server is healthy before
starting, so that an outage isn't reported as twenty journey failures.

**Run them on a schedule, not on every change.** Run them nightly or before a release, a
handful at a time, with a time budget for each (`timeout` per test, and an overall budget
for the run). Record traces and video for journeys only (`trace: 'on'`,
`video: 'retain-on-failure'`). They are too expensive for every short test, but invaluable
when a 12-minute flow fails at minute 11.

**Keep them few.** Have one journey per persona for each critical business flow (sign up
to first purchase, claim to payout), not one per feature. If there are more than about 20,
they are becoming the main suite, with all the slowness and attribution problems that the
short scenarios were designed to avoid.

**An agent walking a long flow is exploration, not testing.** Having Kiro walk a long flow
through Playwright MCP is useful to *discover* behaviour, for example emergent features
before a release, or regressions a human would notice. Its output should be findings and
candidate scenarios (like `emergent.md`), not a pass or fail verdict. A pass or fail
verdict should only come from deterministic Playwright runs.

In Archon, a journey run would be a separate workflow. Bash nodes run the journeys
(`npm run test:suite -- --grep @journey`, or `bddgen --tags @journey`), and a final bash
node maps each failing step to its short scenario and that scenario's last status. No
agent is involved in the verdict.

---

## 12. playwright-bdd or Cucumber.js

The two were compared in a separate thread, with prototypes of both on Playwright 1.65.1.
The choice is **playwright-bdd 9.2.1**, pinned exactly together with `@playwright/test`
1.65.1.

| Criterion | playwright-bdd 9.2.1 | Cucumber.js 13.3 + Playwright as a library |
|---|---|---|
| Failing step readable by `jq` | Same Cucumber JSON; a scenario timeout is blamed on the step that was running | Same Cucumber JSON |
| Deterministic runs | `--repeat-each`, `--retries=0`, `forbidOnly`; undefined/ambiguous steps fail during generation, before a browser starts | No repeat option (loop it yourself); undefined steps fail only at run time, and `--dry-run` exits 0 |
| Gherkin vs code drift | Generated tests in `.features-gen/` can go stale; fixed by always regenerating | Reads `.feature` at run time, so no drift |
| Ease for an LLM | Steps are `async ({ page }, arg) =>`, the same shape as Playwright MCP and codegen output | `function (this: World)`; an arrow function silently breaks `this`; you write the browser lifecycle |
| Playwright features | Fixtures, `storageState` via a setup project, traces, sharding, `--last-failed` | Library only; traces and auth by hand |
| Maintenance | About 830 stars, effectively one maintainer; releases follow Playwright versions | Official project, about 5.4k stars |

Its weaknesses each have a fix in this design:

- **Drift:** always `rm -rf .features-gen && bddgen` before `playwright test`.
- **`@fail` and other skip tags:** caught by the lint.
- **Version coupling:** pinned exact versions, upgraded together. Stay on 9.x until 10.0
  is stable. v10 adds `$step.skip()`, which the step lint will then need to reject.

Serenity/JS was ruled out. It adds a Screenplay layer the model would have to learn, and
its reports need a Java CLI on WSL.

---

## 13. The dev server, logins and secrets

- **Login.** Use Playwright's `storageState`. A setup project logs in once per role and
  saves the session to `.auth/<role>.json` (gitignored). The tests then start already
  logged in. For the browser check, `@playwright/mcp` accepts a storage state file too,
  so the agent can also start logged in.
- **Secrets never go into prompts.** Credentials come from environment variables read by
  the setup script, not from the workflow's inputs and not from the spec. Prompts and
  run transcripts are stored.
- **The agent is given untrusted input.** Specs and dev server pages are text the model
  reads, and a page could contain instructions. The browser check node can only read
  files and use the browser. `write-steps` has a shell, so it can run the tests itself,
  which makes it the node to harden first. Options are dropping `shell` from its tools,
  so that only the bash gate runs tests, or running the workflow in a container.
- **Rate limits and load.** 3 runs per scenario × a few hundred scenarios is real load on
  a shared dev server. Run one worker and a modest batch (`--limit`), and tell the team
  that owns the server.
- **Data hygiene.** The browser check creates data prefixed `e2e-` and never changes data
  it didn't create. Ask for a cleanup job for `e2e-` data, or run one nightly.

---

## 14. WSL notes

- **Keep the repository on the Linux filesystem** (`~/work/…`), not under `/mnt/c`. Across
  that boundary, npm, git and Playwright run many times slower.
- **Install the browser's system libraries once:** run
  `npx playwright install-deps chromium` in the suite folder. It asks for sudo to run apt,
  so the workflow's setup node does not do it. It only downloads the browser.
- **Everything is headless and CLI-only.** Reports are files: `reports/cucumber.html`,
  `reports/playwright/index.html`, and traces under `test-results/`. Open them from
  Windows through `\\wsl$`, or with `npx playwright show-report reports/playwright`.
- **Kiro gives an MCP server 30 seconds to start.** The setup node warms the npx cache
  for `@playwright/mcp`, so the first browser check doesn't time out on the download.

---

## 15. Running it

One spec:

```sh
archon workflow run kiro-spec-to-e2e --no-worktree \
  --input spec_dir=specs/PROJ-123-checkout \
  --input base_url=https://dev.example.com/ \
  --input jira_projects='PROJ|CORE' \
  --input commit=yes
```

The whole folder, a batch at a time:

```sh
.archon/spec-to-e2e/bin/run-all.sh specs https://dev.example.com/ \
  --jira-projects 'PROJ|CORE' --commit --limit 20
# later: retry what was held
.archon/spec-to-e2e/bin/run-all.sh specs https://dev.example.com/ --retry flagged --limit 10
```

Trying it out against the bundled example and the public TodoMVC demo:

```sh
archon workflow run kiro-spec-to-e2e --no-worktree \
  --input spec_dir=.archon/spec-to-e2e/example-specs/TODO-101-todo-items \
  --input base_url=https://demo.playwright.dev/todomvc/
```

`--no-worktree` is required. The suite is meant to live and accumulate in your checkout,
and a worktree would throw it away when the run ends.

`base_url` should end in `/` (the test run adds it if missing). Step code navigates with
paths relative to it, such as `page.goto('./')`, so the same suite runs against any
environment by changing `BASE_URL`.

Working with the suite directly:

```sh
cd acceptance
TICKET=PROJ-123 npm run test:ticket     # one ticket, no retries
npm run test:suite                      # everything active, without journeys
npm run lint:features                   # every ticket's features against the rules
npm run matrix                          # regenerate TRACEABILITY.md
```

**What a person reviews**, in order of value:

1. **`needs-human` tickets.** These are scenarios where the app and the spec disagree.
   Each one is either a bug to raise in Jira (linked to the ticket) or a spec that needs
   updating.
2. **`emergent.md` files.** Tick what is intended behaviour.
3. **`flagged` tickets.** The tests could not be made to pass. Look at `failing_step` in
   the state file first.
4. **A sample of `not-e2e.md` files and generated steps** in the first weeks, to check
   that the extract step leaves out the right things and the steps assert strongly
   enough.

---

## 16. Models and cost

The sample pins `minimax-m2.5`, Kiro's cheap model, for trials. A ticket that goes green
in the first round costs 4 to 6 Kiro turns: extract, explore, 1 to 3 `write-steps`
attempts, and revise answering "none". The maximum is 16. For the client run, consider a
stronger model for `explore` and `write-steps` (the nodes that drive a browser and write
code), and keep the cheap one for `extract` and `revise`. Set `model:` on those nodes.

**Wall time is dominated by the two browser-driving Kiro turns, not by the tests.** In
the trial, `explore` took 10.5 minutes and `write-steps` 11 minutes for 8 scenarios on
the cheap model. The deterministic test run took 7.5 seconds. Plan for roughly 25 to 45
minutes per spec on the cheap model, longer for specs with more scenarios or revisions.
That makes 200 specs on the order of 100 to 150 hours: two to three weeks of nightly
batches with a single driver.

Ways to shorten that, in order of safety:

- **A faster, stronger model for `explore` and `write-steps`.** Fewer wrong verdicts, and
  usually fewer attempts.
- **Smaller specs or a cap on scenarios per run.**
- **Several drivers on separate spec subsets,** each in its own clone, merging the suite
  afterwards. One ticket only writes its own folders, so merges are easy, but the dev
  server takes the combined load.

Run the first 5 to 10 specs before committing to a schedule. They will show the real
time per spec on the client's app.

---

## 17. How Archon shaped the workflow

Things in Archon 0.14 that decided the structure (see [ARCHON-LEARNINGS.md](ARCHON-LEARNINGS.md)):

- **A failing node inside a `loop_group` body fails the whole group.** So `run-tests`
  always exits 0 and prints `TESTS-GREEN`/`TESTS-RED`. The only body node allowed to fail
  is the feature lint, and a failure there ends the ticket as `flagged`.
- **A `workflow:` node cannot go inside a `loop_group`.** The per-spec loop therefore
  lives in `run-all.sh`, not in a parent workflow.
- **Nested `loop_group`s are supported but not hardened**, according to Archon's docs. The
  outer loop holds the inner one. This was tested on Kiro in `kiro-nested-loop-groups` and
  in the trial run described in section 19.
- **A skipped node propagates its skip to the nodes that depend on it,** and reading the
  output of a node that did not run fails. So the nodes that must always run (`classify`,
  `revise`, `round-end`, `finish`) read files, use `trigger_rule: all_done`, or are never
  skipped. `revise` runs every round and answers "none" at once when there is nothing to
  revise.
- **`when:` cannot compare a `loop_group`'s output.** Decisions are taken from bash nodes
  (`extract-verdict`, `record`'s `confirmed` count) instead.
- **Inputs reach bash nodes as `INPUTS_<NAME>` environment variables,** and reach prompts
  as `$INPUTS.<name>`.
- **Kiro has no session forks,** so `context: { resume: … }` is unavailable. The outer loop
  uses `fresh_context: true`, and passes what a round needs explicitly
  (`$LOOP_PREV.classify.output`, the evidence file). Long browser sessions don't pile up.
- **`$ARTIFACTS_DIR` is per run.** Round counters, frozen copies and each attempt's report
  live there. Only the suite folder is committed.
- **The console shows only the output of nodes nothing depends on.** So a final `report`
  node (`trigger_rule: all_done`) prints the summary. Everything else is in the run's
  transcript.

---

## 18. Not implemented yet, and open questions

**Unimplemented in the sample:**

- **The Jira node.** The stub returns `{"implemented": false, …}` and the extract step
  works from the spec alone. Replace it with a Kiro node with a Jira MCP server and
  `allowed_tools: []`, or a bash node calling the REST API, and keep the field names.
- **Confluence publishing** (section 4).
- **Login** (`storageState` setup project, section 13).
- **Specs that aren't text.** `.docx` and `.pdf` should be converted first (`pandoc`,
  `pdftotext`) in a node before `extract`, with the text kept beside the original.
- **Very large specs.** Extract reads everything in one turn. A spec that doesn't fit
  should be split by section, with one feature file per section.
- **Environment failures** (section 6) are not told apart automatically.
- **The journey workflow** (section 11).

**Open questions for the team:**

- **When the Jira ticket and the spec disagree, which wins?** Probably the newer one, or
  Jira's acceptance criteria. This is a policy to decide, and then to state in the
  extract prompt.
- **Who owns `steps/common/`?** The workflow freezes it, so shared steps are written by
  people. That is deliberate, but somebody has to do it as the suite grows.
- **What happens to an `app-mismatch`?** Raise a Jira bug automatically, linked to the
  ticket, or leave it to the reviewer?
- **When a ticket's spec changes,** its scenarios are re-extracted. Should scenarios that
  disappear be deleted, or kept with a tag until a person confirms?
- **How should the release (`@since-0.3`) be recorded?** As an input to the workflow, or
  read from Jira's fix version once the Jira node exists?

---

## 19. What was tested

- **`archon validate workflows kiro-spec-to-e2e`** passes on Archon 0.14.0 with the Kiro
  plugin (no errors, no warnings).
- **Every helper script** was run on its own on macOS (bash 3.2, BSD tools), against
  sample feature files and against a real playwright-bdd 9.2.1 Cucumber report:
  - ticket resolution: folder name, `TICKET` file, single key in the files, ambiguous
    folders, `jira_projects`;
  - feature lint: a good file, and a bad file breaking every rule;
  - status tags: applied, then replaced on the next round without stacking;
  - the `Then` values list, the freeze list, the report parser, the step lint, the matrix;
  - the driver, as a dry run: run, skip, hold, retry, limit, bad folder.
- **A trial run** of the whole workflow against the TodoMVC demo with `minimax-m2.5`
  (Archon 0.14.0, macOS) on the bundled example spec. It **completed as `done`** after 1
  round, 1 test attempt and 0 revisions, in about 37 minutes:

  | Step | Time |
  |---|---|
  | setup (first time: npm install and browser download) | 3.5 min |
  | extract | 1.8 min |
  | explore (8 scenarios) | 10.5 min |
  | write-steps | 11 min |
  | test run (15 scenario runs) | 7.5 s |

  What it showed:
  - **Extract was good.** It wrote 8 short scenarios in 4 files, every one tagged and with
    a `# source:` line. It left out all three technical notes, each with a correct reason.
  - **The browser check caught a real spec/app disagreement.** The spec says the footer
    shows "0 items left", but the app hides the footer when the list is empty. Two
    scenarios were tagged `app-mismatch` and kept out of the tests.
  - **It also produced a false `app-mismatch`.** It claimed the input field is not cleared
    after adding a todo, which it is. That scenario was wrongly left out. This is why
    `app-mismatch` goes to a person, why the state file counts `to_review`, and why a
    stronger model for `explore` is worth considering.
  - **The emergent list was noisy.** Two of the five entries contradict each other. This
    confirms they must stay candidates until a person ticks them.
  - **The step code passed every gate but had weaknesses only a person would spot:**
    - a hard-coded dev server URL (now rejected by `lint-steps.sh`);
    - a `Then` that ignores its `{string}` and checks the only checkbox;
    - `getByText` not scoped to the footer.

    The prompt now spells out the last two. A gate can't catch them (section 8).
- **After the trial:**
  - The `finish` and `report` nodes were changed and re-run against the trial's real
    artifacts.
  - A small workflow confirmed that the final `all_done` node runs after the skipped
    `commit` node, and that only that node's output reaches the console.
  - The URL rule was checked against the trial's steps: it flags them, and the advised
    `page.goto('./')` passes 5/5 against the demo.

Not tested:
- the client's dev server, WSL itself, or login;
- a spec large enough to need splitting;
- a ticket that goes through a feature revision;
- the URL rule's feedback loop with a model, that is, whether the model fixes the URL on
  its next attempt.
