# 玄机塔罗

> 分形结构语法 · AI 深度塔罗推演系统

## 快速部署

### Replit
1. 上传项目文件到 Replit
2. 在 **Secrets** 中添加：`DEEPSEEK_API_KEY = 你的Key`
3. 添加：`DATABASE_URL = 你的 PostgreSQL 连接串`
4. 点击 **Run**，访问 `https://你的域名`

### 本地运行
```bash
npm install
DATABASE_URL=your_postgres_url DEEPSEEK_API_KEY=your_key node server.js
```

## 默认账号

| 账号 | 密码 | 说明 |
|------|------|------|
| admin | admin888 | 管理员，首次启动自动创建 |

## 图片资源

将以下图片放入 `public/` 目录后重启：

| 文件名 | 用途 |
|--------|------|
| `pay-19.jpg` | 19.9元支付赞赏码 |
| `wechat-qr.jpg` | 微信客服二维码 |

## 套餐说明

| 套餐 | 次数 | 开通方式 |
|------|------|----------|
| 免费用户 | 3次（一次性） | 注册即得 |
| 星渊会员 | 30次/月 | 管理后台手动发放 |

## 管理后台

访问 `/admin`，使用管理员账号登录。功能：
- 仪表盘：用户总数、今日新增、今日推演、会员数
- 用户管理：搜索用户、发放/取消星渊会员
- 邀请码管理：生成邀请码、查看使用状态
- 提问统计：感情/事业/财运/健康/其他 分类占比饼图 + 每日明细

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DATABASE_URL` | PostgreSQL 连接串（必填） | — |
| `DEEPSEEK_API_KEY` | DeepSeek API密钥（必填） | — |
| `PORT` | 监听端口 | 3000 |
| `JWT_SECRET` | JWT签名密钥（建议修改） | xuanji-tarot-secret-xj2024 |

## 技术栈

- **后端**：Node.js + Express + pg + jsonwebtoken + bcryptjs
- **前端**：原生 HTML/CSS/JS + TailwindCSS CDN
- **AI**：DeepSeek Chat API（deepseek-chat 模型）
- **数据库**：PostgreSQL（通过 `DATABASE_URL` 连接）
