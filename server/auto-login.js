// auto-login.js - Playwright自动登录DeepSeek平台并提取userToken
const { chromium } = require("playwright");
const http = require("http");

async function main() {
  console.log("[auto-login] 启动浏览器...");
  
  const browser = await chromium.launch({ 
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 800 }
  });
  
  const page = await context.newPage();
  
  // 监听URL变化来检测登录成功
  let loggedIn = false;
  page.on("framenavigated", async (frame) => {
    if (frame === page.mainFrame()) {
      const url = page.url();
      console.log("[auto-login] 页面跳转: " + url.substring(0, 80));
      // DeepSeek登录成功后通常会跳转到usage或dashboard页面
      if (url.includes("platform.deepseek.com") && !url.includes("/login") && !url.includes("/signin")) {
        loggedIn = true;
      }
    }
  });
  
  // 先去登录页
  await page.goto("https://platform.deepseek.com/usage", { 
    waitUntil: "domcontentloaded", 
    timeout: 30000 
  });
  console.log("[auto-login] 已打开 DeepSeek 平台，请在浏览器中登录...");
  
  // 等待登录（最多5分钟）
  let token = null;
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000);
    
    // 检查是否已登录（URL变化或出现特定元素）
    const url = page.url();
    const hasDashboard = url.includes("platform.deepseek.com") && 
                         !url.includes("/login") && 
                         !url.includes("/signin");
    
    if (hasDashboard || loggedIn) {
      // 等待页面完全加载后再提取token
      await page.waitForTimeout(3000);
      
      try {
        // 方法1: 从localStorage提取
        token = await page.evaluate(() => {
          const raw = localStorage.getItem("userToken");
          if (!raw) return null;
          try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.value && parsed.value.length > 10) {
              return raw;
            }
          } catch (e) {}
          return null;
        });
        
        // 方法2: 如果localStorage没有，尝试从所有storage key中找
        if (!token) {
          token = await page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              const val = localStorage.getItem(key);
              if (key && key.toLowerCase().includes("token") && val) {
                try {
                  const p = JSON.parse(val);
                  if (p && p.value && p.value.length > 10) return val;
                } catch (e) {
                  if (val.length > 20) return JSON.stringify({ value: val, __version: "0" });
                }
              }
            }
            return null;
          });
        }
        
        if (token) {
          console.log("[auto-login] 检测到 Token!");
          break;
        }
      } catch (e) {
        console.log("[auto-login] 提取token时出错: " + e.message + ", 重试...");
      }
    }
    
    if (i % 15 === 0 && i > 0) {
      console.log("[auto-login] 等待登录中... (" + Math.floor(i * 2 / 60) + "分钟)");
    }
  }
  
  if (token) {
    console.log("[auto-login] Token获取成功!");
    
    // 发送到本地服务器
    try {
      const postData = JSON.stringify({ token: token });
      await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: "localhost", port: 3000,
          path: "/api/platform-token", method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData)
          }
        }, (res) => {
          let body = "";
          res.on("data", (c) => { body += c; });
          res.on("end", () => {
            console.log("[auto-login] 服务器响应: " + body);
            resolve();
          });
        });
        req.on("error", (e) => { console.log("[auto-login] 发送失败: " + e.message); resolve(); });
        req.write(postData);
        req.end();
      });
    } catch (e) {
      console.error("[auto-login] 发送异常: " + e.message);
    }
    
    await page.waitForTimeout(2000);
  } else {
    console.log("[auto-login] 超时: 未检测到登录");
  }
  
  await browser.close();
  console.log("[auto-login] 浏览器已关闭");
}

main().catch(e => {
  console.error("[auto-login] 致命错误: " + e.message);
  process.exit(1);
});