/**
 * OpenAI服务
 * 封装OpenAI API调用，实现文本生成、编辑和优化功能
 */

const { OpenAI } = require('openai');
const logger = require('../utils/logger');
const { ERROR_CODES } = require('../utils/errorCodes');
const cache = require('../utils/cache');

// 初始化OpenAI客户端
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID,
  timeout: parseInt(process.env.API_TIMEOUT || '30000'), // 毫秒
  maxRetries: 2
});

// 默认配置
const DEFAULT_CONFIG = {
  maxRetries: 2,
  retryDelay: 1000,
  timeout: 30000,
};

/**
 * 智能重试机制
 */
async function executeWithRetry(operation, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  let lastError = null;
  
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      // 使用超时Promise包装API调用
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timed out')), config.timeout);
      });
      
      const result = await Promise.race([
        operation(),
        timeoutPromise
      ]);
      
      return result;
    } catch (error) {
      lastError = error;
      
      // 判断错误是否可重试
      const isRetryable = isRetryableError(error);
      if (!isRetryable || attempt === config.maxRetries) {
        logger.error(`OpenAI API error (final): ${error.message}`);
        break;
      }
      
      // 计算指数退避延迟
      const delay = calculateBackoff(attempt, config.retryDelay);
      logger.warn(`OpenAI API error, retrying in ${delay}ms: ${error.message}`);
      
      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // 所有重试都失败，抛出适当错误
  throw mapToServiceError(lastError);
}

/**
 * 判断错误是否可重试
 */
function isRetryableError(error) {
  // 处理超时错误
  if (error.message.includes('timed out') || error.code === 'ETIMEDOUT') {
    return true;
  }
  
  // 处理OpenAI特定错误
  if (error.response) {
    const status = error.response.status;
    // 429 (速率限制), 500, 502, 503, 504 (服务器错误) 可重试
    return [429, 500, 502, 503, 504].includes(status);
  }
  
  // 网络错误通常可重试
  return error.code === 'ECONNRESET' || 
         error.code === 'ECONNREFUSED' || 
         error.code === 'ENOTFOUND';
}

/**
 * 计算指数退避延迟
 */
function calculateBackoff(attempt, baseDelay) {
  // 添加随机因子避免请求同步
  const jitter = Math.random() * 300;
  return Math.min(
    (Math.pow(2, attempt) * baseDelay) + jitter,
    30000 // 最大延迟30秒
  );
}

/**
 * 映射API错误到服务错误
 */
function mapToServiceError(error) {
  if (!error) {
    return new Error('Unknown error occurred');
  }
  
  // 处理OpenAI特定错误
  if (error.response) {
    const status = error.response.status;
    const data = error.response.data;
    
    switch (status) {
      case 400:
        if (data.error?.code === 'context_length_exceeded') {
          const err = new Error('Prompt exceeds maximum context length for the model');
          err.code = 'context_length_exceeded';
          err.errorCode = ERROR_CODES.CONTEXT_LENGTH_EXCEEDED;
          return err;
        }
        break;
      case 401:
        return Object.assign(new Error('Invalid API key'), { 
          errorCode: ERROR_CODES.UNAUTHORIZED 
        });
      case 403:
        return Object.assign(new Error('Permission denied'), { 
          errorCode: ERROR_CODES.FORBIDDEN 
        });
      case 404:
        return Object.assign(new Error('Requested resource not found'), { 
          errorCode: ERROR_CODES.RESOURCE_NOT_FOUND 
        });
      case 429:
        return Object.assign(new Error('Rate limit exceeded'), { 
          errorCode: ERROR_CODES.RATE_LIMIT_EXCEEDED 
        });
    }
  }
  
  // 返回原始错误，确保包含所有信息
  return error;
}

/**
 * 文本生成服务
 */
exports.generateText = async (params) => {
  const { 
    prompt, 
    systemPrompt = '', 
    temperature = 0.7, 
    maxTokens = 1000, 
    model = 'gpt-4',
    userId = 'anonymous',
    useCaching = true,
    ...options
  } = params;
  
  // 缓存逻辑 - 对于相同的输入参数，返回缓存的结果
  if (useCaching) {
    const cacheKey = `openai:text:${model}:${temperature}:${maxTokens}:${Buffer.from(prompt).toString('base64')}:${Buffer.from(systemPrompt).toString('base64')}`;
    const cachedResult = await cache.get(cacheKey);
    
    if (cachedResult) {
      logger.info(`Cache hit for text generation: ${cacheKey.substring(0, 40)}...`);
      return JSON.parse(cachedResult);
    }
  }
  
  try {
    // 构建消息数组
    const messages = [];
    
    // 添加系统提示
    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt
      });
    }
    
    // 添加用户提示
    messages.push({
      role: 'user',
      content: prompt
    });
    
    // 调用OpenAI API生成文本
    const result = await executeWithRetry(async () => {
      const response = await openai.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        top_p: options.topP || 1,
        frequency_penalty: options.frequencyPenalty || 0,
        presence_penalty: options.presencePenalty || 0,
        user: userId,
      });
      
      return response;
    });
    
    // 处理API响应
    const generatedText = result.choices[0].message.content;
    const totalTokens = result.usage.total_tokens;
    
    const responseData = {
      text: generatedText,
      usage: {
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        totalTokens
      },
      model: result.model
    };
    
    // 将结果存入缓存
    if (useCaching) {
      const cacheKey = `openai:text:${model}:${temperature}:${maxTokens}:${Buffer.from(prompt).toString('base64')}:${Buffer.from(systemPrompt).toString('base64')}`;
      // 根据令牌使用量设置缓存时间 - 越长的响应缓存越久
      const cacheTTL = Math.min(
        24 * 60 * 60, // 最大1天
        Math.max(
          60 * 30, // 最小30分钟
          totalTokens * 20 // 每个令牌20秒
        )
      );
      
      await cache.set(cacheKey, JSON.stringify(responseData), cacheTTL);
    }
    
    return responseData;
    
  } catch (error) {
    logger.error(`OpenAI text generation error: ${error.message}`, {
      model,
      userId,
      promptLength: prompt.length,
      stack: error.stack
    });
    
    throw error;
  }
};

/**
 * 文本编辑服务
 */
exports.editText = async (params) => {
  const {
    text,
    instruction,
    model = 'gpt-4',
    temperature = 0.5,
    useCaching = true,
    userId = 'anonymous'
  } = params;
  
  // 缓存逻辑
  if (useCaching) {
    const cacheKey = `openai:edit:${model}:${temperature}:${Buffer.from(text).toString('base64')}:${Buffer.from(instruction).toString('base64')}`;
    const cachedResult = await cache.get(cacheKey);
    
    if (cachedResult) {
      logger.info(`Cache hit for text editing: ${cacheKey.substring(0, 40)}...`);
      return JSON.parse(cachedResult);
    }
  }
  
  try {
    // 使用聊天API实现编辑功能
    const messages = [
      {
        role: 'system',
        content: '你是一个能够根据指令编辑文本的助手。请遵循用户的指令修改提供的文本。只返回修改后的完整文本，不要添加额外的解释。'
      },
      {
        role: 'user',
        content: `原文本:\n${text}\n\n指令:\n${instruction}\n\n修改后的文本:`
      }
    ];
    
    const result = await executeWithRetry(async () => {
      const response = await openai.chat.completions.create({
        model,
        messages,
        temperature,
        user: userId,
      });
      
      return response;
    });
    
    const editedText = result.choices[0].message.content;
    
    const responseData = {
      text: editedText,
      usage: {
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        totalTokens: result.usage.total_tokens
      },
      model: result.model
    };
    
    // 缓存结果
    if (useCaching) {
      const cacheKey = `openai:edit:${model}:${temperature}:${Buffer.from(text).toString('base64')}:${Buffer.from(instruction).toString('base64')}`;
      await cache.set(cacheKey, JSON.stringify(responseData), 60 * 60 * 12); // 12小时
    }
    
    return responseData;
    
  } catch (error) {
    logger.error(`OpenAI text editing error: ${error.message}`, {
      model,
      userId,
      textLength: text.length,
      instructionLength: instruction.length,
      stack: error.stack
    });
    
    throw error;
  }
};

/**
 * 文本总结服务
 */
exports.summarizeText = async (params) => {
  const {
    text,
    maxLength = 150,
    format = 'paragraph',
    temperature = 0.5,
    model = 'gpt-3.5-turbo',
    userId = 'anonymous',
    useCaching = true
  } = params;
  
  // 构建系统提示，引导模型生成合适的总结
  const systemPrompt = `总结以下文本，创建一个${format === 'bullets' ? '要点列表' : '段落'}。总结应包含最重要的信息，不超过${maxLength}个单词。`;
  
  // 复用文本生成函数
  return this.generateText({
    prompt: text,
    systemPrompt,
    temperature,
    model,
    userId,
    useCaching
  });
};

/**
 * 获取当前支持的模型列表
 */
exports.getSupportedModels = async () => {
  try {
    const response = await executeWithRetry(async () => {
      return await openai.models.list();
    });
    
    // 过滤处理结果，提取所需信息
    return response.data
      .filter(model => model.id.startsWith('gpt-'))
      .map(model => ({
        id: model.id,
        name: model.id,
        description: getModelDescription(model.id),
        maxTokens: getModelMaxTokens(model.id),
        type: 'text'
      }));
      
  } catch (error) {
    logger.error(`Error fetching OpenAI models: ${error.message}`);
    
    // 如果API调用失败，返回硬编码的模型列表
    return [
      {
        id: 'gpt-4',
        name: 'GPT-4',
        description: '最强大的GPT模型，适合需要高级推理的复杂任务',
        maxTokens: 8192,
        type: 'text'
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        description: '强大的语言模型，适合大多数日常任务，速度快且成本较低',
        maxTokens: 4096,
        type: 'text'
      }
    ];
  }
};

// 辅助函数：获取模型描述
function getModelDescription(modelId) {
  const descriptions = {
    'gpt-4': '最强大的GPT模型，适合需要高级推理的复杂任务',
    'gpt-4-turbo': 'GPT-4的更快版本，适合需要高级推理且响应速度更快的场景',
    'gpt-3.5-turbo': '强大的语言模型，适合大多数日常任务，速度快且成本较低'
  };
  
  return descriptions[modelId] || '通用语言模型';
}

// 辅助函数：获取模型的最大标记数
function getModelMaxTokens(modelId) {
  const tokenLimits = {
    'gpt-4': 8192,
    'gpt-4-32k': 32768,
    'gpt-4-turbo': 8192,
    'gpt-3.5-turbo': 4096,
    'gpt-3.5-turbo-16k': 16384
  };
  
  return tokenLimits[modelId] || 4096; // 默认4096
}

/**
 * 健康检查，验证API连接
 */
exports.healthCheck = async () => {
  try {
    // 调用简单的API请求测试连接
    await executeWithRetry(async () => {
      return await openai.models.retrieve('gpt-3.5-turbo');
    }, { timeout: 5000 });
    
    return {
      status: 'healthy',
      provider: 'openai',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`OpenAI health check failed: ${error.message}`);
    
    return {
      status: 'unhealthy',
      provider: 'openai',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}; 