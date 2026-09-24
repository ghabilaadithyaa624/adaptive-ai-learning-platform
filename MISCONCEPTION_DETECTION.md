# Structured misconception detection

The source of truth is authored distractor metadata plus deterministic response telemetry—not an LLM. Each hypothesis contains skill, optional subskill, selected distractors, optional linked prerequisite, error classification, distinct-item evidence count, confidence, first/last observation, and supporting question IDs.

## Confidence and false-positive controls

- One distinct item: `LOW`, `isolated_mistake`.
- Two distinct items with the same authored misconception: `MEDIUM`.
- Three or more distinct items: `HIGH` only when the evidence is a repeated content pattern.
- Retries on one question count once.
- Missing authored misconception metadata produces no semantic hypothesis.
- Predominantly fast errors are classified as `careless_error`, not promoted to a high-confidence content misconception.
- Authored prerequisite links produce `prerequisite_weakness`.
- A substantial fall from previously high mastery produces `knowledge_decay`.
- No hypothesis plus thin response evidence remains `insufficient-data` in the existing error profile.

The detector recomputes hypotheses from immutable response evidence, making first/last observation and confidence auditable. Question authoring may optionally link a distractor to `prerequisiteSkillId`; validation rejects unknown skills.

## Product integration

- **Learner state:** every skill carries structured hypotheses alongside—not in place of—the existing error profile.
- **Recommendations:** medium/high repeated misconceptions yield targeted practice; prerequisite hypotheses route remediation upstream. Low-confidence hypotheses never change the recommendation action.
- **Remediation:** deterministic tutor policy chooses conceptual remediation for repeated misconceptions and scaffolding for prerequisite weakness.
- **Tutor context:** structured hypotheses are read-only. Both deterministic and generative tutors may explain a medium/high hypothesis and its evidence. Policy explicitly forbids changing mastery or promoting confidence. Only graded responses update mastery.
- **Selection:** v3 receives authored item misconception tags. A medium/high repeated hypothesis gives a small, transparent alignment nudge inside difficulty appropriateness. It cannot override prerequisite/no-repeat/exposure gates and low-confidence or careless evidence receives no nudge.

No LLM output feeds hypothesis confidence, learner mastery, or item selection labels.
