/**
 * Text Engine Service - Main Server
 * 高性能文本生成微服务，提供AI驱动的文本创建、编辑和优化功能
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createClient } = require('redis');
const { connect } = require('./config/database');
const logger = require('./utils/logger');
const routes = require('./routes');

// 初始化Express应用
const app = express();
const PORT = process.env.PORT || 5001;

// 增强的安全性中间件
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 请求日志和解析
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// API请求限流中间件
const apiLimiter = require('./middlewares/rateLimiter');
app.use('/api/', apiLimiter);

// 初始化Redis连接 (用于缓存和速率限制)
let redisClient;
(async () => {
  redisClient = createClient({
    url: process.env.REDIS_URL
  });
  
  redisClient.on('error', (err) => {
    logger.error('Redis client error', err);
  });
  
  await redisClient.connect();
  logger.info('Redis client connected');
  
  // Redis连接注入
  app.use((req, res, next) => {
    req.redisClient = redisClient;
    next();
  });
})().catch(err => {
  logger.warn('Redis connection failed, proceeding without caching:', err.message);
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'text-engine', version: process.env.npm_package_version });
});

// 路由注册
app.use('/api/v1', routes);

// 404处理
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// 全局错误处理
app.use((err, req, res, next) => {
  logger.error(`Error occurred: ${err.stack}`);
  
  // 处理特定类型的错误
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message });
  }
  
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// 启动服务器，连接数据库
async function startServer() {
  try {
    // 连接MongoDB
    await connect();
    logger.info('MongoDB connected successfully');
    
    // 启动服务器
    app.listen(PORT, () => {
      logger.info(`Text Engine Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

startServer();

// 优雅关闭
const gracefulShutdown = async () => {
  logger.info('Shutting down server...');
  
  if (redisClient) {
    await redisClient.quit();
    logger.info('Redis connection closed');
  }
  
  process.exit(0);
};

// 监听终止信号
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

module.exports = app; // 导出用于测试 