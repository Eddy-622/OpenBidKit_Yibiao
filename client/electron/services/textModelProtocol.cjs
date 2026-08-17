const TEXT_API_PROTOCOLS = ['openai-compatible', 'anthropic-messages'];
const DEFAULT_TEXT_API_PROTOCOL = 'openai-compatible';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS_CAP = 32768;
const ANTHROPIC_CONTINUE_USER_CONTENT = '（继续）';

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function normalizeTextApiProtocol(value, provider) {
  if (provider && provider !== 'custom') {
    return DEFAULT_TEXT_API_PROTOCOL;
  }
  return value === 'anthropic-messages' ? 'anthropic-messages' : DEFAULT_TEXT_API_PROTOCOL;
}

function resolveTextApiProtocol(config) {
  return normalizeTextApiProtocol(config?.api_protocol, config?.text_model_provider);
}

function isAnthropicMessagesProtocol(config) {
  return resolveTextApiProtocol(config) === 'anthropic-messages';
}

function getTextChatUrl(config) {
  const baseUrl = trimBaseUrl(config?.base_url);
  return isAnthropicMessagesProtocol(config)
    ? `${baseUrl}/messages`
    : `${baseUrl}/chat/completions`;
}

function getTextModelsUrl(config) {
  return `${trimBaseUrl(config?.base_url)}/models`;
}

function createTextRequestHeaders(config) {
  if (isAnthropicMessagesProtocol(config)) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': config?.api_key || '',
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config?.api_key || ''}`,
  };
}

function resolveAnthropicMaxTokens(config) {
  const limit = Number(config?.context_length_limit);
  const normalized = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : ANTHROPIC_MAX_TOKENS_CAP;
  return Math.min(ANTHROPIC_MAX_TOKENS_CAP, normalized);
}

function extractOpenAiMessageText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }

  return content == null ? '' : String(content);
}

function buildAnthropicMessagesRequest(config, sourceBody) {
  const source = sourceBody && typeof sourceBody === 'object' ? sourceBody : {};
  const sourceMessages = Array.isArray(source.messages) ? source.messages : [];
  const systemParts = [];
  const conversation = [];

  sourceMessages.forEach((message) => {
    const role = message?.role;
    const text = extractOpenAiMessageText(message?.content);
    if (role === 'system') {
      if (text) {
        systemParts.push(text);
      }
      return;
    }

    if (role !== 'user' && role !== 'assistant') {
      return;
    }

    const last = conversation[conversation.length - 1];
    if (last && last.role === role) {
      last.content = last.content ? `${last.content}\n\n${text}` : text;
      return;
    }

    conversation.push({ role, content: text });
  });

  if (conversation[0]?.role === 'assistant') {
    conversation.unshift({ role: 'user', content: ANTHROPIC_CONTINUE_USER_CONTENT });
  }

  const body = {
    model: config?.model_name || source.model,
    max_tokens: resolveAnthropicMaxTokens(config),
    messages: conversation,
  };

  if (systemParts.length) {
    body.system = systemParts.join('\n\n');
  }

  if (source.stream) {
    body.stream = true;
  }

  return body;
}

function extractAnthropicTextContent(responseData) {
  const blocks = Array.isArray(responseData?.content) ? responseData.content : [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function mapAnthropicUsage(usage) {
  const source = usage || {};
  const promptTokens = Number(source.input_tokens ?? source.prompt_tokens ?? 0);
  const completionTokens = Number(source.output_tokens ?? source.completion_tokens ?? 0);
  const cachedTokens = Number(source.cache_read_input_tokens ?? 0);

  return {
    prompt_tokens: Number.isFinite(promptTokens) && promptTokens > 0 ? Math.floor(promptTokens) : 0,
    completion_tokens: Number.isFinite(completionTokens) && completionTokens > 0 ? Math.floor(completionTokens) : 0,
    total_tokens: (Number.isFinite(promptTokens) && promptTokens > 0 ? Math.floor(promptTokens) : 0)
      + (Number.isFinite(completionTokens) && completionTokens > 0 ? Math.floor(completionTokens) : 0),
    cache_read_input_tokens: Number.isFinite(cachedTokens) && cachedTokens > 0 ? Math.floor(cachedTokens) : 0,
    input_tokens: source.input_tokens,
    output_tokens: source.output_tokens,
  };
}

function mergeAnthropicUsage(current, nextUsage) {
  const mapped = mapAnthropicUsage({
    input_tokens: nextUsage?.input_tokens ?? current.prompt_tokens,
    output_tokens: nextUsage?.output_tokens ?? current.completion_tokens,
    cache_read_input_tokens: nextUsage?.cache_read_input_tokens ?? current.cache_read_input_tokens,
  });
  return mapped;
}

function toInternalChatResult(responseData) {
  const usage = mapAnthropicUsage(responseData?.usage);
  return {
    content: extractAnthropicTextContent(responseData),
    usage,
    responseData,
  };
}

function mapAnthropicStopReason(reason) {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'end_turn' || reason === 'stop_sequence' || !reason) return 'stop';
  return String(reason);
}

function anthropicMessageToOpenAiCompletion(responseData) {
  const content = extractAnthropicTextContent(responseData);
  const usage = mapAnthropicUsage(responseData?.usage);
  return {
    id: responseData?.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    model: responseData?.model || '',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: mapAnthropicStopReason(responseData?.stop_reason),
    }],
    usage,
  };
}

function createAnthropicSseError(payload, data) {
  const message = payload?.error?.message || payload?.message || 'AI 流式请求失败';
  const error = new Error(message);
  error.raw_response_payload = payload;
  error.raw_sse_data = data;
  return error;
}

function parseSseJsonData(data, parseErrorMessage) {
  try {
    return JSON.parse(data);
  } catch (error) {
    const parseError = new Error(`${parseErrorMessage || 'AI 流式响应解析失败'}：${error.message}`);
    parseError.raw_response_body = data;
    throw parseError;
  }
}

function consumeAnthropicSsePayload(payload, handlers) {
  if (payload?.type === 'error' || (payload?.error && !payload?.type)) {
    handlers.onError?.(payload);
    return 'error';
  }

  if (payload?.type === 'message_start') {
    handlers.onMessageStart?.(payload.message);
    return;
  }

  if (payload?.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
    const text = typeof payload.delta.text === 'string' ? payload.delta.text : '';
    if (text) {
      handlers.onTextDelta?.(text);
    }
    return;
  }

  if (payload?.type === 'message_delta') {
    handlers.onUsage?.(payload.usage);
    if (payload.delta?.stop_reason) {
      handlers.onStopReason?.(payload.delta.stop_reason);
    }
    return;
  }

  if (payload?.type === 'message_stop') {
    handlers.onStop?.();
    return 'done';
  }
}

async function readSseDataLines(response, onData, options = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error(options.unreadableMessage || 'AI 流式响应不可读');
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let done = false;

  async function processLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
      return;
    }

    const data = trimmed.slice(5).trim();
    if (!data) {
      return;
    }

    const result = await onData(data);
    if (result === 'done') {
      done = true;
    }
  }

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      await processLine(line);
      if (done) {
        break;
      }
    }
  }

  buffer += decoder.decode();
  if (!done && buffer.trim()) {
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      await processLine(line);
      if (done) {
        break;
      }
    }
  }
}

async function readAnthropicMessageStream(response) {
  const contentParts = [];
  let usage = mapAnthropicUsage(null);
  let messageId = '';
  let model = '';

  await readSseDataLines(response, async (data) => {
    if (data === '[DONE]') {
      return 'done';
    }

    const payload = parseSseJsonData(data, 'AI 流式响应解析失败');
    const result = consumeAnthropicSsePayload(payload, {
      onError(errorPayload) {
        throw createAnthropicSseError(errorPayload, data);
      },
      onMessageStart(message) {
        if (message?.id) {
          messageId = message.id;
        }
        if (message?.model) {
          model = message.model;
        }
        if (message?.usage) {
          usage = mergeAnthropicUsage(usage, message.usage);
        }
      },
      onTextDelta(text) {
        contentParts.push(text);
      },
      onUsage(nextUsage) {
        usage = mergeAnthropicUsage(usage, nextUsage);
      },
    });
    return result;
  });

  const content = contentParts.join('');
  return {
    content,
    usage,
    responseData: {
      id: messageId,
      model,
      stream: true,
      content: [{ type: 'text', text: content }],
      usage,
    },
  };
}

function createAnthropicToOpenAiSseStream(source) {
  if (!source?.getReader) {
    throw new Error('AI 流式响应不可读');
  }

  const reader = source.getReader();
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();
  let buffer = '';
  let completionId = `chatcmpl-${Date.now()}`;
  let usage = mapAnthropicUsage(null);
  let finished = false;

  function encodeSse(payload) {
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function chunkPayload(delta, finishReason = null, includeUsage = false) {
    const payload = {
      id: completionId,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    };
    if (includeUsage) {
      payload.usage = usage;
    }
    return payload;
  }

  async function processLine(controller, line) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
      return;
    }

    const data = trimmed.slice(5).trim();
    if (!data) {
      return;
    }

    if (data === '[DONE]') {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      finished = true;
      return;
    }

    const payload = parseSseJsonData(data, 'AI 流式响应解析失败');
    const result = consumeAnthropicSsePayload(payload, {
      onError(errorPayload) {
        throw createAnthropicSseError(errorPayload, data);
      },
      onMessageStart(message) {
        if (message?.id) {
          completionId = message.id;
        }
        if (message?.usage) {
          usage = mergeAnthropicUsage(usage, message.usage);
        }
      },
      onTextDelta(text) {
        controller.enqueue(encodeSse(chunkPayload({ content: text })));
      },
      onUsage(nextUsage) {
        usage = mergeAnthropicUsage(usage, nextUsage);
      },
      onStop() {
        controller.enqueue(encodeSse(chunkPayload({}, 'stop', true)));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        finished = true;
      },
    });

    if (result === 'done') {
      finished = true;
    }
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        while (!finished) {
          const { value, done } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) {
              const lines = buffer.split(/\r?\n/);
              for (const line of lines) {
                await processLine(controller, line);
                if (finished) {
                  break;
                }
              }
            }
            if (!finished) {
              controller.enqueue(encodeSse(chunkPayload({}, 'stop', true)));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            await processLine(controller, line);
            if (finished) {
              controller.close();
              return;
            }
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // 上游取消失败不影响代理关闭。
      }
    },
  });
}

function copyUpstreamResponseHeaders(response, fallbackContentType) {
  const headers = {
    'content-type': response.headers.get('content-type') || fallbackContentType,
  };
  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) {
    headers['cache-control'] = cacheControl;
  }
  const requestId = response.headers.get('x-request-id');
  if (requestId) {
    headers['x-request-id'] = requestId;
  }
  return headers;
}

async function translateAnthropicResponseToOpenAI(response, options = {}) {
  if (options.stream) {
    return new Response(createAnthropicToOpenAiSseStream(response.body), {
      status: response.status,
      headers: copyUpstreamResponseHeaders(response, 'text/event-stream; charset=utf-8'),
    });
  }

  const responseData = await response.json();
  return new Response(JSON.stringify(anthropicMessageToOpenAiCompletion(responseData)), {
    status: response.status,
    headers: copyUpstreamResponseHeaders(response, 'application/json; charset=utf-8'),
  });
}

module.exports = {
  TEXT_API_PROTOCOLS,
  DEFAULT_TEXT_API_PROTOCOL,
  ANTHROPIC_VERSION,
  ANTHROPIC_MAX_TOKENS_CAP,
  trimBaseUrl,
  normalizeTextApiProtocol,
  resolveTextApiProtocol,
  isAnthropicMessagesProtocol,
  getTextChatUrl,
  getTextModelsUrl,
  createTextRequestHeaders,
  resolveAnthropicMaxTokens,
  buildAnthropicMessagesRequest,
  extractAnthropicTextContent,
  mapAnthropicUsage,
  toInternalChatResult,
  anthropicMessageToOpenAiCompletion,
  readAnthropicMessageStream,
  translateAnthropicResponseToOpenAI,
};
