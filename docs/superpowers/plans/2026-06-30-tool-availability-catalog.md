# Tool Availability Catalog Implementation Plan

> This index intentionally contains only phase document paths. Open exactly one phase document when implementing or validating that phase, to avoid mixing changes across phases.

**Source Spec:** [`docs/superpowers/specs/2026-06-30-tool-availability-catalog-design.md`](../specs/2026-06-30-tool-availability-catalog-design.md)

## Phase Documents

1. [Task 1: ToolCatalogStore Core](./2026-06-30-tool-availability-catalog-phase1-tool-catalog-store.md)
2. [Task 2: RuntimePlan Catalog Resolution](./2026-06-30-tool-availability-catalog-phase2-runtime-plan-catalog.md)
3. [Task 3: Tool Contract Header Rendering](./2026-06-30-tool-availability-catalog-phase3-tool-contract-header.md)
4. [Task 4: Non-Streaming Availability Drift Retry](./2026-06-30-tool-availability-catalog-phase4-availability-drift-retry.md)
5. [Task 5: Forwarder Retry Hook and Diagnostics](./2026-06-30-tool-availability-catalog-phase5-forwarder-diagnostics.md)
6. [Task 6: Final Regression and Probe Prep](./2026-06-30-tool-availability-catalog-phase6-final-regression-probe.md)

## Execution Rule

- Implement and validate one phase at a time.
- Do not open or follow later phase documents during an earlier phase.
- Do not mix file changes from multiple phases in one validation batch.
- If a later-phase change already exists in the working tree, leave it unvalidated until its phase review.
