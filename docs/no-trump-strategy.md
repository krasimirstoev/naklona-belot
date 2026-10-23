# No-Trump strategy and reproducible evaluation

Read [the pre-change investigation](no-trump-investigation.md) for confirmed
weaknesses and the exact engine rules. The strategy is entirely local/offline.
The NT work preserves the game schema, rules, UI and worker protocol. A subsequent
stricter bidding and partner-opening update is described in [bot tactics](bot-tactics.md);
the forced-contract results below do not evaluate that later auction change.
The later contra-escape option and correction that capot cancels doubling also
postdate these measurements; their recorded percentages describe the older rules.

## Model

`BotPosition → buildKnowledge → assessNoTrump → candidate resource valuations
→ strategic candidate set → tactical choice → optional belief endgame/search`.

`bot-no-trump.ts` evaluates the same public resources for Medium and Hard's
rollouts: unknown higher cards, accessible suit length, masters, outside entries,
uncaptured points, remaining tricks, current team capture and collected points.
`NT_CAPTURE` keeps the conservative tactical cost scale; retention and continuation
are small adjustments. The first experimental replacement using a larger future
value lost 44.7%–55.3% over 512 deals. Simply valuing future cards more was harmful.
Later exploratory variants also failed to establish an advantage; the reports in
`docs/benchmarks/nt-development*.json` record those experiments, not production
qualification. Their intermediate source versions are not retained as policies.

A capture probability is a marginal ownership approximation. Capacity weights
and public ownership constraints reduce impossible threats; correlated holdings
and whether an opponent chooses to duck remain uncertain. It is deliberately
not labelled contract success probability. Hard's terminal utility remains the
real `calculateResult` vector: match outcome, recorded score, contract outcome,
card points. Thus contra, hanging, capot, match context and final trick are
included without duplicating the rules in the heuristic.

Plans are reconstructed on each move. The chosen candidate's actual contributions
are exposed in `reasons`; alternatives show the resource expenditure, rather
than a narrative invented after the action. Existing partnership safety and ten
guard plans retain precedence. Exact/search evaluation can choose outside those
preferred candidates. `strategy` in a searched decision describes its starting
plan, not a claim that search endorsed every heuristic premise.

## Strategy catalogue

The table records activation, evidence, action, failure/conflict cases, concrete
examples and tests. `tests/bot-no-trump.test.ts` replays 12 complete legal deals;
`tests/bot-strategy.test.ts` supplies additional negative cases for guards,
entries, forced following and partnership safety. Several equivalent cards may
share a plan; tests assert resources/legal choices rather than arbitrary tie order.

| Strategy and purpose | Conditions and required public knowledge | Preferred decision, example | Harmful case, counterexample and conflict | Evaluation and automated coverage |
| --- | --- | --- | --- | --- |
| NT_PRESERVE_ACE: retain a richer future capture | Fourth seat, cheap trick, a single master in the suit with a low companion, outside master entry, enough tricks left; unknown suit points | Compare cashing against ducking. In `nt-duck`, keep club A over a four-point trick, retain diamond/heart entries | Without a return entry or with current valuable points, ducking can strand the ace. Conflicts with tempo and immediate contract security; not a blanket ace preference | Cheap duck/take tests; full legal continuation changes made to failed for the opponents in the regression; paired score/contract results decide overall value |
| NT_PROTECT_TEN: retain a potential winner | Higher ace unplayed, legal alternatives, own length/guards and possible enemy ownership | Keep guarded ten or its last companion if a cheaper expendable card exists | Following suit is mandatory. In `nt-expose-ten` the ten is forced despite uncertain ace. Paying more to guard than can be saved is harmful | Forced-ten and existing guard/no-guard tests; local avoidable ten losses plus contract results |
| NT_PROMOTE_TEN: update winning resources | Public ace disappearance, all remaining higher cards and own honours | Recognize ten, then king etc. as masters. `nt-promoted-ten` leads the established ten | Ace merely being possible at partner is not proof it has gone. Keeping a master forever loses value | Promotion test and public-history purity; masters collected/lost proxies |
| NT_DEVELOP_LONG_SUIT: establish multiple captures | Own length, missing higher cards, outside entry, enough remaining rounds | Force one blocker with K/Q, retain the outside entry; `nt-develop` versus the already established `nt-run-suit` | Length without entries or time is weak. Opponent can duck the blocker. Conflicts with cashing points before opponents discard them | Development/run tests; existing no-entry and bad-continuation tests; long-suit-run proxy plus result |
| NT_CASH_WINNERS: realize assets before they strand | Masters, outside points, available continuation, remaining tricks | Cash a master where points and follow-up remain; do not blindly choose the highest printed points | Feeding an established off-suit ten can sacrifice an independent trick. A long suit with no opposing points is not automatically best | Promotion, partnership preservation, run and endgame tests; captured points and final score |
| NT_DUCK_TRICK: compare deliberate loss with expenditure | Same resources as preservation, current capture value, entries and legal losing alternatives | Sacrifice C7 instead of club A in the recorded complete deal | A cheap trick can still be the necessary entry; `nt-take-cheap` uses its ace without an outside entry | Paired cheap-trick counterexamples and full-deal regression; win rate rather than count of ducks |
| NT_TEMPO_CONTROL: value the continuation of winning | Remaining own master chains, capture chance, outside suit points | Prefer control when it opens actual runnable resources; scale by those resources | A generic initiative bonus caused regressions in development. Conflicts with cheap winning card/entry retention | Candidate contribution and long-suit tests; `nt-no-tempo` ablation |
| NT_PARTNER_FEED: bank threatened points | Partner currently winning; `secureTeamTrick` rules out every later legal enemy overtake | Feed vulnerable H10 in `nt-feed`, preserve a master when an expendable card can follow | Merely leading now is not security; mandatory following overrides free discard. Future winners may be worth more than this gift | Feeding/preservation tests and existing unsafe-partner tests; card/score difference |
| NT_PARTNER_ENTRY: transfer rather than monopolize control | Public ownership/void information and sampled legal allocations; no conventional signals assumed | Existing safe support preserves partner initiative; terminal search can choose a lead that lets partner cash the final winners | No early-hand convention says a previous high lead promises another winner. General bidding-derived entry inference remains unsupported | Partnership tests, hidden-deal invariance and exhaustive endgame test; overall team result |
| NT_CONTRACT_DEFENSE: prevent a made contract | Declaring team and captured doubled points, actual terminal score | A guaranteed team majority defeats the opposing contract; `nt-defend` reaches the secure threshold | Card-point maximization can lose the contract. In uncertain positions only completed terminal samples estimate outcomes; the heuristic does not know future cards | Defensive threshold and terminal-utility tests, separate defense rate |
| NT_SMART_DISCARD: keep useful future resources | No led suit, own masters, guarded tens, long suits and partner security | Discard an expendable low card in `nt-discard`, feed threatened points only when safe | NT voids have no ruffing value. Do not discard a master only to shorten a suit | Discard, guard and forced-following tests; lost-master/ten metrics are contextual proxies |
| NT_CONTRACT_OBJECTIVE: value scoring consequences | Captured points and actual scoring context in terminal search | Secure 132 of the normal 260 NT points; search evaluates recorded scores and match outcome | The heuristic threshold is sufficient, not an estimated success probability or match-win forecast. Risk of hanging differs from failure | Scoring tests for all multipliers/hanging/capot; score and success/defeat rates together |
| NT_ENDGAME: retain the last entry and final 20 | Two or fewer cards per seat, constrained possible allocations, actual scoring state | Aggregate the existing exact per-allocation minimax over all allocations (up to 90), equally weighted | Double-dummy continuation has strategy fusion: different hypothetical worlds can choose different future moves. An allocation is never asserted as the actual hidden hand | Enumeration uniqueness/capacity tests, Medium/Hard equivalence, objective and last-trick tests; final-two-trick points |

## Endgame, rollout budget and confidence

Medium uses `decideMediumCard`. With at most eight cards remaining it enumerates
all compatible allocations and calls the existing seven-card solver after each
candidate. The work is bounded (at most 90 allocations, two choices per seat);
it has no wall-clock stopping condition and is deterministic. Earlier Medium
moves use the inexpensive public assessment. Easy stays random legal play.

Hard keeps the 220 ms default and existing constrained uniform sampler. Each
candidate sees the same allocation, only complete comparison batches count,
and simulated players see their own hand plus public history. NT now requires
three completed batches before a sampled choice replaces its fallback, except
when all possible allocations have been evaluated. This is a minimal evidence
floor, not a statistical confidence guarantee. Diagnostics expose the threshold,
completed/aborted batches, distinct samples, low confidence, exhaustive status
and fallback. An interrupted enumeration cannot use a biased lexicographic
prefix; when the requested batch limit is smaller than the allocation count,
Hard samples uniformly instead. A preliminary four-batch experiment exposed
this prefix bias and is retained as `nt-hard-validation.json`, not qualification.

Fixed seeds and a completed fixed amount of work are reproducible. Real-time
budgets can complete different amounts on different hardware. Endgame minimax
is exact within each hypothetical allocation, not an imperfect-information
optimal strategy. The existing worker timeout/error recovery stays unchanged.

## Headless evaluation

The exact previous seven policy modules are in `benchmarks/no-trump-baseline/`.
Both policies share the engine/types. Historical runs used the rule version
identified by their source fingerprint; later rule changes apply equally to
both policies in new comparisons. `medium-nt-before` and `hard-nt-before`
use this snapshot; the older `medium-before`/`hard-before` remain available too.
The source hashes and scoring context are written into every new report.

```sh
npm run train:bots -- --contract NT --games 10000 --a medium --b medium-nt-before --split heldout --output /tmp/nt.json
npm run train:bots -- --contract NT --seeds 256 --split validation --rotations 4 --a medium --b tactics
npm run train:bots -- --contract NT --seeds 32 --a hard --b hard-nt-before --batches 4
npm run train:bots -- --contract NT --seeds 16 --a hard --b hard-nt-before --timed --batches 100
npm run train:bots -- --contract NT --seeds 32 --scores 140,145 --hanging 20 --multiplier 4
node --import tsx scripts/explain-bot.ts --scenario nt-duck
node --import tsx scripts/explain-bot.ts --scenario nt-endgame --hard
```

`--games` aliases independent `--seeds`, not total rounds: every seed gets both
team assignments, every selected contract and optionally all four seat rotations.
Deal and declarer rotate together; the default declarer also cycles over seeds.
Default development/validation/heldout ranges start at 1/2000001/3000001. Custom
`--seed-start` permits experiments; the caller must keep sets disjoint. These
are forced-contract rounds, not an evaluation of bidding or whole matches.

Reports include success/defeat, round ties/wins, card and final score differences,
tricks, final-two-trick points, long-suit runs, lost masters, locally avoidable
ten losses, calculation times, completed batches and fallback. Definitions are
embedded: a lost master may be forced; a long-suit run is a proxy, not causal
proof of development; a safe alternative to a lost ten proves only a local
opportunity, not that spending that alternative wins the whole hand. The
bootstrap groups assignments/contracts/rotations by independent deal seed.

Ablations: `nt-no-retention`, `nt-no-tempo`, `nt-no-endgame`, plus
`hard-nt-no-retention` and `hard-nt-no-tempo`. These are diagnostic comparisons,
not independent optimization trials. Automatic parameter optimization is deferred:
the exploratory regressions show model error, and current Hard evidence is not
sufficient for fitting more weights. The CLI supplies the infrastructure for
later fixed-configuration experiments without adding a learning runtime.

## Measured results

The locked Medium policy was evaluated on independent seeds 3000001–3002048,
with swapped teams. [Raw held-out report](benchmarks/nt-medium-heldout.json):
4096 rounds, contract outcome score **51.75%**, deal-bootstrap 95% interval
**50.93–52.60%** (hanging counts half). Average recorded-score advantage **+0.74**,
card-point advantage **+5.02** per round. Declarer success **51.56%**; defense
success **50.24%**; these exclude ties. Medium p95 **1.64 ms**, maximum **51.59 ms**,
6256 exhaustive endgame decisions with no fallback in this run.

[Validation against the tactical policy](benchmarks/nt-diverse-validation.json)
uses 256 separate seeds and all four rotations: **56.74%**, 95% interval
**54.20–59.47%**, over 2048 rounds. This opponent uses the NT tactical evaluation
without the strategic filter or Medium endgame. It is a distinct ablation, not
the frozen baseline. The result demonstrates a modest aggregate Medium gain
under this protocol; it does not prove that each heuristic independently helps,
that bidding improved, or that all partners benefit.

The separate [timed Hard check](benchmarks/nt-hard-timed.json) covers only 16
independent seeds / 32 rounds at the production 220 ms budget. Contract outcome
score is 56.25%, interval 43.75–68.75%; average recorded score is −0.125 and card
points −12.75 per round. This is **not evidence of stronger Hard play**. Its p95
is 220.19 ms, maximum 220.80 ms, with 3 fallbacks / 348 search decisions (0.86%),
25.85 mean completed batches and 59 aborted batches excluded from evaluation.
The old policy completed 39.93 batches on average: the richer rollout costs
throughput, even though the wall-clock budget is unchanged. Fixed-batch and
timed results must therefore be reported separately.

The original comparison failure caused by biased endgame prefixes was corrected
before the final Hard run. The final fixed-batch result is reported below.

Remaining limitations: early partner-entry inference is deliberately conservative;
there is no learned bidding model, convention-based signal interpretation,
calibrated Medium contract probability or proof of optimal hidden-information
play. Existing strategic candidate filters can override a resource ranking;
terminal search can override those filters. Individual ablation differences on
512 rounds are not sufficient to justify another tuning cycle on validation
seeds. No optional automated optimizer or neural dependency was introduced.


The [final fixed-batch Hard report](benchmarks/nt-hard-heldout.json) uses 128
held-out seeds / 256 paired rounds, four complete comparisons per sampled
choice: **52.34%**, 95% interval **47.46–57.03%**. Average recorded score **+0.30**,
card points **−2.77**; 2799 search calls with no fallback. This also does not
establish a Hard strength gain. Together with the timed run it verifies execution,
budget and diagnostics while leaving a larger independent strength study open.

Final component checks use the same 256 validation seeds / 512 paired rounds
against the exact old Medium. These intervals concern each policy versus the
baseline, not the statistical significance of differences between ablations.

| Configuration | Contract outcome score | 95% interval | Average recorded-score difference |
| --- | ---: | ---: | ---: |
| [Full policy](benchmarks/nt-final-validation.json) | 51.86% | 49.41–54.10% | +0.69 |
| [No belief endgame](benchmarks/nt-final-ablation-endgame.json) | 50.20% | 47.85–52.54% | +0.04 |
| [No additional retention valuation](benchmarks/nt-final-ablation-retention.json) | 50.49% | 48.24–52.64% | +0.09 |
| [No tempo/development valuation](benchmarks/nt-final-ablation-tempo.json) | 52.44% | 50.20–54.59% | +0.89 |

The last row is a useful warning: additional tempo heuristics have **not** been
shown to independently improve strength. The held-out full-policy result supports
the aggregate change only. More independent ablation data is preferable to
selecting weights from this small validation ranking.

Validation completed: all 78 tests; production TypeScript/client/server build;
a compiled NT worker legal-action smoke check; CLI rotation/recontra/hanging/
near-match scoring-context smoke checks; whitespace check. The old all-contract
tactical golden hash was replaced by direct complete-decision comparisons with
the frozen current policy for every non-NT contract, because NT decisions and
explanations intentionally changed. Scenario, legality, hidden-information,
uniform-sampling and scorer checks remain in place.
