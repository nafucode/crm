require('dotenv').config({ path: '.env.development.local' });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();
const kv = redis; // 兼容所有 kv 引用

const app = express();
const port = 3000;
const JWT_SECRET = 'your_super_secret_key_that_should_be_long_and_random'; // 请在未来替换为一个更安全的密钥

// 中间件
app.use(cors()); // 允许跨域请求
app.use(express.json()); // 解析 JSON 请求体
app.use(express.static(path.join(__dirname, 'public'))); // 只托管 public 目录下的静态文件

// 明确的页面路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html')); // 根目录直接导向登录
});
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// API: 用户登录
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await kv.hgetall(`user:${username}`);
        if (!user) {
            return res.status(401).json({ message: '用户名或密码错误' });
        }

        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (err) {
                return res.status(500).json({ message: '服务器错误' });
            }
            if (isMatch) {
                const token = jwt.sign({ username: user.username, realName: user.realName, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
                res.json({ token });
            } else {
                res.status(401).json({ message: '用户名或密码错误' });
            }
        });
    } catch (error) {
        console.error('登录时从 KV 读取用户数据出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

// 认证中间件
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (token == null) return res.sendStatus(401); // 如果没有 token，则拒绝访问

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403); // 如果 token 无效，则拒绝访问
        req.user = user;
        next(); // token 有效，继续执行下一个中间件或路由处理器
    });
};

// 管理员认证中间件
const authenticateAdmin = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        if (user.role !== 'admin') return res.sendStatus(403); // 验证管理员角色
        req.user = user;
        next();
    });
};

// API: 获取当前用户信息
app.get('/api/user', authenticateToken, (req, res) => {
    res.json({ realName: req.user.realName });
});



// API 路由：处理表单提交（支持批量和合并）
app.post('/api/submit', authenticateToken, async (req, res) => {
    const submissions = req.body;

    if (!Array.isArray(submissions) || submissions.length === 0) {
        return res.status(400).send('提交数据格式不正确或为空');
    }

    try {
        // 1. 获取所有现有数据用于查重
        const allFeedback = await kv.lrange('feedback', 0, -1);
        
        // 2. 创建一个查找映射表，提高效率
        const feedbackMap = new Map();
        allFeedback.forEach((item, index) => {
            if (item.country && item.phone) {
                const key = `${item.country}:${item.phone}`;
                feedbackMap.set(key, { ...item, originalIndex: index });
            }
        });

        const pipeline = kv.pipeline();
        let hasUpdates = false; // 标记是否有更新操作

        // 3. 遍历本次提交的所有数据
        for (const submission of submissions) {
            // 只有当国家和电话都存在时，才进行查重
            if (submission.country && submission.phone) {
                const key = `${submission.country}:${submission.phone}`;
                const existingRecord = feedbackMap.get(key);

                if (existingRecord) {
                    // 找到了重复记录，进行合并
                    const mergedRecord = {
                        ...existingRecord,
                        customerId: submission.customerId, // 更新客户信息
                        summary: `${submission.summary} (更新于 ${new Date(submission.Timestamp).toLocaleString()})\n${existingRecord.summary}`,
                        salesperson: submission.salesperson, // 更新提交人
                        Timestamp: submission.Timestamp, // 更新时间戳
                    };
                    delete mergedRecord.originalIndex; // 删除辅助字段

                    // 使用 LSET 更新指定索引的元素
                    pipeline.lset('feedback', existingRecord.originalIndex, mergedRecord);
                    hasUpdates = true;
                    continue; // 处理下一个提交
                }
            }
            // 如果没有重复，则作为新记录添加
            pipeline.lpush('feedback', submission);
        }

        await pipeline.exec();

        res.status(200).send('数据提交成功，重复记录已智能合并。');

    } catch (error) {
        console.error('向 Redis 写入数据时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

// API 路由：读取并返回所有反馈数据
app.get('/api/data', authenticateAdmin, async (req, res) => {
    try {
        const feedback = await kv.lrange('feedback', 0, -1);
        res.json(feedback.reverse()); // 返回倒序，让最新的在前面
    } catch (error) {
        console.error('从 Redis 读取数据时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

// API 路由：获取当前用户的提交历史
app.get('/api/my-submissions', authenticateToken, async (req, res) => {
    try {
        const allFeedback = await kv.lrange('feedback', 0, -1);
        const userSubmissions = allFeedback.filter(item => item.salesperson === req.user.realName);
        res.json(userSubmissions.reverse()); // 返回倒序，让最新的在前面
    } catch (error) {
        console.error('从 Redis 读取用户提交历史时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

// API 路由：为地图提供按国家聚合的数据
app.get('/api/map-data', authenticateAdmin, async (req, res) => {
    try {
        const feedback = await redis.lrange('feedback', 0, -1);
        
        const countryCounts = feedback.reduce((acc, row) => {
            const country = row.country; // 注意是小写
            if (country) {
                acc[country] = (acc[country] || 0) + 1;
            }
            return acc;
        }, {});

        const mapData = Object.keys(countryCounts).map(name => ({
            name,
            value: countryCounts[name]
        }));

        res.json(mapData);
    } catch (error) {
        console.error('读取地图数据出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

// API 路由：更新一行数据
app.post('/api/update', authenticateAdmin, async (req, res) => {
    const { timestamp, phone, summary } = req.body;

    if (!timestamp) {
        return res.status(400).send('缺少时间戳标识');
    }

    try {
        const allFeedback = await kv.lrange('feedback', 0, -1);
        const index = allFeedback.findIndex(item => (item.Timestamp || item.timestamp) === timestamp);

        if (index === -1) {
            return res.status(404).send('未找到要更新的数据行');
        }

        // 获取旧记录，然后更新它
        const oldRecord = allFeedback[index];
        const newRecord = {
            ...oldRecord,
            phone: phone, // 添加或更新 phone 字段
            summary: summary // 更新 summary 字段
        };

        await kv.lset('feedback', index, newRecord);
        res.status(200).json({ message: '数据更新成功', updatedRecord: newRecord });
    } catch (error) {
        console.error('更新 Redis 数据时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

// API 路由：删除一行数据
app.post('/api/delete', authenticateAdmin, async (req, res) => {
    const { Timestamp, timestamp } = req.body;
    const ts = Timestamp || timestamp; // 兼容大小写两种写法

    if (!ts) {
        return res.status(400).send('缺少时间戳标识');
    }

    try {
        const allFeedback = await redis.lrange('feedback', 0, -1);
        const itemToDelete = allFeedback.find(item => (item.timestamp || item.Timestamp) === ts);

        if (!itemToDelete) {
            return res.status(404).send('未找到要删除的数据行');
        }

        await redis.lrem('feedback', 1, itemToDelete);
        res.status(200).send('数据删除成功');
    } catch (error) {
        console.error('删除 Redis 数据时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

// 导出 app 实例以供 Vercel 使用
module.exports = app;
