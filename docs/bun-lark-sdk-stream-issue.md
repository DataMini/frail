# Bun + Lark SDK 流式下载不兼容问题

## 问题

`@larksuiteoapi/node-sdk` 的文件下载 API（如 `im.messageResource.get`、`im.image.get`）在 **Bun 运行时下无法正常工作**，调用会 hang 住直到超时，报错：

```
The socket connection was closed unexpectedly.
```

## 原因

SDK 内部使用 axios 的 `responseType: "stream"` 获取 Node.js 可读流（`Readable`），然后通过 `res.data.pipe(writableStream)` 写入文件。

Bun 的 HTTP 实现对 axios 的 Node.js stream 模式兼容性不完整，导致：
1. axios 请求返回的 `res.data` 流对象行为异常
2. `res.data.readable` 状态不正确
3. 连接被意外关闭

相关 SDK 源码位置（`node_modules/@larksuiteoapi/node-sdk/lib/index.js`）：

```javascript
// messageResource.get 实现
const res = yield this.httpInstance.request({
    url: fillApiPath(`${this.domain}/open-apis/im/v1/messages/:message_id/resources/:file_key`, path),
    method: "GET",
    responseType: "stream",  // <-- 问题根源：Bun 不完全支持 axios stream
    // ...
});
// 返回的 writeFile 内部用 res.data.pipe(writableStream)
```

## 影响范围

所有返回文件流的 Lark SDK API，包括：
- `client.im.messageResource.get()` — 获取消息中的资源文件
- `client.im.image.get()` — 下载图片
- `client.im.file.get()` — 下载文件

## 解决方案

**绕过 SDK，用 `fetch` 直接调用飞书 REST API。**

```typescript
// 1. 获取 tenant access token
const tokenResp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
});
const { tenant_access_token } = await tokenResp.json();

// 2. 直接下载图片
const resp = await fetch(
  `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=image`,
  { headers: { Authorization: `Bearer ${tenant_access_token}` } }
);

const buf = await resp.arrayBuffer();
fs.writeFileSync(filePath, Buffer.from(buf));
```

Bun 原生的 `fetch` 不依赖 axios，直接使用 Bun 的 HTTP 实现，下载正常。

## 验证

```bash
# SDK 方式（失败）
bun -e "
  const Lark = require('@larksuiteoapi/node-sdk');
  const client = new Lark.Client({...});
  client.im.messageResource.get({...}).then(r => r.writeFile('/tmp/test.png'));
"
# → hang 然后 "socket connection was closed unexpectedly"

# fetch 方式（成功）
bun -e "
  const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages/{id}/resources/{key}?type=image',
    { headers: { Authorization: 'Bearer ...' } });
  Bun.write('/tmp/test.png', await resp.arrayBuffer());
"
# → 正常下载
```

## 相关文件

- `src/feishu/client.ts` — `downloadImage()` 使用 fetch 实现
- Lark SDK: `@larksuiteoapi/node-sdk@1.60.0`
- Runtime: Bun

## 后续

如果 Bun 未来修复了 axios stream 兼容性（或 Lark SDK 切换到 `fetch`），可以改回使用 SDK 方法。
