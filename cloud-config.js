// Public client configuration for cloud sync (safe to ship in the browser).
//
// 本项目默认以纯本地模式运行：数据保存在浏览器 localStorage（键名 daylist.v2）。
// 如需启用跨设备云同步，请填入你自己的云端服务配置（公开的客户端配置，
// 可随前端一起发布）；两项均留空时应用自动退回本地模式，不影响其他功能。
window.WORKBUDDY_CLOUD_CONFIG = {
  endpoint: "",
  publishableKey: ""
};
