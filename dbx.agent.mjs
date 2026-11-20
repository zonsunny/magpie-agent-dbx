export const MAGPIE_CONFIG_ID = 'magpie';
export const MAGPIE_CONFIG_NAME = 'Magpie';

// DBX's reasoning levels accepted by AiModelListItem.supportedEffortLevels.
const DBX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function mapModelItem(model) {
  const id = typeof model?.id === 'string' ? model.id.trim() : '';
  if (!id) return null;
  const item = { name: id };
  const label = typeof model?.name === 'string' ? model.name.trim() : '';
  if (label && label !== id) item.label = label;
  const efforts = Array.isArray(model?.efforts)
    ? model.efforts.filter((e) => typeof e === 'string' && DBX_EFFORTS.has(e))
    : [];
  if (efforts.length > 0) item.supportedEffortLevels = efforts;
  return item;
}

export function buildSelectionPayload({ gateway, model, models }) {
  const url = String(gateway?.v1 ?? '').trim();
  const key = String(gateway?.key ?? '').trim();
  const seen = new Set();
  const list = [];
  for (const m of models ?? []) {
    const item = mapModelItem(m);
    if (!item || seen.has(item.name)) continue;
    seen.add(item.name);
    list.push(item);
  }
  const active = typeof model?.id === 'string' ? model.id.trim() : '';
  if (active && !seen.has(active)) {
    const item = mapModelItem(model);
    if (item) list.unshift(item);
  }
  return {
    'gateway.url': url,
    'gateway.key': key,
    model: active || list[0]?.name || '',
    models: list,
  };
}

export const agent = {
  id: 'dbx',
  name: 'DBX',
  icon: 'data:image/png;base64,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',
  // Maintained by index.mjs when DBX's dbx.db exists; its absence means not detected.
  dir: '~/.config/magpie/dbx-home',
  // Magpie writes only its own JSON bridge file here; index.mjs syncs it into DBX's SQLite.
  config: '~/.config/magpie/dbx-agent.json',
  format: 'json',
  model: 'model',
  ua: ['DBX/'],
  notice:
    'Restart DBX to reload its AI model list; disconnecting restores your previous default model. 重启 DBX 后生效，断开连接会还原原默认配置。',
};

export function connect(input) {
  return buildSelectionPayload(input);
}
