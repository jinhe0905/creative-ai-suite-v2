/**
 * API路由索引
 * 集中管理所有路由，采用模块化结构设计，支持API版本控制
 */

const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const { cacheMiddleware } = require('../middlewares/cache');

// 导入各功能模块路由
const textGenerationRoutes = require('./textGeneration.routes');
const textEditingRoutes = require('./textEditing.routes');
const textAnalysisRoutes = require('./textAnalysis.routes');
const promptTemplatesRoutes = require('./promptTemplates.routes');
const userPreferencesRoutes = require('./userPreferences.routes');

// 基本路由 - 无需认证
router.get('/', (req, res) => {
  res.status(200).json({
    service: 'Text Engine API',
    version: 'v1',
    status: 'active',
    documentation: '/api/v1/docs'
  });
});

// API文档路由
router.use('/docs', express.static('docs/api'));

// 功能路由注册，带自动缓存策略
router.use('/text/generate', cacheMiddleware('short'), textGenerationRoutes);
router.use('/text/edit', textEditingRoutes);
router.use('/text/analyze', cacheMiddleware('medium'), textAnalysisRoutes);

// 需要认证的路由
router.use('/templates', auth(), promptTemplatesRoutes);
router.use('/preferences', auth(), userPreferencesRoutes);

// 批量操作路由
router.use('/batch', require('./batch.routes'));

// 健康检查和指标路由
router.use('/metrics', require('./metrics.routes'));

// 未来可能的扩展点
// router.use('/v2', require('./v2Routes'));

module.exports = router; 