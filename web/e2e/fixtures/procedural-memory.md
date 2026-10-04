What if an AI agent could improve from user traffic—without retraining the model?

A new paper from Adobe and Brown University explores exactly that:
“Evolving Procedural Memory from User Traffic for Agentic Graphic Design”

👉 WHY

Professional graphic design is not simply “generate an image.” An agent must retrieve assets, edit typography, create masks, manipulate vectors, arrange layouts, inspect intermediate results, and preserve an editable document across many dependent actions.

Learning from outcomes is hard because there’s no reliable test for “good design.” A result can meet objectives yet fail on hierarchy, composition, or style.

The paper asks: instead of changing the model, can we improve the knowledge around it?

👉 WHAT

The researchers keep the foundation model frozen and evolve an external procedural memory: a bank of natural-language playbooks called skills.

A skill sits between a single tool call and a full trajectory. It describes a reusable procedure—e.g., creating double exposure, extracting a silhouette, or composing assets with masks.

The bank evolves in two ways:
• Widening: adds skills for recurring tasks not yet covered.
• Deepening: repairs existing skills by comparing successful and failed executions.

Widening expands what the agent can attempt; deepening makes those procedures more reliable.

👉 HOW

A frozen model controls equivalents of Photoshop, Illustrator, and InDesign through 230+ tools.

After each trajectory:
1. A multimodal grader checks brief completeness and visual quality.
2. Repeated uncovered subtasks are clustered into candidate skills.
3. Failure-prone skills are revised using successful executions as “do not regress” references.
4. Every proposed change enters a matched replay gate.

The gate is the key safety mechanism: candidate and incumbent skills run on the same prompts with the same assets and context. A change ships only if it improves at least one replayed case and causes no detected regression.

Results across five rounds: 1,406 briefs and 1,869 automatically graded trajectories—with no weight updates and no human reward labels. The skill bank grew from 76 to 139 skills.

On Claude Sonnet 4:
• GenEval2 execution success: 72.7% → 99.3%
• Generation quality: +11.99 points
• Evolved agent win rate vs. no-skill agent on specialized benchmarks: 61.8%

Claude Opus 4.6 reached a 67.6% win rate.

Notably, widening or deepening alone barely beat the baseline (49.4% and 48.6%). Combined, they reached 58.5%.

Broader lesson

Continual agent improvement may not require changing model weights. A practical learning target can be an interpretable library of procedures—expanded by new experience, repaired after failure, and protected by regression testing.

For agents in open-ended environments, learning what to remember (procedures) may be as important as learning new parameters.