/**
 * ESLint custom rule: no-adapter-tool-injection
 *
 * Forbids Provider Adapter files from importing tool injection symbols
 * owned exclusively by ToolCallingEngine.
 *
 * INV-001: ToolCallingEngine is the sole owner of tool prompt injection.
 * Provider Adapters must never import:
 *   - hasToolPromptInjected
 *   - toolsToSystemPrompt
 *   - TOOL_WRAP_HINT
 *   - shouldInjectToolPrompt
 *
 * Applies to: src/main/proxy/adapters/** (configurable via options.pattern)
 */

'use strict'

const FORBIDDEN_IMPORTS = new Set([
  'hasToolPromptInjected',
  'toolsToSystemPrompt',
  'TOOL_WRAP_HINT',
  'shouldInjectToolPrompt',
])

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid Provider Adapter imports of tool injection symbols owned by ToolCallingEngine',
      recommended: false,
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedPatterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Import source patterns that are allowed (e.g., comments containing the name)',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbiddenImport:
        'Provider Adapters must not import "{{name}}". Tool prompt injection is owned by ToolCallingEngine (INV-001).',
      forbiddenModule:
        'Provider Adapters must not import from "{{source}}". The entire "utils/tools" module is owned by ToolCallingEngine (INV-001).',
    },
  },

  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value
        if (source.includes('utils/tools')) {
          context.report({
            node,
            messageId: 'forbiddenModule',
            data: { source },
          })
        }
      },
      ImportSpecifier(node) {
        if (FORBIDDEN_IMPORTS.has(node.imported.name)) {
          context.report({
            node,
            messageId: 'forbiddenImport',
            data: { name: node.imported.name },
          })
        }
      },
      ImportDefaultSpecifier(node) {
        const source = context.sourceCode.getText(node.parent.source)
        for (const forbidden of FORBIDDEN_IMPORTS) {
          if (source.includes(forbidden)) {
            context.report({
              node,
              messageId: 'forbiddenImport',
              data: { name: forbidden },
            })
          }
        }
      },
      ImportNamespaceSpecifier(node) {
        const source = context.sourceCode.getText(node.parent.source)
        for (const forbidden of FORBIDDEN_IMPORTS) {
          if (source.includes(forbidden)) {
            context.report({
              node,
              messageId: 'forbiddenImport',
              data: { name: forbidden },
            })
          }
        }
      },
    }
  },
}
