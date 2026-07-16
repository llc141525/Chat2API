import type {
  ChatCompletionChoice,
  ChatCompletionResponse,
} from '../../../types.ts'
import type { OpenAIResponseMapperInput, OpenAIStreamChunk } from '../types.ts'

export function mapNonStreamOpenAIResponse(input: OpenAIResponseMapperInput): ChatCompletionResponse {
  return {
    id: input.id,
    object: 'chat.completion',
    created: input.created,
    model: input.model,
    choices: [mapNonStreamChoice(input)],
  }
}

export function mapStreamOpenAIResponseChunks(input: OpenAIResponseMapperInput): OpenAIStreamChunk[] {
  const baseChunk = {
    id: input.id,
    object: 'chat.completion.chunk' as const,
    created: input.created,
    model: input.model,
  }

  const roleChunk: OpenAIStreamChunk = {
    ...baseChunk,
    choices: [{
      index: 0,
      delta: { role: 'assistant' },
      finish_reason: null,
    }],
  }

  if (input.input.kind === 'valid_tool_calls') {
    return [
      roleChunk,
      {
        ...baseChunk,
        choices: [{
          index: 0,
          delta: { tool_calls: input.input.toolCalls },
          finish_reason: null,
        }],
      },
      {
        ...baseChunk,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'tool_calls',
        }],
      },
    ]
  }

  const content = input.input.kind === 'plain_text'
    ? input.input.content
    : input.input.safeMessage

  return [
    roleChunk,
    {
      ...baseChunk,
      choices: [{
        index: 0,
        delta: { content },
        finish_reason: null,
      }],
    },
    {
      ...baseChunk,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    },
  ]
}

function mapNonStreamChoice(input: OpenAIResponseMapperInput): ChatCompletionChoice {
  if (input.input.kind === 'valid_tool_calls') {
    return {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: input.input.toolCalls,
      },
      finish_reason: 'tool_calls',
    }
  }

  return {
    index: 0,
    message: {
      role: 'assistant',
      content: input.input.kind === 'plain_text' ? input.input.content : input.input.safeMessage,
    },
    finish_reason: 'stop',
  }
}
