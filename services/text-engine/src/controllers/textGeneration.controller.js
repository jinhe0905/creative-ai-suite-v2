/**
 * 文本生成控制器
 * 处理各种文本生成请求，集成多种AI语言模型
 */

const { v4: uuidv4 } = require('uuid');
const { validationResult } = require('express-validator');
const openaiService = require('../services/openai.service');
const palmService = require('../services/palm.service');
const anthropicService = require('../services/anthropic.service');
const localLLMService = require('../services/localLLM.service');
const TextProject = require('../models/textProject.model');
const UserPreference = require('../models/userPreference.model');
const logger = require('../utils/logger');
const { createMetricsRecord } = require('../utils/metrics');
const { ERROR_CODES, API_ERRORS } = require('../utils/errorCodes');

/**
 * 创建新的文本生成任务
 * 支持多种模型选择，自定义参数，以及用户偏好应用
 */
exports.generateText = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        errorCode: ERROR_CODES.VALIDATION_ERROR
      });
    }

    const { prompt, model = 'gpt-4', temperature = 0.7, maxTokens = 1000, systemPrompt, options = {} } = req.body;
    const userId = req.user?.id || 'anonymous';
    
    // 获取用户偏好设置（如果存在）
    let userPreference = null;
    if (userId !== 'anonymous') {
      userPreference = await UserPreference.findOne({ userId });
    }
    
    // 应用用户偏好设置
    const effectiveModel = options.usePreferredModel && userPreference?.preferredModel 
      ? userPreference.preferredModel 
      : model;
      
    const effectiveTemperature = options.usePreferredSettings && userPreference?.defaultTemperature 
      ? userPreference.defaultTemperature 
      : temperature;
    
    // 根据模型选择适当的服务
    let generationService;
    switch (effectiveModel.toLowerCase()) {
      case 'gpt-4':
      case 'gpt-3.5-turbo':
        generationService = openaiService;
        break;
      case 'palm':
      case 'gemini':
        generationService = palmService;
        break;
      case 'claude':
      case 'claude-instant':
        generationService = anthropicService;
        break;
      case 'local-llama':
      case 'local-mistral':
        generationService = localLLMService;
        break;
      default:
        generationService = openaiService;
    }
    
    // 性能指标记录开始
    const startTime = Date.now();
    
    // 生成文本
    const generationResult = await generationService.generateText({
      prompt,
      systemPrompt: systemPrompt || userPreference?.defaultSystemPrompt || '',
      temperature: effectiveTemperature,
      maxTokens,
      userId,
      model: effectiveModel,
      ...options
    });
    
    // 性能指标记录结束
    const duration = Date.now() - startTime;
    await createMetricsRecord({
      userId,
      operation: 'text_generation',
      model: effectiveModel,
      promptLength: prompt.length,
      responseLength: generationResult.text.length,
      processingTimeMs: duration,
      tokensUsed: generationResult.usage?.totalTokens || 0,
      successful: true
    });
    
    // 保存项目（如果需要）
    let projectRecord = null;
    if (options.saveAsProject) {
      projectRecord = await TextProject.create({
        projectId: uuidv4(),
        userId,
        title: options.projectTitle || generationResult.text.split('\n')[0].substring(0, 50),
        content: generationResult.text,
        prompt,
        systemPrompt: systemPrompt || userPreference?.defaultSystemPrompt || '',
        model: effectiveModel,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {
          temperature: effectiveTemperature,
          maxTokens,
          tokensUsed: generationResult.usage?.totalTokens || 0,
          ...options.metadata
        }
      });
    }
    
    // 返回生成结果
    res.status(200).json({
      success: true,
      result: {
        text: generationResult.text,
        model: effectiveModel,
        tokensUsed: generationResult.usage?.totalTokens || 0,
        processingTimeMs: duration,
        projectId: projectRecord?.projectId || null
      }
    });
    
    // 记录成功的生成请求
    logger.info(`Text generation successful - model: ${effectiveModel}, tokens: ${generationResult.usage?.totalTokens || 0}, time: ${duration}ms`);
    
  } catch (error) {
    logger.error(`Text generation failed: ${error.message}`, { stack: error.stack });
    
    // 特定错误处理
    if (error.code === 'context_length_exceeded') {
      return res.status(400).json({
        success: false,
        message: 'The provided prompt is too long for the selected model.',
        errorCode: ERROR_CODES.CONTEXT_LENGTH_EXCEEDED
      });
    }
    
    if (error.code === 'model_not_available') {
      return res.status(503).json({
        success: false,
        message: 'The requested model is currently not available.',
        errorCode: ERROR_CODES.MODEL_UNAVAILABLE
      });
    }
    
    // 通用错误处理
    next(error);
  }
};

/**
 * 批量文本生成
 * 支持同时处理多个提示，提高吞吐量
 */
exports.batchGenerate = async (req, res, next) => {
  try {
    const { prompts, model = 'gpt-3.5-turbo', temperature = 0.7 } = req.body;
    const userId = req.user?.id || 'anonymous';
    
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'A non-empty array of prompts is required',
        errorCode: ERROR_CODES.VALIDATION_ERROR
      });
    }
    
    if (prompts.length > 10) {
      return res.status(400).json({
        success: false, 
        message: 'Batch requests are limited to 10 prompts',
        errorCode: ERROR_CODES.TOO_MANY_REQUESTS
      });
    }
    
    // 批量处理，根据模型选择适当的服务
    let generationService;
    switch (model.toLowerCase()) {
      case 'gpt-4':
      case 'gpt-3.5-turbo':
        generationService = openaiService;
        break;
      default:
        generationService = openaiService;
    }
    
    const startTime = Date.now();
    
    // 并行处理所有提示
    const results = await Promise.allSettled(
      prompts.map(prompt => 
        generationService.generateText({
          prompt: typeof prompt === 'string' ? prompt : prompt.text,
          systemPrompt: typeof prompt === 'object' ? prompt.systemPrompt : '',
          temperature,
          maxTokens: typeof prompt === 'object' ? prompt.maxTokens || 1000 : 1000,
          model,
          userId
        })
      )
    );
    
    const duration = Date.now() - startTime;
    
    // 处理结果
    const processedResults = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return {
          success: true,
          index,
          text: result.value.text,
          tokensUsed: result.value.usage?.totalTokens || 0
        };
      } else {
        return {
          success: false,
          index,
          error: result.reason.message || 'Unknown error'
        };
      }
    });
    
    // 记录批量处理指标
    await createMetricsRecord({
      userId,
      operation: 'batch_text_generation',
      model,
      batchSize: prompts.length, 
      successCount: processedResults.filter(r => r.success).length,
      failureCount: processedResults.filter(r => !r.success).length,
      processingTimeMs: duration,
      successful: true
    });
    
    res.status(200).json({
      success: true,
      results: processedResults,
      totalTime: duration,
      totalSuccessful: processedResults.filter(r => r.success).length
    });
    
  } catch (error) {
    logger.error(`Batch text generation failed: ${error.message}`, { stack: error.stack });
    next(error);
  }
};

/**
 * 获取用户的所有文本生成项目
 */
exports.getUserProjects = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, sortBy = 'createdAt', order = 'desc' } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = {};
    sort[sortBy] = order === 'desc' ? -1 : 1;
    
    const projects = await TextProject.find({ userId })
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .select('projectId title createdAt updatedAt model metadata.tokensUsed');
    
    const total = await TextProject.countDocuments({ userId });
    
    res.status(200).json({
      success: true,
      data: {
        projects,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
    
  } catch (error) {
    logger.error(`Error retrieving user projects: ${error.message}`);
    next(error);
  }
};

/**
 * 获取特定项目详情
 */
exports.getProjectById = async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    
    const project = await TextProject.findOne({ projectId, userId });
    
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
        errorCode: ERROR_CODES.RESOURCE_NOT_FOUND
      });
    }
    
    res.status(200).json({
      success: true,
      data: project
    });
    
  } catch (error) {
    logger.error(`Error retrieving project: ${error.message}`);
    next(error);
  }
}; 