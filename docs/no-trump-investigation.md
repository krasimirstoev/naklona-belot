# NT investigation before implementation

Baseline: `benchmarks/no-trump-baseline/` is a verbatim snapshot of the seven
policy/knowledge/search modules at task entry, using shared unchanged rules/types.
This is distinct from the older `benchmarks/baseline/` snapshot.

Confirmed by inspecting the current decision path:

- `base.win` awards 12 regardless of points on the table. With A/8 following
  a low opposing lead, A scores 3.6 versus −0.1 for 8. No continuation is compared.
- Leading masters uses only their own points. A singleton ace outranks a lower
  master at the head of a runnable suit; the number of consecutive winners and
  the points still available outside the hand are absent.
- The NT development plan is a hard filter before tactical ranking. It requires
  exactly one unknown blocker and an outside master, but cannot compare the
  cost of conceding initiative against the current contract position.
- Existing partnership safety, protection of a ten's last guard and recognition
  of masters already work. They must not be described as newly discovered bugs.
- Hard's terminal utility already uses the actual scoring engine. Its rollouts
  inherit Medium's omissions. Uniform constrained sampling and a seven-card
  sampled double-dummy endgame already exist and should be reused.
- A single completed sample may override the fallback plan. Completion counts
  exist, but there is no minimum-evidence threshold or confidence indication.

Rules verified in `engine.ts`: follow suit without mandatory heading in NT;
A > 10 > K > Q > J > 9 > 8 > 7; doubled card values (240 total), last trick 20;
capot adds 90 (350 total); no declarations/belots. Strict raw-score majority
makes the contract; equality hangs. Multiplier 2/4 transfers all rounded points
to the winner; failure does so even undoubled. Unmultiplied hanging credits the
defenders and carries the declaring share; multiplied hanging carries everything.
Prior hanging is awarded to the next non-hanging winner. Capot/hanging cannot
end the match. All terminal evaluation must continue calling `calculateResult`.

External cross-check: [Belot.BG rules](https://belot.bg/belot/rules/) confirm
NT doubling except capot. [Tournament rules](https://cooldown.bg/belot_turning_pravila.pdf)
illustrate local variants (e.g. capot contra); compatibility follows this engine,
not a different tournament convention. Bridge-specific ruff/void incentives and
conventional signals cannot be imported into NT Belot.

Design: evaluate immediate team capture, retained winning resources, the number
of blockers, guarded tens, accessible long-suit continuations and the cost of
surrendering control together. Recompute from public information each decision.
These estimates are heuristics, not calibrated probabilities of contract success.
Only Hard's completed sampled terminal results estimate contract outcomes.
Compare against the frozen current policy on paired seeds before claiming strength.
