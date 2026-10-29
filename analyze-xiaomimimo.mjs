import { chromium } from 'playwright';
import fs from 'fs';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🚀 启动 Chromium（有头模式）...');
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 捕获所有请求
  const allRequests = [];
  page.on('request', req => {
    if (req.method() === 'POST' || req.method() === 'GET') {
      allRequests.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData: req.postData()
      });
    }
  });

  // 1. 先去主页
  console.log('📍 正在打开主页...');
  await page.goto('https://aistudio.xiaomimimo.com/');
  await sleep(3000);

  // 2. 抓 localStorage / cookie
  const storage = await page.evaluate(() => ({
    localStorage: { ...localStorage },
    cookies: document.cookie
  }));
  console.log('\n📦 localStorage keys:', Object.keys(storage.localStorage));
  console.log('🍪 Cookie:', storage.cookies.substring(0, 300));
  
  fs.writeFileSync('xmm-localStorage.json', JSON.stringify(storage.localStorage, null, 2));
  console.log('✅ 已保存 xmm-localStorage.json');

  console.log('\n⏳ 请在浏览器里完成登录（扫码/账号密码），登录完成后等待 10 秒自动继续...');
  await sleep(10000);

  // 登录后再次抓取
  const storageAfterLogin = await page.evaluate(() => ({
    localStorage: { ...localStorage },
    cookies: document.cookie
  }));
  console.log('\n📦 登录后 localStorage keys:', Object.keys(storageAfterLogin.localStorage));
  console.log('🍪 登录后 Cookie:', storageAfterLogin.cookies.substring(0, 300));
  fs.writeFileSync('xmm-localStorage-after-login.json', JSON.stringify(storageAfterLogin.localStorage, null, 2));

  // 3. 去聊天页
  console.log('\n📍 正在打开聊天页...');
  await page.goto('https://aistudio.xiaomimimo.com/#/ultra');
  await page.waitForTimeout(5000);

  console.log('⏳ 请在浏览器里：新建对话 -> 发一条消息（如 "hi"） -> 发送完成后等待 20 秒...');
  await sleep(20000);

  // 筛选可能的聊天请求（排除 APM/telemetry）
  const chatCandidates = allRequests.filter(r => {
    const url = r.url.toLowerCase();
    return (url.includes('chat') || 
            url.includes('completion') || 
            url.includes('message') ||
            url.includes('generate') ||
            url.includes('stream') ||
            url.includes('conversation') ||
            url.includes('api/') && !url.includes('apm-rum') && !url.includes('rum') && !url.includes('track')) &&
           !url.includes('apm-rum') && !url.includes('analytics') && !url.includes('telemetry');
  });

  console.log('\n📊 所有请求数量:', allRequests.length);
  console.log('🎯 疑似聊天/业务请求数量:', chatCandidates.length);

  if (chatCandidates.length > 0) {
    fs.writeFileSync('xmm-all-requests.json', JSON.stringify(allRequests, null, 2));
    fs.writeFileSync('xmm-chat-candidates.json', JSON.stringify(chatCandidates, null, 2));
    
    console.log('\n✅ 已保存 xmm-all-requests.json 和 xmm-chat-candidates.json');
    
    chatCandidates.forEach((req, i) => {
      console.log(`\n--- 候选 ${i + 1} ---`);
      console.log('URL:', req.url);
      console.log('Method:', req.method);
      console.log('Headers:', JSON.stringify(req.headers, null, 2));
      console.log('Body:', req.postData);
    });
  } else {
    console.log('\n⚠️ 没找到疑似聊天请求');
    console.log('所有请求：');
    allRequests.forEach((req, i) => {
      console.log(`  ${i + 1}. [${req.method}] ${req.url}`);
    });
    fs.writeFileSync('xmm-all-requests.json', JSON.stringify(allRequests, null, 2));
  }

  await browser.close();
}

main().catch(err => {
  console.error('❌ 出错:', err);
  process.exit(1);
});