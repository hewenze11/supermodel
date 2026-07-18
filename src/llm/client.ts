import { LLMMessage } from '../engine/message-list';

export interface LLMClientConfig {
  provider_type: 'openai' | 'anthropic';
  model: string;
  api_key: string;
  base_url?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionRequest {
  messages: LLMMessage[];
  model: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: {
    include_usage: boolean;
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

export interface Choice {
  index: number;
  message?: LLMMessage;
  delta?: LLMMessage;
  finish_reason: string | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

export class LLMClient {
  private config: LLMClientConfig;
  
  constructor(config: LLMClientConfig) {
    this.config = config;
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    // Determine the actual model to use (prefer request.model, fall back to config.model)
    const model = request.model || this.config.model;
    
    // Prepare the request
    const preparedRequest: ChatCompletionRequest = {
      ...request,
      model,
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.max_tokens ?? this.config.max_tokens,
      stream: false, // Non-streaming for this method
    };

    if (this.config.provider_type === 'openai') {
      return await this.callOpenAI(preparedRequest);
    } else if (this.config.provider_type === 'anthropic') {
      return await this.callAnthropic(preparedRequest);
    } else {
      throw new Error(`Unsupported provider type: ${this.config.provider_type}`);
    }
  }

  async *streamChatCompletion(request: ChatCompletionRequest): AsyncGenerator<StreamChunk, void, void> {
    // Determine the actual model to use
    const model = request.model || this.config.model;
    
    // Prepare the request
    const preparedRequest: ChatCompletionRequest = {
      ...request,
      model,
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.max_tokens ?? this.config.max_tokens,
      stream: true,
      stream_options: request.stream_options ?? { include_usage: true }
    };

    if (this.config.provider_type === 'openai') {
      yield* this.streamOpenAI(preparedRequest);
    } else if (this.config.provider_type === 'anthropic') {
      yield* this.streamAnthropic(preparedRequest);
    } else {
      throw new Error(`Unsupported provider type: ${this.config.provider_type}`);
    }
  }

  private async callOpenAI(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout
    
    try {
      const baseUrl = this.config.base_url || 'https://api.openai.com/v1';
      
      // Mask authorization header for logging
      const requestHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.api_key.replace(/^(.{4}).*(.{4})$/, '$1***$2')}` // Mask API key
      };
      
      console.log(`Making request to OpenAI API: ${baseUrl}/chat/completions with headers: ${JSON.stringify(requestHeaders)}`);
      
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.api_key}`
        },
        body: JSON.stringify({
          ...request,
          stream: false
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Don't expose the actual error body to prevent leaking sensitive information
        console.error(`OpenAI API error: ${response.status}`);
        throw new Error('Upstream API error');
      }

      const data = await response.json();
      return data as ChatCompletionResponse;
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error('Request timed out');
      }
      // Don't expose internal error details to prevent information leakage
      console.error('Error calling OpenAI API:', (error as Error).message);
      throw new Error('Upstream API error');
    }
  }

  private async *streamOpenAI(request: ChatCompletionRequest): AsyncGenerator<StreamChunk, void, void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout for streaming
    
    try {
      const baseUrl = this.config.base_url || 'https://api.openai.com/v1';
      
      // Mask authorization header for logging
      const requestHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.api_key.replace(/^(.{4}).*(.{4})$/, '$1***$2')}` // Mask API key
      };
      
      console.log(`Making streaming request to OpenAI API: ${baseUrl}/chat/completions with headers: ${JSON.stringify(requestHeaders)}`);
      
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.api_key}`
        },
        body: JSON.stringify({
          ...request,
          stream: true
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Don't expose the actual error body to prevent leaking sensitive information
        console.error(`OpenAI API error: ${response.status}`);
        throw new Error('Upstream API error');
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process each complete line
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.substring(0, newlineIndex);
            buffer = buffer.substring(newlineIndex + 1);

            if (line.startsWith('data: ')) {
              const dataStr = line.substring(6); // Remove 'data: ' prefix
              
              if (dataStr.trim() === '[DONE]') {
                return;
              }
              
              try {
                const chunk = JSON.parse(dataStr) as StreamChunk;
                yield chunk;
              } catch (e) {
                console.error('Error parsing SSE data:', e);
                console.error('Data:', dataStr);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error('Request timed out');
      }
      // Don't expose internal error details to prevent information leakage
      console.error('Error in OpenAI streaming:', (error as Error).message);
      throw new Error('Upstream API error');
    }
  }

  private async callAnthropic(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout
    
    try {
      // Convert OpenAI-style messages to Anthropic format
      const anthropicMessages = this.convertToAnthropicFormat(request.messages);
      const systemMessage = request.messages.filter(m => m.role === 'system')[0]?.content || '';
      
      // Remove system messages from the converted messages
      const filteredMessages = anthropicMessages.filter(m => m.role !== 'system');
      
      const baseUrl = this.config.base_url || 'https://api.anthropic.com/v1';
      
      // Mask authorization header for logging
      const requestHeaders = {
        'Content-Type': 'application/json',
        'x-api-key': this.config.api_key.replace(/^(.{4}).*(.{4})$/, '$1***$2'), // Mask API key
        'anthropic-version': '2023-06-01'
      };
      
      console.log(`Making request to Anthropic API: ${baseUrl}/messages with headers: ${JSON.stringify(requestHeaders)}`);
      
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.api_key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: request.model,
          messages: filteredMessages,
          max_tokens: request.max_tokens || 1024,
          temperature: request.temperature,
          system: systemMessage || undefined
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Don't expose the actual error body to prevent leaking sensitive information
        console.error(`Anthropic API error: ${response.status}`);
        throw new Error('Upstream API error');
      }

      const data = await response.json();
      
      // Convert Anthropic response to OpenAI format
      return this.convertAnthropicToOpenAI(data, request.model);
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error('Request timed out');
      }
      // Don't expose internal error details to prevent information leakage
      console.error('Error calling Anthropic API:', (error as Error).message);
      throw new Error('Upstream API error');
    }
  }

  private async *streamAnthropic(request: ChatCompletionRequest): AsyncGenerator<StreamChunk, void, void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout for streaming
    
    try {
      // Convert OpenAI-style messages to Anthropic format
      const anthropicMessages = this.convertToAnthropicFormat(request.messages);
      const systemMessage = request.messages.filter(m => m.role === 'system')[0]?.content || '';
      
      // Remove system messages from the converted messages
      const filteredMessages = anthropicMessages.filter(m => m.role !== 'system');
      
      const baseUrl = this.config.base_url || 'https://api.anthropic.com/v1';
      
      // Mask authorization header for logging
      const requestHeaders = {
        'Content-Type': 'application/json',
        'x-api-key': this.config.api_key.replace(/^(.{4}).*(.{4})$/, '$1***$2'), // Mask API key
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'messages-2023-12-15'  // Enable beta streaming features if needed
      };
      
      console.log(`Making streaming request to Anthropic API: ${baseUrl}/messages with headers: ${JSON.stringify(requestHeaders)}`);
      
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.api_key,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'messages-2023-12-15'  // Enable beta streaming features if needed
        },
        body: JSON.stringify({
          model: request.model,
          messages: filteredMessages,
          max_tokens: request.max_tokens || 1024,
          temperature: request.temperature,
          stream: true,
          system: systemMessage || undefined
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Don't expose the actual error body to prevent leaking sensitive information
        console.error(`Anthropic API error: ${response.status}`);
        throw new Error('Upstream API error');
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process each complete line
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.substring(0, newlineIndex);
            buffer = buffer.substring(newlineIndex + 1);

            if (line.startsWith('event: ')) {
              // Handle different event types
              const eventType = line.substring(7); // Remove 'event: ' prefix
              // Skip to the next line which should contain the data
              const dataLineIndex = buffer.indexOf('\n');
              if (dataLineIndex !== -1) {
                const dataLine = buffer.substring(0, dataLineIndex);
                buffer = buffer.substring(dataLineIndex + 1);
                
                if (dataLine.startsWith('data: ')) {
                  const dataStr = dataLine.substring(6); // Remove 'data: ' prefix
                  
                  try {
                    const parsedData = JSON.parse(dataStr);
                    
                    // Convert Anthropic stream event to OpenAI format
                    const openAIChunk = this.convertAnthropicStreamEventToOpenAI(parsedData, request.model);
                    if (openAIChunk) {
                      yield openAIChunk;
                    }
                  } catch (e) {
                    console.error('Error parsing Anthropic SSE data:', e);
                    console.error('Data:', dataStr);
                  }
                }
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error('Request timed out');
      }
      // Don't expose internal error details to prevent information leakage
      console.error('Error in Anthropic streaming:', (error as Error).message);
      throw new Error('Upstream API error');
    }
  }

  private convertToAnthropicFormat(messages: LLMMessage[]): Array<{ role: string; content: string }> {
    return messages.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user', // Anthropic only has user/assistant
      content: msg.content
    }));
  }

  private convertAnthropicToOpenAI(anthropicResponse: any, model: string): ChatCompletionResponse {
    // Extract the text from the content array
    const textContent = anthropicResponse.content?.[0]?.text || '';
    
    return {
      id: anthropicResponse.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent
        },
        finish_reason: anthropicResponse.stop_reason || 'stop'
      }],
      usage: {
        prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
        completion_tokens: anthropicResponse.usage?.output_tokens || 0,
        total_tokens: (anthropicResponse.usage?.input_tokens || 0) + (anthropicResponse.usage?.output_tokens || 0)
      }
    };
  }

  private convertAnthropicStreamEventToOpenAI(event: any, model: string): StreamChunk | null {
    // Handle different Anthropic stream events
    switch (event.type) {
      case 'message_start':
        // Initial message info
        return null; // Don't yield this, just collect usage
        
      case 'content_block_start':
        // Beginning of content block
        return null;
        
      case 'content_block_delta':
        // Content delta
        if (event.delta?.type === 'text_delta') {
          return {
            id: event.message?.id || `msg_${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                content: event.delta.text
              },
              finish_reason: null
            }]
          };
        }
        return null;
        
      case 'message_delta':
        // Delta info including stop reason and usage
        return {
          id: event.message?.id || `msg_${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            delta: { role: 'assistant' as const, content: '' },
            finish_reason: event.delta?.stop_reason || null
          }],
          usage: event.usage ? {
            prompt_tokens: event.usage.input_tokens || 0,
            completion_tokens: event.usage.output_tokens || 0,
            total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0)
          } : undefined
        };
        
      case 'message_stop':
        // Final message - could send a final chunk with usage if needed
        return null;
        
      default:
        return null;
    }
  }
}

