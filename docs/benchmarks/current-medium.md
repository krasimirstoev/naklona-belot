# Current Medium evaluation

Historical measurement: these reports predate the later contra-escape option
and the correction that capot cancels contra/recontra. The source fingerprints
identify the rules used in each run; the percentages are not a new measurement
of the current scoring rules.

Opponent: the exact frozen Medium in `benchmarks/no-trump-baseline`, before
both the NT engine work and the subsequent stricter bidding / partner-opening
changes. Production policies are not tuned during this evaluation.

Two complementary measurements:

- Equal-contract play: 1024 independent seeds, each played under all six
  contracts with both team assignments (12,288 rounds). Declarer cycles across
  seats. Auctions are forced; this isolates playing decisions, including the
  public partner-opening signal, and does not test willingness to bid.
- Complete matches: 512 different independent seeds, each played with swapped
  team assignments (1024 matches). Both policies bid and play normally. The
  engine determines redeals after four passes, scoring, hanging carryovers,
  capot continuation and match completion at 151. Initial dealer cycles across
  seeds. Paired matches begin with identical shuffled cards and random streams;
  subsequent trajectories and numbers of deals can differ because policies bid
  and win differently. Policy randomness is separate from the dealing RNG.

The uncertainty intervals resample independent deal/match seeds, keeping both
team assignments together. Forced-round contract outcome counts hanging as half;
full-match win rate counts actual engine match winners, with no half wins.
Per-contract forced-round rates have equal sample sizes; natural-auction contract
frequencies are endogenous and must not be compared as if randomly assigned.

Commands:

```sh
npm run train:bots -- --a medium --b medium-nt-before --seeds 1024 --seed-start 5000001 --split heldout --output docs/benchmarks/current-medium-all-contracts.json
node --import tsx scripts/bot-match-benchmark.ts --seeds 512 --seed-start 6000001 --progress --output docs/benchmarks/current-medium-matches.json
```

Reports record the production reference and frozen baseline source fingerprints.
The match report additionally records the benchmark source hash and every paired
match outcome. This measures these two policies against each other; it does not
estimate win rate against all humans or other bot opponents.

Verification: TypeScript checking; two independent repetitions of a two-seed
match smoke run produced identical outcomes, auctions, contract metrics and
bootstrap intervals. Match wins, final scores and round totals were checked for
consistency. No production bot behavior was changed for this measurement.

## Complete matches with real bidding

Current Medium won **492 of 1024 matches (48.05%)**; the old Medium won 532. The paired 95% interval is **45.41%–50.68%**. This does not demonstrate a strength improvement in complete matches.

The matches contained 13409 completed rounds and 1434 four-pass redeals. Mean final score difference was -1.03 points per match. Current Medium's per-decision p95 was 0.96 ms.

Natural suit contracts chosen by the current team were made in 769/822 cases (93.55%); those chosen by the old team were made in 7643/10372 (73.69%). These are different selected hands, not a controlled comparison of the same declarations. The current policy declares suits much less often and selects NT/AT more frequently. High success on a narrow set of bids does not establish better match results.

[Raw match report](current-medium-matches.json). All 1024 match outcomes, score sums, paired assignments, all-pass counts and completed-round totals were checked for consistency.

## Equal-contract rounds

Across 12,288 paired forced-contract rounds, the current Medium's contract outcome score is **50.38%**, 95% interval **50.13–50.64%**. Hanging counts half. This shows a small advantage for this play-only protocol, which does not translate into a demonstrated full-match advantage.

| Contract | Rounds | Current outcome score | Mean recorded-score difference |
| --- | ---: | ---: | ---: |
| C | 2048 | 49.83% | -0.024 |
| D | 2048 | 49.93% | -0.036 |
| H | 2048 | 50.07% | +0.007 |
| S | 2048 | 49.88% | -0.031 |
| NT | 2048 | 52.56% | +1.048 |
| AT | 2048 | 50.00% | +0.000 |

[Raw equal-contract report](current-medium-all-contracts.json). Its production and baseline fingerprints match the full-match report. No conclusions about human opponents or a stronger auction can be drawn from the forced-contract table.
