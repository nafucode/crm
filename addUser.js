const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const usersFilePath = path.join(__dirname, 'users.json');

// 获取命令行参数
const [,, username, password, realName] = process.argv;

if (!username || !password || !realName) {
    console.error('错误: 请提供用户名、密码和真实姓名。');
    console.error('用法: node addUser.js <用户名> <密码> "<真实姓名>"');
    process.exit(1);
}

// 读取用户文件
let users = [];
if (fs.existsSync(usersFilePath)) {
    try {
        users = JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
    } catch (e) {
        console.error('错误: users.json 文件格式不正确。');
        process.exit(1);
    }
}

// 加密密码
bcrypt.genSalt(10, (err, salt) => {
    if (err) throw err;
    bcrypt.hash(password, salt, (err, hash) => {
        if (err) throw err;

        const userIndex = users.findIndex(u => u.username === username);

        if (userIndex > -1) {
            // 更新现有用户
            users[userIndex].password = hash;
            users[userIndex].realName = realName;
            console.log(`用户 '${username}' 的密码和信息已更新。`);
        } else {
            // 添加新用户
            users.push({
                username: username,
                password: hash,
                realName: realName
            });
            console.log(`新用户 '${username}' 已成功添加。`);
        }

        // 写回文件
        fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 4), 'utf8');
        console.log('users.json 文件已更新。');
    });
});
