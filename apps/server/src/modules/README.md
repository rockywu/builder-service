# 业务模块边界

`auth/` 已实现密码哈希、登录/当前会话/退出接口，以及管理 API 认证边界。

后续实现 users、projects、git、builds、releases、settings。构建调度和执行属于 builds，产物下载与测试状态属于 releases，图标上传属于 projects。各模块注册 Fastify 路由，数据库操作交给数据库 Worker。

当前只创建用户及会话表，没有项目、队列或产物业务表，不执行 Git 或构建命令。
