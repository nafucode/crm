const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const port = 3000;
const JWT_SECRET = 'your_super_secret_key_that_should_be_long_and_random'; // 请在未来替换为一个更安全的密钥

// 中间件
app.use(cors()); // 允许跨域请求
app.use(express.json()); // 解析 JSON 请求体

app.use(express.static(__dirname));

// API: 用户登录
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));
    const user = users.find(u => u.username === username);

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

const csvFilePath = path.join(__dirname, 'feedback.csv');
const CSV_HEADERS = ['Timestamp', 'Country', 'CustomerInfo', 'Phone', 'Description', 'Submitter'];

// 写入 CSV 文件的表头（如果文件不存在）
if (!fs.existsSync(csvFilePath)) {
    const headerString = CSV_HEADERS.map(h => `"${h}"`).join(',') + '\n';
    fs.writeFileSync(csvFilePath, headerString, 'utf8');
}

// API 路由：处理表单提交（支持批量）
app.post('/api/submit', authenticateToken, (req, res) => {
    const submissions = req.body; // 现在 submissions 是一个数组

    if (!Array.isArray(submissions) || submissions.length === 0) {
        return res.status(400).send('提交数据格式不正确或为空');
    }

    const formatCsvField = (field) => {
        const str = String(field || '').replace(/"/g, '""');
        return `"${str}"`;
    };

    // 为每个提交对象创建一个 CSV 行
    const csvRows = submissions.map(submission => {
        const rowData = {
            Timestamp: submission.timestamp,
            Country: submission.country,
            CustomerInfo: submission.customerInfo,
            Phone: submission.phone,
            Description: submission.description,
            Submitter: submission.submitter
        };
        return CSV_HEADERS.map(header => formatCsvField(rowData[header])).join(',');
    }).join('\n') + '\n';

    // 将所有新行一次性追加到 CSV 文件中
    fs.appendFile(csvFilePath, csvRows, 'utf8', (err) => {
        if (err) {
            console.error('文件写入失败:', err);
            return res.status(500).send('服务器内部错误');
        }
        res.status(200).send('数据提交成功');
    });
});

// API 路由：读取并返回所有反馈数据
app.get('/api/data', authenticateToken, (req, res) => {
    const results = [];
    if (!fs.existsSync(csvFilePath)) {
        return res.json([]); // 如果文件不存在，返回空数组
    }

    fs.createReadStream(csvFilePath)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            res.json(results); // 在文件读取结束后，将结果作为 JSON 返回
        })
        .on('error', (error) => {
            console.error('读取 CSV 文件时出错:', error);
            res.status(500).send('服务器内部错误');
        });
});

// API 路由：为地图提供按国家聚合的数据
app.get('/api/map-data', authenticateAdmin, (req, res) => {
    const results = [];
    if (!fs.existsSync(csvFilePath)) {
        return res.json([]);
    }

    fs.createReadStream(csvFilePath)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            const countryCounts = results.reduce((acc, row) => {
                const country = row.Country;
                if (country) {
                    acc[country] = (acc[country] || 0) + 1;
                }
                return acc;
            }, {});

            const mapData = Object.keys(countryCounts).map(countryName => {
                return { name: countryName, value: countryCounts[countryName] };
            });

            res.json(mapData);
        })
        .on('error', (error) => {
            console.error('读取 CSV 文件时出错:', error);
            res.status(500).send('服务器内部错误');
        });
});

// API 路由：更新一行数据
app.post('/api/update', authenticateAdmin, (req, res) => {
    const updatedRow = req.body;
    const results = [];

    // 1. 读取整个 CSV 文件
    fs.createReadStream(csvFilePath)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            // 2. 找到并更新数据
            const rowIndex = results.findIndex(row => row.Timestamp === updatedRow.Timestamp);
            if (rowIndex === -1) {
                return res.status(404).send('未找到要更新的数据行');
            }
            results[rowIndex] = updatedRow;

            // 3. 将更新后的数据转换回 CSV 字符串
            if (results.length === 0) {
                const headerString = CSV_HEADERS.map(h => `"${h}"`).join(',') + '\n';
                fs.writeFileSync(csvFilePath, headerString, 'utf8');
                return res.status(200).send('数据更新成功');
            }

            const headerString = CSV_HEADERS.map(h => `"${h}"`).join(',') + '\n';
            const csvString = results.map(row => {
                return CSV_HEADERS.map(header => {
                    const value = String(row[header] || '').replace(/"/g, '""');
                    return `"${value}"`;
                }).join(',');
            }).join('\n');

            // 4. 重写整个 CSV 文件
            fs.writeFile(csvFilePath, headerString + csvString, 'utf8', (err) => {
                if (err) {
                    console.error('文件写入失败:', err);
                    return res.status(500).send('服务器内部错误');
                }
                res.status(200).send('数据更新成功');
            });
        })
        .on('error', (error) => {
            console.error('读取 CSV 文件时出错:', error);
            res.status(500).send('服务器内部错误');
        });
});

// API 路由：删除一行数据
app.post('/api/delete', authenticateAdmin, (req, res) => {
    const { Timestamp } = req.body;
    if (!Timestamp) {
        return res.status(400).send('缺少时间戳标识');
    }

    const results = [];
    fs.createReadStream(csvFilePath)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            const filteredResults = results.filter(row => row.Timestamp !== Timestamp);

            if (results.length === filteredResults.length) {
                return res.status(404).send('未找到要删除的数据行');
            }

            if (filteredResults.length === 0) {
                const headerString = CSV_HEADERS.map(h => `"${h}"`).join(',') + '\n';
                fs.writeFileSync(csvFilePath, headerString, 'utf8');
                return res.status(200).send('数据删除成功，文件已清空');
            }

            const headerString = CSV_HEADERS.map(h => `"${h}"`).join(',') + '\n';
            const csvString = filteredResults.map(row => {
                return CSV_HEADERS.map(header => {
                    const value = String(row[header] || '').replace(/"/g, '""');
                    return `"${value}"`;
                }).join(',');
            }).join('\n');

            fs.writeFile(csvFilePath, headerString + csvString, 'utf8', (err) => {
                if (err) {
                    console.error('文件写入失败:', err);
                    return res.status(500).send('服务器内部错误');
                }
                res.status(200).send('数据删除成功');
            });
        })
        .on('error', (error) => {
            console.error('读取 CSV 文件时出错:', error);
            res.status(500).send('服务器内部错误');
        });
});

// 启动服务器
app.listen(port, () => {
    console.log(`服务器正在运行在 http://localhost:${port}`);
});
