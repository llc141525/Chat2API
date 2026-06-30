# Tool Availability Catalog Phase 3: Tool Contract Header Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source Spec:** [`docs/superpowers/specs/2026-06-30-tool-availability-catalog-design.md`](../specs/2026-06-30-tool-availability-catalog-design.md)

**Parent Index:** [`docs/superpowers/plans/2026-06-30-tool-availability-catalog.md`](./2026-06-30-tool-availability-catalog.md)

## Phase Isolation Rule

- This document contains only Phase 3: Tool Contract Header Rendering.
- Do not implement files or steps from other Phase 7 plan documents while executing or validating this phase.
- If working tree changes from another phase already exist, leave them unvalidated until their own phase review.

### Task 3: Tool Contract Header Rendering

**Files:**
- Modify: `src/main/proxy/toolCalling/protocols/managedXml.ts`
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- Modify: `tests/tool-calling/tool-engine.test.ts`
- Modify: `tests/tool-calling/provider-profiles.test.ts`

- [ ] **Step 1: Add failing prompt header test**

Append to `tests/tool-calling/tool-engine.test.ts`:

```ts
test('managed prompt includes Tool Contract Header from catalog snapshot', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-header`,
  })

  const content = result.messages[0].content as string
  assert.match(content, /Tool Contract Header/)
  assert.match(content, /contract_header_version: 1/)
  assert.match(content, new RegExp(`catalog_fingerprint: ${result.plan.catalogSnapshot?.fingerprint}`))
  assert.match(content, /allowed_tools: default_api:list_dir, default_api:read_file/)
  assert.match(content, /The tools listed in this contract are available for this turn/)
})
```

- [ ] **Step 2: Run the failing header test**

Run:

```powershell
node --test tests/tool-calling/tool-engine.test.ts
```

Expected: FAIL because the prompt does not contain `Tool Contract Header`.

- [ ] **Step 3: Add contract render input to managed XML protocol**

Modify `src/main/proxy/toolCalling/protocols/managedXml.ts` by adding:

```ts
export interface ManagedXmlContractHeaderInput {
  catalogFingerprint: string
  allowedToolNames: string[]
  protocol: string
  contractHeaderVersion: number
}

export function renderManagedXmlContractHeader(input: ManagedXmlContractHeaderInput): string {
  return [
    'Tool Contract Header',
    `contract_header_version: ${input.contractHeaderVersion}`,
    `protocol: ${input.protocol}`,
    `catalog_fingerprint: ${input.catalogFingerprint}`,
    `allowed_tools: ${input.allowedToolNames.join(', ')}`,
    'The tools listed in this contract are available for this turn because they were provided by the runtime.',
  ].join('\n')
}
```

Do not add drift recovery instructions to this header.

- [ ] **Step 4: Render prompt from catalog snapshot in ToolCallingEngine**

Modify `src/main/proxy/toolCalling/ToolCallingEngine.ts`:

```ts
import { getProviderToolProfile } from './providerProfiles.ts'
import { renderManagedXmlContractHeader } from './protocols/managedXml.ts'
```

Change the render call:

```ts
      messages: injectPrompt(request.messages, renderPrompt(plan, this.config)),
```

Replace `renderPrompt` with:

```ts
function renderPrompt(
  plan: ToolCallingPlan,
  config: ToolCallingConfig,
): string {
  const prompt = getToolProtocol(plan.protocol).renderPrompt(plan.tools)
  const profile = getProviderToolProfile(plan.providerId)
  const contractHeader = plan.catalogSnapshot
    ? renderManagedXmlContractHeader({
        catalogFingerprint: plan.catalogSnapshot.fingerprint,
        allowedToolNames: plan.catalogSnapshot.allowedToolNames,
        protocol: plan.protocol,
        contractHeaderVersion: profile.contractHeaderVersion,
      })
    : ''
  const fullPrompt = contractHeader ? `${contractHeader}\n\n${prompt}` : prompt
  const customPromptTemplate = config.diagnosticsEnabled
    ? config.advanced.customPromptTemplate
    : undefined
  if (!customPromptTemplate) return fullPrompt

  return customPromptTemplate
    .replace(/\{\{tools\}\}/g, fullPrompt)
    .replace(/\{\{tool_names\}\}/g, plan.tools.map((tool) => tool.name).join(', '))
    .replace(/\{\{format\}\}/g, plan.protocol)
}
```

- [ ] **Step 5: Add provider profile defaults test**

Append to `tests/tool-calling/provider-profiles.test.ts`:

```ts
test('managed provider profiles expose contract header and availability retry defaults', () => {
  for (const providerId of ['qwen', 'qwen-ai', 'glm']) {
    const profile = getProviderToolProfile(providerId)
    assert.equal(profile.preferredManagedProtocol, 'managed_xml')
    assert.equal(profile.contractHeaderVersion, 1)
    assert.equal(profile.availabilityDriftRetry, 'enabled')
  }
})
```

- [ ] **Step 6: Run focused tests**

Run:

```powershell
node --test tests/tool-calling/provider-profiles.test.ts tests/tool-calling/tool-engine.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit contract header rendering**

```powershell
git add src/main/proxy/toolCalling/protocols/managedXml.ts src/main/proxy/toolCalling/ToolCallingEngine.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/provider-profiles.test.ts
git commit -m "feat: inject tool contract header"
```

---
