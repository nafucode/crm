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
app.get('/africa.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'africa.html'));
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

async function submitCustomerRecords(req, res, redisKey, label) {
    const submissions = req.body;

    if (!Array.isArray(submissions) || submissions.length === 0) {
        return res.status(400).send('提交数据格式不正确或为空');
    }

    try {
        const allRecords = await kv.lrange(redisKey, 0, -1);
        const recordMap = new Map();
        allRecords.forEach((item, index) => {
            if (item.country && item.phone) {
                recordMap.set(`${item.country}:${item.phone}`, { ...item, originalIndex: index });
            }
        });

        const pipeline = kv.pipeline();
        for (const submission of submissions) {
            if (submission.country && submission.phone) {
                const key = `${submission.country}:${submission.phone}`;
                const existingRecord = recordMap.get(key);

                if (existingRecord) {
                    const mergedRecord = {
                        ...existingRecord,
                        customerId: submission.customerId,
                        summary: `${submission.summary || ''} (更新于 ${new Date(submission.Timestamp).toLocaleString()})\n${existingRecord.summary || ''}`.trim(),
                        salesperson: submission.salesperson,
                        marketGroup: submission.marketGroup || existingRecord.marketGroup,
                        groupOwner: submission.groupOwner || existingRecord.groupOwner,
                        groupNote: submission.groupNote || existingRecord.groupNote,
                        Timestamp: submission.Timestamp,
                    };
                    delete mergedRecord.originalIndex;
                    pipeline.lset(redisKey, existingRecord.originalIndex, mergedRecord);
                    continue;
                }
            }

            pipeline.lpush(redisKey, submission);
        }

        await pipeline.exec();
        res.status(200).send(`${label}提交成功，重复记录已智能合并。`);
    } catch (error) {
        console.error(`向 Redis 写入${label}数据时出错:`, error);
        res.status(500).send('服务器内部错误');
    }
}

app.post('/api/africa-submit', authenticateToken, async (req, res) => {
    submitCustomerRecords(req, res, 'africa_feedback', '非洲客户');
});

// API 路由：读取并返回所有反馈数据
app.get('/api/data', authenticateAdmin, async (req, res) => {
    try {
        const feedback = await kv.lrange('feedback', 0, -1);
        res.json(feedback); // Keep original order for client-side reversal
    } catch (error) {
        console.error('从 Redis 读取数据时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

app.get('/api/africa-data', authenticateAdmin, async (req, res) => {
    try {
        const feedback = await kv.lrange('africa_feedback', 0, -1);
        res.json(feedback);
    } catch (error) {
        console.error('从 Redis 读取非洲客户数据时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

// API 路由：获取地图数据（对所有登录用户开放）
app.get('/api/map-data', authenticateToken, async (req, res) => {
    try {
        const allFeedback = await kv.lrange('feedback', 0, -1);
        const countryCounts = allFeedback.reduce((acc, row) => {
            const country = row.country;
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
        console.error('从 Redis 读取地图数据时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

// API 路由：获取图表数据（对所有登录用户开放）
app.get('/api/chart-data', authenticateToken, async (req, res) => {
    try {
        const allFeedback = await kv.lrange('feedback', 0, -1);
        // 只返回渲染图表所需的安全字段
        const chartData = allFeedback.map(item => ({
            Timestamp: item.Timestamp || item.timestamp,
            salesperson: item.salesperson
        }));
        res.json(chartData);
    } catch (error) {
        console.error('从 Redis 读取图表数据时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

app.get('/api/report-data', authenticateToken, async (req, res) => {
    if (req.user.username !== 'naf' && req.user.role !== 'admin') {
        return res.sendStatus(403);
    }

    try {
        const allFeedback = await kv.lrange('feedback', 0, -1);
        res.json(allFeedback);
    } catch (error) {
        console.error('读取汇报材料数据时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

const ORDER_STATUS_KEY = 'crm:order-status';
const SALES_PLAN_KEY = 'crm:sales-plan:2026';
const SALES_PLAN_MONTHS = ['3月','4月','5月','6月','7月','8月','9月','10月','11月','12月','1月'];
const SALES_PLAN_PEOPLE = ['胡佳润', '张多加', '李孟琪', '陈颢', '钱晨阳', '李菲艳'];
const SALES_PLAN_DEFAULT = {
    '胡佳润': { '3月': 4, '5月': 1, '6月': 4, '7月': 3 },
    '张多加': { '3月': 1, '5月': 5, '6月': 1 },
    '李孟琪': { '4月': 3, '7月': 6 },
    '陈颢': {},
    '钱晨阳': { '6月': 1 },
    '李菲艳': {}
};

function normalizeSalesPlanData(data = {}) {
    const normalized = {};
    SALES_PLAN_PEOPLE.forEach(person => {
        normalized[person] = {};
        SALES_PLAN_MONTHS.forEach(month => {
            normalized[person][month] = Math.max(0, parseInt(data?.[person]?.[month], 10) || 0);
        });
    });
    return normalized;
}

function normalizeOrderStatusRow(row = {}) {
    return {
        id: row.id || makeId('o_'),
        customer: row.customer || '',
        quantity: Math.max(0, parseInt(row.quantity, 10) || 0),
        country: row.country || '',
        orderNo: row.orderNo || '',
        status: row.status || '订单收款',
        note: row.note || '',
        updatedAt: row.updatedAt || new Date().toISOString()
    };
}

app.get('/api/sales-plan', authenticateToken, async (req, res) => {
    try {
        const stored = await kv.get(SALES_PLAN_KEY);
        const source = stored && typeof stored === 'object' ? stored : SALES_PLAN_DEFAULT;
        res.json({ data: normalizeSalesPlanData(source) });
    } catch (error) {
        console.error('读取销售计划失败:', error);
        res.status(500).json({ error: '读取销售计划失败' });
    }
});

app.post('/api/sales-plan', authenticateToken, async (req, res) => {
    try {
        const data = normalizeSalesPlanData(req.body.data || {});
        await kv.set(SALES_PLAN_KEY, data);
        res.json({ ok: true, data });
    } catch (error) {
        console.error('保存销售计划失败:', error);
        res.status(500).json({ error: '保存销售计划失败' });
    }
});

app.get('/api/order-status', authenticateToken, async (req, res) => {
    try {
        const rows = await kv.get(ORDER_STATUS_KEY);
        res.json({ rows: Array.isArray(rows) ? rows.map(normalizeOrderStatusRow) : [] });
    } catch (error) {
        console.error('读取订单状态表失败:', error);
        res.status(500).json({ error: '读取订单状态表失败' });
    }
});

app.post('/api/order-status', authenticateToken, async (req, res) => {
    try {
        const rows = Array.isArray(req.body.rows) ? req.body.rows.map(row => ({
            ...normalizeOrderStatusRow(row),
            updatedAt: new Date().toISOString()
        })) : [];
        await kv.set(ORDER_STATUS_KEY, rows);
        res.json({ ok: true, rows });
    } catch (error) {
        console.error('保存订单状态表失败:', error);
        res.status(500).json({ error: '保存订单状态表失败' });
    }
});

// API 路由：获取当前用户的提交历史
app.get('/api/my-submissions', authenticateToken, async (req, res) => {
    try {
        const allFeedback = await kv.lrange('feedback', 0, -1);
        const userSubmissions = allFeedback.filter(item => item.salesperson === req.user.realName);
        userSubmissions.sort((a, b) => new Date(b.Timestamp || b.timestamp || 0) - new Date(a.Timestamp || a.timestamp || 0));
        res.json(userSubmissions);
    } catch (error) {
        console.error('从 Redis 读取用户提交历史时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

app.get('/api/africa-my-submissions', authenticateToken, async (req, res) => {
    try {
        const allFeedback = await kv.lrange('africa_feedback', 0, -1);
        const userSubmissions = allFeedback.filter(item => item.salesperson === req.user.realName);
        userSubmissions.sort((a, b) => new Date(b.Timestamp || b.timestamp || 0) - new Date(a.Timestamp || a.timestamp || 0));
        res.json(userSubmissions);
    } catch (error) {
        console.error('从 Redis 读取用户非洲客户提交历史时出错:', error);
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

// API 路由：更新数据行（管理员或记录所有者）
app.post('/api/update', authenticateToken, async (req, res) => {
    const { timestamp, customerId, phone, summary, isDealer } = req.body;

    if (!timestamp) {
        return res.status(400).send('缺少时间戳标识');
    }

    try {
        const allFeedback = await kv.lrange('feedback', 0, -1);
        const index = allFeedback.findIndex(item => (item.Timestamp || item.timestamp) === timestamp);

        if (index === -1) {
            return res.status(404).send('未找到要更新的数据行');
        }

        const oldRecord = allFeedback[index];

        // 权限检查：必须是管理员或记录的原始提交人
        if (req.user.role !== 'admin' && req.user.realName !== oldRecord.salesperson) {
            return res.status(403).send('权限不足：您只能修改自己的提交记录。');
        }

        const newRecord = {
            ...oldRecord,
            customerId: customerId,
            phone: phone,
            summary: summary,
            ...(isDealer !== undefined && { isDealer })
        };

        await kv.lset('feedback', index, newRecord);
        res.status(200).json({ message: '数据更新成功', updatedRecord: newRecord });
    } catch (error) {
        console.error('更新 Redis 数据时出错:', error);
        res.status(500).send('服务器内部错误');
    }
});

async function updateCustomerRecord(req, res, redisKey, label) {
    const { timestamp, customerId, phone, summary, marketGroup, groupOwner, groupNote } = req.body;

    if (!timestamp) {
        return res.status(400).send('缺少时间戳标识');
    }

    try {
        const allFeedback = await kv.lrange(redisKey, 0, -1);
        const index = allFeedback.findIndex(item => (item.Timestamp || item.timestamp) === timestamp);

        if (index === -1) {
            return res.status(404).send('未找到要更新的数据行');
        }

        const oldRecord = allFeedback[index];
        if (req.user.role !== 'admin' && req.user.realName !== oldRecord.salesperson) {
            return res.status(403).send('权限不足：您只能修改自己的提交记录。');
        }

        const newRecord = {
            ...oldRecord,
            customerId,
            phone,
            summary,
            ...(marketGroup !== undefined && { marketGroup }),
            ...(groupOwner !== undefined && { groupOwner }),
            ...(groupNote !== undefined && { groupNote }),
        };
        await kv.lset(redisKey, index, newRecord);
        res.status(200).json({ message: `${label}数据更新成功`, updatedRecord: newRecord });
    } catch (error) {
        console.error(`更新 Redis ${label}数据时出错:`, error);
        res.status(500).send('服务器内部错误');
    }
}

app.post('/api/africa-update', authenticateToken, async (req, res) => {
    updateCustomerRecord(req, res, 'africa_feedback', '非洲客户');
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

async function deleteCustomerRecord(req, res, redisKey, label) {
    const { Timestamp, timestamp } = req.body;
    const ts = Timestamp || timestamp;

    if (!ts) {
        return res.status(400).send('缺少时间戳标识');
    }

    try {
        const allFeedback = await redis.lrange(redisKey, 0, -1);
        const itemToDelete = allFeedback.find(item => (item.timestamp || item.Timestamp) === ts);

        if (!itemToDelete) {
            return res.status(404).send('未找到要删除的数据行');
        }

        await redis.lrem(redisKey, 1, itemToDelete);
        res.status(200).send(`${label}数据删除成功`);
    } catch (error) {
        console.error(`删除 Redis ${label}数据时出错:`, error);
        res.status(500).send('服务器内部错误');
    }
}

app.post('/api/africa-delete', authenticateAdmin, async (req, res) => {
    deleteCustomerRecord(req, res, 'africa_feedback', '非洲客户');
});

// ─────────────────────────────────────────────────────────────
// CRM prospect search APIs
// The old dashboard called an external Railway service directly from the
// browser. Keeping these routes same-origin prevents CORS/SSL outages from
// breaking the CRM page, and lets us save prospects in our own Redis store.
// ─────────────────────────────────────────────────────────────
const PROSPECTS_KEY = 'crm:prospects';
const SCRIPTS_KEY = 'crm:scripts';
const SEO_UPSTREAM = process.env.SEO_API_UPSTREAM_URL || '';
const PROSPECT_SHEET_UPSTREAM = process.env.PROSPECT_SHEET_UPSTREAM_URL
    || process.env.SEO_API_UPSTREAM_URL
    || 'https://elevator-seo-production.up.railway.app';

function parseStoredValue(value) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function makeId(prefix = '') {
    return `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeProspect(row = {}) {
    return {
        id: row.id || makeId('p_'),
        country: row.country || '',
        city: row.city || '',
        company: row.company || row.name || '',
        phone: row.phone || '',
        whatsapp: row.whatsapp || row.phone || '',
        website: row.website || '',
        address: row.address || '',
        email: row.email || '',
        saved_at: row.saved_at || row.created_at || new Date().toLocaleDateString('zh-CN'),
        source: row.source || 'crm'
    };
}

async function readProspects() {
    const rows = await kv.lrange(PROSPECTS_KEY, 0, -1);
    return (rows || []).map(parseStoredValue).filter(Boolean).map(normalizeProspect);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 4500) {
    if (typeof fetch !== 'function') {
        throw new Error('Server fetch is unavailable');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const text = await response.text();
        let data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = { raw: text };
            }
        }
        if (!response.ok) {
            throw new Error(data.error || data.message || `HTTP ${response.status}`);
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

function buildFallbackDealers({ country, city, type, exclude = [] }) {
    const excludeSet = new Set((exclude || []).map(x => String(x).toLowerCase()));
    const baseQueries = [
        `${type} in ${city} ${country}`,
        `elevator distributor ${city} ${country}`,
        `lift company ${city} ${country}`,
        `elevator installation company ${city} ${country}`,
        `escalator distributor ${city} ${country}`,
        `elevator importer ${city} ${country}`,
        `site:.com ${city} ${country} elevator company`,
        `Google Maps elevator company ${city} ${country}`
    ];

    const entries = baseQueries.map((query, index) => {
        const isMaps = index === 0 || index === baseQueries.length - 1;
        const label = isMaps ? `Google Maps · ${query}` : `Google Search · ${query}`;
        const url = isMaps
            ? `https://www.google.com/maps/search/${encodeURIComponent(query)}`
            : `https://www.google.com/search?q=${encodeURIComponent(query)}`;

        return {
            company: label,
            phone: '',
            whatsapp: '',
            website: url,
            address: `${city}, ${country} · click website to verify`,
            email: '',
            source: 'google-search-link'
        };
    });

    return entries.filter(item => !excludeSet.has(item.company.toLowerCase()));
}

async function syncProspectsToSheet(rows) {
    if (!PROSPECT_SHEET_UPSTREAM || !rows.length) {
        return { ok: true, skipped: true };
    }

    try {
        const data = await fetchJsonWithTimeout(`${PROSPECT_SHEET_UPSTREAM}/api/prospects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows })
        }, 15000);
        return { ok: true, count: data.count || rows.length, source: PROSPECT_SHEET_UPSTREAM };
    } catch (error) {
        console.warn('同步潜在客户到 Google Sheet 失败:', error.message);
        return { ok: false, error: error.message, source: PROSPECT_SHEET_UPSTREAM };
    }
}

app.get('/api/prospects', async (req, res) => {
    try {
        const prospects = await readProspects();
        res.json({ prospects });
    } catch (error) {
        console.error('读取 CRM 潜在客户失败:', error);
        res.status(500).json({ error: '读取潜在客户失败' });
    }
});

app.post('/api/prospects', async (req, res) => {
    try {
        const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
        if (!rows.length) {
            return res.json({ ok: true, inserted: 0 });
        }

        const existing = await readProspects();
        const existingKeys = new Set(existing.map(p => `${p.company}|${p.city}|${p.country}`.toLowerCase()));
        const pipeline = kv.pipeline();
        const insertedRows = [];
        let inserted = 0;

        rows.map(normalizeProspect).forEach(row => {
            const key = `${row.company}|${row.city}|${row.country}`.toLowerCase();
            if (!row.company || existingKeys.has(key)) return;
            existingKeys.add(key);
            pipeline.lpush(PROSPECTS_KEY, row);
            insertedRows.push(row);
            inserted++;
        });

        if (inserted) await pipeline.exec();
        const sheetSync = inserted ? await syncProspectsToSheet(insertedRows) : { ok: true, skipped: true };
        res.json({ ok: true, inserted, sheetSync });
    } catch (error) {
        console.error('保存 CRM 潜在客户失败:', error);
        res.status(500).json({ error: '保存潜在客户失败' });
    }
});

app.delete('/api/prospects/:id', async (req, res) => {
    try {
        const rows = await kv.lrange(PROSPECTS_KEY, 0, -1);
        const target = (rows || []).find(item => String(parseStoredValue(item)?.id) === String(req.params.id));
        if (!target) {
            return res.status(404).json({ error: '未找到该潜在客户' });
        }
        await kv.lrem(PROSPECTS_KEY, 1, target);
        res.json({ ok: true });
    } catch (error) {
        console.error('删除 CRM 潜在客户失败:', error);
        res.status(500).json({ error: '删除潜在客户失败' });
    }
});

app.post('/api/prospects/update-email', async (req, res) => {
    try {
        const { id, email } = req.body;
        const prospects = await readProspects();
        const index = prospects.findIndex(item => String(item.id) === String(id));
        if (index === -1) {
            return res.status(404).json({ error: '未找到该潜在客户' });
        }
        const next = { ...prospects[index], email: email || '' };
        await kv.lset(PROSPECTS_KEY, index, next);
        res.json({ ok: true, prospect: next });
    } catch (error) {
        console.error('更新潜在客户邮箱失败:', error);
        res.status(500).json({ error: '更新邮箱失败' });
    }
});

app.post('/api/search-dealers', async (req, res) => {
    const { country, city, type, exclude = [] } = req.body || {};
    if (!country || !city) {
        return res.status(400).json({ error: '缺少国家或城市' });
    }

    if (SEO_UPSTREAM) {
        try {
            const upstream = await fetchJsonWithTimeout(`${SEO_UPSTREAM}/api/search-dealers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ country, city, type, exclude })
            });

            if (Array.isArray(upstream.dealers) && upstream.dealers.length) {
                return res.json({ dealers: upstream.dealers, source: 'upstream' });
            }
        } catch (error) {
            console.warn('实时搜索服务不可用，使用核实入口:', error.message);
        }
    }

    res.json({
        fallback: true,
        dealers: buildFallbackDealers({ country, city, type, exclude }),
        message: '实时搜索服务暂不可用，已生成 Google 核实入口。'
    });
});

app.post('/api/enrich-email', async (req, res) => {
    if (SEO_UPSTREAM) {
        try {
            const upstream = await fetchJsonWithTimeout(`${SEO_UPSTREAM}/api/enrich-email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body || {})
            }, 6000);

            return res.json({ email: upstream.email || '', source: 'upstream' });
        } catch (error) {
            console.warn('邮箱搜索服务不可用:', error.message);
        }
    }

    return res.json({ email: '', source: 'fallback' });
});

function normalizeScript(script = {}) {
    const id = String(script.id || '').trim();
    return {
        ...script,
        id,
        vars: Array.isArray(script.vars)
            ? script.vars
            : String(script.vars || '').split(',').map(x => x.trim()).filter(Boolean),
        tags: Array.isArray(script.tags)
            ? script.tags
            : String(script.tags || '').split(',').map(x => x.trim()).filter(Boolean)
    };
}

async function readScripts() {
    const raw = await kv.hgetall(SCRIPTS_KEY);
    return Object.values(raw || {})
        .map(parseStoredValue)
        .filter(Boolean)
        .map(normalizeScript)
        .filter(script => script.id)
        .sort((a, b) => a.id.localeCompare(b.id));
}

app.get('/api/scripts', async (req, res) => {
    try {
        const scripts = await readScripts();
        res.json({ scripts });
    } catch (error) {
        console.error('读取话术库失败:', error);
        res.status(500).json({ error: '读取话术库失败' });
    }
});

app.post('/api/scripts', async (req, res) => {
    try {
        const script = normalizeScript(req.body);
        if (!script.id || !script.title || !script.en) {
            return res.status(400).json({ error: 'ID、标题、英文内容为必填项' });
        }
        await kv.hset(SCRIPTS_KEY, { [script.id]: script });
        res.json({ ok: true, script });
    } catch (error) {
        console.error('新增话术失败:', error);
        res.status(500).json({ error: '新增话术失败' });
    }
});

app.put('/api/scripts/:id', async (req, res) => {
    try {
        const script = normalizeScript({ ...req.body, id: req.params.id });
        if (!script.id || !script.title || !script.en) {
            return res.status(400).json({ error: 'ID、标题、英文内容为必填项' });
        }
        await kv.hset(SCRIPTS_KEY, { [script.id]: script });
        res.json({ ok: true, script });
    } catch (error) {
        console.error('更新话术失败:', error);
        res.status(500).json({ error: '更新话术失败' });
    }
});

app.delete('/api/scripts/:id', async (req, res) => {
    try {
        await kv.hdel(SCRIPTS_KEY, req.params.id);
        res.json({ ok: true });
    } catch (error) {
        console.error('删除话术失败:', error);
        res.status(500).json({ error: '删除话术失败' });
    }
});

// 导出 app 实例以供 Vercel 使用
module.exports = app;
