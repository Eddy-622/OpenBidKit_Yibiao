const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiHttpErrorFromResponse, getAiHttpError, isOfficialBalanceInsufficient } = require('./aiHttpError.cjs');
const { isRetryableAiRequestError } = require('./aiRetry.cjs');

const OFFICIAL_BALANCE_BODY = '{"error":{"message":"余额不足","type":"yibiao_ai_error","param":null,"code":"INSUFFICIENT_BALANCE"}}';

function createResponse(status, body, contentType = 'application/json') {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

test('官方 402 余额不足被识别且不重试，错误信息取服务端说明', async () => {
  const error = await createAiHttpErrorFromResponse(createResponse(402, OFFICIAL_BALANCE_BODY), 'AI 请求失败', { source: 'text-model' });
  assert.equal(error.message, '余额不足');
  assert.equal(error.status, 402);
  assert.equal(isRetryableAiRequestError(error), false);
  assert.equal(isOfficialBalanceInsufficient(getAiHttpError(error)), true);
});

test('其他服务商的 402、普通 JSON 错误和 HTML 错误页不按官方余额不足处理', () => {
  const payloads = [
    { status: 402, body: '{"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}' },
    { status: 400, body: '{"error":{"message":"bad request","type":"invalid_request_error","code":"INSUFFICIENT_BALANCE"}}' },
    { status: 402, body: '{"error":{"message":"余额不足","type":"yibiao_ai_error","code":"RATE_LIMITED"}}' },
    { status: 502, body: '<!doctype html><html><body>Bad Gateway</body></html>', contentType: 'text/html' },
    { status: 402, body: '' },
  ];
  for (const payload of payloads) {
    assert.equal(isOfficialBalanceInsufficient(payload), false, payload.body);
  }
});
