import { chromium } from 'playwright';
import fs from 'fs';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🚀 启动 Chromium（有头模式，方便你手动操作）...');
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 捕获所有请求
  const allRequests = [];
  page.on('request', req => {
    if (req.method() === 'POST') {
      allRequests.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData: req.postData()
      });
    }
  });

  // 1. 先去主页（可能已经登录了）
  console.log('📍 正在打开主页...');
  await page.goto('https://chatglm.cn/');
  await sleep(3000);

  // 2. 抓 localStorage / cookie
  const storage = await page.evaluate(() => ({
    localStorage: { ...localStorage },
    cookies: document.cookie
  }));
  console.log('\n📦 localStorage keys:', Object.keys(storage.localStorage));
  
  fs.writeFileSync('chatglm-localStorage.json', JSON.stringify(storage.localStorage, null, 2));
  console.log('✅ 已保存 chatglm-localStorage.json');

  // 3. 去聊天页 - 这是关键！
  console.log('\n📍 正在打开聊天页 (https://chatglm.cn/main/chat)...');
  await page.goto('https://chatglm.cn/main/chat');
  await page.waitForTimeout(5000);

  console.log('⏳ 请在浏览器里：');
  console.log('   1. 如果有"新建对话"按钮，点一下');
  console.log('   2. 在输入框发一条消息，如 "hi" 或 "测试"');
  console.log('   3. 发送完成后，等待 20 秒自动继续...');
  await sleep(20000);

  // 筛选可能的聊天请求
  const chatCandidates = allRequests.filter(r => 
    r.url.includes('chat') || 
    r.url.includes('completion') || 
    r.url.includes('message') ||
    r.url.includes('generate') ||
    r.url.includes('stream') ||
    r.url.includes('v1/') ||
    r.url.includes('v2/') ||
    r.url.includes('mainchat') ||
    r.url.includes('conversation')
  );

  console.log('\n📊 所有 POST 请求数量:', allRequests.length);
  console.log('🎯 疑似聊天请求数量:', chatCandidates.length);

  if (chatCandidates.length > 0) {
    fs.writeFileSync('chatglm-all-requests.json', JSON.stringify(allRequests, null, 2));
    fs.writeFileSync('chatglm-chat-candidates.json', JSON.stringify(chatCandidates, null, 2));
    
    console.log('\n✅ 已保存 chatglm-all-requests.json 和 chatglm-chat-candidates.json');
    
    chatCandidates.forEach((req, i) => {
      console.log(`\n--- 候选 ${i + 1} ---`);
      console.log('URL:', req.url);
      console.log('Headers:', JSON.stringify(req.headers, null, 2));
      console.log('Body:', req.postData);
    });
  } else {
    console.log('\n⚠️ 没找到疑似聊天请求');
    console.log('所有 POST 请求：');
    allRequests.forEach((req, i) => {
      console.log(`  ${i + 1}. ${req.url}`);
    });
    fs.writeFileSync('chatglm-all-requests.json', JSON.stringify(allRequests, null, 2));
  }

  await browser.close();
}

main().catch(err => {
  console.error('❌ 出错:', err);
  process.exit(1);
});