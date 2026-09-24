# Synthetic learner simulation environment

> ### ⚠️ Synthetic evidence — not a measurement of real learning
> Every learner described here is simulated. The world model is an **assumption
> written by the same team as the policy under test**, so results establish how
> selection policies behave *relative to one another under that assumption* and
> nothing more. They are not evidence of real-world learning gains and must not
> appear in efficacy claims, marketing, or procurement material. Every artefact
> the environment emits carries `evidenceType: "synthetic-simulation"` so this
> cannot be lost downstream.

This document describes the environment itself. For the results it produced,
see [`benchmarks/RESULTS.md`](benchmarks/RESULTS.md); for the policy under test,
see [`ADAPTIVE_ENGINE.md`](ADAPTIVE_ENGINE.md).

---

## 1. Why this exists

The platform can measure whether it *predicts* answers well (Brier, ECE, RMSE).
It cannot measure whether it *teaches* well, because nobody observes a real
learner's latent knowledge. This environment manufactures a world where that
latent state is known by construction, so questions like "did this policy
actually cause learning, or just measure it more precisely?" have answers.

It is deliberately built to be able to embarrass the policy it evaluates. The
two design choices that matter most:

- **A trivial baseline floor.** Three heuristics with no model, no prerequisite
  reasoning and no tuning run alongside the real policies. If the adaptive stack
  cannot beat them, the report says so in bold.
- **An ideal-observer ceiling.** An oracle that reads ground truth establishes
  how much learning was available at all, turning every score into a *fraction
  of achievable* rather than a number with no scale.

Both are reported on the primary held-out split, not in an appendix.

---

## 2. Running it

```bash
npm run bench        # regenerate benchmarks/RESULTS.md + results.json (~15s)
npm run bench:tune   # re-run the weight search  -> benchmarks/tuning.json
npx vitest run tests/unit/simulator.test.ts   # 41 environment regression tests
```

Everything is deterministic: same commit ⇒ byte-identical output. No wall clock,
no unseeded randomness, no network. `npm run bench` *rewrites* the committed
report, so a policy change that is not re-benchmarked shows up as a diff in
review.

| File | Role |
| :--- | :--- |
| `benchmarks/world.ts` | Skills, item bank, archetypes, and the latent learning/forgetting/fatigue process |
| `benchmarks/simulate.ts` | Runs one (policy × archetype × world × seed) cell; emits metrics, step traces, trajectories |
| `benchmarks/policies.ts` | The three shippable policies, three baselines, and the oracle |
| `benchmarks/baselines.ts` | Floor/ceiling bracket, difficulty sweep, response-model calibration probe |
| `benchmarks/protocol.ts` | Splits, guardrails, adoption rule, disclosed protocol amendments |
| `benchmarks/harness.ts` | Composes all of the above into `RESULTS.md` / `results.json` |
| `benchmarks/tune.ts` | Deterministic coordinate ascent over policy weights — train split only |

---

## 3. The world

**8 skills** in a depth-4 prerequisite DAG; **80 items** (10 per skill) spanning
difficulty 0.10–0.95, Bloom levels 1–6, and 40–150 s of expected time. Item
length is deliberately *not* correlated with difficulty, so a policy cannot buy
an easy win by picking long questions.

A learner is a vector of latent per-skill abilities plus memory state. Each
served item runs through:

1. **Retrieval.** `retrievability = exp(-elapsed_days / stability)` — what the
   learner can currently reach, as opposed to what they once knew.
2. **Prerequisite support.** Weak prerequisites depress performance on dependent
   skills, so a policy that skips ahead is punished by the world rather than by
   a scoring convention.
3. **Response.** A 3-parameter IRT-style curve over (effective ability, item
   difficulty, discrimination), squeezed by slip and guess rates.
4. **Fatigue.** After ~18 minutes in a session, performance and acquisition both
   degrade and responses slow down. This is what makes *time* a real budget and
   long sessions genuinely worse than short ones.
5. **Learning.** Ability rises by an amount proportional to remaining headroom
   and to how productive the difficulty was; errors teach too, but less than
   successes. Stability (resistance to forgetting) rises with successful recall.

### Anti-circularity

The world must not be a restatement of the policy's own scoring, or the
benchmark would only prove the policy agrees with itself. Three separations are
enforced:

- The world's gain rule uses a different functional form (headroom exponent
  1.15, asymmetric success/error factor) from the policy's `expectedMasteryGain`.
- The world sees **truth**; the policy sees only noisy estimates from the tracer.
- Prerequisite violations are scored against **true** prerequisite ability,
  which no policy can observe. `eligibleCoverage` likewise.

They remain members of the same model family, which is a real limitation: a
simulator and a policy that both believe in IRT-shaped learning will agree about
more than reality might. §7 lists what would falsify this.

---

## 4. The learner population

Ten archetypes. Five are visible to the weight tuner; five are **never** seen
during tuning and carry the generalisation claim. `protocol.ts` throws at import
time if an id is unknown or the partition is incomplete — archetypes are
resolved by string, so a rename would otherwise silently shrink the population.

| Archetype | Split | Learn | Forget | Slip / Guess | Conf. bias | Fatigue res. | What it stresses |
| :--- | :--- | ---: | ---: | :--- | ---: | ---: | :--- |
| `cold-start-novice` | train | 1.0 | 1.0 | .10 / .20 | 0 | 1.0 | No prior evidence at all — the tracer starts blind |
| `intermediate` | train | 1.0 | 1.0 | .10 / .20 | 0 | 1.0 | The ordinary case |
| `advanced` | train | 1.0 | 1.0 | .08 / .18 | +0.05 | 1.1 | Ceiling effects; needs stretch, not remediation |
| `uneven` | train | 1.0 | 1.0 | .10 / .20 | 0 | 1.0 | Jagged profile — strong and weak skills interleaved |
| `slow-learner` | train | 0.5 | 1.2 | .12 / .20 | −0.10 | 0.7 | Half acquisition, tires fast; wasted items cost double |
| `fast-learner` | **held-out** | 1.9 | 0.8 | .09 / .20 | +0.10 | 1.2 | Outruns the tracer; early ceiling effects |
| `forgetful` | **held-out** | 1.0 | 3.0 | .12 / .20 | 0 | 1.0 | Triple decay — punishes policies that never revisit |
| `overconfident` | **held-out** | 0.9 | 1.1 | .12 / .20 | **+0.75** | 1.0 | Guesses and answers fast; looks better than they are |
| `underconfident` | **held-out** | 1.0 | 0.9 | .10 / .18 | **−0.75** | 0.9 | Rarely guesses, slow; looks worse than they are |
| `high-variance` | **held-out** | 1.0 | 1.0 | .28 / .32 | 0 | 0.9 | Pure response noise — is the signal real? |

### Confidence bias is an estimation attack, not flavour

`confidenceBias` warps slip, guess and response time *without touching latent
ability*, so observed behaviour misrepresents competence in a specific
direction. Measured on the base world:

| | slip | guess | P(correct) on a mid item | response time |
| :--- | ---: | ---: | ---: | ---: |
| `overconfident` (ability 0.28) | 0.255 | 0.365 | 0.499 | 85 s |
| `underconfident` (ability 0.76) | 0.235 | 0.020 | 0.688 | 133 s |

The over-confident learner's guessing lifts a genuinely weak learner to a
coin-flip, while the under-confident learner's refusal to guess drags a strong
one down. Both mislead the tracer, in opposite directions — which is exactly
what produces the finding in §6.3.

### Fatigue

Zero for the first ~18 minutes of a session, then performance degrades by up to
18%, acquisition by up to 35%, and responses slow. `fatigueResistance` scales
the onset per archetype. Fatigue is recorded on every step trace, so any
result can be checked for "did this only happen because the learner was tired?".

---

## 5. Protocol

- **4 sessions × 8 items**, 2 days apart, then a **14-day retention probe**.
- **Common random numbers**: the outcome draw for a given (seed, item, step) is
  identical across policies, so comparisons are paired and differences are not
  luck. All statistics are paired accordingly (bootstrap CI + exact sign test).
- **Splits**: train = 5 archetypes × 4 seeds (20 cells). Held-out = 10
  archetypes × 8 unseen seeds (80 cells) — *primary evidence*. Robustness = 10
  archetypes × 2 further seeds × 5 perturbed worlds (100 cells).
- **Equal-time control**: the item budget quietly rewards a policy for picking
  longer questions, so the whole held-out split is re-run under a 14-minute
  budget as a control.
- **Adoption rule** is pre-registered in `protocol.ts` and evaluated
  mechanically: relative improvement, bootstrap CI lower bound, sign test,
  robustness share, and seven guardrails. `benchmark.test.ts` fails if the
  shipped serving default disagrees with the verdict.

Protocol changes made after seeing results are recorded in
`PROTOCOL_AMENDMENTS`, reproduced in `RESULTS.md`, and emitted to
`results.json` — an amendment a reader cannot see is indistinguishable from
moving the goalposts. There are currently three.

---

## 6. What the environment found

Full numbers in `benchmarks/RESULTS.md`. The three that matter:

### 6.1 Every shippable policy loses to a trivial baseline

Held-out, 80 cells, retained mastery gain:

| Tier | Policy | Retained gain | % of ceiling |
| :--- | :--- | ---: | ---: |
| ceiling | oracle (true p→0.75) | **1.370** | 100% |
| floor | `mastery-gap-only` | **1.135** | 82.8% |
| floor | `random` | 1.061 | 77.4% |
| floor | `difficulty-only` | 0.933 | 68.1% |
| real | **v3** | 0.906 | 66.1% |
| real | v2 | 0.861 | 62.8% |
| real | legacy | 0.776 | 56.7% |

v3 > v2 > legacy holds, and v3 is comfortably the safest policy on
prerequisites (882 violations vs v2's 1336, against the floor's 1088–1221). But
"better than what we shipped last" is a much weaker claim than "good", and a
six-line heuristic captures 83% of achievable learning to v3's 66%.

`mastery-gap-only` is strong because it is an accidental curriculum: always the
*easiest unseen item* in the *least-mastered skill* is weakest-topic-first,
easy-to-hard progression. Its 65% ZPD hit rate is emergent, not designed.

### 6.2 The bottleneck is the response model, not the knowledge tracer

Selection runs through a chain: tracer → mastery estimate → **response model** →
P(correct) → chosen difficulty. Handing the response model a learner whose
mastery *equals true latent ability* — perfect knowledge tracing — it still
over-predicts by **+0.241** (RMSE 0.277, 800 pairs), and the bias grows with
item difficulty (+0.164 on the easiest band, +0.289 on 0.5–0.7).

So a policy asking for an item at P(correct)=0.75 receives one the learner
passes far less often. The harder a policy aims at the productive band, the
further past it it overshoots — while a heuristic that ignores the model lands
inside. Measured across policies: all of them predict ≈0.72–0.82 and deliver a
true 0.34–0.56.

**This explains the original v2 paradox**: v2 improved every estimation metric
(RMSE 0.229→0.186) yet produced no learning gain, because it improved link 1 of
a chain broken at link 2. The defect is invisible to RMSE, Brier and ECE because
it is not the tracer's error.

> The bias is measured *relative to this synthetic world* — it says the response
> model disagrees with the simulator's IRT process, not that it is wrong about
> real learners. **Do not recalibrate the shipped model against these numbers.**
> Run `probeResponseModelCalibration`'s equivalent against production telemetry
> first; fitting a production model to a fiction would be worse than the status
> quo.

### 6.3 Mis-estimated learners never get promoted

4 of v3's 5 neglected-but-eligible skills come from `underconfident`. That
learner has high true ability (0.76) and almost never guesses, so it fails items
it could pass, the tracer under-estimates it, and the prerequisite gate never
believes it is ready for the deepest skills. Under-confidence is therefore not
just a measurement problem — it becomes a *curriculum* problem, capping how far
a learner is allowed to progress.

### 6.4 World validation

Before trusting any ZPD-shaped objective, the world has to reward difficulty
targeting. Sweeping the oracle's target success probability gives an **interior
optimum at ≈0.70** (retained gain 1.43) against 0.80 at the hardest setting and
1.36 at the easiest. Serving trivial questions does not maximise learning here,
so the premise is justified rather than assumed.

Two caveats kept with the finding: the top is *flat* (0.60–0.80 are within a few
percent, so `successTarget = 0.75` is inside the plateau but not uniquely
optimal), and the curve stops falling at the easy end because the bank runs out
of items that easy — the oracle cannot find anything above true p≈0.87.

---

## 7. Limitations

The environment is built to be falsifiable. It would be wrong if:

- **The learning rule is wrong.** Gain ∝ remaining headroom × productive-difficulty
  efficiency is a modelling choice. Real acquisition may be more threshold-like,
  more insight-driven, or more sensitive to instruction than to item selection.
- **Prerequisites are too strong.** The world makes prerequisite gaps directly
  depress performance. If real prerequisite effects are weaker, v3's
  prerequisite safety is worth less than it looks here.
- **The item bank is too clean.** 80 items, uniform difficulty coverage, no
  mislabelled difficulties, no duplicates, no bad distractors. Real banks are
  none of these.
- **The population is a guess.** Ten archetypes with hand-chosen traits are a
  caricature of a real cohort. They were chosen to span failure modes, not to
  match any measured distribution.
- **Simulation and policy share a model family.** Both assume IRT-shaped
  responses. A world built on a genuinely different theory of learning could
  reorder these policies.

What the environment *is* good for: catching regressions, comparing selection
policies under an explicit and inspectable set of assumptions, localising a
defect to a specific component (§6.2), and producing the metric plumbing a real
trial would need.

What it is *not* good for: any claim about human learning outcomes.

---

## 8. Extending it

- **New archetype** — add to `ARCHETYPES` in `world.ts`, then add its id to
  exactly one of `TRAIN_ARCHETYPE_IDS` / `HELD_OUT_ONLY_ARCHETYPE_IDS` in
  `protocol.ts`. The import-time guard will throw until you do.
- **New baseline** — implement `BenchPolicy` in `policies.ts` and add it to
  `BASELINE_POLICIES`. Baselines must not read `ctx.truth`; a test enforces
  this by scanning the source.
- **New metric** — add to `CellMetrics` in `simulate.ts` and to `REPORT_METRICS`
  in `protocol.ts`. Add it to `GUARDRAILS` only if a regression in it should
  block adoption.
- **Re-tuning** — `npm run bench:tune` reads the train split only and prints a
  patch for `src/lib/ml/policy/weights.ts`. It must never see held-out cells.

After any change: `npm run bench` to regenerate the report, and commit the
regenerated `RESULTS.md` / `results.json` with the code change.
