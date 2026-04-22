require('dotenv').config(); // 在文件顶部引入 dotenv
const { createClient } = require('@vercel/kv');
const bcrypt = require('bcryptjs');

const kv = createClient({
  url: process.env.REDIS_URL,
});

const [,, username, password, realName, role = 'user'] = process.argv;

if (!username || !password || !realName) {
    console.error('用法: node addUser.js <用户名> <密码> "<真实姓名>" [角色]');
    console.error('角色可选，默认为 \'user\'。管理员请使用 \'admin\'.');
    process.exit(1);
}

async function addUser() {
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const user = {
            username,
            password: hashedPassword,
            realName,
            role,
        };

        await kv.hset(`user:${username}`, user);

        console.log(`用户 '${username}' (${realName}) 已作为 '${role}' 角色成功添加/更新到数据库。`);
    } catch (error) {
        console.error('添加用户时出错:', error);
    }
}

addUser();
