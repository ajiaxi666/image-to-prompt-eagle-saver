const FEISHU_API = 'https://open.feishu.cn/open-apis';

// In-memory token cache (cleared on service worker restart, ~2h TTL)
let cachedToken = null;
let tokenExpiresAt = 0;

export async function getTenantAccessToken(appId, appSecret) {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }
  const res = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书认证失败：${data.msg}`);
  cachedToken = data.tenant_access_token;
  tokenExpiresAt = Date.now() + (data.expire || 7200) * 1000;
  return cachedToken;
}

export async function getBitableInfo(appToken, token) {
  const res = await fetch(`${FEISHU_API}/bitable/v1/apps/${appToken}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取 Bitable 信息失败：${data.msg}`);
  return data.data.app;
}

export async function listTables(appToken, token) {
  const res = await fetch(`${FEISHU_API}/bitable/v1/apps/${appToken}/tables`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取数据表列表失败：${data.msg}`);
  return (data.data.items || []).map(t => ({
    tableId: t.table_id,
    name: t.name,
  }));
}

export async function listRecords(appToken, tableId, token, pageToken = '', pageSize = 50) {
  const params = new URLSearchParams({ page_size: String(pageSize) });
  if (pageToken) params.set('page_token', pageToken);
  const res = await fetch(
    `${FEISHU_API}/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params}`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取记录失败：${data.msg}`);
  return {
    items: (data.data.items || []).map(r => ({
      recordId: r.record_id,
      ...r.fields,
      _createdTime: r.created_time,
      _createdBy: r.created_by,
    })),
    hasMore: data.data.has_more || false,
    pageToken: data.data.page_token || '',
  };
}

export async function createRecord(appToken, tableId, token, fields) {
  const res = await fetch(
    `${FEISHU_API}/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ fields }),
    },
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`创建记录失败：${data.msg}`);
  return data.data.record;
}

export async function deleteRecord(appToken, tableId, token, recordId) {
  const res = await fetch(
    `${FEISHU_API}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    },
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`删除记录失败：${data.msg}`);
  return true;
}
