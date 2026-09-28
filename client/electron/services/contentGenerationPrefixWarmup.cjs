const { setTimeout: delay } = require('node:timers/promises');

const PREFIX_WARMUP_SETTLE_MS = 1500;

// 并发请求同时到达时互相用不上缓存；先用只含公共前缀的短请求写入缓存，失败不影响后续并发。
async function warmSharedPrefix({ aiService, system, sharedInput, signal, onActivity, logTitle, label }) {
  onActivity?.({ message: `正在预热${label}缓存` });
  try {
    await aiService.chat({ signal, logTitle, output_token_limit: 1,
      messages: [{ role: 'system', content: system }, { role: 'user', content: sharedInput }] });
    // 部分服务在请求结束后才异步构建前缀缓存，稍候再放开并发。
    await delay(PREFIX_WARMUP_SETTLE_MS, undefined, { signal });
  } catch (error) {
    signal.throwIfAborted();
    onActivity?.({ message: `${label}缓存预热失败，直接并发：${error.message}` });
  }
}

module.exports = { warmSharedPrefix };
